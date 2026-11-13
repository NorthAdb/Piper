// 工具网关测试（P2-3）：对话写工具 github_comment 走循环闸 + 薄网关的全链路。
// A 段（进程内）：PolicyEngine 仓库绑定、ToolApproval 存储状态机、网关
// toolApprovalId 路径（fetch 替身）——未批准被拒、批准后恰好一次、快照不符
// denied + 记录 failed、重复执行被拒、崩溃重放靠幂等标记复用。
// B 段（真实 server 子进程 + 模型替身 + GitHub 替身）：对话提出评论 → SSE
// 出现 tool phase "pending" 且无 start、替身写 API 0 次；批准后恰好一条、
// 审计可按 toolApprovalId 追溯；驳回零写入；杀进程后会话 JSONL 里该调用
// 是 pending 不是 error，重启批准仍恰好一次（恢复路径 + 幂等）；未绑定仓
// 被策略 deny 且不产待批；主 bot 的模型请求里根本没有 github_comment。
// 用法（在 apps/piper 下）：node dist/scripts/test-tool-gateway.js
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_DIR } from "./app-dir.ts";

const results: { seq: number; name: string; ok: boolean }[] = [];
let seq = 0;
function check(name: string, ok: boolean, detail = ""): void {
	seq += 1;
	results.push({ seq, name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${String(seq).padStart(2, "0")} ${name}${ok ? "" : ` — ${detail}`}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | null | undefined | Promise<T | null | undefined>, timeoutMs = 25000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error("waitFor 超时");
		await sleep(200);
	}
}

// ================= A 段：进程内 =================
const tmpA = mkdtempSync(join(tmpdir(), "piper-toolgw-a-"));
process.env.PIPER_DATA_DIR = join(tmpA, "data");
process.env.PIPER_TOOL_APPROVALS_FILE = join(tmpA, "tool-approvals.json");
process.env.PIPER_AUDIT_FILE = join(tmpA, "audit.jsonl");
process.env.PIPER_GITHUB_API_BASE = "http://gh-stub.invalid";
process.env.GITHUB_TOKEN = ["tg", "stub", "token"].join("-");

const realFetch = globalThis.fetch;
interface StubPost {
	path: string;
	body: string;
}
const aPosts: StubPost[] = [];
const aComments = new Map<string, { body: string; html_url: string }[]>();
globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
	const url = String(input);
	const method = init?.method ?? "GET";
	const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
	let m: RegExpExecArray | null;
	if ((m = /^http:\/\/gh-stub\.invalid\/repos\/(.+)\/pulls\/(\d+)$/.exec(url))) return json({ state: "open", draft: false, head: { sha: "stub-head" } });
	if ((m = /^http:\/\/gh-stub\.invalid\/repos\/(.+)\/issues\/(\d+)$/.exec(url))) return json({ state: "open" });
	if ((m = /^http:\/\/gh-stub\.invalid\/repos\/(.+)\/issues\/(\d+)\/comments\?/.exec(url))) return json(aComments.get(`${m[1]}#${m[2]}`) ?? []);
	if ((m = /^http:\/\/gh-stub\.invalid\/repos\/(.+)\/issues\/(\d+)\/comments$/.exec(url)) && method === "POST") {
		const body = JSON.parse(init?.body ?? "{}") as { body?: string };
		aPosts.push({ path: url, body: body.body ?? "" });
		const comment = { body: body.body ?? "", html_url: `http://gh-stub.invalid/${m[1]}/issues/${m[2]}#c${aPosts.length}` };
		const key = `${m[1]}#${m[2]}`;
		aComments.set(key, [...(aComments.get(key) ?? []), comment]);
		return json(comment);
	}
	return { ok: false, status: 599, json: async () => ({ message: "unstubbed" }) };
}) as typeof fetch;

const { PolicyEngine } = await import("../lib/policy.ts");
const toolApprovals = await import("../lib/tool-approvals.ts");
const { gatewayExecuteWrite } = await import("../lib/gateway.ts");
const { listAudit } = await import("../lib/audit.ts");
const { ensureData } = await import("../lib/store.ts");
ensureData();

const KEEPER = "repo-keeper";
const GOOD_ARGS = { repo: "NorthAdb/LinkForge", kind: "pr_comment", number: 1, body: "请尽快处理这个 PR。" };

