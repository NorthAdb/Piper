// 晨间仓库扫描 routine（P1-2）：只读拉 GitHub REST API 取证，主产物是拍板清单（Finding），
// 统计信息只进日报的「其余观察」，不再冒充主结果。
// 进入拍板清单的规则是程序化的（就这三条，不要临时扩种类）：
//   ci_failed：按工作流分别取各自在默认分支上最新一条已结束（status=completed）的 run，
//   仅 conclusion 为 failure 才开单（cancelled/timed_out/startup_failure 不报、不回溯）；
//   pr_needs_review：open、非 draft、且按「已批准」锁定语义（lib/pr-review.ts：每位审查人
//   最新一条为准、陈旧批准不算数）仍待审的 PR；
//   issue_untriaged（Issue 分诊）：open 的 Issue（非 PR），打开满 48 小时，且无人评论、
//   无标签、无认领人——三者任一出现即视为已有人分诊，不开单。
// 取证完整性（R6）：pulls/reviews/runs 都翻页取尽（各自有上限，触顶时日报写明「仅检查
// 前 N 条」）；一个仓的全部取证先完成，再统一计算、统一落盘——任一环节失败整仓不开
// Finding、不做对账退役，失败记入日报（半成品不落盘）；runs 接口失败不再静默吞掉，
// 该仓日报写明「CI 数据缺失：<状态码>」（其余规则照常，该仓不计 failures）。
// 去重（R5，口径已锁定）：键 repo+type+subject，按状态冷却——open/approved/executing
// 不得另开；rejected 头部未变且未满 14 天不重开；executed 仅头部变化可重开；expired 可重开
//（实现在 findings.findBlockingFinding）。头部取 PR 的 head.sha / run 的 head_sha，开单时
// 存进 Finding.headSha 作下轮比较基准。
// 扫描前对账（R5）：每仓先复核既有 open/approved Finding——PR 已合并/关闭/draft/已批准、
// 或同工作流 CI 已转绿/已被新失败 run 取代的，自动转 expired 并写审计 reconciled:<原因>，
// 退出待批。Issue 类同理：已关闭（issue_closed）或已有人评论/打标签/认领
//（issue_triaged）的自动退役。建议先用规则模板，不上模型润色，
// 模型不得发明 GitHub 上不存在的 PR 或 CI（后续步骤若引入模型写建议，同样受此约束）。
// 令牌经 lib/settings.ts 的 githubToken() 统一读取（L0-4：设置文件优先、环境变量兜底），
// 本文件不直读令牌环境变量；无令牌走公开限额。API 基址缺省 https://api.github.com，
// 可用 PIPER_GITHUB_API_BASE 覆盖（R4：回归用本地 GitHub 桩，全程离线、结果确定）。
// 单仓失败不中断整体，失败原因写进日报；
// 全部仓库失败时由调用方判定整轮失败（L0-5 语义，本文件只回 failures/total）。
// 本文件全程只读，绝不调用任何 GitHub 写接口：pr_needs_review 附带的 writeIntent 只是
// 「建议的写动作」（规则模板正文，P1-6），要等人在收件箱批准后才经网关真正发送。
import { githubToken } from "./settings.ts";
import { createFinding, findBlockingFinding, listFindings, updateFinding } from "./findings.ts";
import type { Finding, FindingDetail, FindingInput } from "./findings.ts";
import { evaluateReviews, latestReviewStances, prNeedsReview } from "./pr-review.ts";
import { appendAudit } from "./audit.ts";
import { redact } from "./redact.ts";
import type { ArtifactMeta } from "./store.ts";

// 一仓取证的汇总。info / commits / pulls / issues / runs 是 GitHub REST 的原始
// 响应（外部边界，字段随接口变），消费方逐字段取用，故这几处保留 any——
// 这是本文件仅有的 any 所在，扫描规则的输入输出（Finding 等）都有真实类型。
interface RepoData {
	info: any;
	branch: string;
	commits: any[];
	pulls: any[];
	issues: any[];
	runs: any[];
	ciMissing: string | number | null;
	notes: string[];
}

export interface ReconciledItem {
	id: string;
	repo: string;
	type: string;
	subject: string;
	cause: string;
}

function ghBase(): string {
	return (process.env.PIPER_GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, "");
}

