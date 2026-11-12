// 薄网关测试（P1-6 + R1 返工）：进程内 fetch 替身 + 临时 findings/audit/approvals/notifications
// 文件，全程不打活网、不对真实仓库发任何评论。用法（在 apps/piper 下）：
// node dist/scripts/test-gateway.js（或 npm run test:gateway）
// R4 起 PIPER_DATA_DIR 一并指向临时目录：网关经 store 读 bot 绑定、经 settings 读令牌，
// 数据面全部隔离——种子 bots 由 ensureData 在临时目录生成，不再隐含依赖真实 data/。
// SKIP 口径（R4）：跳过必须经 skip() 输出并在汇总单列，绝不计为 PASS。
// 覆盖：未批准直调被拒、正向批准恰好发一次评论（正文 = 批准快照 + 幂等标记）、驳回零调用、
// 过期/已关闭不能再批准、意图快照与当前存储不符被拒（denied/intent_changed）、带旧 intentHash
// 批准回 409、仓库未绑定被拒、不支持的意图被拒、无令牌明确失败且可重试、PR 已关闭执行失败
// 保持 approved、正文含令牌被拒、写接口失败保持 approved、并发批准互斥（替身 50ms 延迟下恰好
// 一次写、第二个 409）、崩溃重放靠评论标记查重（总写次数仍 1）、审计正负两类齐全且不含令牌、
// 以及「除网关外无人构造 GitHub 评论写端点」的源码绕过断言。
// 失败可恢复切片新增：已关闭视图（终态 Finding 带关闭原因留痕、不混入待批列表、
// 无 writeIntent 不入列）与 bot 自我事实（绑定清单如实、凭据红线在场）。
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { ArtifactMeta } from "../lib/store.ts";
import type { Finding } from "../lib/findings.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_DIR } from "./app-dir.ts";

const tmp = mkdtempSync(join(tmpdir(), "piper-gateway-"));
process.env.PIPER_DATA_DIR = join(tmp, "data");
process.env.PIPER_FINDINGS_FILE = join(tmp, "findings.jsonl");
process.env.PIPER_AUDIT_FILE = join(tmp, "audit.jsonl");
process.env.PIPER_APPROVALS_FILE = join(tmp, "approvals.jsonl");
process.env.PIPER_NOTIFICATIONS_FILE = join(tmp, "notifications.jsonl");

// 隔离目录里不存在 settings-github.json，令牌恒走 env 兜底（R4 前还要看本机真实
// 设置文件是否存在、存在就整项跳过——那正是审计 B4 指出的不可复现点，已删除）。
const ENV_TOKEN = "ghp_gateway_test_token_0001";
process.env.GITHUB_TOKEN = ENV_TOKEN;

const results: { seq: number; name: string; ok: boolean; status: string }[] = [];
let seq = 0;
function check(name: string, ok: boolean, detail = "") {
	seq += 1;
	results.push({ seq, name, ok, status: ok ? "pass" : "fail" });
	console.log(`${ok ? "PASS" : "FAIL"} ${String(seq).padStart(2, "0")} ${name}${ok ? "" : ` — ${detail}`}`);
}
function skip(name: string, reason = "") {
	seq += 1;
	results.push({ seq, name, ok: false, status: "skip" });
	console.log(`SKIP ${String(seq).padStart(2, "0")} ${name}${reason ? ` — ${reason}` : ""}`);
}

// ---- fetch 替身：网关会用到的端点（PR 查询、评论列表、评论发表），其余一律 599 ----
// 评论按 PR 落在 commentsByKey 里模拟 GitHub 侧已存在的评论（崩溃重放靠它查重标记）。
const realFetch = globalThis.fetch;
interface StubComment {
	body: unknown;
	html_url: string;
}
const postCalls: { path: string; body: { body?: string }; auth: string }[] = [];
const commentsByKey = new Map<string, StubComment[]>();
let pullState = "open";
let pullDraft = false;
let pullReviews: { state?: string; user?: { login?: string }; commit_id?: string }[] = [];
let postShouldFail = false;
let pullShouldFail = false;
let fetchDelayMs = 0;
let postCrashAfterSuccess = false;
interface StubInit {
	method?: string;
	body?: string;
	headers?: { Authorization?: string };
}
// 替身只实现网关实际用到的 ok/status/json 三个面，不是完整 Response，故 cast 到 typeof fetch。
globalThis.fetch = (async (url: unknown, init: StubInit = {}) => {
	if (fetchDelayMs) await new Promise((r) => setTimeout(r, fetchDelayMs));
	const u = new URL(String(url));
	const method = init.method ?? "GET";
	const commentsMatch = u.pathname.match(/^\/repos\/(.+)\/issues\/(\d+)\/comments$/);
	if (commentsMatch && method === "GET") {
		const key = `${commentsMatch[1]}#${commentsMatch[2]}`;
		// 按 GitHub 口径分页：缺省 per_page=30，page 从 1 起（F2 用例靠它摆位标记评论）。
		const all = commentsByKey.get(key) ?? [];
		const perPage = Number(u.searchParams.get("per_page") ?? 30);
		const page = Number(u.searchParams.get("page") ?? 1);
		return { ok: true, status: 200, json: async () => all.slice((page - 1) * perPage, page * perPage) };
	}
	if (commentsMatch && method === "POST") {
		const body = JSON.parse(init.body ?? "{}");
		postCalls.push({ path: u.pathname, body, auth: init.headers?.Authorization ?? "" });
		const key = `${commentsMatch[1]}#${commentsMatch[2]}`;
		const comment = { body: body.body, html_url: `https://github.com/${commentsMatch[1]}/pull/${commentsMatch[2]}#issuecomment-4242` };
		commentsByKey.set(key, [...(commentsByKey.get(key) ?? []), comment]);
		if (postCrashAfterSuccess) throw new Error("simulated crash after POST succeeded");
		if (postShouldFail) return { ok: false, status: 500, json: async () => ({}) };
		return { ok: true, status: 201, json: async () => comment };
	}
	if (method === "GET" && /\/pulls\/\d+\/reviews$/.test(u.pathname)) {
		const perPage = Number(u.searchParams.get("per_page") ?? 30);
		const page = Number(u.searchParams.get("page") ?? 1);
		return { ok: true, status: 200, json: async () => pullReviews.slice((page - 1) * perPage, page * perPage) };
	}
	if (method === "GET" && /\/pulls\/\d+$/.test(u.pathname)) {
		if (pullShouldFail) return { ok: false, status: 500, json: async () => ({}) };
		return { ok: true, status: 200, json: async () => ({ state: pullState, draft: pullDraft, head: { sha: "head-sha-1" } }) };
	}
	return { ok: false, status: 599, json: async () => ({}) };
}) as typeof fetch;

