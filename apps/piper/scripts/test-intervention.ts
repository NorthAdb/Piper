// 人的介入面测试（P2-4）：收件箱之外的服务端行为全链路。
// A 段（进程内）：ToolApproval 落盘纪律（原子写、损坏隔离不静默覆盖）与
// 改正文 updateToolApprovalBody 的状态/内容校验。
// B 段（真实 server 子进程 + 模型替身 + GitHub 替身）：待批产生通知
// （approval.pending 带 toolApprovalId）；批准前改正文（锁定字段改参回
// 400、快照不变，审计记最终正文，批准后按新正文恰好发一次）；审计接口
// 按 toolApprovalId 过滤；待批中中止（记录 cancelled、零写入、会话以
// error 终态落盘、再批准 409）；无 run 中止回 aborted:false；执行中中止
// （已发出的写按真实结果落账、同批不再有其他写）；同批双待批 + 杀进程
// 重启后恢复第二个（第一个已执行的绝不重发）；在途驳回回 409（B10，
// 记录保持 approved、在途写完成落 executed 恰好一次）；run-state
// （B11，无 run false / 待批停泊 true / 落定 false / 未登录 401）；
// 暂时性失败后驳回对照（B12，approved+error 未在途时驳回成功、零写入）；
// 中止记账（B13/B14，P2-9 试用后修复：纯文本生成中途中止发 aborted
// 不发 error、半截文本落 interrupted 条目、下一轮历史含半截文本）。
// 用法（在 apps/piper 下）：node dist/scripts/test-intervention.js
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const tmpA = mkdtempSync(join(tmpdir(), "piper-interv-a-"));
const TA_FILE = join(tmpA, "tool-approvals.json");
process.env.PIPER_DATA_DIR = join(tmpA, "data");
process.env.PIPER_TOOL_APPROVALS_FILE = TA_FILE;

const toolApprovals = await import("../lib/tool-approvals.ts");
const { ensureData } = await import("../lib/store.ts");
ensureData();

const GOOD_ARGS = { repo: "NorthAdb/LinkForge", kind: "pr_comment", number: 1, body: "原始正文" };
const recA = toolApprovals.createToolApproval({ botId: "repo-keeper", sessionId: "s-iv-a", toolCallId: "call-iv-a", toolName: "github_comment", argsSnapshot: GOOD_ARGS });
const onDisk = JSON.parse(readFileSync(TA_FILE, "utf8")) as { id: string }[];
check(
	"A1 原子落盘：写入后文件是完整 JSON 数组（含新记录），目录里不留 .tmp 残留",
	Array.isArray(onDisk) && onDisk.some((r) => r.id === recA.id) && !readdirSync(tmpA).some((f) => f.includes(".tmp-")),
	`files=${readdirSync(tmpA).join(",")}`,
);

// 损坏隔离：把文件写坏，读应回空表 + 原文件被改名隔离，随后写入从新表开始
writeFileSync(TA_FILE, "not-json{{{", "utf8");
const afterCorrupt = toolApprovals.listToolApprovals();
const quarantined = readdirSync(tmpA).filter((f) => f.startsWith("tool-approvals.json.corrupt-"));
const recB = toolApprovals.createToolApproval({ botId: "repo-keeper", sessionId: "s-iv-b", toolCallId: "call-iv-b", toolName: "github_comment", argsSnapshot: GOOD_ARGS });
const freshDisk = JSON.parse(readFileSync(TA_FILE, "utf8")) as { id: string }[];
check(
	"A2 损坏隔离：解析失败不当空表静默覆盖——原文件改名保留、新写入只含新记录",
	afterCorrupt.length === 0 &&
		quarantined.length === 1 &&
		readFileSync(join(tmpA, quarantined[0]), "utf8") === "not-json{{{" &&
		freshDisk.length === 1 &&
		freshDisk[0].id === recB.id,
	`quarantined=${quarantined.join(",")} fresh=${JSON.stringify(freshDisk.map((r) => r.id))}`,
);

