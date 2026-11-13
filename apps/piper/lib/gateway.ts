// 薄网关（P1-6 + R1 返工）：apps/piper 层所有对外写副作用的唯一入口。默认拒绝，放行
// 两种写意图：pr_comment（给指定 PR 发评论）与 issue_comment（给指定 Issue 发评论，
// Issue 分诊起）——两者共用同一套快照/幂等/审计机制，分发只在执行前复检处分叉
// （PR 查状态+审查前提；Issue 查状态+「仍无人回应」前提）。通用形状：网关只认
// 「批准记录 + 关联 Finding」，不认调用方是谁——扫描与对话层没有任何直达 GitHub
// 写接口的路径（绕过断言在 scripts/test-gateway.ts 里以源码检索钉死）。
// R1 起网关只执行批准时刻的意图快照（approvals 的批准记录），不执行 Finding 里现存的
// writeIntent 本身：执行前拿快照与当前 writeIntent 逐字比对，不一致 denied/intent_changed，
// 批准之后被改过的内容发不出去。
// 放行条件（领取执行前的同步复检，任一不满足即拒绝并写审计，绝不调用写 API）：
//   1. Finding 存在，且带批准记录 id 与意图快照；
//   2. 快照恰好等于 Finding 当前 writeIntent（kind / repo / 编号 / body 逐字一致）；
//   3. 意图种类是 pr_comment 或 issue_comment；
//   4. 目标仓库在该 Finding 所属 bot 的绑定仓内；
//   5. Finding 已被批准（status=approved）——未经批准的直调一律拒绝；已在 executing
//      说明有另一路正在执行，拒绝防并发双发；
//   6. Finding 未过期（过期则顺手转 expired）；
//   7. 评论正文不含任何已知秘密或令牌形状（统一 redact 口径：当前/历史令牌、
//      模型 Key、前缀模式，见 lib/redact.ts；R7 前只查当前 GitHub 令牌）；
//   8. 有令牌（无令牌 failed/no_token，明确失败不假成功）。
// 领取与执行（领取 = approved→executing 的同步段，单进程内即互斥）：
//   - 领取后先写一条审计 executing，再做网络调用——进程崩溃后能看到「发到一半」；
//   - 执行前现查目标 PR 仍为 open，否则 failed/pr_not_open，退回 approved 可重试；
//     issue_comment 同理查 Issue 仍 open（failed/issue_not_open），且评论查重时
//     发现除本批准标记外已有任何评论 → 已有人分诊，failed/precondition_changed；
//   - 再复检触发规则前提（R5）：PR 非 draft、且按与扫描同一套「已批准」判定
//     （lib/pr-review.ts）仍待审——批准后 PR 已被批准的，不再发过时催办评论，
//     failed/precondition_changed 退回 approved；复检取证失败同样退回，不误发；
//   - 发评论前先查该 PR 已有评论里是否带本批准的幂等标记
//     <!-- piper:approval=<approvalId> -->，有则复用该评论记 executed，不再 POST；
//     查重必须翻页取尽（F2，第二轮返工）：per_page=100、上限 10 页——只看第一页
//     会漏掉靠后页的标记而重复发评论；到上限仍没取尽且没找到标记时不发，
//     failed/comments_check_incomplete 退回 approved（宁可不发，不能冒险双发）；
//   - POST 的正文 = 快照正文 + 幂等标记；成功写审计 executed（带评论 URL）、Finding 转 executed；
//   - 任一网络步失败：Finding 从 executing 退回 approved、写审计 failed，错误可见可重试。
// 凭证只经 lib/settings.ts 的 githubToken() 读取，本文件不直读环境变量与设置文件。
import { githubToken } from "./settings.ts";
import { containsSecret, redact } from "./redact.ts";
import { getBot } from "./store.ts";
import { getFinding, updateFinding } from "./findings.ts";
import type { Finding } from "./findings.ts";
import { appendAudit } from "./audit.ts";
import { evaluateReviews } from "./pr-review.ts";
import { ghPage, PAGE_CAPS } from "./scan.ts";
import { getToolApproval, toolIntentSnapshotOf, updateToolApproval } from "./tool-approvals.ts";
import type { ToolApproval } from "./tool-approvals.ts";