const artifactCalls: { botId: string; kind: string; title?: unknown; body?: unknown }[] = [];
const saveArtifactStub = (input: { botId: string; kind: string; title?: unknown; body?: unknown }): ArtifactMeta => {
	artifactCalls.push(input);
	return { id: "stub-artifact-id", botId: input.botId, kind: input.kind, title: String(input.title ?? ""), createdAt: null };
};

try {
	const { ensureData } = await import("../lib/store.ts");
	ensureData(); // 在隔离目录生成种子 bots（网关按 bot 绑定仓校验，repo-keeper 必须存在）
	const { createFinding, getFinding: getFindingRaw, updateFinding } = await import("../lib/findings.ts");
	const { approveApproval: approveApprovalRaw, listApprovals, listClosedApprovals, recoverInterruptedExecutions, rejectApproval } = await import("../lib/approvals.ts");
	// 本套件的 Finding 均为刚写入必存在（原 JS 全程按此隐含假定写）：包一层非空断言收口，
	// approveApproval 的 null（不存在→404）与 getFinding 的 null 在本套件语境下都不出现。
	const getFinding = (id: string): Finding => getFindingRaw(id) as Finding;
	const approveApproval = async (...args: Parameters<typeof approveApprovalRaw>) =>
		(await approveApprovalRaw(...args)) as NonNullable<Awaited<ReturnType<typeof approveApprovalRaw>>>;
	const { gatewayExecuteWrite } = await import("../lib/gateway.ts");
	const { appendAudit, listAudit } = await import("../lib/audit.ts");
	const { botSelfFacts } = await import("../lib/kernel.ts");
	const { listNotifications } = await import("../lib/notify.ts");
	const { githubToken } = await import("../lib/settings.ts");
	const token = githubToken();

	const BODY = "晨间分诊提醒：这个 PR 尚未获得任何批准（APPROVED）审查，请维护者抽空审查并给出结论。";
	function makeFinding(overrides: Record<string, unknown> = {}) {
		return createFinding({
			repo: "NorthAdb/LinkForge",
			type: "pr_needs_review",
			subject: "42",
			botId: "repo-keeper",
			title: "PR 待审查：#42 Test（NorthAdb/LinkForge）",
			summary: "stub summary",
			evidenceUrl: "https://github.com/NorthAdb/LinkForge/pull/42",
			suggestedAction: "请审查该 PR 并给出结论。",
			writeIntent: { kind: "pr_comment", prNumber: 42, body: BODY },
			expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
			...overrides,
		});
	}
	const auditFor = (id: string) => listAudit({ findingId: id });
	const viewOf = (id: string) => listApprovals().find((a) => a.findingId === id);
	// 调用点的 Finding 都带 writeIntent（makeFinding 恒给），沿用原 JS 的隐含假定取非空。
	const snapOf = (f: Finding) => ({ kind: f.writeIntent!.kind, repo: f.repo, prNumber: f.writeIntent!.prNumber, body: f.writeIntent!.body });
	// 直接改 findings 文件里的 writeIntent（模拟存储被事后篡改，绕过 updateFinding 的字段保护）。
	function tamperFindingFile(id: string, newBody: string) {
		const file = process.env.PIPER_FINDINGS_FILE as string;
		const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
		const out = lines.map((line) => {
			const f = JSON.parse(line) as { id?: string; writeIntent?: { body?: string } };
			if (f.id === id) f.writeIntent = { ...f.writeIntent, body: newBody };
			return JSON.stringify(f);
		});
		writeFileSync(file, out.join("\n") + "\n", "utf8");
	}

	// 1. 负向：未批准直调网关 → denied/not_approved，写 API 0 次，审计有 denied
	{
		const f = makeFinding({ subject: "101" });
		const before = postCalls.length;
		const r = await gatewayExecuteWrite({ findingId: f.id, approvalId: "ap-direct", snapshot: snapOf(f) });
		check(
			"负向：未经批准直调网关被拒（not_approved），替身写 API 0 次，审计有 denied",
			r.ok === false && r.result === "denied" && r.reason === "not_approved" && postCalls.length === before && auditFor(f.id).some((x) => x.result === "denied" && x.reason === "not_approved"),
			JSON.stringify(r),
		);
	}

	// 2. 正向：批准（带 intentHash）→ 网关执行快照恰好发一次评论（正文 = 快照正文 + 幂等标记），
	//    状态 executed，审计 approved/executing/executed 同一 approvalId，artifact 与通知齐全
	let executedFinding: Finding | undefined;
	let executedApprovalId: string | null | undefined;
	{
		const f = makeFinding({ subject: "42" });
		executedFinding = f;
		const view = viewOf(f.id);
		const before = postCalls.length;
		const out = await approveApproval(f.id, { intentHash: view?.intentHash, saveArtifactFn: saveArtifactStub });
		const call = postCalls[before];
		const recs = auditFor(f.id);
		executedApprovalId = recs.find((x) => x.result === "approved")?.approvalId;
		check(
			"正向：批准后替身写 API 恰好一次，正文为批准快照加幂等标记且带令牌，Finding 转 executed",
			out.execution.ok === true &&
				postCalls.length === before + 1 &&
				call.path === "/repos/NorthAdb/LinkForge/issues/42/comments" &&
				typeof executedApprovalId === "string" &&
				executedApprovalId.length > 0 &&
				call.body.body === `${BODY}\n\n<!-- piper:approval=${executedApprovalId} -->` &&
				call.auth === `Bearer ${token}` &&
				getFinding(f.id).status === "executed" &&
				out.approval.commentUrl === "https://github.com/NorthAdb/LinkForge/pull/42#issuecomment-4242",
			JSON.stringify(out.execution),
		);
		check(
			"正向审计：同一 Finding 可追到 approved、executing（发前落痕）与 executed（含 commentUrl），approvalId 一致；有执行 artifact 与 approval.executed 通知",
			recs.some((x) => x.result === "approved" && x.approvalId === executedApprovalId) &&
				recs.some((x) => x.result === "executing" && x.approvalId === executedApprovalId) &&
				recs.some((x) => x.result === "executed" && x.approvalId === executedApprovalId && x.commentUrl?.includes("issuecomment-4242")) &&
				artifactCalls.length === 1 &&
				artifactCalls[0].kind === "gateway-execution" &&
				listNotifications().some((n) => n.type === "approval.executed" && n.findingId === f.id) &&
				!listApprovals().some((a) => a.findingId === f.id),
			`审计=${recs.map((x) => x.result).join(",")}`,
		);
	}

	// 3. 驳回：写 API 0 次，状态 rejected，审计有 rejected；已关闭再批准 → 409
	{
		const f = makeFinding({ subject: "103" });
		const before = postCalls.length;
		const a = rejectApproval(f.id) as NonNullable<ReturnType<typeof rejectApproval>>;
		check(
			"驳回：替身写 API 0 次，状态 rejected，审计有 rejected",
			a.status === "rejected" && postCalls.length === before && auditFor(f.id).some((x) => x.result === "rejected"),
			`status=${a.status}`,
		);
		let threw: (Error & { status?: number }) | null = null;
		try {
			await approveApproval(f.id, { intentHash: viewOf(f.id)?.intentHash, saveArtifactFn: saveArtifactStub });
		} catch (err) {
			threw = err as Error & { status?: number };
		}
		check("已关闭（rejected）再批准被拒（409），不产生写调用", threw?.status === 409 && postCalls.length === before, `threw=${threw?.status}`);
	}

	// 4. 过期：open 且已过期 → 批准回 409 且转 expired；approved 后过期 → 网关 denied/expired
	{
		const f = makeFinding({ subject: "104", expiresAt: new Date(Date.now() - 1000).toISOString() });
		let threw: (Error & { status?: number }) | null = null;
		try {
			await approveApproval(f.id, { intentHash: undefined, saveArtifactFn: saveArtifactStub });
		} catch (err) {
			threw = err as Error & { status?: number };
		}
		const g = makeFinding({ subject: "105" });
		updateFinding(g.id, { status: "approved", expiresAt: new Date(Date.now() - 1000).toISOString() });
		const before = postCalls.length;
		const r = await gatewayExecuteWrite({ findingId: g.id, approvalId: "ap-direct", snapshot: snapOf(g) });
		check(
			"过期不能批准/执行：open 过期批准回 409 且状态转 expired；approved 过期被网关 denied/expired，写 API 0 次",
			threw?.status === 409 && getFinding(f.id).status === "expired" && r.result === "denied" && r.reason === "expired" && getFinding(g.id).status === "expired" && postCalls.length === before,
			`threw=${threw?.status} r=${JSON.stringify(r)}`,
		);
	}

	// 5. 意图快照与当前存储不符：网关拿到的快照正文与 Finding 现存 writeIntent 不一致
	//    → denied/intent_changed，写 API 0 次（旧实现会把被改后的正文发出去）
	{
		const f = makeFinding({ subject: "106" });
		updateFinding(f.id, { status: "approved" });
		const before = postCalls.length;
		const r = await gatewayExecuteWrite({ findingId: f.id, approvalId: "ap-direct", snapshot: { ...snapOf(f), body: "被篡改的正文" } });
		check(
			"快照不符被拒：网关只执行批准快照，快照与当前 writeIntent 不一致 → denied/intent_changed，写 API 0 次",
			r.result === "denied" && r.reason === "intent_changed" && postCalls.length === before,
			JSON.stringify(r),
		);
	}

	// 6. 篡改后再批准：文件里的 writeIntent 被直接改掉后，拿旧 intentHash 批准 → 409，写 API 0 次
	{
		const f = makeFinding({ subject: "116" });
		const staleHash = viewOf(f.id)?.intentHash;
		tamperFindingFile(f.id, "被篡改的正文");
		const before = postCalls.length;
		let threw: (Error & { status?: number }) | null = null;
		try {
			await approveApproval(f.id, { intentHash: staleHash, saveArtifactFn: saveArtifactStub });
		} catch (err) {
			threw = err as Error & { status?: number };
		}
		check(
			"篡改后批准被拒：writeIntent 被改后带旧 intentHash 批准回 409「内容已变」，状态仍 open，写 API 0 次",
			threw?.status === 409 && /内容已变/.test(String(threw?.message ?? "")) && getFinding(f.id).status === "open" && postCalls.length === before,
			`threw=${threw?.status} ${threw?.message ?? ""}`,
		);
	}

	// 7. 仓库未绑定 bot → denied/repo_not_bound
	{
		const f = makeFinding({ repo: "Acme/Widgets", subject: "107", evidenceUrl: "https://github.com/Acme/Widgets/pull/42" });
		updateFinding(f.id, { status: "approved" });
		const before = postCalls.length;
		const r = await gatewayExecuteWrite({ findingId: f.id, approvalId: "ap-direct", snapshot: snapOf(f) });
		check(
			"仓库未绑定被拒：目标仓不在 bot 绑定仓内 → denied/repo_not_bound，写 API 0 次",
			r.result === "denied" && r.reason === "repo_not_bound" && postCalls.length === before,
			JSON.stringify(r),
		);
	}

	// 8. 不支持的意图种类（绕过 createFinding 校验手写一行，模拟其他生产者）→ denied/unsupported_intent
	{
		const raw = {
			id: "f-raw-unsupported",
			repo: "NorthAdb/LinkForge",
			type: "pr_needs_review",
			subject: "108",
			title: "raw",
			summary: "",
			evidenceUrl: "https://github.com/NorthAdb/LinkForge/pull/42",
			suggestedAction: "",
			writeIntent: { kind: "merge_pr", prNumber: 42, body: "x" },
			expiresAt: null,
			status: "approved",
			botId: "repo-keeper",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		appendFileSync(process.env.PIPER_FINDINGS_FILE as string, JSON.stringify(raw) + "\n", "utf8");
		const before = postCalls.length;
		const r = await gatewayExecuteWrite({
			findingId: raw.id,
			approvalId: "ap-direct",
			snapshot: { kind: "merge_pr", repo: raw.repo, prNumber: 42, body: "x" },
		});
		check(
			"不支持的意图被拒：kind 非 pr_comment → denied/unsupported_intent，写 API 0 次",
			r.result === "denied" && r.reason === "unsupported_intent" && postCalls.length === before,
			JSON.stringify(r),
		);
	}

	// 9. 无令牌：批准执行明确失败（no_token）、保持 approved、可重试成功。
	//    R4 前本机若有真实 settings-github.json 本项整项「跳过也算过」；隔离后令牌
	//    来源恒为 env，本项在任何机器上都真跑，不再有跳过分支。
	{
		const f = makeFinding({ subject: "109" });
		delete process.env.GITHUB_TOKEN;
		const before = postCalls.length;
		const out1 = await approveApproval(f.id, { intentHash: viewOf(f.id)?.intentHash, saveArtifactFn: saveArtifactStub });
		const failedOk =
			out1.execution.ok === false &&
			out1.execution.result === "failed" &&
			out1.execution.reason === "no_token" &&
			getFinding(f.id).status === "approved" &&
			postCalls.length === before &&
			auditFor(f.id).some((x) => x.result === "failed" && x.reason === "no_token");
		process.env.GITHUB_TOKEN = ENV_TOKEN;
		const out2 = await approveApproval(f.id, { intentHash: viewOf(f.id)?.intentHash, saveArtifactFn: saveArtifactStub });
		check(
			"无令牌不假成功：execution failed/no_token、Finding 保持 approved、审计有 failed；补上令牌后重试即 executed",
			failedOk && out2.execution.ok === true && getFinding(f.id).status === "executed" && postCalls.length === before + 1,
			`out1=${JSON.stringify(out1.execution)} out2=${JSON.stringify(out2.execution)}`,
		);
	}

	// 10. PR 已关闭：执行前复检失败 → failed/pr_not_open，保持 approved，收件箱 lastError 可见，写 API 0 次
	{
		const f = makeFinding({ subject: "110" });
		pullState = "closed";
		const before = postCalls.length;
		const out = await approveApproval(f.id, { intentHash: viewOf(f.id)?.intentHash, saveArtifactFn: saveArtifactStub });
		pullState = "open";
		const listed = listApprovals().find((a) => a.findingId === f.id);
		check(
			"PR 已关闭：执行前复检 → failed/pr_not_open，Finding 保持 approved 且 lastError 可见，写 API 0 次",
			out.execution.ok === false &&
				out.execution.reason === "pr_not_open" &&
				getFinding(f.id).status === "approved" &&
				listed?.lastError === "pr_not_open" &&
				postCalls.length === before,
			JSON.stringify(out.execution),
		);
	}

	// 11. 正文含令牌 → denied/secret_in_body（发送前拦截），写 API 0 次
	{
		const f = makeFinding({ subject: "111", writeIntent: { kind: "pr_comment", prNumber: 42, body: `提醒：令牌是 ${token} 请审查` } });
		updateFinding(f.id, { status: "approved" });
		const before = postCalls.length;
		const r = await gatewayExecuteWrite({ findingId: f.id, approvalId: "ap-direct", snapshot: snapOf(f) });
		check(
			"正文含令牌被拒：denied/secret_in_body，写 API 0 次",
			r.result === "denied" && r.reason === "secret_in_body" && postCalls.length === before,
			JSON.stringify(r),
		);
	}

	// 12. 写接口 500：failed/comment_failed，保持 approved 可重试
	{
		const f = makeFinding({ subject: "112" });
		postShouldFail = true;
		const out = await approveApproval(f.id, { intentHash: viewOf(f.id)?.intentHash, saveArtifactFn: saveArtifactStub });
		postShouldFail = false;
		check(
			"写接口失败：execution failed/comment_failed*，Finding 保持 approved，审计有 failed",
			out.execution.ok === false && String(out.execution.reason).startsWith("comment_failed") && getFinding(f.id).status === "approved" && auditFor(f.id).some((x) => x.result === "failed"),
			JSON.stringify(out.execution),
		);
	}

	// 13. 并发批准互斥：替身带 50ms 延迟，两个并发批准 → 写替身恰好 1 次、审计 executed 恰好
	//     1 条、第二个请求 409「正在执行」（审计探针 P1 在旧实现上是 2 次写）
	{
		const f = makeFinding({ subject: "113" });
		const hash = viewOf(f.id)?.intentHash;
		fetchDelayMs = 50;
		const before = postCalls.length;
		const settle = <T,>(p: Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: Error & { status?: number } }> =>
			p.then((v) => ({ ok: true as const, v })).catch((e) => ({ ok: false as const, e: e as Error & { status?: number } }));
		const [r1, r2] = await Promise.all([
			settle(approveApproval(f.id, { intentHash: hash, saveArtifactFn: saveArtifactStub })),
			settle(approveApproval(f.id, { intentHash: hash, saveArtifactFn: saveArtifactStub })),
		]);
		fetchDelayMs = 0;
		const successes = [r1, r2].filter((r) => r.ok && r.v.execution?.ok === true);
		const conflicts = [r1, r2].filter((r) => !r.ok && r.e?.status === 409);
		check(
			"并发批准互斥：两个并发批准恰好一次写、一条 executed 审计，另一个回 409",
			successes.length === 1 &&
				conflicts.length === 1 &&
				postCalls.length === before + 1 &&
				auditFor(f.id).filter((x) => x.result === "executed").length === 1 &&
				getFinding(f.id).status === "executed",
			`r1=${JSON.stringify(r1.ok ? r1.v.execution : r1.e?.status)} r2=${JSON.stringify(r2.ok ? r2.v.execution : r2.e?.status)} posts=${postCalls.length - before}`,
		);
	}

	// 14. 崩溃重放：替身 POST 在 GitHub 侧成功后抛错（模拟进程崩溃），Finding 退回 approved；
	//     再次批准时网关先查评论标记，复用已有评论记 executed，写替身总计仍 1 次
	{
		const f = makeFinding({ subject: "114", writeIntent: { kind: "pr_comment", prNumber: 77, body: BODY }, evidenceUrl: "https://github.com/NorthAdb/LinkForge/pull/77" });
		postCrashAfterSuccess = true;
		const before = postCalls.length;
		const out1 = await approveApproval(f.id, { intentHash: viewOf(f.id)?.intentHash, saveArtifactFn: saveArtifactStub });
		postCrashAfterSuccess = false;
		const out2 = await approveApproval(f.id, { intentHash: viewOf(f.id)?.intentHash, saveArtifactFn: saveArtifactStub });
		check(
			"崩溃重放幂等：POST 成功后崩溃退回 approved，再次批准靠标记查重不再 POST，总写次数 1 且转 executed",
			out1.execution.ok === false &&
				getFinding(f.id).status === "executed" &&
				out2.execution.ok === true &&
				postCalls.length === before + 1 &&
				auditFor(f.id).filter((x) => x.result === "executed").length === 1,
			`out1=${JSON.stringify(out1.execution)} out2=${JSON.stringify(out2.execution)} posts=${postCalls.length - before}`,
		);
	}

	// 15. 审计完整性：字段形状齐全且全文件不含令牌全文
	{
		const rec = auditFor(executedFinding!.id).find((x) => x.result === "executed");
		const rawAudit = readFileSync(process.env.PIPER_AUDIT_FILE as string, "utf8");
		check(
			"审计样例字段：ts/botId/intent{kind,repo,prNumber,bodyLength,bodyPreview}/result/findingId/approvalId/commentUrl 齐全且审计文件不含令牌",
			rec !== undefined &&
				typeof rec.ts === "string" &&
				rec.botId === "repo-keeper" &&
				rec.intent?.kind === "pr_comment" &&
				rec.intent?.repo === "NorthAdb/LinkForge" &&
				rec.intent?.prNumber === 42 &&
				rec.intent?.bodyLength === BODY.length &&
				rec.intent?.bodyPreview === BODY.slice(0, 120) &&
				rec.findingId === executedFinding!.id &&
				rec.approvalId === executedApprovalId &&
				!rawAudit.includes(token),
			JSON.stringify(rec),
		);
	}

	// 16. 规则前提复检（R5）：扫描时 PR 待审、批准后 PR 已被批准（审查人最新为 APPROVED 且
	//     所针对 commit 与当前 head 一致）→ 网关 failed/precondition_changed，不发评论，
	//     Finding 保持 approved、审计有 failed/precondition_changed
	{
		const f = makeFinding({ subject: "117" });
		pullReviews = [{ state: "APPROVED", user: { login: "rev" }, commit_id: "head-sha-1" }];
		const before = postCalls.length;
		const out = await approveApproval(f.id, { intentHash: viewOf(f.id)?.intentHash, saveArtifactFn: saveArtifactStub });
		pullReviews = [];
		check(
			"前提已变被拦：批准后 PR 已获批准 → failed/precondition_changed，写 API 0 次，保持 approved，审计有该原因",
			out.execution.ok === false &&
				out.execution.result === "failed" &&
				out.execution.reason === "precondition_changed" &&
				getFinding(f.id).status === "approved" &&
				postCalls.length === before &&
				auditFor(f.id).some((x) => x.result === "failed" && x.reason === "precondition_changed"),
			JSON.stringify(out.execution),
		);
	}

	// 直接改 findings 文件里的 updatedAt（模拟执行在途已停留很久，updatedAt 不是可改字段）。
	function ageFindingFile(id: string, iso: string) {
		const file = process.env.PIPER_FINDINGS_FILE as string;
		const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
		const out = lines.map((line) => {
			const f = JSON.parse(line) as { id?: string; updatedAt?: string };
			if (f.id === id) f.updatedAt = iso;
			return JSON.stringify(f);
		});
		writeFileSync(file, out.join("\n") + "\n", "utf8");
	}

	// 17. executing 崩溃恢复（F1，第二轮返工）：进程在网关领取执行后、落终态前死亡
	//     （kill -9 等），Finding 会永久卡 executing——批准 409、驳回 409。恢复函数把
	//     超时（缺省 5 分钟，按 updatedAt 计）的 executing 退回 approved 并写审计
	//     failed/interrupted；刚领取的（未超时）不动。启动语义 olderThanMs=0 全量恢复。
	{
		const stale = makeFinding({ subject: "118" });
		updateFinding(stale.id, { status: "approved" });
		updateFinding(stale.id, { status: "executing" });
		ageFindingFile(stale.id, new Date(Date.now() - 10 * 60 * 1000).toISOString());
		const fresh = makeFinding({ subject: "119" });
		updateFinding(fresh.id, { status: "approved" });
		updateFinding(fresh.id, { status: "executing" });
		let recovered: number | null = null;
		let err: Error | null = null;
		try {
			recovered = recoverInterruptedExecutions();
		} catch (e) {
			err = e as Error;
		}
		check(
			"executing 恢复：超时 executing 退回 approved 并写审计 failed/interrupted，未超时的不动",
			err === null &&
				recovered === 1 &&
				getFinding(stale.id).status === "approved" &&
				auditFor(stale.id).some((x) => x.result === "failed" && x.reason === "interrupted") &&
				getFinding(fresh.id).status === "executing",
			`err=${err?.message ?? ""} recovered=${recovered} stale=${getFinding(stale.id).status} fresh=${getFinding(fresh.id).status}`,
		);
		let recoveredAtBoot: number | null = null;
		try {
			recoveredAtBoot = recoverInterruptedExecutions({ olderThanMs: 0 });
		} catch (e) {
			err = e as Error;
		}
		check(
			"executing 恢复（启动语义）：olderThanMs=0 时未超时的 executing 也退回 approved",
			err === null && recoveredAtBoot === 1 && getFinding(fresh.id).status === "approved",
			`err=${err?.message ?? ""} recovered=${recoveredAtBoot} fresh=${getFinding(fresh.id).status}`,
		);
	}

	// 18. 评论幂等查重翻页（F2，第二轮返工）：查重改 per_page=100 翻页取尽，上限 10 页；
	//     到上限仍没取尽且没找到标记 → 不发，failed/comments_check_incomplete，退回 approved。
	//     摆位都靠「首次执行 POST 成功后崩溃」种下带标记评论，再用填充评论把它推到目标位置：
	//     A 共 35 条、标记在第 35 条（GitHub 默认每页 30 时位于第 2 页，旧实现只取第一页必漏检重发）；
	//     B 共 120 条、标记在第 111 条（per_page=100 的第 2 页）；
	//     C 共 1006 条、标记在第 1006 条（超出 10 页 × 100 的取尽上限）。
	//     A/B：重试 POST 0 次、复用已有评论记 executed；C：POST 0 次、保持 approved、审计有该原因。
	async function seedCrashedWithMarker(f: Finding, total: number, markerIndex: number) {
		postCrashAfterSuccess = true;
		const out1 = await approveApproval(f.id, { intentHash: viewOf(f.id)?.intentHash, saveArtifactFn: saveArtifactStub });
		postCrashAfterSuccess = false;
		// 调用点的 Finding 恒带 writeIntent（makeFinding 恒给），沿用原 JS 的隐含假定取非空。
		const key = `${f.repo}#${f.writeIntent!.prNumber}`;
		const arr = commentsByKey.get(key) ?? [];
		const markerComment = arr[arr.length - 1] as StubComment;
		const fillers = Array.from({ length: total - 1 }, (_, i) => ({ body: `filler ${i}`, html_url: `https://example.invalid/filler-${i}` }));
		commentsByKey.set(key, [...fillers.slice(0, markerIndex), markerComment, ...fillers.slice(markerIndex)]);
		return out1;
	}
	{
		const fA = makeFinding({ subject: "201", writeIntent: { kind: "pr_comment", prNumber: 201, body: BODY }, evidenceUrl: "https://github.com/NorthAdb/LinkForge/pull/201" });
		await seedCrashedWithMarker(fA, 35, 34);
		const beforeA = postCalls.length;
		const outA = await approveApproval(fA.id, { intentHash: viewOf(fA.id)?.intentHash, saveArtifactFn: saveArtifactStub });
		check(
			"查重翻页 A：35 条评论、标记在第 35 条 → 重试 POST 0 次，复用已有评论记 executed",
			outA.execution.ok === true && outA.execution.reused === true && postCalls.length === beforeA && getFinding(fA.id).status === "executed",
			`out=${JSON.stringify(outA.execution)} posts=${postCalls.length - beforeA}`,
		);
		const fB = makeFinding({ subject: "202", writeIntent: { kind: "pr_comment", prNumber: 202, body: BODY }, evidenceUrl: "https://github.com/NorthAdb/LinkForge/pull/202" });
		await seedCrashedWithMarker(fB, 120, 110);
		const beforeB = postCalls.length;
		const outB = await approveApproval(fB.id, { intentHash: viewOf(fB.id)?.intentHash, saveArtifactFn: saveArtifactStub });
		check(
			"查重翻页 B：120 条评论、标记在第 111 条（per_page=100 第 2 页）→ 重试 POST 0 次，复用记 executed",
			outB.execution.ok === true && outB.execution.reused === true && postCalls.length === beforeB && getFinding(fB.id).status === "executed",
			`out=${JSON.stringify(outB.execution)} posts=${postCalls.length - beforeB}`,
		);
		const fC = makeFinding({ subject: "203", writeIntent: { kind: "pr_comment", prNumber: 203, body: BODY }, evidenceUrl: "https://github.com/NorthAdb/LinkForge/pull/203" });
		await seedCrashedWithMarker(fC, 1006, 1005);
		const beforeC = postCalls.length;
		const outC = await approveApproval(fC.id, { intentHash: viewOf(fC.id)?.intentHash, saveArtifactFn: saveArtifactStub });
		check(
			"查重翻页 C：标记超出 10 页上限 → POST 0 次，failed/comments_check_incomplete，保持 approved，审计有该原因",
			outC.execution.ok === false &&
				outC.execution.reason === "comments_check_incomplete" &&
				postCalls.length === beforeC &&
				getFinding(fC.id).status === "approved" &&
				auditFor(fC.id).some((x) => x.result === "failed" && x.reason === "comments_check_incomplete"),
			`out=${JSON.stringify(outC.execution)} posts=${postCalls.length - beforeC} status=${getFinding(fC.id).status}`,
		);
	}

	// 19. 绕过断言：除 gateway.ts 外，lib 与 server 没有任何文件构造 GitHub 评论写端点；
	//     扫描与对话层文件不得同时出现 api.github.com 与 POST 写调用。
	{
		const libFiles = readdirSync(join(APP_DIR, "lib")).filter((f) => f.endsWith(".ts"));
		const sources: Record<string, string> = Object.fromEntries(libFiles.map((f) => [f, readFileSync(join(APP_DIR, "lib", f), "utf8")]));
		sources["server.ts"] = readFileSync(join(APP_DIR, "server.ts"), "utf8");
		const withComments = Object.entries(sources)
			.filter(([, src]) => src.includes("/comments"))
			.map(([name]) => name);
		const readLayers = ["scan.ts", "kernel.ts", "approvals.ts", "findings.ts"];
		const readLayerClean = readLayers.every((name) => !(sources[name].includes("api.github.com") && sources[name].includes('"POST"')));
		check(
			"无绕过：只有 gateway.ts 构造 /comments 写端点；scan/kernel/approvals/findings 无 GitHub POST 写调用",
			JSON.stringify(withComments) === JSON.stringify(["gateway.ts"]) && readLayerClean,
			`withComments=${withComments.join(",")}`,
		);
	}

	// 20. COMMENTED 不撤销批准——网关同源判定（F4，第二轮返工）：审查人 APPROVED
	//     （针对当前 head）后又提交一条 COMMENTED（回复行内评论即产生）——网关复检与
	//     扫描共用 evaluateReviews，必须同样判「已批准」→ failed/precondition_changed、
	//     写 API 0 次。旧实现按「最新一条」取到 COMMENTED 判 no_approval，会误发评论。
	{
		const f = makeFinding({ subject: "120" });
		pullReviews = [
			{ state: "APPROVED", user: { login: "rev" }, commit_id: "head-sha-1" },
			{ state: "COMMENTED", user: { login: "rev" }, commit_id: "head-sha-1" },
		];
		const before = postCalls.length;
		const out = await approveApproval(f.id, { intentHash: viewOf(f.id)?.intentHash, saveArtifactFn: saveArtifactStub });
		pullReviews = [];
		check(
			"F4 网关同源：批准后同人 COMMENTED → 仍判已批准，failed/precondition_changed，写 API 0 次，保持 approved",
			out.execution.ok === false &&
				out.execution.result === "failed" &&
				out.execution.reason === "precondition_changed" &&
				postCalls.length === before &&
				getFinding(f.id).status === "approved" &&
				auditFor(f.id).some((x) => x.result === "failed" && x.reason === "precondition_changed"),
			JSON.stringify(out.execution),
		);
	}

	// 21. draft 复检（F5②，第二轮返工）：Finding 批准后 PR 变 draft → 网关执行前复检
	//     failed/precondition_changed、写 API 0 次、保持 approved。去掉网关的 draft
	//     复检本项即变红（会一路走到 POST）。
	{
		const f = makeFinding({ subject: "121" });
		pullDraft = true;
		const before = postCalls.length;
		const out = await approveApproval(f.id, { intentHash: viewOf(f.id)?.intentHash, saveArtifactFn: saveArtifactStub });
		pullDraft = false;
		check(
			"F5 draft 复检：批准后 PR 变 draft → failed/precondition_changed，写 API 0 次，保持 approved，审计有该原因",
			out.execution.ok === false &&
				out.execution.result === "failed" &&
				out.execution.reason === "precondition_changed" &&
				postCalls.length === before &&
				getFinding(f.id).status === "approved" &&
				auditFor(f.id).some((x) => x.result === "failed" && x.reason === "precondition_changed"),
			JSON.stringify(out.execution),
		);
	}

	// 22. 陈旧批准在网关仍判待审（F5③，第二轮返工）：批准所针对的 commit（old-sha-999）
	//     与当前 head（head-sha-1）不一致——按锁定口径陈旧批准 = 仍待审（扫描侧同一场景
	//     由夹具 pr-approved-then-new-commits 钉住应报），网关与扫描共用同一判定，前提
	//     未变，照常发送并 executed。本项钉住「网关复检把当前 head 传进判定」：复检不传
	//     head 时陈旧无从判定、会误判已批准 → 本项变红。
	{
		const f = makeFinding({ subject: "122" });
		pullReviews = [{ state: "APPROVED", user: { login: "rev" }, commit_id: "old-sha-999" }];
		const before = postCalls.length;
		const out = await approveApproval(f.id, { intentHash: viewOf(f.id)?.intentHash, saveArtifactFn: saveArtifactStub });
		pullReviews = [];
		check(
			"F5 陈旧批准仍待审：批准 commit 与当前 head 不一致 → 同一判定仍待审，网关照常发送（写 API 1 次）并 executed",
			out.execution.ok === true && postCalls.length === before + 1 && getFinding(f.id).status === "executed",
			`out=${JSON.stringify(out.execution)} posts=${postCalls.length - before}`,
		);
	}
	// 23. 已关闭视图（失败可恢复切片）：终态 Finding 带关闭原因出现在 closed 里、
	//     不再出现在待批列表；无 writeIntent 的 Finding 不入已关闭视图。
	{
		const rej = makeFinding({ subject: "123" });
		rejectApproval(rej.id);
		const expReconciled = makeFinding({ subject: "124" });
		updateFinding(expReconciled.id, { status: "expired" });
		appendAudit({ botId: "repo-keeper", intent: null, result: "expired", reason: "reconciled:pr_merged", findingId: expReconciled.id });
		const expTtl = makeFinding({ subject: "125" });
		updateFinding(expTtl.id, { status: "expired" });
		const exe = makeFinding({ subject: "126" });
		await approveApproval(exe.id, { intentHash: viewOf(exe.id)?.intentHash, saveArtifactFn: saveArtifactStub });
		const noIntent = createFinding({
			repo: "NorthAdb/LinkForge",
			type: "ci_failed",
			subject: "run-127",
			botId: "repo-keeper",
			title: "CI 失败（无写意图）",
			summary: "",
			evidenceUrl: "https://github.com/NorthAdb/LinkForge/actions",
			suggestedAction: "",
			writeIntent: null,
			status: "rejected",
		});
		const closed = listClosedApprovals();
		const closedOf = (id: string) => closed.find((a) => a.findingId === id);
		check(
			"已关闭视图：驳回项带 closeReason=rejected_by_user 与 closedAt，且不在待批列表",
			closedOf(rej.id)?.status === "rejected" &&
				closedOf(rej.id)?.closeReason === "rejected_by_user" &&
				Boolean(closedOf(rej.id)?.closedAt) &&
				!listApprovals().some((a) => a.findingId === rej.id),
			JSON.stringify(closedOf(rej.id) ?? null),
		);
		check(
			"已关闭视图：对账退役项带 closeReason=reconciled:pr_merged",
			closedOf(expReconciled.id)?.status === "expired" && closedOf(expReconciled.id)?.closeReason === "reconciled:pr_merged",
			JSON.stringify(closedOf(expReconciled.id) ?? null),
		);
		check(
			"已关闭视图：无终态审计的过期项 closeReason 为 null（不编造原因）、closedAt 回落 updatedAt",
			closedOf(expTtl.id)?.status === "expired" && closedOf(expTtl.id)?.closeReason === null && Boolean(closedOf(expTtl.id)?.closedAt),
			JSON.stringify(closedOf(expTtl.id) ?? null),
		);
		check(
			"已关闭视图：已执行项带 commentUrl；无 writeIntent 的终态 Finding 不入列；新关闭的排在前",
			closedOf(exe.id)?.status === "executed" &&
				Boolean(closedOf(exe.id)?.commentUrl) &&
				!closedOf(noIntent.id) &&
				closed.findIndex((a) => a.findingId === exe.id) < closed.findIndex((a) => a.findingId === rej.id),
			`exe=${JSON.stringify(closedOf(exe.id) ?? null)}`,
		);
	}

	// 24. bot 自我事实（失败可恢复切片）：绑定仓库如实列出、扫描取证边界与凭据
	//     红线在场；无绑定时明说未绑定，不编造。
	{
		const base = {
			id: "b-test",
			name: "测试 bot",
			systemPrompt: "",
			tools: [] as string[],
			memoryScope: "self",
			routines: [] as string[],
			isMain: false,
			canManageBots: false,
			createdAt: "2026-11-12T00:00:00.000Z",
		};
		const withRepos = botSelfFacts({ ...base, repos: ["NorthAdb/LinkForge", "NorthAdb/Loom"] }, { runsMorningScan: true });
		const noRepos = botSelfFacts({ ...base, repos: [] });
		check(
			"bot 自我事实：绑定仓库逐个列出、含扫描例程说明、含凭据红线（只走设置页、拒绝在对话里接收）",
			withRepos.includes("NorthAdb/LinkForge") &&
				withRepos.includes("NorthAdb/Loom") &&
				withRepos.includes("晨间仓库扫描例程挂在你名下") &&
				withRepos.includes("只能由用户在「设置」页填写") &&
				withRepos.includes("绝不要请用户在对话里把令牌或 Key 发给你"),
			withRepos,
		);
		check(
			"bot 自我事实：无绑定仓库时明说未绑定，且不出现扫描例程说明",
			noRepos.includes("没有绑定任何 GitHub 仓库") && !noRepos.includes("晨间仓库扫描例程挂在你名下"),
			noRepos,
		);
	}
} finally {
	globalThis.fetch = realFetch;
	delete process.env.PIPER_DATA_DIR;
	delete process.env.PIPER_FINDINGS_FILE;
	delete process.env.PIPER_AUDIT_FILE;
	delete process.env.PIPER_APPROVALS_FILE;
	delete process.env.PIPER_NOTIFICATIONS_FILE;
	delete process.env.GITHUB_TOKEN;
	rmSync(tmp, { recursive: true, force: true });
}

const passedCount = results.filter((r) => r.status === "pass").length;
const skippedCount = results.filter((r) => r.status === "skip").length;
const failed = results.filter((r) => r.status === "fail");
console.log(`\n结果：${passedCount}/${results.length} 通过，${skippedCount} 跳过（单列，不计通过），${failed.length} 失败`);
if (failed.length) process.exit(1);