// 改正文：pending 可改且只改 body；终态回 409；空正文/含秘密回 400
const edited = toolApprovals.updateToolApprovalBody(recB.id, "改后的正文");
toolApprovals.updateToolApproval(recB.id, { status: "approved" });
toolApprovals.updateToolApproval(recB.id, { status: "executed" });
let status409 = false;
let status400Empty = false;
let status400Secret = false;
try {
	toolApprovals.updateToolApprovalBody(recB.id, "再改");
} catch (e) {
	status409 = (e as { status?: number }).status === 409;
}
const recC = toolApprovals.createToolApproval({ botId: "repo-keeper", sessionId: "s-iv-c", toolCallId: "call-iv-c", toolName: "github_comment", argsSnapshot: GOOD_ARGS });
try {
	toolApprovals.updateToolApprovalBody(recC.id, "  ");
} catch (e) {
	status400Empty = (e as { status?: number }).status === 400;
}
try {
	toolApprovals.updateToolApprovalBody(recC.id, ["ghp", "_"].join("") + "x".repeat(36));
} catch (e) {
	status400Secret = (e as { status?: number }).status === 400;
}
check(
	"A3 改正文：pending 只改 body 其余字段不动；executed 回 409；空正文与疑似含秘密回 400 且快照不变",
	edited.argsSnapshot !== null &&
		typeof edited.argsSnapshot === "object" &&
		(edited.argsSnapshot as typeof GOOD_ARGS).body === "改后的正文" &&
		(edited.argsSnapshot as typeof GOOD_ARGS).repo === GOOD_ARGS.repo &&
		(edited.argsSnapshot as typeof GOOD_ARGS).number === GOOD_ARGS.number &&
		status409 &&
		status400Empty &&
		status400Secret &&
		(toolApprovals.getToolApproval(recC.id)?.argsSnapshot as typeof GOOD_ARGS).body === GOOD_ARGS.body,
	`edited=${JSON.stringify(edited.argsSnapshot)} 409=${status409} empty=${status400Empty} secret=${status400Secret}`,
);

// ================= B 段：真实 server + 双替身 =================
// ---- GitHub 替身：同 test-tool-gateway，另加 POST 延迟与在途计数 ----
const ghPosts: { path: string; body: string }[] = [];
const ghComments = new Map<string, { body: string; html_url: string }[]>();
let ghDelayMs = 0;
let ghFailPost = false;
let ghPostStarted = 0;
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
			if (ghFailPost) {
				resHttp.writeHead(500, { "Content-Type": "application/json" });
				resHttp.end(JSON.stringify({ message: "stub post failure" }));
				return;
			}
			ghPostStarted += 1;
			const repoPart = m[1];
			const numberPart = m[2];
			const body = (JSON.parse(raw || "{}") as { body?: string }).body ?? "";
			const key = `${repoPart}#${numberPart}`;
			const respond = () => {
				ghPosts.push({ path: url, body });
				const comment = { body, html_url: `http://gh.invalid/${repoPart}/issues/${numberPart}#c${ghPosts.length}` };
				ghComments.set(key, [...(ghComments.get(key) ?? []), comment]);
				send(comment);
			};
			if (ghDelayMs > 0) setTimeout(respond, ghDelayMs);
			else respond();
			return;
		}
		resHttp.writeHead(404, { "Content-Type": "application/json" });
		resHttp.end(JSON.stringify({ message: "not found" }));
	});
});
await new Promise<void>((r) => ghStub.listen(0, "127.0.0.1", () => r()));
const GH_BASE = `http://127.0.0.1:${(ghStub.address() as { port: number }).port}`;

