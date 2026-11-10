// 晨间仓库扫描 routine（P1-2）：只读拉 GitHub REST API 取证，主产物是拍板清单（Finding），
// 统计信息只进日报的「其余观察」，不再冒充主结果。
// 进入拍板清单的规则是程序化的（本批就这两条，不要临时扩种类）：
//   ci_failed：默认分支上最近一次已结束（status=completed）的 workflow run 结论为 failure；
//   pr_needs_review：open、非 draft、且按「已批准」锁定语义（lib/pr-review.mjs：每位审查人
//   最新一条为准、陈旧批准不算数）仍待审的 PR。
// 去重（R5，口径已锁定）：键 repo+type+subject，按状态冷却——open/approved/executing
// 不得另开；rejected 头部未变且未满 14 天不重开；executed 仅头部变化可重开；expired 可重开
//（实现在 findings.findBlockingFinding）。头部取 PR 的 head.sha / run 的 head_sha，开单时
// 存进 Finding.headSha 作下轮比较基准。
// 扫描前对账（R5）：每仓先复核既有 open/approved Finding——PR 已合并/关闭/draft/已批准、
// 或同工作流 CI 已转绿/已被新失败 run 取代的，自动转 expired 并写审计 reconciled:<原因>，
// 退出待批。建议先用规则模板，不上模型润色，
// 模型不得发明 GitHub 上不存在的 PR 或 CI（后续步骤若引入模型写建议，同样受此约束）。
// 令牌经 lib/settings.mjs 的 githubToken() 统一读取（L0-4：设置文件优先、环境变量兜底），
// 本文件不直读令牌环境变量；无令牌走公开限额。API 基址缺省 https://api.github.com，
// 可用 PIPER_GITHUB_API_BASE 覆盖（R4：回归用本地 GitHub 桩，全程离线、结果确定）。
// 单仓失败不中断整体，失败原因写进日报；
// 全部仓库失败时由调用方判定整轮失败（L0-5 语义，本文件只回 failures/total）。
// 本文件全程只读，绝不调用任何 GitHub 写接口：pr_needs_review 附带的 writeIntent 只是
// 「建议的写动作」（规则模板正文，P1-6），要等人在收件箱批准后才经网关真正发送。
import { githubToken } from "./settings.mjs";
import { createFinding, findBlockingFinding, listFindings, updateFinding } from "./findings.mjs";
import { evaluateReviews, prNeedsReview } from "./pr-review.mjs";
import { appendAudit } from "./audit.mjs";

function ghBase() {
	return (process.env.PIPER_GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, "");
}

async function gh(path) {
	const headers = { Accept: "application/vnd.github+json", "User-Agent": "piper-morning-scan" };
	const token = githubToken();
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(`${ghBase()}${path}`, { headers });
	if (!res.ok) throw new Error(`GitHub API ${res.status} ${path}`);
	return res.json();
}

function fmtDate(iso) {
	return iso ? String(iso).slice(0, 10) : "-";
}

// Finding 过期时间：7 天后过期，避免清单腐烂（总图 4.2）。状态迁移（过期清理）在后续切片。
const FINDING_TTL_DAYS = 7;

function expiresAtFrom(now) {
	return new Date(now.getTime() + FINDING_TTL_DAYS * 24 * 3600 * 1000).toISOString();
}

async function fetchRepoData(repo) {
	const info = await gh(`/repos/${repo}`);
	const branch = info.default_branch;
	const [commits, pulls, issues, runs] = await Promise.all([
		gh(`/repos/${repo}/commits?per_page=5`),
		gh(`/repos/${repo}/pulls?state=open&per_page=10`),
		gh(`/repos/${repo}/issues?state=open&per_page=10`),
		// Actions 未启用等情况下 runs 接口报错不应拖垮整仓取证，降级为「无 CI 数据」
		gh(`/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=10`).catch(() => ({ workflow_runs: [] })),
	]);
	return {
		info,
		branch,
		commits: commits ?? [],
		pulls: pulls ?? [],
		issues: (issues ?? []).filter((i) => !i.pull_request),
		runs: runs?.workflow_runs ?? [],
	};
}

async function fetchReviews(repo, prNumber) {
	return (await gh(`/repos/${repo}/pulls/${prNumber}/reviews?per_page=100`)) ?? [];
}

// ---- 扫描前对账（R5）：把已失效的 open/approved Finding 自动退役为 expired ----
// PR 类：已 merged/closed、变 draft、或按锁定语义已算当前已批准 → 退役；
// CI 类：同工作流最新已结束 run 已转绿（ci_green）或已被一条更新的失败 run 取代
//（ci_superseded，新 run 由本轮规则另开）→ 退役。取证不足（PR 单查失败、工作流
// 无法确认）时不退役，宁可多留一轮等人处理。退役一律写审计 reason=reconciled:<原因>。
function ciRetireCause(f, data) {
	const mine = data.runs.find((r) => String(r.id) === f.subject);
	const workflow = f.workflow ?? mine?.name ?? null;
	if (!workflow) return null;
	const latestCompleted = data.runs.filter((r) => r.name === workflow && r.head_branch === data.branch && r.status === "completed")[0];
	if (!latestCompleted || String(latestCompleted.id) === f.subject) return null;
	if (latestCompleted.conclusion === "success") return "ci_green";
	if (latestCompleted.conclusion === "failure") return "ci_superseded";
	return null;
}