// GitHub API 响应是外部边界：返回 any，由各消费点按接口文档逐字段取用。
// 失败同 gateway 口径带回 GitHub 的 message（截断 200 字），日报里能直接看到
// 403 的原因而不是只有一个状态码。
async function gh(path: string): Promise<any> {
	const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "piper-morning-scan" };
	const token = githubToken();
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(`${ghBase()}${path}`, { headers });
	if (!res.ok) {
		let detail = "";
		try {
			const j: any = await res.json();
			if (typeof j?.message === "string" && j.message) detail = `：${redact(j.message.slice(0, 200))}`;
		} catch {
			// 响应体不是 JSON 就只报状态码
		}
		throw Object.assign(new Error(`GitHub API ${res.status} ${path}${detail}`), { status: res.status });
	}
	return res.json();
}

// 翻页取尽（R6）：按 per_page 逐页拉，直到某页不满 per_page 为止；累计到 maxItems
// 且最后一页仍满页时记 truncated（调用方在日报写明「仅检查前 N 条」）。
// extract 把响应体映射成数组（runs 接口是 { workflow_runs: [...] } 包装）。
// 本函数与上限表同时供 lib/gateway.ts 复检取 reviews 使用（F2，第二轮返工）：
// 扫描与网关共用同一套翻页口径，不各写一份。
export interface PageCaps {
	perPage: number;
	maxItems: number;
}

export const PAGE_CAPS: Record<"pulls" | "reviews" | "runs" | "issues", PageCaps> = {
	pulls: { perPage: 100, maxItems: 200 },
	reviews: { perPage: 100, maxItems: 300 },
	runs: { perPage: 100, maxItems: 100 },
	issues: { perPage: 100, maxItems: 200 },
};

export async function ghPage<T>(
	path: string,
	{ perPage, maxItems }: PageCaps,
	extract: (j: any) => T[] | undefined | null = (j: any) => j as T[],
): Promise<{ items: T[]; truncated: boolean }> {
	const sep = path.includes("?") ? "&" : "?";
	const items: T[] = [];
	let truncated = false;
	for (let page = 1; ; page += 1) {
		const batch = extract(await gh(`${path}${sep}per_page=${perPage}&page=${page}`)) ?? [];
		items.push(...batch);
		if (batch.length < perPage) break;
		if (items.length >= maxItems) {
			truncated = true;
			break;
		}
	}
	return { items: items.slice(0, maxItems), truncated };
}

function fmtDate(iso: unknown): string {
	return iso ? String(iso).slice(0, 10) : "-";
}

// Finding 过期时间：7 天后过期，避免清单腐烂（总图 4.2）。状态迁移（过期清理）在后续切片。
const FINDING_TTL_DAYS = 7;

function expiresAtFrom(now: Date): string {
	return new Date(now.getTime() + FINDING_TTL_DAYS * 24 * 3600 * 1000).toISOString();
}

async function fetchRepoData(repo: string): Promise<RepoData> {
	const info = await gh(`/repos/${repo}`);
	const branch: string = info.default_branch;
	const notes: string[] = [];
	const pullsPagePromise = ghPage(`/repos/${repo}/pulls?state=open`, PAGE_CAPS.pulls);
	// runs 接口失败（Actions 未启用、权限不足等）不再静默吞掉：记下状态码，
	// 日报该仓下写明「CI 数据缺失：<状态码>」；本仓其余取证与 PR 规则照常。
	const runsPagePromise: Promise<{ items: any[]; truncated: boolean; ciMissing?: string | number }> = ghPage(
		`/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}`,
		PAGE_CAPS.runs,
		(j) => j?.workflow_runs,
	).catch((err) => ({ items: [] as any[], truncated: false, ciMissing: (err as { status?: string | number } | undefined)?.status ?? "未知" }));
	const issuesPagePromise = ghPage(`/repos/${repo}/issues?state=open`, PAGE_CAPS.issues);
	const [commits, pullsPage, issuesPage, runsPage] = await Promise.all([
		gh(`/repos/${repo}/commits?per_page=5`),
		pullsPagePromise,
		issuesPagePromise,
		runsPagePromise,
	]);
	if (pullsPage.truncated) notes.push(`PR 超过检查上限，仅检查前 ${PAGE_CAPS.pulls.maxItems} 条`);
	if (issuesPage.truncated) notes.push(`Issue 超过检查上限，仅检查前 ${PAGE_CAPS.issues.maxItems} 条`);
	if (runsPage.truncated) notes.push(`CI run 超过检查上限，仅检查最近 ${PAGE_CAPS.runs.maxItems} 条`);
	return {
		info,
		branch,
		commits: commits ?? [],
		pulls: pullsPage.items,
		issues: issuesPage.items.filter((i: any) => !i.pull_request),
		runs: runsPage.items,
		ciMissing: runsPage.ciMissing ?? null,
		notes,
	};
}