// 批准记录里的意图快照形状（属主在 lib/approvals.ts 的 intentSnapshotOf，
// 网关执行前与 Finding 当前 writeIntent 逐字比对，用的是同一份形状）。
export interface IntentSnapshot {
	kind: string;
	repo: string;
	prNumber: number | null;
	issueNumber: number | null;
	body: string;
}

export interface GatewayResult {
	ok: boolean;
	result: "denied" | "failed" | "executed";
	reason?: string;
	commentUrl?: string | null;
	reused?: boolean;
	finding?: Finding | null;
	toolApproval?: ToolApproval | null;
}

// GitHub API 基址：缺省官方；可用 PIPER_GITHUB_API_BASE 覆盖（R4：回归/测试指向本地桩）。
function ghBase(): string {
	return (process.env.PIPER_GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, "");
}

// GitHub API 响应是外部边界：返回 any，由消费点逐字段取用（同 lib/scan.ts 口径）。
// 失败时尽量带回 GitHub 自己的错误 message（切片三）：fine-grained PAT 权限不足
// 的 403 只看状态码完全无从排障，message 里写着原因（如 Resource not accessible
// by personal access token）。message 是外部文本：截断到 200 字防审计/通知被灌爆，
// 并先经 redact 抹掉任何令牌形状的子串才拼进错误，不带凭据出门。
async function ghJson(path: string, { method = "GET", token, body }: { method?: string; token?: string; body?: unknown } = {}): Promise<any> {
	const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "piper-gateway" };
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(`${ghBase()}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!res.ok) {
		let detail = "";
		try {
			const j: any = await res.json();
			if (typeof j?.message === "string" && j.message) detail = `：${redact(j.message.slice(0, 200))}`;
		} catch {
			// 响应体不是 JSON 就只报状态码，不因解析失败掩盖原始错误
		}
		throw Object.assign(new Error(`GitHub API ${res.status} ${method} ${path}${detail}`), { status: res.status });
	}
	return res.json();
}

// 评论查重翻页（F2）：per_page=100 逐页取，直到某页不满 100 为止；最多取
// COMMENTS_CHECK_MAX_PAGES 页。complete=false 表示到上限仍可能没取尽——调用方
// 在没找到标记时不得发评论（无法证明「没发过」）。
const COMMENTS_CHECK_PER_PAGE = 100;
const COMMENTS_CHECK_MAX_PAGES = 10;

async function fetchCommentsForCheck(repo: string, prNumber: number, token: string): Promise<{ comments: any[]; complete: boolean }> {
	const comments: any[] = [];
	for (let page = 1; page <= COMMENTS_CHECK_MAX_PAGES; page += 1) {
		const batch = await ghJson(`/repos/${repo}/issues/${prNumber}/comments?per_page=${COMMENTS_CHECK_PER_PAGE}&page=${page}`, { token });
		const list = Array.isArray(batch) ? batch : [];
		comments.push(...list);
		if (list.length < COMMENTS_CHECK_PER_PAGE) return { comments, complete: true };
	}
	return { comments, complete: false };
}

function sameIntent(snapshot: IntentSnapshot | null | undefined, finding: Finding | null | undefined): boolean {
	const current = finding?.writeIntent;
	if (!snapshot || !current) return false;
	if (snapshot.kind !== current.kind || snapshot.repo !== finding.repo || snapshot.body !== current.body) return false;
	// 编号按 kind 比对（另一种编号在快照里恒为 null，不参与）。
	if (current.kind === "issue_comment") return Number(snapshot.issueNumber) === Number(current.issueNumber);
	return Number(snapshot.prNumber) === Number(current.prNumber);
}

// ---- 评论写入的共享尾段（Finding 与工具待批两条路径共用） ----
// 领取（claim）由各路径在调用前完成并写好 executing 审计；本段负责：
//   目标状态复检（PR / Issue 仍 open、Issue 不是 PR）→ 幂等查重（翻页取尽，
//   没取尽且无标记则不发）→ POST（快照正文 + 幂等标记）→ executed 审计。
// applyRulePreconditions 只对 Finding 路径为 true：那两条是扫描规则的前提
// （PR 仍待审、Issue 仍无人回应），不是评论本身的合法性——对话里用户明确
// 要求发的评论，PR 已被批准或 Issue 已有回复都不构成不发的理由（P2-3 落点）。
// 失败一律先 rollback（释放领取/退回可重试态）再由调用方的 failed 落审计。
interface CommentWriteRun {
	base: { botId: string | null; findingId: string | null; approvalId: string | null; toolApprovalId: string | null; intent: unknown };
	repo: string;
	snapshot: IntentSnapshot;
	token: string;
	markerId: string;
	applyRulePreconditions: boolean;
	rollback: () => void;
	markExecuted: () => void;
	failed: (reason: string) => GatewayResult;
}

async function runCommentWrite(run: CommentWriteRun): Promise<GatewayResult> {
	const { snapshot, repo, token } = run;
	const targetNumber = (snapshot.kind === "issue_comment" ? snapshot.issueNumber : snapshot.prNumber) as number;

	if (snapshot.kind === "pr_comment") {
		let pr: any;
		try {
			pr = await ghJson(`/repos/${repo}/pulls/${targetNumber}`, { token });
		} catch (err) {
			run.rollback();
			return run.failed(`pr_check_failed: ${(err as Error).message}`);
		}
		if (pr.state !== "open") {
			run.rollback();
			return run.failed("pr_not_open");
		}
		if (run.applyRulePreconditions) {
			// 规则前提复检（R5）：与扫描共用 lib/pr-review.ts 的「已批准」判定。
			if (pr.draft) {
				run.rollback();
				return run.failed("precondition_changed");
			}
			let reviews: any[];
			try {
				// 复检取 reviews 与扫描共用同一翻页函数（F2 顺手项）：一页 100 条装不下时
				// 只看第一页会漏掉靠后的 APPROVED / CHANGES_REQUESTED，判定会错。
				reviews = (await ghPage(`/repos/${repo}/pulls/${targetNumber}/reviews`, PAGE_CAPS.reviews)).items;
			} catch (err) {
				run.rollback();
				return run.failed(`precondition_check_failed: ${(err as Error).message}`);
			}
			if (evaluateReviews(reviews, pr.head?.sha).approved) {
				run.rollback();
				return run.failed("precondition_changed");
			}
		}
	} else {
		// issue_comment 复检：Issue 仍 open、且确实是 Issue 不是 PR（编号串了线
		// 时宁可不发）；Finding 路径的「仍无人回应」前提在下面的查重段一并验证。
		let issue: any;
		try {
			issue = await ghJson(`/repos/${repo}/issues/${targetNumber}`, { token });
		} catch (err) {
			run.rollback();
			return run.failed(`issue_check_failed: ${(err as Error).message}`);
		}
		if (issue.pull_request) {
			run.rollback();
			return run.failed("not_an_issue");
		}
		if (issue.state !== "open") {
			run.rollback();
			return run.failed("issue_not_open");
		}
	}

	// 幂等查重：同一批准若已留过评论（例如上次 POST 成功后进程崩溃），直接复用，不再发第二条。
	// 查重翻页取尽（F2）；到上限仍没取尽且没找到标记 → 无法证明没发过，不发。
	const marker = `<!-- piper:approval=${run.markerId} -->`;
	let existing: any = null;
	let commentsComplete = true;
	let checkedComments: any[] = [];
	try {
		const checked = await fetchCommentsForCheck(repo, targetNumber, token);
		commentsComplete = checked.complete;
		checkedComments = checked.comments;
		existing = checked.comments.find((c) => typeof c?.body === "string" && c.body.includes(marker)) ?? null;
	} catch (err) {
		run.rollback();
		return run.failed(`comments_check_failed: ${(err as Error).message}`);
	}
	if (!existing && !commentsComplete) {
		run.rollback();
		return run.failed("comments_check_incomplete");
	}
	if (!existing && run.applyRulePreconditions && snapshot.kind === "issue_comment" && checkedComments.length > 0) {
		run.rollback();
		return run.failed("precondition_changed");
	}
	if (existing) {
		appendAudit({ ...run.base, result: "executed", commentUrl: existing.html_url ?? null });
		run.markExecuted();
		return { ok: true, result: "executed", commentUrl: existing.html_url ?? null, reused: true };
	}

	let comment: any;
	try {
		comment = await ghJson(`/repos/${repo}/issues/${targetNumber}/comments`, {
			method: "POST",
			token,
			body: { body: `${snapshot.body}\n\n${marker}` },
		});
	} catch (err) {
		run.rollback();
		return run.failed(`comment_failed: ${(err as Error).message}`);
	}

	appendAudit({ ...run.base, result: "executed", commentUrl: comment.html_url ?? null });
	run.markExecuted();
	return { ok: true, result: "executed", commentUrl: comment.html_url ?? null };
}

export async function gatewayExecuteWrite({
	findingId,
	approvalId = null,
	snapshot = null,
	toolApprovalId = null,
}: { findingId?: string | null; approvalId?: string | null; snapshot?: IntentSnapshot | null; toolApprovalId?: string | null } = {}): Promise<GatewayResult> {
	// P2-3：对话工具待批走同一入口（§1.1 锁定的入参扩展），分发到工具路径；
	// Finding 路径的参数与语义不变。
	if (toolApprovalId) return gatewayExecuteToolWrite({ toolApprovalId, snapshot });

	const finding = findingId ? getFinding(findingId) : null;
	const auditIntent = { ...(snapshot ?? finding?.writeIntent ?? {}), repo: snapshot?.repo ?? finding?.repo ?? null };
	const base = { botId: finding?.botId ?? null, findingId: findingId ?? null, approvalId, toolApprovalId: null as string | null, intent: auditIntent };
	const denied = (reason: string): GatewayResult => {
		appendAudit({ ...base, result: "denied", reason });
		return { ok: false, result: "denied", reason };
	};
	const failed = (reason: string): GatewayResult => {
		appendAudit({ ...base, result: "failed", reason });
		return { ok: false, result: "failed", reason };
	};
	// 执行在途的失败退回：executing→approved（迁移表内的合法退回），保持可重试。
	// rollback 只在 finding 已确认存在后调用，即 findingId 必非空。
	const rollback = (): void => {
		const cur = getFinding(findingId as string);
		if (cur?.status === "executing") updateFinding(findingId as string, { status: "approved" });
	};

	if (!finding) return denied("finding_not_found");
	if (!approvalId) return denied("missing_approval");
	if (!snapshot) return denied("missing_snapshot");
	if (!finding.writeIntent) return denied("no_write_intent");
	if (!sameIntent(snapshot, finding)) return denied("intent_changed");
	if (snapshot.kind !== "pr_comment" && snapshot.kind !== "issue_comment") return denied("unsupported_intent");

	const bot = getBot(finding.botId);
	if (!bot) return denied("bot_not_found");
	if (!(bot.repos ?? []).includes(finding.repo)) return denied("repo_not_bound");

	if (finding.status === "executing") return denied("already_executing");
	if (finding.status !== "approved") return denied("not_approved");
	if (finding.expiresAt && Date.parse(finding.expiresAt) <= Date.now()) {
		updateFinding(finding.id, { status: "expired" });
		return denied("expired");
	}

	const token = githubToken();
	if (typeof snapshot.body === "string" && containsSecret(snapshot.body)) return denied("secret_in_body");
	if (!token) return failed("no_token");

	// 领取执行：读—判—写在本同步段内完成（上面的 getFinding 与这里的 updateFinding
	// 之间没有 await），单进程内第二个并发执行到此必然看到 executing 而被上面的检查拒绝。
	updateFinding(finding.id, { status: "executing" });
	appendAudit({ ...base, result: "executing" });

	const out = await runCommentWrite({
		base,
		repo: finding.repo,
		snapshot,
		token,
		markerId: approvalId,
		applyRulePreconditions: true,
		rollback,
		markExecuted: () => {
			updateFinding(finding.id, { status: "executed" });
		},
		failed,
	});
	return { ...out, finding: getFinding(finding.id) };
}

// ---- 工具待批路径（P2-3）：领取物是 ToolApproval 记录而不是 Finding ----
// 校验口径与 Finding 路径同构：快照必须与落盘记录逐字一致、仓库必须在
// bot 绑定内、记录必须已批准。差别（落点，README 有记）：
//   - 领取用进程内在途集合（记录状态机没有 executing 态，§1.1 锁定）；
//   - 校验级 denied（快照不符 / 含秘密 / 不支持的意图 / 未绑定）把记录置
//     failed 终态——这类重试也不会变；暂时性 failed（目标已关、网络、
//     无令牌）保持 approved 并把原因写进 error，再次批准即可重试；
//   - 不套用扫描规则前提复检（见 runCommentWrite 的落点说明）。
const toolWritesInFlight = new Set<string>();

async function gatewayExecuteToolWrite({
	toolApprovalId,
	snapshot = null,
}: { toolApprovalId: string; snapshot?: IntentSnapshot | null }): Promise<GatewayResult> {
	const record = getToolApproval(toolApprovalId);
	const recordSnapshot = toolIntentSnapshotOf(record);
	const auditIntent = { ...(snapshot ?? recordSnapshot ?? {}), repo: snapshot?.repo ?? recordSnapshot?.repo ?? null };
	const base = { botId: record?.botId ?? null, findingId: null as string | null, approvalId: null as string | null, toolApprovalId, intent: auditIntent };
	// 校验级拒绝：记录置 failed 终态（already_* 与 not_found 除外，它们不改变记录）。
	const deniedTerminal = (reason: string): GatewayResult => {
		appendAudit({ ...base, result: "denied", reason });
		if (record && record.status === "approved") updateToolApproval(record.id, { status: "failed", error: reason });
		return { ok: false, result: "denied", reason, toolApproval: getToolApproval(toolApprovalId) };
	};
	const denied = (reason: string): GatewayResult => {
		appendAudit({ ...base, result: "denied", reason });
		return { ok: false, result: "denied", reason, toolApproval: record ? getToolApproval(toolApprovalId) : null };
	};
	const failed = (reason: string): GatewayResult => {
		appendAudit({ ...base, result: "failed", reason });
		// 暂时性失败：状态保持 approved，原因记进 error 供收件箱展示与重试。
		if (record) updateToolApproval(record.id, { status: "approved", error: reason });
		return { ok: false, result: "failed", reason, toolApproval: getToolApproval(toolApprovalId) };
	};

	if (!record) return denied("tool_approval_not_found");
	if (!snapshot) return deniedTerminal("missing_snapshot");
	if (!recordSnapshot) return deniedTerminal("invalid_snapshot");
	if (
		snapshot.kind !== recordSnapshot.kind ||
		snapshot.repo !== recordSnapshot.repo ||
		snapshot.body !== recordSnapshot.body ||
		Number(snapshot.prNumber) !== Number(recordSnapshot.prNumber) ||
		Number(snapshot.issueNumber) !== Number(recordSnapshot.issueNumber)
	) {
		return deniedTerminal("intent_changed");
	}
	if (snapshot.kind !== "pr_comment" && snapshot.kind !== "issue_comment") return deniedTerminal("unsupported_intent");

	const bot = getBot(record.botId);
	if (!bot) return deniedTerminal("bot_not_found");
	if (!(bot.repos ?? []).includes(snapshot.repo)) return deniedTerminal("repo_not_bound");

	if (record.status === "executed") return denied("already_executed");
	if (toolWritesInFlight.has(toolApprovalId)) return denied("already_executing");
	if (record.status !== "approved") return deniedTerminal("not_approved");

	const token = githubToken();
	if (typeof snapshot.body === "string" && containsSecret(snapshot.body)) return deniedTerminal("secret_in_body");
	if (!token) return failed("no_token");

	// 领取：同步段内登记在途并写 executing 审计（与 Finding 路径同口径：
	// 先落审计再做网络调用，进程崩溃后能看到「发到一半」；崩溃后记录仍是
	// approved，重试时靠幂等标记查重防双发）。
	toolWritesInFlight.add(toolApprovalId);
	appendAudit({ ...base, result: "executing" });
	try {
		const out = await runCommentWrite({
			base,
			repo: snapshot.repo,
			snapshot,
			token,
			markerId: toolApprovalId,
			applyRulePreconditions: false,
			rollback: () => {
				toolWritesInFlight.delete(toolApprovalId);
			},
			markExecuted: () => {
				toolWritesInFlight.delete(toolApprovalId);
				updateToolApproval(toolApprovalId, { status: "executed", error: null });
			},
			failed,
		});
		return { ...out, toolApproval: getToolApproval(toolApprovalId) };
	} finally {
		toolWritesInFlight.delete(toolApprovalId);
	}
}