async function prRetireCause(repo, f, data, fetchReviewsCached) {
	const num = Number(f.subject);
	let pr = data.pulls.find((p) => p.number === num) ?? null;
	if (!pr) {
		try {
			pr = await gh(`/repos/${repo}/pulls/${num}`);
		} catch {
			return null;
		}
		if (pr.state === "closed") return pr.merged_at ? "pr_merged" : "pr_closed";
	}
	if (pr.draft) return "pr_draft";
	const reviews = await fetchReviewsCached(num);
	if (evaluateReviews(reviews, pr.head?.sha).approved) return "pr_approved";
	return null;
}

async function reconcileRepo(repo, data, fetchReviewsCached) {
	const reconciled = [];
	const candidates = listFindings({ repo }).filter((f) => f.status === "open" || f.status === "approved");
	for (const f of candidates) {
		const cause = f.type === "pr_needs_review" ? await prRetireCause(repo, f, data, fetchReviewsCached) : ciRetireCause(f, data);
		if (!cause) continue;
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
	return reconciled;
}

// 对一个仓库取证并按规则开 Finding（落盘）。取证失败抛错，由上层记入日报并计 failures。
async function scanRepo(repo, botId, now) {
	const data = await fetchRepoData(repo);
	// 审查结果在对账与规则之间共用一轮取证，避免同一 PR 重复拉 reviews。
	const reviewsCache = new Map();
	const fetchReviewsCached = async (prNumber) => {
		if (!reviewsCache.has(prNumber)) reviewsCache.set(prNumber, await fetchReviews(repo, prNumber));
		return reviewsCache.get(prNumber);
	};
	// 先对账再开新：失效的旧项退役后不占去重名额，本轮报告也只讲还活着的事。
	const reconciled = await reconcileRepo(repo, data, fetchReviewsCached);
	const created = [];

	// 规则一：ci_failed。runs 已按创建时间倒序；除 API 的 branch 参数外，客户端再按
	// head_branch 与 status=completed 过滤一层，保证「最近一次已结束」取的是默认分支的 run。
	const latestCompleted = data.runs.filter((r) => r.head_branch === data.branch && r.status === "completed")[0];
	if (latestCompleted && latestCompleted.conclusion === "failure") {
		const subject = String(latestCompleted.id);
		if (!findBlockingFinding(repo, "ci_failed", subject, { headSha: latestCompleted.head_sha ?? null, now })) {
			created.push(
				createFinding({
					repo,
					type: "ci_failed",
					subject,
					botId,
					title: `CI 失败：${latestCompleted.name ?? latestCompleted.display_title ?? "workflow"}（${repo}）`,
					summary: `默认分支 ${data.branch} 最近一次已结束的 workflow run（${fmtDate(latestCompleted.created_at)} 创建）结论为 failure。`,
					evidenceUrl: latestCompleted.html_url,
					suggestedAction: "请查看该 run 的失败日志，决定是直接修复，还是在相关 PR 下留言跟进。",
					expiresAt: expiresAtFrom(now),
					headSha: latestCompleted.head_sha ?? null,
					workflow: latestCompleted.name ?? null,
				}),
			);
		}
	}

	// 规则二：pr_needs_review。draft 不取审查、直接跳过（也不产生 Finding）。
	// 附带 writeIntent：建议的写动作是「在该 PR 下发一条规则模板评论」——只是待批参数，
	// 扫描本身不发送；人在收件箱批准后由网关（P1-6）执行，批不批由人决定。
	for (const p of data.pulls) {
		if (p.draft) continue;
		const headSha = p.head?.sha ?? null;
		const reviews = await fetchReviewsCached(p.number);
		if (!prNeedsReview(reviews, headSha)) continue;
		const subject = String(p.number);
		if (findBlockingFinding(repo, "pr_needs_review", subject, { headSha, now })) continue;
		created.push(
			createFinding({
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
			}),
		);
	}

	return { data, created, reconciled };
}

// 「其余观察」：统计与列表只进这里，不进拍板清单。
function observationLines(repo, data) {
	const lines = [];
	lines.push(`### ${repo}`);
	lines.push("");
	lines.push(
		`- 概况：⭐ ${data.info.stargazers_count} · Fork ${data.info.forks_count} · 默认分支 ${data.branch} · 最近推送 ${fmtDate(data.info.pushed_at)}`,
	);
	lines.push(`- 待处理：PR ${data.pulls.length} 个 · Issue ${data.issues.length} 个`);
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
export async function runMorningScan({ repos, botId, saveArtifact }) {
	const now = new Date();
	const dateStr = now.toISOString().slice(0, 10);
	const createdAll = [];
	const reconciledAll = [];
	const observations = [];
	let failures = 0;
	for (const repo of repos) {
		try {
			const { data, created, reconciled } = await scanRepo(repo, botId, now);
			createdAll.push(...created);
			reconciledAll.push(...reconciled);
			observations.push(observationLines(repo, data));
		} catch (err) {
			failures += 1;
			observations.push(`### ${repo}\n\n- 扫描失败：${err.message}\n`);
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
		for (const f of createdAll) {
			parts.push(`- [${f.type === "ci_failed" ? "CI 失败" : "PR 待审查"}] ${f.title}`);
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