// 返回 { reviews, truncated }：审查可能上百条，必须翻页取尽——只看第一页会把
// 第二页才出现的 APPROVED 漏掉（误报待审），或漏掉 CHANGES_REQUESTED（误判已批准）。
async function fetchReviews(repo: string, prNumber: number): Promise<{ reviews: any[]; truncated: boolean }> {
	const page = await ghPage(`/repos/${repo}/pulls/${prNumber}/reviews`, PAGE_CAPS.reviews);
	return { reviews: page.items, truncated: page.truncated };
}

// 拍板详情取证（切片二）：单查 PR 拿描述/分支/改动规模，再拉变更文件清单
//（存前 20 个，总数以 PR 的 changed_files 为准）。详情不是规则输入——取不到
// 时调用方降级为「无详情开单 + 日报注明」，不让展示层故障连坐开单主链。
const DETAIL_FILES_CAP = 20;
const DETAIL_BODY_CHARS = 500;

async function fetchPrDetail(repo: string, prNumber: number, reviews: unknown, headSha: string | null): Promise<FindingDetail> {
	const pr = await gh(`/repos/${repo}/pulls/${prNumber}`);
	const filesPage = await ghPage(`/repos/${repo}/pulls/${prNumber}/files`, { perPage: 100, maxItems: 100 });
	return {
		bodyExcerpt: String(pr?.body ?? "").slice(0, DETAIL_BODY_CHARS),
		baseRef: String(pr?.base?.ref ?? ""),
		headRef: String(pr?.head?.ref ?? ""),
		changedFiles: typeof pr?.changed_files === "number" ? pr.changed_files : filesPage.items.length,
		additions: typeof pr?.additions === "number" ? pr.additions : 0,
		deletions: typeof pr?.deletions === "number" ? pr.deletions : 0,
		files: filesPage.items
			.slice(0, DETAIL_FILES_CAP)
			.map((f: any) => ({
				filename: String(f?.filename ?? ""),
				additions: typeof f?.additions === "number" ? f.additions : 0,
				deletions: typeof f?.deletions === "number" ? f.deletions : 0,
			})),
		reviewers: latestReviewStances(reviews, headSha),
	};
}

// ---- 扫描前对账（R5）：把已失效的 open/approved Finding 自动退役为 expired ----
// PR 类：已 merged/closed、变 draft、或按锁定语义已算当前已批准 → 退役；
// CI 类：同工作流最新已结束 run 已转绿（ci_green）或已被一条更新的失败 run 取代
//（ci_superseded，新 run 由本轮规则另开）→ 退役。取证不足（PR 单查失败、工作流
// 无法确认）时不退役，宁可多留一轮等人处理。退役一律写审计 reason=reconciled:<原因>。
function ciRetireCause(f: Finding, data: RepoData): string | null {
	const mine = data.runs.find((r) => String(r.id) === f.subject);
	const workflow = f.workflow ?? mine?.name ?? null;
	if (!workflow) return null;
	const latestCompleted = data.runs.filter((r) => r.name === workflow && r.head_branch === data.branch && r.status === "completed")[0];
	if (!latestCompleted || String(latestCompleted.id) === f.subject) return null;
	if (latestCompleted.conclusion === "success") return "ci_green";
	if (latestCompleted.conclusion === "failure") return "ci_superseded";
	return null;
}

