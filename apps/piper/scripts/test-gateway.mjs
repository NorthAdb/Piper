// 薄网关测试（P1-6）：进程内 fetch 替身 + 临时 findings/audit/notifications 文件，全程不打活网、
// 不对真实仓库发任何评论。用法（在 apps/piper 下）：node scripts/test-gateway.mjs（或 npm run test:gateway）
// 覆盖：未批准直调被拒、正向批准恰好发一次评论、驳回零调用、过期/已关闭不能再批准、
// 意图被改被拒、仓库未绑定被拒、不支持的意图被拒、无令牌明确失败且可重试、PR 已关闭
// 执行失败保持 approved、正文含令牌被拒、写接口失败保持 approved、审计正负两类齐全
// 且不含令牌、以及「除网关外无人构造 GitHub 评论写端点」的源码绕过断言。
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "piper-gateway-"));
process.env.PIPER_FINDINGS_FILE = join(tmp, "findings.jsonl");
process.env.PIPER_AUDIT_FILE = join(tmp, "audit.jsonl");
process.env.PIPER_NOTIFICATIONS_FILE = join(tmp, "notifications.jsonl");

const SETTINGS_GITHUB_FILE = join(APP_DIR, "data", "settings-github.json");
const hasSettingsToken = existsSync(SETTINGS_GITHUB_FILE);
const ENV_TOKEN = "ghp_gateway_test_token_0001";
if (!hasSettingsToken) process.env.GITHUB_TOKEN = ENV_TOKEN;