check("A1 策略：绑定仓的 github_comment → ask", PolicyEngine.decide({ botId: KEEPER, toolName: "github_comment", args: GOOD_ARGS }) === "ask");
check(
	"A2 策略：未绑定仓 → deny",
	PolicyEngine.decide({ botId: KEEPER, toolName: "github_comment", args: { ...GOOD_ARGS, repo: "NorthAdb/NotBound" } }) === "deny",
);
check(
	"A3 策略：参数形状不全（空正文/坏种类/编号非正整数）→ deny",
	PolicyEngine.decide({ botId: KEEPER, toolName: "github_comment", args: { ...GOOD_ARGS, body: " " } }) === "deny" &&
		PolicyEngine.decide({ botId: KEEPER, toolName: "github_comment", args: { ...GOOD_ARGS, kind: "label" } }) === "deny" &&
		PolicyEngine.decide({ botId: KEEPER, toolName: "github_comment", args: { ...GOOD_ARGS, number: 0 } }) === "deny" &&
		PolicyEngine.decide({ botId: KEEPER, toolName: "github_comment", args: { ...GOOD_ARGS, number: 1.5 } }) === "deny",
);

const recA = toolApprovals.createToolApproval({ botId: KEEPER, sessionId: "s-a", toolCallId: "call-a", toolName: "github_comment", argsSnapshot: GOOD_ARGS });
const recDup = toolApprovals.createToolApproval({ botId: KEEPER, sessionId: "s-a", toolCallId: "call-a", toolName: "github_comment", argsSnapshot: GOOD_ARGS });
let illegalThrew = false;
try {
	toolApprovals.updateToolApproval(recA.id, { status: "executed" });
} catch {
	illegalThrew = true;
}
check(
	"A4 存储：新建 pending、同 (session,toolCall) 重复创建复用同一条、非法迁移抛错、快照整形正确",
	recA.status === "pending" &&
		recDup.id === recA.id &&
		illegalThrew &&
		JSON.stringify(toolApprovals.toolIntentSnapshotOf(recA)) ===
			JSON.stringify({ kind: "pr_comment", repo: "NorthAdb/LinkForge", prNumber: 1, issueNumber: null, body: GOOD_ARGS.body }),
	`rec=${JSON.stringify(recA)}`,
);

const outPending = await gatewayExecuteWrite({ toolApprovalId: recA.id, snapshot: toolApprovals.toolIntentSnapshotOf(recA) });
check(
	"A5 网关：未批准（pending）直调 → denied/not_approved，写 API 0 次",
	outPending.ok === false && outPending.result === "denied" && outPending.reason === "not_approved" && aPosts.length === 0,
	JSON.stringify(outPending),
);

toolApprovals.updateToolApproval(recA.id, { status: "approved" });
const outOk = await gatewayExecuteWrite({ toolApprovalId: recA.id, snapshot: toolApprovals.toolIntentSnapshotOf(recA) });
const auditA = listAudit({ toolApprovalId: recA.id });
check(
	"A6 网关：批准后执行恰好一次，正文含快照与本记录幂等标记，记录 executed，审计有 executing/executed",
	outOk.ok === true &&
		aPosts.length === 1 &&
		aPosts[0].body.includes(GOOD_ARGS.body) &&
		aPosts[0].body.includes(`<!-- piper:approval=${recA.id} -->`) &&
		toolApprovals.getToolApproval(recA.id)?.status === "executed" &&
		auditA.some((x) => x.result === "executing") &&
		auditA.some((x) => x.result === "executed"),
	`out=${JSON.stringify(outOk)} posts=${aPosts.length}`,
);

const outAgain = await gatewayExecuteWrite({ toolApprovalId: recA.id, snapshot: toolApprovals.toolIntentSnapshotOf(recA) });
check(
	"A7 网关：已 executed 再执行 → denied/already_executed，仍只发过一次",
	outAgain.ok === false && outAgain.reason === "already_executed" && aPosts.length === 1,
	JSON.stringify(outAgain),
);

const recB = toolApprovals.createToolApproval({ botId: KEEPER, sessionId: "s-b", toolCallId: "call-b", toolName: "github_comment", argsSnapshot: GOOD_ARGS });
toolApprovals.updateToolApproval(recB.id, { status: "approved" });
const tampered = { ...toolApprovals.toolIntentSnapshotOf(recB)!, body: "被篡改的正文" };
const outTampered = await gatewayExecuteWrite({ toolApprovalId: recB.id, snapshot: tampered });
check(
	"A8 网关：快照与落盘记录不符 → denied/intent_changed，记录置 failed，写 API 仍 1 次",
	outTampered.ok === false &&
		outTampered.reason === "intent_changed" &&
		toolApprovals.getToolApproval(recB.id)?.status === "failed" &&
		aPosts.length === 1,
	JSON.stringify(outTampered),
);