// 对账退役原因（纯计算，只读已取证数据，不发请求、不落盘）：
// prDetails 是阶段一为不在 open 列表里的候选 PR 单查的结果（null = 单查失败，取证不足不退役）；
// reviewsOf(num) 返回阶段一已取齐的审查（未取到返回 undefined，取证不足不退役）。
function prRetireCause(f: Finding, data: RepoData, prDetails: Map<number, any>, reviewsOf: (num: number) => any): string | null {
	const num = Number(f.subject);
	let pr = data.pulls.find((p) => p.number === num) ?? null;
	if (!pr) {
		pr = prDetails.get(num) ?? null;
		if (!pr) return null;
		if (pr.state === "closed") return pr.merged_at ? "pr_merged" : "pr_closed";
	}
	if (pr.draft) return "pr_draft";
	const reviews = reviewsOf(num);
	if (reviews && evaluateReviews(reviews, pr.head?.sha).approved) return "pr_approved";
	return null;
}

// Issue 的标签名归一：接口给 [{ name }] 或字符串数组都认。
export function issueLabels(issue: any): string[] {
	if (!Array.isArray(issue?.labels)) return [];
	return issue.labels.map((l: any) => (typeof l === "string" ? l : String(l?.name ?? ""))).filter(Boolean);
}

// 「已有人分诊」判定（规则三与对账共用同一口径）：有评论、或有标签、或有认领人，
// 任一成立即已分诊。字段缺失按未分诊处理（与取证缺 head 同口径：不误判已分诊）。
export function issueTouched(issue: any): boolean {
	return (
		(typeof issue?.comments === "number" && issue.comments > 0) ||
		issueLabels(issue).length > 0 ||
		(Array.isArray(issue?.assignees) && issue.assignees.length > 0)
	);
}

function issueRetireCause(f: Finding, data: RepoData, issueDetails: Map<number, any>): string | null {
	const num = Number(f.subject);
	const inList = data.issues.find((i) => i.number === num);
	if (inList) return issueTouched(inList) ? "issue_triaged" : null;
	const one = issueDetails.get(num) ?? null;
	if (!one) return null;
	if (one.state === "closed") return "issue_closed";
	return issueTouched(one) ? "issue_triaged" : null;
}

// Issue 开单的年龄门：刚提的 Issue 给维护者留 48 小时自然处理窗口，过了才进拍板清单。
const ISSUE_TRIAGE_MIN_AGE_MS = 48 * 3600 * 1000;