const results = [];
let seq = 0;
function check(name, ok, detail = "") {
	seq += 1;
	results.push({ seq, name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${String(seq).padStart(2, "0")} ${name}${ok ? "" : ` — ${detail}`}`);
}

// ---- fetch 替身：只认网关会用到的两个端点，其余一律 599 ----
const realFetch = globalThis.fetch;
const postCalls = [];
let pullState = "open";
let postShouldFail = false;
let pullShouldFail = false;
globalThis.fetch = async (url, init = {}) => {
	const u = new URL(String(url));
	const method = init.method ?? "GET";
	if (method === "POST" && /\/issues\/\d+\/comments$/.test(u.pathname)) {
		postCalls.push({ path: u.pathname, body: JSON.parse(init.body ?? "{}"), auth: init.headers?.Authorization ?? "" });
		if (postShouldFail) return { ok: false, status: 500, json: async () => ({}) };
		const repo = u.pathname.split("/").slice(2, 4).join("/");
		const n = u.pathname.match(/\/issues\/(\d+)\/comments/)[1];
		return { ok: true, status: 201, json: async () => ({ html_url: `https://github.com/${repo}/pull/${n}#issuecomment-4242` }) };
	}
	if (method === "GET" && /\/pulls\/\d+$/.test(u.pathname)) {
		if (pullShouldFail) return { ok: false, status: 500, json: async () => ({}) };
		return { ok: true, status: 200, json: async () => ({ state: pullState }) };
	}
	return { ok: false, status: 599, json: async () => ({}) };
};

const artifactCalls = [];
const saveArtifactStub = (input) => {
	artifactCalls.push(input);
	return { id: "stub-artifact-id", ...input };
};

try {
	const { createFinding, getFinding, updateFinding } = await import("../lib/findings.mjs");
	const { approveApproval, listApprovals, rejectApproval } = await import("../lib/approvals.mjs");
	const { gatewayExecuteWrite } = await import("../lib/gateway.mjs");
	const { listAudit } = await import("../lib/audit.mjs");
	const { listNotifications } = await import("../lib/notify.mjs");
	const { githubToken } = await import("../lib/settings.mjs");
	const token = githubToken();

	const BODY = "晨间分诊提醒：这个 PR 尚未获得任何批准（APPROVED）审查，请维护者抽空审查并给出结论。";
	function makeFinding(overrides = {}) {
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
	const auditFor = (id) => listAudit({ findingId: id });

	// 1. 负向：未批准直调网关 → denied/not_approved，写 API 0 次，审计有 denied
	{
		const f = makeFinding({ subject: "101" });
		const before = postCalls.length;
		const r = await gatewayExecuteWrite({ findingId: f.id, intent: f.writeIntent });
		check(
			"负向：未经批准直调网关被拒（not_approved），替身写 API 0 次，审计有 denied",
			r.ok === false && r.result === "denied" && r.reason === "not_approved" && postCalls.length === before && auditFor(f.id).some((x) => x.result === "denied" && x.reason === "not_approved"),
			JSON.stringify(r),
		);
	}

	// 2. 正向：批准 → 网关恰好发一次评论（参数=批准的仓库/PR/正文），状态 executed，
	//    审计 approved + executed（带评论链接），审计 artifact 落盘（替身），通知 approval.executed
	let executedFinding;
	{
		const f = makeFinding({ subject: "42" });
		executedFinding = f;
		const before = postCalls.length;
		const out = await approveApproval(f.id, { saveArtifactFn: saveArtifactStub });
		const call = postCalls[before];
		const recs = auditFor(f.id);
		check(
			"正向：批准后替身写 API 恰好一次，参数为批准的仓库/PR/正文且带令牌，Finding 转 executed",
			out.execution.ok === true &&
				postCalls.length === before + 1 &&
				call.path === "/repos/NorthAdb/LinkForge/issues/42/comments" &&
				call.body.body === BODY &&
				call.auth === `Bearer ${token}` &&
				getFinding(f.id).status === "executed" &&
				out.approval.commentUrl === "https://github.com/NorthAdb/LinkForge/pull/42#issuecomment-4242",
			JSON.stringify(out.execution),
		);
		check(
			"正向审计：同一 Finding 可追到 approved 与 executed（含 commentUrl），且有网关执行 artifact 与 approval.executed 通知",
			recs.some((x) => x.result === "approved") &&
				recs.some((x) => x.result === "executed" && x.commentUrl?.includes("issuecomment-4242")) &&
				artifactCalls.length === 1 &&
				artifactCalls[0].kind === "gateway-execution" &&
				listNotifications().some((n) => n.type === "approval.executed" && n.findingId === f.id) &&
				!listApprovals().some((a) => a.findingId === f.id),
			`审计=${recs.map((x) => x.result).join(",")}`,
		);
	}

	// 3. 驳回：写 API 0 次，状态 rejected，审计有 rejected
	{
		const f = makeFinding({ subject: "103" });
		const before = postCalls.length;
		const a = rejectApproval(f.id);
		check(
			"驳回：替身写 API 0 次，状态 rejected，审计有 rejected",
			a.status === "rejected" && postCalls.length === before && auditFor(f.id).some((x) => x.result === "rejected"),
			`status=${a.status}`,
		);
		// 4. 已关闭再批准 → 409
		let threw = null;
		try {
			await approveApproval(f.id, { saveArtifactFn: saveArtifactStub });
		} catch (err) {
			threw = err;
		}
		check("已关闭（rejected）再批准被拒（409），不产生写调用", threw?.status === 409 && postCalls.length === before, `threw=${threw?.status}`);
	}

	// 5. 过期：open 且已过期 → 批准时被惰性清理转 expired 并 409；approved 后过期 → 网关 denied/expired
	{
		const f = makeFinding({ subject: "104", expiresAt: new Date(Date.now() - 1000).toISOString() });
		let threw = null;
		try {
			await approveApproval(f.id, { saveArtifactFn: saveArtifactStub });
		} catch (err) {
			threw = err;
		}
		const g = makeFinding({ subject: "105" });
		updateFinding(g.id, { status: "approved", expiresAt: new Date(Date.now() - 1000).toISOString() });
		const before = postCalls.length;
		const r = await gatewayExecuteWrite({ findingId: g.id, intent: g.writeIntent });
		check(
			"过期不能批准/执行：open 过期批准回 409 且状态转 expired；approved 过期被网关 denied/expired，写 API 0 次",
			threw?.status === 409 && getFinding(f.id).status === "expired" && r.result === "denied" && r.reason === "expired" && getFinding(g.id).status === "expired" && postCalls.length === before,
			`threw=${threw?.status} r=${JSON.stringify(r)}`,
		);
	}

	// 6. 意图被改：approved 后拿篡改正文来执行 → denied/intent_mismatch，写 API 0 次
	{
		const f = makeFinding({ subject: "106" });
		updateFinding(f.id, { status: "approved" });
		const before = postCalls.length;
		const r = await gatewayExecuteWrite({ findingId: f.id, intent: { ...f.writeIntent, body: "被篡改的正文" } });
		check(
			"意图被改被拒：请求动作与 Finding.writeIntent 不逐字一致 → denied/intent_mismatch，写 API 0 次",
			r.result === "denied" && r.reason === "intent_mismatch" && postCalls.length === before,
			JSON.stringify(r),
		);
	}

	// 7. 仓库未绑定 bot → denied/repo_not_bound
	{
		const f = makeFinding({ repo: "Acme/Widgets", subject: "107", evidenceUrl: "https://github.com/Acme/Widgets/pull/42" });
		updateFinding(f.id, { status: "approved" });
		const before = postCalls.length;
		const r = await gatewayExecuteWrite({ findingId: f.id, intent: f.writeIntent });
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
		appendFileSync(process.env.PIPER_FINDINGS_FILE, JSON.stringify(raw) + "\n", "utf8");
		const before = postCalls.length;
		const r = await gatewayExecuteWrite({ findingId: raw.id, intent: raw.writeIntent });
		check(
			"不支持的意图被拒：kind 非 pr_comment → denied/unsupported_intent，写 API 0 次",
			r.result === "denied" && r.reason === "unsupported_intent" && postCalls.length === before,
			JSON.stringify(r),
		);
	}

	// 9. 无令牌：批准执行明确失败（no_token）、保持 approved、可重试成功（本机有设置令牌时跳过）
	if (!hasSettingsToken) {
		const f = makeFinding({ subject: "109" });
		delete process.env.GITHUB_TOKEN;
		const before = postCalls.length;
		const out1 = await approveApproval(f.id, { saveArtifactFn: saveArtifactStub });
		const failedOk =
			out1.execution.ok === false &&
			out1.execution.result === "failed" &&
			out1.execution.reason === "no_token" &&
			getFinding(f.id).status === "approved" &&
			postCalls.length === before &&
			auditFor(f.id).some((x) => x.result === "failed" && x.reason === "no_token");
		process.env.GITHUB_TOKEN = ENV_TOKEN;
		const out2 = await approveApproval(f.id, { saveArtifactFn: saveArtifactStub });
		check(
			"无令牌不假成功：execution failed/no_token、Finding 保持 approved、审计有 failed；补上令牌后重试即 executed",
			failedOk && out2.execution.ok === true && getFinding(f.id).status === "executed" && postCalls.length === before + 1,
			`out1=${JSON.stringify(out1.execution)} out2=${JSON.stringify(out2.execution)}`,
		);
	} else {
		check("无令牌用例：本机存在 settings-github.json（文件优先），跳过 env 令牌操纵", true, "skipped");
	}

	// 10. PR 已关闭：执行前复检失败 → failed/pr_not_open，保持 approved，收件箱 lastError 可见，写 API 0 次
	{
		const f = makeFinding({ subject: "110" });
		pullState = "closed";
		const before = postCalls.length;
		const out = await approveApproval(f.id, { saveArtifactFn: saveArtifactStub });
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
		const r = await gatewayExecuteWrite({ findingId: f.id, intent: f.writeIntent });
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
		const out = await approveApproval(f.id, { saveArtifactFn: saveArtifactStub });
		postShouldFail = false;
		check(
			"写接口失败：execution failed/comment_failed*，Finding 保持 approved，审计有 failed",
			out.execution.ok === false && String(out.execution.reason).startsWith("comment_failed") && getFinding(f.id).status === "approved" && auditFor(f.id).some((x) => x.result === "failed"),
			JSON.stringify(out.execution),
		);
	}

	// 13. 审计完整性：字段形状齐全且全文件不含令牌全文
	{
		const rec = auditFor(executedFinding.id).find((x) => x.result === "executed");
		const rawAudit = readFileSync(process.env.PIPER_AUDIT_FILE, "utf8");
		check(
			"审计样例字段：ts/botId/intent{kind,repo,prNumber,bodyLength,bodyPreview}/result/findingId/approvalId/commentUrl 齐全且审计文件不含令牌",
			Boolean(rec) &&
				typeof rec.ts === "string" &&
				rec.botId === "repo-keeper" &&
				rec.intent?.kind === "pr_comment" &&
				rec.intent?.repo === "NorthAdb/LinkForge" &&
				rec.intent?.prNumber === 42 &&
				rec.intent?.bodyLength === BODY.length &&
				rec.intent?.bodyPreview === BODY.slice(0, 120) &&
				rec.findingId === executedFinding.id &&
				rec.approvalId === executedFinding.id &&
				!rawAudit.includes(token),
			JSON.stringify(rec),
		);
	}

	// 14. 绕过断言：除 gateway.mjs 外，lib 与 server 没有任何文件构造 GitHub 评论写端点；
	//     扫描与对话层文件不得同时出现 api.github.com 与 POST 写调用。
	{
		const libFiles = readdirSync(join(APP_DIR, "lib")).filter((f) => f.endsWith(".mjs"));
		const sources = Object.fromEntries(libFiles.map((f) => [f, readFileSync(join(APP_DIR, "lib", f), "utf8")]));
		sources["server.mjs"] = readFileSync(join(APP_DIR, "server.mjs"), "utf8");
		const withComments = Object.entries(sources)
			.filter(([, src]) => src.includes("/comments"))
			.map(([name]) => name);
		const readLayers = ["scan.mjs", "kernel.mjs", "approvals.mjs", "findings.mjs"];
		const readLayerClean = readLayers.every((name) => !(sources[name].includes("api.github.com") && sources[name].includes('"POST"')));
		check(
			"无绕过：只有 gateway.mjs 构造 /comments 写端点；scan/kernel/approvals/findings 无 GitHub POST 写调用",
			JSON.stringify(withComments) === JSON.stringify(["gateway.mjs"]) && readLayerClean,
			`withComments=${withComments.join(",")}`,
		);
	}
} finally {
	globalThis.fetch = realFetch;
	delete process.env.PIPER_FINDINGS_FILE;
	delete process.env.PIPER_AUDIT_FILE;
	delete process.env.PIPER_NOTIFICATIONS_FILE;
	if (!hasSettingsToken) delete process.env.GITHUB_TOKEN;
	rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