const recC = toolApprovals.createToolApproval({
	botId: KEEPER,
	sessionId: "s-c",
	toolCallId: "call-c",
	toolName: "github_comment",
	argsSnapshot: { ...GOOD_ARGS, repo: "NorthAdb/NotBound" },
});
toolApprovals.updateToolApproval(recC.id, { status: "approved" });
const outUnbound = await gatewayExecuteWrite({ toolApprovalId: recC.id, snapshot: toolApprovals.toolIntentSnapshotOf(recC) });
check(
	"A9 网关：仓库未绑定 → denied/repo_not_bound，记录置 failed",
	outUnbound.ok === false && outUnbound.reason === "repo_not_bound" && toolApprovals.getToolApproval(recC.id)?.status === "failed",
	JSON.stringify(outUnbound),
);

const recD = toolApprovals.createToolApproval({ botId: KEEPER, sessionId: "s-d", toolCallId: "call-d", toolName: "github_comment", argsSnapshot: { ...GOOD_ARGS, number: 7 } });
toolApprovals.updateToolApproval(recD.id, { status: "approved" });
// 模拟「上次 POST 成功后进程崩溃」：评论已带本记录标记存在于 GitHub 侧。
aComments.set("NorthAdb/LinkForge#7", [{ body: `${GOOD_ARGS.body}\n\n<!-- piper:approval=${recD.id} -->`, html_url: "http://gh-stub.invalid/prev" }]);
const postsBeforeD = aPosts.length;
const outReplay = await gatewayExecuteWrite({ toolApprovalId: recD.id, snapshot: toolApprovals.toolIntentSnapshotOf(recD) });
check(
	"A10 网关：崩溃重放——标记已存在则复用不重发，记录 executed",
	outReplay.ok === true && outReplay.reused === true && aPosts.length === postsBeforeD && toolApprovals.getToolApproval(recD.id)?.status === "executed",
	JSON.stringify(outReplay),
);

globalThis.fetch = realFetch;

// ================= B 段：真实 server + 双替身 =================
// ---- GitHub 替身（HTTP）：网关用到的端点，其余 404 ----
const ghPosts: { path: string; body: string }[] = [];
const ghComments = new Map<string, { body: string; html_url: string }[]>();
const ghStub: Server = createServer((reqHttp, resHttp) => {
	const url = reqHttp.url ?? "";
	let raw = "";
	reqHttp.on("data", (c) => (raw += c));
	reqHttp.on("end", () => {
		const send = (body: unknown) => {
			resHttp.writeHead(200, { "Content-Type": "application/json" });
			resHttp.end(JSON.stringify(body));
		};
		let m: RegExpExecArray | null;
		if ((m = /^\/repos\/(.+)\/pulls\/(\d+)$/.exec(url))) return send({ state: "open", draft: false, head: { sha: "stub-head" } });
		if ((m = /^\/repos\/(.+)\/issues\/(\d+)$/.exec(url))) return send({ state: "open" });
		if ((m = /^\/repos\/(.+)\/issues\/(\d+)\/comments\?/.exec(url))) return send(ghComments.get(`${m[1]}#${m[2]}`) ?? []);
		if ((m = /^\/repos\/(.+)\/issues\/(\d+)\/comments$/.exec(url)) && reqHttp.method === "POST") {
			const body = (JSON.parse(raw || "{}") as { body?: string }).body ?? "";
			ghPosts.push({ path: url, body });
			const comment = { body, html_url: `http://gh.invalid/${m[1]}/issues/${m[2]}#c${ghPosts.length}` };
			const key = `${m[1]}#${m[2]}`;
			ghComments.set(key, [...(ghComments.get(key) ?? []), comment]);
			return send(comment);
		}
		resHttp.writeHead(404, { "Content-Type": "application/json" });
		resHttp.end(JSON.stringify({ message: "not found" }));
	});
});
await new Promise<void>((r) => ghStub.listen(0, "127.0.0.1", () => r()));
const GH_BASE = `http://127.0.0.1:${(ghStub.address() as { port: number }).port}`;