// 对一个仓库取证并按规则开 Finding。三阶段（R6，半成品不落盘）：
//   阶段一 取证：仓数据、对账候选 PR 的单查、全部相关 PR 的审查，全部先取齐；
//     本阶段任何失败都抛错，由上层记入日报并计 failures，本仓不落任何盘。
//   阶段二 计算：纯计算对账退役清单与待开 Finding（去重仍读存储现状；退役原因与
//     开单规则互斥——会退役的项本轮必然不会再被规则开出，见各 retire cause 与规则
//     的对应关系，所以不需假设退役已落盘）。
//   阶段三 落盘：先落对账退役（转 expired + 审计），再落新开 Finding。
async function scanRepo(repo: string, botId: string, now: Date): Promise<{ data: RepoData; created: Finding[]; reconciled: ReconciledItem[] }> {
	// ---- 阶段一：取证 ----
	const data = await fetchRepoData(repo);
	const notes = data.notes;
	// 取证缺 head 的 PR（pulls 条目无 head.sha）：陈旧批准无从判定、去重头部比较也
	// 无从比对，统一按「头部未变」处理（F5 末段，审计已同意保留）——日报写明，不许静默。
	for (const p of data.pulls) {
		if (!p.draft && !p.head?.sha) {
			notes.push(`PR #${p.number} 取证缺 head（head.sha 缺失），按头部未变处理：不判陈旧批准，去重冷却按未变`);
		}
	}
	// 审查结果在对账与规则之间共用一轮取证，避免同一 PR 重复拉 reviews。
	const reviewsCache = new Map<number, any[]>();
	const fetchReviewsCached = async (prNumber: number): Promise<any[]> => {
		if (!reviewsCache.has(prNumber)) {
			const { reviews, truncated } = await fetchReviews(repo, prNumber);
			if (truncated) notes.push(`PR #${prNumber} 的审查超过检查上限，仅检查前 ${PAGE_CAPS.reviews.maxItems} 条`);
			reviewsCache.set(prNumber, reviews);
		}
		// 上面的 has/set 保证此处必有值（单线程顺序执行，无并发写入）。
		return reviewsCache.get(prNumber) as any[];
	};
	const candidates = listFindings({ repo }).filter((f) => f.status === "open" || f.status === "approved");
	// 对账候选 PR 不在 open 列表时先单查取证（已合并/关闭的 PR 不在 open 列表里）。
	const prDetails = new Map<number, any>();
	for (const f of candidates) {
		if (f.type !== "pr_needs_review") continue;
		const num = Number(f.subject);
		if (data.pulls.some((p) => p.number === num)) continue;
		try {
			prDetails.set(num, await gh(`/repos/${repo}/pulls/${num}`));
		} catch {
			prDetails.set(num, null);
		}
	}
	// 候选 PR 若仍 open，其审查也在本阶段取齐（失败即整仓失败，不留半截）。
	for (const f of candidates) {
		if (f.type !== "pr_needs_review") continue;
		const num = Number(f.subject);
		const pr = data.pulls.find((p) => p.number === num) ?? prDetails.get(num);
		if (pr && pr.state !== "closed" && !pr.draft) await fetchReviewsCached(num);
	}
	// 对账候选 Issue 不在 open 列表时单查取证（已关闭的 Issue 不在 open 列表里）。
	const issueDetails = new Map<number, any>();
	for (const f of candidates) {
		if (f.type !== "issue_untriaged") continue;
		const num = Number(f.subject);
		if (data.issues.some((i) => i.number === num)) continue;
		try {
			issueDetails.set(num, await gh(`/repos/${repo}/issues/${num}`));
		} catch {
			issueDetails.set(num, null);
		}
	}
	// 规则要看的审查全部取齐。draft 不取审查、直接跳过（也不产生 Finding）。
	for (const p of data.pulls) {
		if (!p.draft) await fetchReviewsCached(p.number);
	}

	// ---- 阶段二：计算 ----
	const retirePlan: Array<{ finding: Finding; cause: string }> = [];
	for (const f of candidates) {
		const cause =
			f.type === "pr_needs_review"
				? prRetireCause(f, data, prDetails, (num) => reviewsCache.get(num))
				: f.type === "issue_untriaged"
					? issueRetireCause(f, data, issueDetails)
					: ciRetireCause(f, data);
		if (cause) retirePlan.push({ finding: f, cause });
	}
	const createPlan: FindingInput[] = [];

	// 规则一：ci_failed（R6：按工作流分别取最新）。runs 已按创建时间倒序；除 API 的
	// branch 参数外，客户端再按 head_branch 与 status=completed 过滤一层；同一工作流
	// 第一条命中的已结束 run 即该工作流的最新一条。只认 conclusion==="failure"，
	// cancelled/timed_out/startup_failure 不报，也绝不回溯更早的 failure。
	const latestByWorkflow = new Map<string, any>();
	for (const r of data.runs) {
		if (r.head_branch !== data.branch || r.status !== "completed") continue;
		const workflow = r.name ?? "(未命名工作流)";
		if (!latestByWorkflow.has(workflow)) latestByWorkflow.set(workflow, r);
	}
	for (const run of latestByWorkflow.values()) {
		if (run.conclusion !== "failure") continue;
		const subject = String(run.id);
		if (findBlockingFinding(repo, "ci_failed", subject, { headSha: run.head_sha ?? null, now })) continue;
		createPlan.push({
			repo,
			type: "ci_failed",
			subject,
			botId,
			title: `CI 失败：${run.name ?? run.display_title ?? "workflow"}（${repo}）`,
			summary: `默认分支 ${data.branch} 上「${run.name ?? "workflow"}」工作流最近一次已结束的 run（${fmtDate(run.created_at)} 创建）结论为 failure。`,
			evidenceUrl: run.html_url,
			suggestedAction: "请查看该 run 的失败日志，决定是直接修复，还是在相关 PR 下留言跟进。",
			expiresAt: expiresAtFrom(now),
			headSha: run.head_sha ?? null,
			workflow: run.name ?? null,
		});
	}

	// 规则二：pr_needs_review。附带 writeIntent：建议的写动作是「在该 PR 下发一条
	// 规则模板评论」——只是待批参数，扫描本身不发送；人在收件箱批准后由网关
	//（P1-6）执行，批不批由人决定。
	for (const p of data.pulls) {
		if (p.draft) continue;
		const headSha = p.head?.sha ?? null;
		const reviews = reviewsCache.get(p.number) ?? [];
		if (!prNeedsReview(reviews, headSha)) continue;
		const subject = String(p.number);
		if (findBlockingFinding(repo, "pr_needs_review", subject, { headSha, now })) continue;
		createPlan.push({
			repo,
			type: "pr_needs_review",
			subject,
			botId,
			title: `PR 待审查：#${p.number} ${p.title}（${repo}）`,
			summary: `PR #${p.number} 由 ${p.user?.login ?? "?"} 于 ${fmtDate(p.created_at)} 打开，按每位审查人最新一条审查判定仍未获得批准。`,
			evidenceUrl: p.html_url,
			suggestedAction: "请审查该 PR 并给出结论，或批准收件箱里的模板评论由网关发到 PR 下跟进。",
			writeIntent: {
				kind: "pr_comment",
				prNumber: p.number,
				body: `晨间分诊提醒：这个 PR 尚未获得任何批准（APPROVED）审查，请维护者抽空审查并给出结论。\n\n（由 Piper 仓库管家在晨间扫描中生成，经人工批准后由网关发送。）`,
			},
			expiresAt: expiresAtFrom(now),
			headSha,
		});
	}

	// 规则三：issue_untriaged。附带 writeIntent 是分诊评论模板（先回应作者、告知
	// 已进入分诊），同样只是待批参数，批准后才由网关发送。Issue 没有 head，
	// 去重头部恒为 null（驳回后按 14 天冷却，见 findings.findBlockingFinding）。
	for (const issue of data.issues) {
		const createdMs = Date.parse(issue.created_at ?? "");
		if (!Number.isFinite(createdMs) || now.getTime() - createdMs < ISSUE_TRIAGE_MIN_AGE_MS) continue;
		if (issueTouched(issue)) continue;
		const subject = String(issue.number);
		if (findBlockingFinding(repo, "issue_untriaged", subject, { headSha: null, now })) continue;
		const ageDays = Math.floor((now.getTime() - createdMs) / 86400000);
		createPlan.push({
			repo,
			type: "issue_untriaged",
			subject,
			botId,
			title: `Issue 待分诊：#${issue.number} ${issue.title}（${repo}）`,
			summary: `Issue #${issue.number} 由 ${issue.user?.login ?? "?"} 于 ${fmtDate(issue.created_at)} 打开，已 ${ageDays} 天无人评论、无标签、无认领人。`,
			evidenceUrl: issue.html_url,
			suggestedAction: "请分诊该 Issue：补充标签或指认领人，或批准收件箱里的分诊评论先回应作者。",
			writeIntent: {
				kind: "issue_comment",
				issueNumber: issue.number,
				body: `分诊提醒：这个 Issue 已打开 ${ageDays} 天，尚无人回应。维护者会尽快完成分诊（补充标签 / 指认领人）；作者如有更多复现信息，欢迎补充在下面。\n\n（由 Piper 仓库管家在晨间扫描中生成，经人工批准后由网关发送。）`,
			},
			issueDetail: {
				bodyExcerpt: String(issue.body ?? "").slice(0, DETAIL_BODY_CHARS),
				labels: issueLabels(issue),
				assignees: (Array.isArray(issue.assignees) ? issue.assignees : []).map((a: any) => String(a?.login ?? "")).filter(Boolean),
				commentCount: typeof issue.comments === "number" ? issue.comments : 0,
				authorLogin: issue.user?.login ?? "",
			},
			expiresAt: expiresAtFrom(now),
			headSha: null,
		});
	}

	// ---- 阶段二·五：拍板详情取证（只给本轮真要新开的 pr_needs_review 项拉详情；
	// 失败降级为无详情 + 日报注明，不整仓失败——详情不是规则输入，见 fetchPrDetail） ----
	for (const entry of createPlan) {
		if (entry.type !== "pr_needs_review") continue;
		const num = Number(entry.subject);
		try {
			entry.detail = await fetchPrDetail(repo, num, reviewsCache.get(num) ?? [], typeof entry.headSha === "string" ? entry.headSha : null);
		} catch {
			notes.push(`PR #${num} 拍板详情取证失败，事项照常开出但无详情（可点证据链接到 GitHub 查看）`);
		}
	}

	// ---- 阶段三：落盘（先对账退役，再开新） ----
	const reconciled: ReconciledItem[] = [];
	for (const { finding: f, cause } of retirePlan) {
		updateFinding(f.id, { status: "expired" });
		appendAudit({
			botId: f.botId,
			intent: f.writeIntent ? { ...f.writeIntent, repo: f.repo } : null,
			result: "expired",
			reason: `reconciled:${cause}`,
			findingId: f.id,
		});
		reconciled.push({ id: f.id, repo: f.repo, type: f.type, subject: f.subject, cause });
	}
	const created = createPlan.map((fields) => createFinding(fields));

	return { data, created, reconciled };
}