// ---- 模型替身：单评论 / 双评论（同一条 assistant 消息两个调用）两套话术 ----
// B13（P2-9 中止记账）另加慢速长文话术，并留存全部请求体供断言历史回喂。
let modelCallSeq = 0;
const modelBodies: any[] = [];
const MODEL_KEY = "interv-model-key";
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
		modelBodies.push(body);
		const messages: any[] = body.messages ?? [];
		const last = messages[messages.length - 1] ?? {};
		if (last.role === "tool") {
			sendChunks([{ content: "已根据工具结果回复。" }], "stop");
			return;
		}
		const lastUser = [...messages].reverse().find((mm: any) => mm.role === "user");
		const userText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
		// 慢速长文（B13）：40 段、每段间隔 60ms 的纯文本，供生成中途中止；
		// 「继续」只回一段短文本（其请求体由测试断言含半截历史）。
		if (userText.includes("慢速长文") || userText.trim() === "继续") {
			resHttp.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
			const slowChunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
				`data: ${JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1762732800, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
			void (async () => {
				resHttp.write(slowChunk({ role: "assistant" }));
				const total = userText.includes("慢速长文") ? 40 : 1;
				for (let i = 1; i <= total; i++) {
					if (resHttp.destroyed || resHttp.writableEnded) return;
					resHttp.write(slowChunk({ content: `慢速长文第${i}段。` }));
					if (i < total) await sleep(60);
				}
				if (resHttp.destroyed || resHttp.writableEnded) return;
				resHttp.write(slowChunk({}, "stop"));
				resHttp.end("data: [DONE]\n\n");
			})();
			return;
		}
		modelCallSeq += 1;
		if (userText.includes("双评论")) {
			const args1 = JSON.stringify({ repo: "NorthAdb/LinkForge", kind: "pr_comment", number: 1, body: "第一条评论正文" });
			const args2 = JSON.stringify({ repo: "NorthAdb/LinkForge", kind: "pr_comment", number: 2, body: "第二条评论正文" });
			sendChunks(
				[
					{
						tool_calls: [
							{ index: 0, id: `call_iv_${modelCallSeq}_a`, type: "function", function: { name: "github_comment", arguments: "" } },
							{ index: 1, id: `call_iv_${modelCallSeq}_b`, type: "function", function: { name: "github_comment", arguments: "" } },
						],
					},
					{ tool_calls: [{ index: 0, function: { arguments: args1 } }] },
					{ tool_calls: [{ index: 1, function: { arguments: args2 } }] },
				],
				"tool_calls",
			);
			return;
		}
		const argsJson = JSON.stringify({ repo: "NorthAdb/LinkForge", kind: "pr_comment", number: 1, body: "原始正文" });
		sendChunks(
			[
				{ tool_calls: [{ index: 0, id: `call_iv_${modelCallSeq}`, type: "function", function: { name: "github_comment", arguments: "" } }] },
				{ tool_calls: [{ index: 0, function: { arguments: argsJson } }] },
			],
			"tool_calls",
		);
	});
});
await new Promise<void>((r) => modelStub.listen(0, "127.0.0.1", () => r()));
const MODEL_BASE = `http://127.0.0.1:${(modelStub.address() as { port: number }).port}/v1`;

const tmpB = mkdtempSync(join(tmpdir(), "piper-interv-b-"));
const DATA_B = join(tmpB, "data");
const PORT = Number(process.env.INTERV_PORT || 4399);
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
		GITHUB_TOKEN: ["iv", "stub", "token"].join("-"),
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
	cookie = res.headers.get("set-cookie") ?? "";
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
function lastToolEntry(botId: string, toolCallId: string): any {
	const matches = readSessionEntries(botId).filter((e) => e.role === "tool" && e.toolCallId === toolCallId);
	return matches.length ? matches[matches.length - 1] : null;
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

	// ---- 未登录：中止接口 401 ----
	const unauth = await fetch(`${BASE}/api/chats/repo-keeper/abort`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
	check("B2 未登录调用中止接口回 401", unauth.status === 401, `status=${unauth.status}`);

	// ---- 待批 + 通知 ----
	await chatEvents("repo-keeper", "请给 LinkForge 的 PR 1 留评");
	const p1 = await waitFor(async () => (await toolApprovalsViaApi()).find((a) => a.status === "pending"));
	const notif = await req("/api/notifications");
	check(
		"B3 待批产生 approval.pending 通知且带 toolApprovalId 深链",
		(notif.json?.notifications ?? []).some((n: any) => n.type === "approval.pending" && n.toolApprovalId === p1.id),
		`notif=${JSON.stringify((notif.json?.notifications ?? []).map((n: any) => [n.type, n.toolApprovalId]))} p1=${p1.id}`,
	);

	// ---- 批准前改正文：锁定字段 400、快照不变；正文可改、审计记新正文 ----
	const badEdit = await req(`/api/approvals/${p1.id}/edit`, { method: "POST", body: JSON.stringify({ body: "再改", repo: "NorthAdb/NotBound" }) });
	const afterBad = (await toolApprovalsViaApi()).find((a) => a.id === p1.id);
	const goodEdit = await req(`/api/approvals/${p1.id}/edit`, { method: "POST", body: JSON.stringify({ body: "改后的正文" }) });
	const afterGood = (await toolApprovalsViaApi()).find((a) => a.id === p1.id);
	const editedAudit = readAuditEntries().filter((x) => x.toolApprovalId === p1.id && x.result === "edited");
	check(
		"B4 改正文：带锁定字段（repo 不同）回 400 且快照不变；只改正文成功，审计 edited 的预览是新正文",
		badEdit.status === 400 &&
			afterBad.argsSnapshot?.body === "原始正文" &&
			afterBad.argsSnapshot?.repo === "NorthAdb/LinkForge" &&
			goodEdit.status === 200 &&
			afterGood.argsSnapshot?.body === "改后的正文" &&
			editedAudit.length === 1 &&
			String(editedAudit[0].intent?.bodyPreview ?? "").includes("改后的正文"),
		`bad=${badEdit.status} afterBad=${JSON.stringify(afterBad?.argsSnapshot)} good=${goodEdit.status} audit=${JSON.stringify(editedAudit)}`,
	);

	// ---- 批准：按新正文恰好发一次；审计接口按 toolApprovalId 过滤 ----
	await req(`/api/approvals/${p1.id}/approve`, { method: "POST", body: JSON.stringify({}) });
	await waitFor(async () => (await toolApprovalsViaApi()).find((a) => a.id === p1.id && a.status === "executed"));
	const auditByTool = await req(`/api/audit?toolApprovalId=${p1.id}`);
	const auditByFinding = await req(`/api/audit?findingId=${p1.id}`);
	const toolResults = (auditByTool.json?.records ?? []).map((x: any) => x.result);
	check(
		"B5 批准后按改后正文恰好发一次；GET /api/audit?toolApprovalId 能追到 edited/approved/executed，?findingId= 查不到",
		ghPosts.length === 1 &&
			ghPosts[0].body.includes("改后的正文") &&
			toolResults.includes("edited") &&
			toolResults.includes("approved") &&
			toolResults.includes("executed") &&
			(auditByFinding.json?.records ?? []).length === 0,
		`posts=${JSON.stringify(ghPosts)} toolAudit=${JSON.stringify(toolResults)} findingAudit=${JSON.stringify(auditByFinding.json)}`,
	);

	// ---- 待批中中止：记录 cancelled、零写入、会话 error 终态、再批准 409 ----
	await chatEvents("repo-keeper", "再给 PR 1 留评");
	const p2 = await waitFor(async () => (await toolApprovalsViaApi()).find((a) => a.status === "pending" && a.id !== p1.id));
	const abortRes = await req("/api/chats/repo-keeper/abort", { method: "POST", body: JSON.stringify({}) });
	const p2After = await waitFor(async () => (await toolApprovalsViaApi()).find((a) => a.id === p2.id && a.status === "cancelled"));
	const p2Wound = await waitFor(() => {
		const e = lastToolEntry("repo-keeper", p2.toolCallId);
		return e && e.status === "error" ? e : null;
	});
	const cancelAudit = readAuditEntries().filter((x) => x.toolApprovalId === p2.id && x.result === "cancelled");
	const reapproveCancelled = await req(`/api/approvals/${p2.id}/approve`, { method: "POST", body: JSON.stringify({}) });
	check(
		"B6 待批中中止：回 aborted:true 且点名该记录，记录 cancelled + 审计 cancelled/run_aborted，写 API 不变，会话该调用以 error 终态落盘，再批准回 409",
		abortRes.status === 200 &&
			abortRes.json?.aborted === true &&
			(abortRes.json?.cancelledToolApprovals ?? []).includes(p2.id) &&
			Boolean(p2After) &&
			cancelAudit.length === 1 &&
			cancelAudit[0].reason === "run_aborted" &&
			ghPosts.length === 1 &&
			Boolean(p2Wound) &&
			reapproveCancelled.status === 409,
		`abort=${JSON.stringify(abortRes.json)} posts=${ghPosts.length} audit=${JSON.stringify(cancelAudit)} reapprove=${reapproveCancelled.status}`,
	);

	// ---- 无活动 run 再中止：aborted:false ----
	const abortNone = await req("/api/chats/repo-keeper/abort", { method: "POST", body: JSON.stringify({}) });
	check("B7 无活动 run 时中止回 { aborted: false }", abortNone.status === 200 && abortNone.json?.aborted === false, JSON.stringify(abortNone.json));

	// ---- 执行中中止：已发出的写按真实结果落账，不多写 ----
	ghDelayMs = 2500;
	await chatEvents("repo-keeper", "第三次给 PR 1 留评");
	const p3 = await waitFor(async () => (await toolApprovalsViaApi()).find((a) => a.status === "pending" && a.id !== p1.id && a.id !== p2.id));
	const startedBefore = ghPostStarted;
	await req(`/api/approvals/${p3.id}/approve`, { method: "POST", body: JSON.stringify({}) });
	await waitFor(() => (ghPostStarted > startedBefore ? true : null), 10000);
	const abortExec = await req("/api/chats/repo-keeper/abort", { method: "POST", body: JSON.stringify({}) });
	const p3Done = await waitFor(async () => (await toolApprovalsViaApi()).find((a) => a.id === p3.id && a.status === "executed"), 30000);
	const p3Entry = await waitFor(() => {
		const e = lastToolEntry("repo-keeper", p3.toolCallId);
		return e && e.status === "complete" ? e : null;
	});
	ghDelayMs = 0;
	check(
		"B8 执行中中止：回 aborted:true、不取消已批准记录；在途写按真实结果完成（恰好一次、记录 executed、会话 complete），没有额外写",
		abortExec.json?.aborted === true &&
			(abortExec.json?.cancelledToolApprovals ?? []).length === 0 &&
			Boolean(p3Done) &&
			Boolean(p3Entry) &&
			ghPosts.length === 2,
		`abort=${JSON.stringify(abortExec.json)} posts=${ghPosts.length}`,
	);

	// ---- 同批双待批：批一、杀进程、重启批二，第一条绝不重发 ----
	await chatEvents("repo-keeper", "双评论：给 PR 1 和 PR 2 各留一条");
	const pA = await waitFor(async () => (await toolApprovalsViaApi()).find((a) => a.status === "pending" && a.argsSnapshot?.number === 1 && a.id !== p1.id && a.id !== p2.id && a.id !== p3.id));
	await req(`/api/approvals/${pA.id}/approve`, { method: "POST", body: JSON.stringify({}) });
	await waitFor(async () => (await toolApprovalsViaApi()).find((a) => a.id === pA.id && a.status === "executed"));
	const pB = await waitFor(async () => (await toolApprovalsViaApi()).find((a) => a.status === "pending" && a.argsSnapshot?.number === 2));
	proc?.kill("SIGKILL");
	await waitFor(() => (proc && (proc.exitCode !== null || proc.signalCode) ? true : null), 10000);
	proc = startServer();
	const rebooted = (await waitReady()) && (await login());
	await req("/api/settings/model", { method: "PUT", body: JSON.stringify({ baseUrl: MODEL_BASE, modelId: "stub-model", apiKey: MODEL_KEY }) });
	await req(`/api/approvals/${pB.id}/approve`, { method: "POST", body: JSON.stringify({}) });
	const pBDone = await waitFor(async () => (await toolApprovalsViaApi()).find((a) => a.id === pB.id && a.status === "executed"));
	const reapproveA = await req(`/api/approvals/${pA.id}/approve`, { method: "POST", body: JSON.stringify({}) });
	const bodies = ghPosts.map((p) => p.body);
	check(
		"B9 双待批嵌套恢复：第一条在原 run 执行、第二条待批时杀进程，重启批准第二条恰好发一次（两条正文各一次），第一条再批准回 409",
		rebooted &&
			Boolean(pBDone) &&
			bodies.filter((b) => b.includes("第一条评论正文")).length === 1 &&
			bodies.filter((b) => b.includes("第二条评论正文")).length === 1 &&
			reapproveA.status === 409,
		`posts=${JSON.stringify(bodies)} reapproveA=${reapproveA.status}`,
	);
	// ---- 在途驳回（#36 审计 MAJOR）：已批准且写在途时驳回回 409，
	// 记录不被改成 rejected，在途写按真实结果落 executed、恰好一次 ----
	ghDelayMs = 2500;
	const seenIds = new Set([p1.id, p2.id, p3.id, pA.id, pB.id]);
	await chatEvents("repo-keeper", "第四次给 PR 1 留评");
	const p4 = await waitFor(async () => (await toolApprovalsViaApi()).find((a) => a.status === "pending" && !seenIds.has(a.id)));
	const startedBefore4 = ghPostStarted;
	const postsBefore4 = ghPosts.length;
	await req(`/api/approvals/${p4.id}/approve`, { method: "POST", body: JSON.stringify({}) });
	await waitFor(() => (ghPostStarted > startedBefore4 ? true : null), 10000);
	// 在途的确定性信号：网关领取时同步写 executing 审计（先于任何网络
	// 调用），等到它再驳回，不靠固定 sleep 猜时序。
	await waitFor(() => (readAuditEntries().some((x) => x.toolApprovalId === p4.id && x.result === "executing") ? true : null), 10000);
	const rejectInFlight = await req(`/api/approvals/${p4.id}/reject`, { method: "POST", body: JSON.stringify({}) });
	const p4Mid = (await toolApprovalsViaApi()).find((a) => a.id === p4.id);
	const p4Done = await waitFor(async () => (await toolApprovalsViaApi()).find((a) => a.id === p4.id && a.status === "executed"), 30000);
	ghDelayMs = 0;
	check(
		"B10 在途驳回回 409 且记录保持 approved，在途写完成落 executed、恰好一次（账本与副作用不分叉）",
		rejectInFlight.status === 409 &&
			p4Mid?.status === "approved" &&
			Boolean(p4Done) &&
			ghPosts.length === postsBefore4 + 1 &&
			readAuditEntries().some((x) => x.toolApprovalId === p4.id && x.result === "executing") &&
			readAuditEntries().some((x) => x.toolApprovalId === p4.id && x.result === "executed") &&
			!readAuditEntries().some((x) => x.toolApprovalId === p4.id && x.result === "rejected"),
		`reject=${rejectInFlight.status} mid=${p4Mid?.status} posts=${ghPosts.length - postsBefore4}`,
	);

	// ---- run-state（#36 审计 MINOR）：无 run 为 false，待批停泊期间为
	// true（SSE 已收尾），落定后回到 false；未登录 401 ----
	const unauthState = await fetch(`${BASE}/api/chats/repo-keeper/run-state`);
	const stateIdle = await req("/api/chats/repo-keeper/run-state");
	await chatEvents("repo-keeper", "第五次给 PR 1 留评");
	const p5 = await waitFor(async () => (await toolApprovalsViaApi()).find((a) => a.status === "pending" && !seenIds.has(a.id) && a.id !== p4.id));
	const stateParked = await req("/api/chats/repo-keeper/run-state");
	await req(`/api/approvals/${p5.id}/reject`, { method: "POST", body: JSON.stringify({}) });
	const stateSettled = await waitFor(async () => {
		const s = await req("/api/chats/repo-keeper/run-state");
		return s.json?.active === false ? s : null;
	});
	check(
		"B11 run-state：未登录 401；无 run 时 active:false；待批停泊（SSE 已收尾）时 active:true；驳回落定后回到 false",
		unauthState.status === 401 &&
			stateIdle.json?.active === false &&
			stateParked.json?.active === true &&
			stateSettled.json?.active === false,
		`unauth=${unauthState.status} idle=${JSON.stringify(stateIdle.json)} parked=${JSON.stringify(stateParked.json)}`,
	);

	// ---- 对照（#36 审计 MAJOR）：暂时性失败后 approved+error、未在途时
	// 驳回仍成功、零写入。GitHub 替身对 POST 回 500 造一次暂时性失败
	// （comment_failed），记录保持 approved 并记 error；再驳回即放弃重试。
	ghFailPost = true;
	const seenIds12 = new Set([p1.id, p2.id, p3.id, pA.id, pB.id, p4.id, p5.id]);
	await chatEvents("repo-keeper", "第六次给 PR 1 留评");
	const p6 = await waitFor(async () => (await toolApprovalsViaApi()).find((a) => a.status === "pending" && !seenIds12.has(a.id)));
	const postsBefore6 = ghPosts.length;
	await req(`/api/approvals/${p6.id}/approve`, { method: "POST", body: JSON.stringify({}) });
	const p6Failed = await waitFor(async () => {
		const r = (await toolApprovalsViaApi()).find((a) => a.id === p6.id);
		return r && r.status === "approved" && typeof r.error === "string" && r.error.includes("comment_failed") ? r : null;
	}, 30000);
	ghFailPost = false;
	const rejectFailed = await req(`/api/approvals/${p6.id}/reject`, { method: "POST", body: JSON.stringify({}) });
	const p6After = (await toolApprovalsViaApi()).find((a) => a.id === p6.id);
	check(
		"B12 暂时性失败后驳回：写失败后记录 approved+error（未在途），驳回回 200、记录 rejected、零写入",
		Boolean(p6Failed) &&
			rejectFailed.status === 200 &&
			p6After?.status === "rejected" &&
			ghPosts.length === postsBefore6 &&
			!readAuditEntries().some((x) => x.toolApprovalId === p6.id && x.result === "executed"),
		`failed=${JSON.stringify(p6Failed?.error)} reject=${rejectFailed.status} after=${p6After?.status} posts=${ghPosts.length - postsBefore6}`,
	);

	// ---- 中止记账（P2-9 试用后修复）：生成纯文本中途中止——SSE 发
	// aborted 不发 error；会话落 interrupted 助手条目（半截文本）+
	// run_aborted 系统条目，不落 error 条目；下一轮「继续」的模型请求
	// 里能看到那半截文本（不再失忆重答）。
	const chatRes13 = await fetch(`${BASE}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Cookie: cookie },
		body: JSON.stringify({ botId: "repo-keeper", message: "请慢速长文输出" }),
	});
	const reader13 = chatRes13.body!.getReader();
	const decoder13 = new TextDecoder();
	let sse13 = "";
	while (!sse13.includes("慢速长文第6段")) {
		const { value, done } = await reader13.read();
		if (done) break;
		sse13 += decoder13.decode(value, { stream: true });
	}
	const abortRes13 = await req("/api/chats/repo-keeper/abort", { method: "POST", body: JSON.stringify({}) });
	for (;;) {
		const { value, done } = await reader13.read();
		if (done) break;
		sse13 += decoder13.decode(value, { stream: true });
	}
	const events13: { event: string; data: any }[] = [];
	for (const block of sse13.split("\n\n")) {
		const ev = /event: (.*)/.exec(block)?.[1];
		const data = /data: (.*)/s.exec(block)?.[1];
		if (ev && data) events13.push({ event: ev, data: JSON.parse(data) });
	}
	const session13 = events13.find((e) => e.event === "session")?.data?.sessionId as string;
	const turnEntries13 = await waitFor(() => {
		const list = readSessionEntries("repo-keeper").filter((e) => e.sessionId === session13);
		return list.some((e) => e.kind === "run_aborted") ? list : null;
	});
	const interrupted13 = turnEntries13.find((e) => e.role === "assistant" && e.interrupted === true);
	const fullText13 = Array.from({ length: 40 }, (_, i) => `慢速长文第${i + 1}段。`).join("");
	check(
		"B13 中止记账：SSE 有 aborted 无 error；半截文本落 interrupted 条目 + run_aborted 条目、无 error 条目",
		abortRes13.json?.aborted === true &&
			events13.some((e) => e.event === "aborted") &&
			!events13.some((e) => e.event === "error") &&
			typeof interrupted13?.text === "string" &&
			interrupted13.text.startsWith("慢速长文第1段") &&
			interrupted13.text.includes("慢速长文第3段") &&
			interrupted13.text.length < fullText13.length &&
			!turnEntries13.some((e) => e.kind === "error"),
		`abort=${JSON.stringify(abortRes13.json)} events=${events13.map((e) => e.event).join(",")} interrupted=${JSON.stringify(interrupted13?.text)?.slice(0, 80)} kinds=${turnEntries13.map((e) => e.kind ?? e.role).join(",")}`,
	);
	const bodiesBefore14 = modelBodies.length;
	await chatEvents("repo-keeper", "继续");
	const followUpBody = modelBodies.slice(bodiesBefore14).find((b) => JSON.stringify(b.messages ?? []).includes("继续"));
	check(
		"B14 中止后继续：下一轮模型请求的历史里含被中止的半截助手文本",
		Boolean(followUpBody) && JSON.stringify(followUpBody.messages).includes("慢速长文第1段"),
		`bodies=${modelBodies.length - bodiesBefore14} found=${Boolean(followUpBody)}`,
	);
} finally {
	proc?.kill("SIGKILL");
	ghStub.close();
	modelStub.close();
	rmSync(tmpA, { recursive: true, force: true });
	rmSync(tmpB, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n== test-intervention: ${results.length - failed.length}/${results.length} passed ==`);
if (failed.length) process.exit(1);