// ---- 模型替身（HTTP，OpenAI 兼容 SSE）：按用户话术发 github_comment ----
// 桩代码是测试边界（外部数据形状），逐字段取用用 any，与 test-webfetch 同口径。
const modelRequests: any[] = [];
let modelCallSeq = 0;
const MODEL_KEY = "toolgw-model-key";
const modelStub: Server = createServer((reqHttp, resHttp) => {
	if (!reqHttp.url?.startsWith("/v1/chat/completions")) {
		resHttp.writeHead(404, { "Content-Type": "application/json" });
		resHttp.end(JSON.stringify({ error: { message: "not found" } }));
		return;
	}
	let raw = "";
	reqHttp.on("data", (c) => (raw += c));
	reqHttp.on("end", () => {
		let body: any = {};
		try {
			body = JSON.parse(raw || "{}");
		} catch {
			/* 忽略 */
		}
		modelRequests.push(body);
		const model = body.model || "stub-model";
		const sendChunks = (chunks: Record<string, unknown>[], finish: string) => {
			resHttp.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
			const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
				`data: ${JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1762732800, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
			resHttp.write(chunk({ role: "assistant" }));
			for (const d of chunks) resHttp.write(chunk(d));
			resHttp.write(chunk({}, finish));
			resHttp.end("data: [DONE]\n\n");
		};
		if (!body.stream) {
			resHttp.writeHead(200, { "Content-Type": "application/json" });
			resHttp.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1762732800, model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
			return;
		}
		const messages: any[] = body.messages ?? [];
		const last = messages[messages.length - 1] ?? {};
		if (last.role === "tool") {
			sendChunks([{ content: "已根据工具结果回复。" }], "stop");
			return;
		}
		const toolNames: string[] = (body.tools ?? []).map((t: any) => t.function?.name ?? t.name);
		const lastUser = [...messages].reverse().find((mm: any) => mm.role === "user");
		const userText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
		if (toolNames.includes("github_comment")) {
			const args = userText.includes("未绑定")
				? { repo: "NorthAdb/NotBound", kind: "pr_comment", number: 9, body: "不应发出的评论" }
				: { repo: "NorthAdb/LinkForge", kind: "pr_comment", number: 1, body: "请尽快处理这个 PR。" };
			modelCallSeq += 1;
			const argsJson = JSON.stringify(args);
			sendChunks(
				[
					{ tool_calls: [{ index: 0, id: `call_tg_${modelCallSeq}`, type: "function", function: { name: "github_comment", arguments: "" } }] },
					{ tool_calls: [{ index: 0, function: { arguments: argsJson } }] },
				],
				"tool_calls",
			);
			return;
		}
		sendChunks([{ content: "好的（没有可用工具时的普通回复）。" }], "stop");
	});
});
await new Promise<void>((r) => modelStub.listen(0, "127.0.0.1", () => r()));
const MODEL_BASE = `http://127.0.0.1:${(modelStub.address() as { port: number }).port}/v1`;

const tmpB = mkdtempSync(join(tmpdir(), "piper-toolgw-b-"));
const DATA_B = join(tmpB, "data");
const PORT = Number(process.env.TOOLGW_PORT || 4397);
const BASE = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess | null = null;
let serverLog = "";
let cookie = "";

function startServer(): ChildProcess {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PORT: String(PORT),
		PIPER_DATA_DIR: DATA_B,
		PIPER_GITHUB_API_BASE: GH_BASE,
		GITHUB_TOKEN: ["tg", "stub", "token"].join("-"),
		PIPER_TEST_MODE: "1",
	};
	delete env.PIPER_TOKEN;
	delete env.PIPER_HOST;
	for (const k of ["PIPER_MODEL_API_KEY", "OPENAI_API_KEY", "PIPER_MODEL_BASE_URL", "PIPER_MODEL_ID", "PIPER_TOOL_APPROVALS_FILE", "PIPER_AUDIT_FILE"]) delete env[k];
	const child = spawn("node", ["dist/server.js"], { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
	child.stdout?.on("data", (d) => (serverLog += d));
	child.stderr?.on("data", (d) => (serverLog += d));
	return child;
}
async function waitReady(): Promise<boolean> {
	for (let i = 0; i < 60; i++) {
		if (!proc || proc.exitCode !== null) return false;
		try {
			const res = await fetch(`${BASE}/api/bots`);
			if (res.status === 401) return true;
		} catch {
			/* 还没起来 */
		}
		await sleep(250);
	}
	return false;
}
async function login(): Promise<boolean> {
	const res = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "piper-dev" }) });
	cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
	return res.status === 200 && Boolean(cookie);
}
async function req(path: string, init: RequestInit = {}): Promise<{ status: number; json: any }> {
	const res = await fetch(BASE + path, { ...init, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(init.headers || {}) } });
	const text = await res.text();
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		/* 非 JSON */
	}
	return { status: res.status, json };
}
async function chatEvents(botId: string, message: string): Promise<{ event: string; data: any }[]> {
	const res = await fetch(`${BASE}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Cookie: cookie },
		body: JSON.stringify({ botId, message }),
		signal: AbortSignal.timeout(60000),
	});
	const raw = await res.text();
	const events: { event: string; data: any }[] = [];
	for (const block of raw.split("\n\n")) {
		const ev = /event: (.*)/.exec(block)?.[1];
		const data = /data: (.*)/s.exec(block)?.[1];
		if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
	}
	return events;
}
async function toolApprovalsViaApi(): Promise<any[]> {
	const out = await req("/api/approvals");
	return [...(out.json?.approvals ?? []), ...(out.json?.closed ?? [])].filter((a: any) => a.kind === "tool_call");
}
function readSessionEntries(botId: string): any[] {
	const file = join(DATA_B, "sessions", `${botId}.jsonl`);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
function readAuditEntries(): any[] {
	const file = join(DATA_B, "audit.jsonl");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

try {
	proc = startServer();
	check("B1 被测 server 启动并登录成功", (await waitReady()) && (await login()), serverLog.slice(-300));
	await req("/api/settings/model", { method: "PUT", body: JSON.stringify({ baseUrl: MODEL_BASE, modelId: "stub-model", apiKey: MODEL_KEY }) });

	// ---- 负向（循环）：提出评论 → 待批，写 API 0 次 ----
	const ev1 = await chatEvents("repo-keeper", "请给 LinkForge 的 PR 1 留评催一下");
	const toolEv1 = ev1.filter((e) => e.event === "tool");
	const pendingItem = await waitFor(async () => (await toolApprovalsViaApi()).find((a) => a.status === "pending"));
	check(
		"B2 对话提出 github_comment → SSE 出现 phase pending 且无 start；收件箱有 kind=tool_call 的 pending 项，快照与模型所提一致",
		toolEv1.some((e) => e.data?.phase === "pending" && e.data?.name === "github_comment") &&
			!toolEv1.some((e) => e.data?.phase === "start") &&
			pendingItem.argsSnapshot?.repo === "NorthAdb/LinkForge" &&
			pendingItem.argsSnapshot?.kind === "pr_comment" &&
			pendingItem.argsSnapshot?.number === 1,
		`toolEv=${JSON.stringify(toolEv1)} item=${JSON.stringify(pendingItem)}`,
	);
	check("B3 批准前替身 GitHub 写 API 为 0 次", ghPosts.length === 0, `posts=${ghPosts.length}`);

	// ---- 正向：批准 → 恰好一条，审计可追 ----
	const approveRes = await req(`/api/approvals/${pendingItem.id}/approve`, { method: "POST", body: JSON.stringify({}) });
	const executed = await waitFor(async () => (await toolApprovalsViaApi()).find((a) => a.id === pendingItem.id && a.status === "executed"));
	const auditB = readAuditEntries().filter((x) => x.toolApprovalId === pendingItem.id);
	check(
		"B4 批准后评论恰好发一次（正文=快照+本记录标记），记录 executed，审计按 toolApprovalId 有 approved/executing/executed",
		approveRes.status === 200 &&
			Boolean(executed) &&
			ghPosts.length === 1 &&
			ghPosts[0].body.includes("请尽快处理这个 PR。") &&
			ghPosts[0].body.includes(`<!-- piper:approval=${pendingItem.id} -->`) &&
			auditB.some((x) => x.result === "approved") &&
			auditB.some((x) => x.result === "executing") &&
			auditB.some((x) => x.result === "executed"),
		`approve=${approveRes.status} posts=${JSON.stringify(ghPosts)} audit=${JSON.stringify(auditB.map((x) => x.result))}`,
	);

	// ---- 驳回：零写入，原 run 干净收尾 ----
	const ev2 = await chatEvents("repo-keeper", "再给 PR 1 留评催一下");
	const pending2 = await waitFor(async () => (await toolApprovalsViaApi()).find((a) => a.status === "pending" && a.id !== pendingItem.id));
	await req(`/api/approvals/${pending2.id}/reject`, { method: "POST", body: JSON.stringify({}) });
	const rejected = await waitFor(async () => (await toolApprovalsViaApi()).find((a) => a.id === pending2.id && a.status === "rejected"));
	const woundDown = await waitFor(() => readSessionEntries("repo-keeper").find((e) => e.role === "tool" && e.toolCallId === pending2.toolCallId && e.status === "error"));
	check(
		"B5 驳回后记录 rejected、写 API 仍 1 次、会话里该调用以 error 终态落盘（原 run 已收尾）",
		Boolean(ev2) && Boolean(rejected) && ghPosts.length === 1 && Boolean(woundDown),
		`posts=${ghPosts.length} entries=${JSON.stringify(readSessionEntries("repo-keeper").filter((e) => e.toolCallId === pending2.toolCallId))}`,
	);

	// ---- 重启后再批准：JSONL 是 pending 不是 error，恢复路径恰好一次 ----
	await chatEvents("repo-keeper", "第三次给 PR 1 留评");
	const pending3 = await waitFor(async () => (await toolApprovalsViaApi()).find((a) => a.status === "pending"));
	proc?.kill("SIGKILL");
	await waitFor(() => (proc && (proc.exitCode !== null || proc.signalCode) ? true : null), 10000);
	const pendingEntry = readSessionEntries("repo-keeper").find((e) => e.role === "tool" && e.toolCallId === pending3.toolCallId);
	check(
		"B6 杀进程后会话 JSONL 里该调用 status 为 pending（不是 error），待批记录仍在",
		pendingEntry?.status === "pending",
		`entry=${JSON.stringify(pendingEntry)}`,
	);
	proc = startServer();
	const rebooted = (await waitReady()) && (await login());
	await req("/api/settings/model", { method: "PUT", body: JSON.stringify({ baseUrl: MODEL_BASE, modelId: "stub-model", apiKey: MODEL_KEY }) });
	await req(`/api/approvals/${pending3.id}/approve`, { method: "POST", body: JSON.stringify({}) });
	const executed3 = await waitFor(async () => (await toolApprovalsViaApi()).find((a) => a.id === pending3.id && a.status === "executed"));
	const reapprove = await req(`/api/approvals/${pending3.id}/approve`, { method: "POST", body: JSON.stringify({}) });
	check(
		"B7 重启后批准仍恰好发一次（恢复路径），记录 executed；再次批准回 409",
		rebooted && Boolean(executed3) && ghPosts.length === 2 && reapprove.status === 409,
		`posts=${ghPosts.length} reapprove=${reapprove.status}`,
	);

	// ---- 绑定仓：未绑定 → deny、无待批、零写入 ----
	const beforeDeny = (await toolApprovalsViaApi()).length;
	const evDeny = await chatEvents("repo-keeper", "给未绑定仓库 NotBound 的 PR 9 留评");
	const denyTool = evDeny.filter((e) => e.event === "tool");
	check(
		"B8 未绑定仓 → 策略 deny：tool end 为 error、无 pending 相位、无新待批记录、写 API 不变",
		denyTool.some((e) => e.data?.phase === "end" && e.data?.detail?.isError) &&
			!denyTool.some((e) => e.data?.phase === "pending") &&
			(await toolApprovalsViaApi()).length === beforeDeny &&
			ghPosts.length === 2,
		`tool=${JSON.stringify(denyTool)}`,
	);

	// ---- 主 bot：工具根本不注册 ----
	const mainBefore = (await toolApprovalsViaApi()).length;
	await chatEvents("piper-main", "请给 LinkForge 的 PR 1 留评催一下");
	const mainReq = [...modelRequests].reverse().find((b) => b.stream);
	const mainTools: string[] = (mainReq?.tools ?? []).map((t: any) => t.function?.name ?? t.name);
	check(
		"B9 主 bot 的模型请求不含 github_comment，且不产生工具待批",
		!mainTools.includes("github_comment") && (await toolApprovalsViaApi()).length === mainBefore,
		`tools=${JSON.stringify(mainTools)}`,
	);
} finally {
	proc?.kill("SIGKILL");
	ghStub.close();
	modelStub.close();
	rmSync(tmpA, { recursive: true, force: true });
	rmSync(tmpB, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n== test-tool-gateway: ${results.length - failed.length}/${results.length} passed ==`);
if (failed.length) process.exit(1);