// 即席开单（切片二）：用户在收件箱指定「仓库 + PR 号」即时开一条 pr_needs_review
// 事项，不必等下一轮扫描。判定与扫描规则二同一套：PR 必须 open、非 draft、按
// 锁定语义仍待审；已合并/已关闭/draft/已批准回结构化 refusal（路由转人话）；
// 已有未关闭的同键事项或仍在冷却期的已关闭事项时返回既有项，不另开一条。
// 评论正文先给模板，用户可在批准前改（approvals.editApprovalBody），批准后
// 仍走同一网关——即席只改「事项从哪来」，不改「写要过闸」。
export interface AdHocResult {
	created: Finding | null;
	existing: Finding | null;
	refusal: "pr_merged" | "pr_closed" | "pr_draft" | "pr_approved" | null;
}

export async function createAdHocReviewFinding({ repo, prNumber, botId }: { repo: string; prNumber: number; botId: string }): Promise<AdHocResult> {
	const now = new Date();
	const pr = await gh(`/repos/${repo}/pulls/${prNumber}`);
	if (pr.state !== "open") return { created: null, existing: null, refusal: pr.merged_at ? "pr_merged" : "pr_closed" };
	if (pr.draft) return { created: null, existing: null, refusal: "pr_draft" };
	const { reviews } = await fetchReviews(repo, prNumber);
	const headSha: string | null = pr.head?.sha ?? null;
	if (evaluateReviews(reviews, headSha).approved) return { created: null, existing: null, refusal: "pr_approved" };
	const blocking = findBlockingFinding(repo, "pr_needs_review", prNumber, { headSha, now });
	if (blocking) return { created: null, existing: blocking, refusal: null };
	let detail: FindingDetail | null = null;
	try {
		detail = await fetchPrDetail(repo, prNumber, reviews, headSha);
	} catch {
		detail = null;
	}
	const created = createFinding({
		repo,
		type: "pr_needs_review",
		subject: String(prNumber),
		botId,
		title: `PR 待审查：#${prNumber} ${pr.title}（${repo}）`,
		summary: `PR #${prNumber} 由 ${pr.user?.login ?? "?"} 于 ${fmtDate(pr.created_at)} 打开，按每位审查人最新一条审查判定仍未获得批准。（即席开单：由你在收件箱手动指定）`,
		evidenceUrl: pr.html_url,
		suggestedAction: "请审查该 PR 并给出结论，或在下方把评论正文改成你想说的话，批准后由网关发到 PR 下。",
		writeIntent: {
			kind: "pr_comment",
			prNumber,
			body: `分诊提醒：这个 PR 尚未获得任何批准（APPROVED）审查，请维护者抽空审查并给出结论。\n\n（由 Piper 仓库管家按你的即席请求生成，经你批准后由网关发送。）`,
		},
		detail,
		expiresAt: expiresAtFrom(now),
		headSha,
	});
	return { created, existing: null, refusal: null };
}

// 「其余观察」：统计与列表只进这里，不进拍板清单。
function observationLines(repo: string, data: RepoData): string {
	const lines: string[] = [];
	lines.push(`### ${repo}`);
	lines.push("");
	lines.push(
		`- 概况：⭐ ${data.info.stargazers_count} · Fork ${data.info.forks_count} · 默认分支 ${data.branch} · 最近推送 ${fmtDate(data.info.pushed_at)}`,
	);
	lines.push(`- 待处理：PR ${data.pulls.length} 个 · Issue ${data.issues.length} 个`);
	// runs 接口失败必须可见，不许静默装作「没有 CI」（R6）。
	if (data.ciMissing != null) lines.push(`- CI 数据缺失：${data.ciMissing}`);
	for (const note of data.notes ?? []) lines.push(`- 提示：${note}`);
	lines.push("");
	lines.push("最近提交：");
	for (const c of data.commits.slice(0, 5)) {
		lines.push(`- ${fmtDate(c.commit?.author?.date)} ${String(c.commit?.message ?? "").split("\n")[0]}（${c.author?.login ?? c.commit?.author?.name ?? "?"}）`);
	}
	if (data.pulls.length) {
		lines.push("");
		lines.push("待处理 PR：");
		for (const p of data.pulls.slice(0, 5)) lines.push(`- #${p.number} ${p.title}（${p.user?.login ?? "?"}，${fmtDate(p.created_at)}${p.draft ? "，draft" : ""}）`);
	}
	if (data.issues.length) {
		lines.push("");
		lines.push("待处理 Issue：");
		for (const i of data.issues.slice(0, 5)) lines.push(`- #${i.number} ${i.title}（${i.user?.login ?? "?"}，${fmtDate(i.created_at)}）`);
	}
	if (data.runs.length) {
		lines.push("");
		lines.push("最近 CI：");
		for (const r of data.runs.slice(0, 5)) {
			lines.push(`- ${fmtDate(r.created_at)} ${r.name ?? r.display_title}：${r.status}${r.conclusion ? ` / ${r.conclusion}` : ""}`);
		}
	}
	lines.push("");
	return lines.join("\n");
}

// 返回 { artifact, report, failures, total, findings, reconciled }：
// findings 为本轮新开的 Finding（已落盘）；reconciled 为本轮对账退役的失效项
//（{ id, repo, type, subject, cause }）；failures 是取证失败的仓库数，total 为仓库总数。
export async function runMorningScan({
	repos,
	botId,
	saveArtifact,
}: {
	repos: string[];
	botId: string;
	saveArtifact: (input: { botId: string; kind: string; title?: unknown; body?: unknown }) => ArtifactMeta;
}): Promise<{ artifact: ArtifactMeta; report: string; failures: number; total: number; findings: Finding[]; reconciled: ReconciledItem[] }> {
	const now = new Date();
	const dateStr = now.toISOString().slice(0, 10);
	const createdAll: Finding[] = [];
	const reconciledAll: ReconciledItem[] = [];
	const observations: string[] = [];
	let failures = 0;
	for (const repo of repos) {
		try {
			const { data, created, reconciled } = await scanRepo(repo, botId, now);
			createdAll.push(...created);
			reconciledAll.push(...reconciled);
			observations.push(observationLines(repo, data));
		} catch (err) {
			failures += 1;
			observations.push(`### ${repo}\n\n- 扫描失败：${(err as Error).message}\n`);
		}
	}

	const parts = [
		`# 晨间仓库日报 ${dateStr}`,
		"",
		`扫描时间：${now.toISOString()} · 仓库数：${repos.length}`,
		"",
		"## 拍板清单",
		"",
	];
	if (createdAll.length) {
		parts.push(`本轮新开 ${createdAll.length} 条需要拍板的事项：`, "");
		const TYPE_LABELS: Record<string, string> = { ci_failed: "CI 失败", pr_needs_review: "PR 待审查", issue_untriaged: "Issue 待分诊" };
		for (const f of createdAll) {
			parts.push(`- [${TYPE_LABELS[f.type] ?? f.type}] ${f.title}`);
			parts.push(`  - 证据：${f.evidenceUrl}`);
			parts.push(`  - 建议：${f.suggestedAction}`);
		}
	} else {
		parts.push("本轮没有需要拍板的事项。");
	}
	if (reconciledAll.length) {
		parts.push("", `对账：本轮 ${reconciledAll.length} 条已失效事项自动退役（转 expired，原因见审计 reconciled:*）。`);
	}
	parts.push("", "## 其余观察", "", observations.join("\n"));

	const body = parts.join("\n");
	const artifact = saveArtifact({ botId, kind: "morning-scan", title: `晨间仓库日报 ${dateStr}`, body });
	return { artifact, report: body, failures, total: repos.length, findings: createdAll, reconciled: reconciledAll };
}
