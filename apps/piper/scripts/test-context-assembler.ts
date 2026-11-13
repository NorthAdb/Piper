// 上下文装配器测试（P2-6）：装配顺序锁定与逐级记录、工具按 name
// 排序、换模型 model_switch、调序 reorder、历史窗口裁剪的 dropped
// 与数字、越过压缩阈值时的 compact 标记、钩子不抛错的契约。
// A 段（进程内）：直接跑 lib/context-assembler.ts 的夹具装配，不打
// 真实模型、不需要 Key。
// B 段（真实 server + 模型替身）：聊天后按 sessionId 从
// GET /api/sessions/:sessionId/context 读回装配记录（401 / 404 /
// 六级齐全）；设置里换 modelId 后再聊一轮，新会话的 system 级带
// model_switch，旧会话记录不受影响。
// 用法（在 apps/piper 下）：node dist/scripts/test-context-assembler.js
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
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

// ================= A 段：进程内 =================
const tmpA = mkdtempSync(join(tmpdir(), "piper-ctx-a-"));
process.env.PIPER_DATA_DIR = join(tmpA, "data");

const assemblerMod = await import("../lib/context-assembler.ts");
const { ContextAssembler, ASSEMBLY_STAGE_ORDER, estimateTextTokens, estimateMessageTokens } = assemblerMod;

// 夹具消息（基座消息的最小形状，装配器只读 role/content 估算）
const msg = (role: string, text: string): any => ({ role, content: [{ type: "text", text }], timestamp: 0 });
const byStage = (records: any[], stage: string): any => records.find((r) => r.stage === stage);

// ---- A1：默认顺序全趟装配 ----
{
	const asm = new ContextAssembler({ sessionId: "s-a1", modelId: "stub-a", previousModelId: null, contextWindow: 128000 });
	const composed = asm.composeSystemPrompt({ system: "人设段文本", aboutMe: "关于我的内容", trailingNote: "工具说明散文" });
	const sorted = asm.orderTools([
		{ name: "workspace_write", description: "写文件", parameters: { type: "object" } },
		{ name: "github_comment", description: "发评论", parameters: { type: "object" } },
		{ name: "web_fetch", description: "抓网页", parameters: { type: "object" } },
	]);
	const hist = [msg("user", "历史问题一"), msg("assistant", "历史回答一"), msg("user", "历史问题二")];
	const turn = msg("user", "本轮问题");
	asm.setHistorySource(3, ["m0", "m2", "m5"]);
	const out = await asm.transformContext([...hist, turn]);
	asm.notePrepareRequest("stub-a");
	const records = asm.records();
	const histTokens = hist.reduce((s, m) => s + estimateMessageTokens(m), 0);
	check(
		"A1 默认装配：拼串与既有格式一致（人设 + 空行 + 关于我 + 工具散文卷尾）；工具按 name 排序；六级按锁定顺序齐全且每级有 before/after；system/about_me/history/turn 数字与估算口径一致；memory 0/0；无 cacheBreak、无 dropped",
		composed === "人设段文本\n\n\n关于我的内容工具说明散文" &&
			JSON.stringify(sorted.map((t) => t.name)) === JSON.stringify(["github_comment", "web_fetch", "workspace_write"]) &&
			out.length === 4 &&
			JSON.stringify(records.map((r) => r.stage)) === JSON.stringify([...ASSEMBLY_STAGE_ORDER]) &&
			records.every((r) => typeof r.tokensBefore === "number" && typeof r.tokensAfter === "number") &&
			byStage(records, "system")?.tokensBefore === estimateTextTokens("人设段文本") + estimateTextTokens("工具说明散文") &&
			byStage(records, "about_me")?.tokensBefore === estimateTextTokens("关于我的内容") &&
			byStage(records, "tools")?.tokensBefore > 0 &&
			byStage(records, "memory")?.tokensBefore === 0 &&
			byStage(records, "memory")?.tokensAfter === 0 &&
			byStage(records, "history")?.tokensBefore === histTokens &&
			byStage(records, "history")?.tokensAfter === histTokens &&
			byStage(records, "turn")?.tokensBefore === estimateMessageTokens(turn) &&
			records.every((r) => r.cacheBreak === undefined && r.dropped === null),
		JSON.stringify(records),
	);
}

// ---- A2：调序 → reorder ----
{
	const swapped = ["system", "tools", "history", "memory", "about_me", "turn"] as const;
	const asm = new ContextAssembler({ sessionId: "s-a2", modelId: "stub-a", previousModelId: null, contextWindow: 128000, stageOrder: swapped });
	asm.composeSystemPrompt({ system: "人设", aboutMe: "关于我", trailingNote: "" });
	asm.orderTools([{ name: "web_fetch", description: "抓网页", parameters: {} }]);
	const hist = [msg("user", "历史")];
	asm.setHistorySource(1, ["m0"]);
	await asm.transformContext([...hist, msg("user", "本轮")]);
	const records = asm.records();
	check(
		"A2 调序：history 与 about_me 对调后，记录按调后顺序输出且两级都带 cacheBreak reorder",
		JSON.stringify(records.map((r) => r.stage)) === JSON.stringify([...swapped]) &&
			byStage(records, "history")?.cacheBreak === "reorder" &&
			byStage(records, "about_me")?.cacheBreak === "reorder" &&
			byStage(records, "system")?.cacheBreak === undefined,
		JSON.stringify(records),
	);
}

// ---- A3：换模型 → model_switch（跨轮与趟内各一） ----
{
	const crossTurn = new ContextAssembler({ sessionId: "s-a3", modelId: "stub-b", previousModelId: "stub-a", contextWindow: 128000 });
	crossTurn.composeSystemPrompt({ system: "人设", aboutMe: "", trailingNote: "" });
	crossTurn.notePrepareRequest("stub-b");
	const midRun = new ContextAssembler({ sessionId: "s-a3b", modelId: "stub-a", previousModelId: "stub-a", contextWindow: 128000 });
	midRun.composeSystemPrompt({ system: "人设", aboutMe: "", trailingNote: "" });
	midRun.notePrepareRequest("stub-c");
	check(
		"A3 换模型：上一轮模型与本轮不同 → system 级 model_switch；趟内 prepareRequest 报来不同模型 → 同样记 model_switch",
		byStage(crossTurn.records(), "system")?.cacheBreak === "model_switch" && byStage(midRun.records(), "system")?.cacheBreak === "model_switch",
		`cross=${JSON.stringify(byStage(crossTurn.records(), "system"))} mid=${JSON.stringify(byStage(midRun.records(), "system"))}`,
	);
}

// ---- A4：窗口裁剪 + 越过压缩阈值 → compact 与 dropped ----
{
	const asm = new ContextAssembler({ sessionId: "s-a4", modelId: "stub-a", previousModelId: null, contextWindow: 4000, reserveTokens: 1000 });
	asm.composeSystemPrompt({ system: "人设", aboutMe: "", trailingNote: "" });
	const hist = Array.from({ length: 30 }, (_, i) => msg(i % 2 ? "assistant" : "user", "x".repeat(500)));
	asm.setHistorySource(30, hist.map((_, i) => `m${i}`));
	const out = await asm.transformContext([...hist, msg("user", "本轮")]);
	const rec = byStage(asm.records(), "history");
	check(
		"A4 阈值+窗口：30 条大消息（估算 3750 ≥ 窗 4000−预留 1000）→ 保留最近 20 条、dropped.ids 为 m0..m9 且 reason 记窗口、before 3750 / after 2500、cacheBreak compact",
		out.length === 21 &&
			rec?.tokensBefore === 3750 &&
			rec?.tokensAfter === 2500 &&
			JSON.stringify(rec?.dropped?.ids) === JSON.stringify(Array.from({ length: 10 }, (_, i) => `m${i}`)) &&
			typeof rec?.dropped?.reason === "string" &&
			rec.dropped.reason.includes("历史窗口") &&
			rec?.cacheBreak === "compact",
		JSON.stringify(rec),
	);
}

// ---- A5：只有窗口裁剪、未到阈值 → 无 compact ----
{
	const asm = new ContextAssembler({ sessionId: "s-a5", modelId: "stub-a", previousModelId: null, contextWindow: 128000 });
	asm.composeSystemPrompt({ system: "人设", aboutMe: "", trailingNote: "" });
	const hist = Array.from({ length: 25 }, (_, i) => msg(i % 2 ? "assistant" : "user", "y".repeat(40)));
	asm.setHistorySource(25, hist.map((_, i) => `m${i}`));
	const out = await asm.transformContext([...hist, msg("user", "本轮")]);
	const rec = byStage(asm.records(), "history");
	check(
		"A5 仅窗口：25 条小消息（250 token，未到阈值）→ dropped 5 条、before 250 / after 200、无 cacheBreak",
		out.length === 21 && rec?.tokensBefore === 250 && rec?.tokensAfter === 200 && rec?.dropped?.ids?.length === 5 && rec?.cacheBreak === undefined,
		JSON.stringify(rec),
	);
}

// ---- A6：钩子契约——不抛错、同趟幂等 ----
{
	const asm = new ContextAssembler({ sessionId: "s-a6", modelId: "stub-a", previousModelId: null, contextWindow: 128000 });
	asm.composeSystemPrompt({ system: "人设", aboutMe: "", trailingNote: "" });
	const weird: any[] = [{ role: "user" }, { role: "assistant", content: "纯字符串内容" }, { role: "user", content: [{ type: "text", text: "正常" }] }];
	asm.setHistorySource(2, ["m0", "m1"]);
	let threw = false;
	let first: any[] = [];
	try {
		first = await asm.transformContext(weird);
	} catch {
		threw = true;
	}
	const secondInput: any[] = [...first, msg("assistant", "后续")];
	const second = await asm.transformContext(secondInput);
	const rec = byStage(asm.records(), "history");
	check(
		"A6 契约：异形消息（缺 content / 字符串 content）不抛错、原样返回；同趟第二次 transformContext 不重复裁剪记账、输入原样返回",
		!threw && first.length === 3 && second === secondInput && typeof rec?.tokensBefore === "number",
		`threw=${threw} first=${first.length} rec=${JSON.stringify(rec)}`,
	);
}

// ================= B 段：真实 server + 模型替身 =================
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
		if (!body.stream) {
			resHttp.writeHead(200, { "Content-Type": "application/json" });
			resHttp.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1762732800, model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
			return;
		}
		resHttp.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
		const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
			`data: ${JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1762732800, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
		resHttp.write(chunk({ role: "assistant" }));
		resHttp.write(chunk({ content: "你好，这是替身回复。" }));
		resHttp.write(chunk({}, "stop"));
		resHttp.end("data: [DONE]\n\n");
	});
});
await new Promise<void>((r) => modelStub.listen(0, "127.0.0.1", () => r()));
const MODEL_BASE = `http://127.0.0.1:${(modelStub.address() as { port: number }).port}/v1`;

const tmpB = mkdtempSync(join(tmpdir(), "piper-ctx-b-"));
const DATA_B = join(tmpB, "data");
const PORT = Number(process.env.CTX_PORT || 4503);
const BASE = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess | null = null;
let serverLog = "";
let cookie = "";

function startServer(): ChildProcess {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PORT: String(PORT),
		PIPER_DATA_DIR: DATA_B,
		GITHUB_TOKEN: ["ctx", "stub", "token"].join("-"),
		PIPER_TEST_MODE: "1",
	};
	delete env.PIPER_TOKEN;
	delete env.PIPER_HOST;
	for (const k of ["PIPER_MODEL_API_KEY", "OPENAI_API_KEY", "PIPER_MODEL_BASE_URL", "PIPER_MODEL_ID", "PIPER_TOOL_APPROVALS_FILE", "PIPER_AUDIT_FILE", "PIPER_GITHUB_API_BASE"]) delete env[k];
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
async function waitFor<T>(fn: () => T | null | undefined | Promise<T | null | undefined>, timeoutMs = 25000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error("waitFor 超时");
		await sleep(200);
	}
}
async function contextOf(sessionId: string): Promise<{ status: number; json: any }> {
	return req(`/api/sessions/${sessionId}/context`);
}

try {
	proc = startServer();
	const ready = (await waitReady()) && (await login());
	await req("/api/settings/model", { method: "PUT", body: JSON.stringify({ baseUrl: MODEL_BASE, modelId: "stub-model", apiKey: "ctx-model-key" }) });
	check("B1 被测 server 启动并登录成功", ready, serverLog.slice(-300));

	const unauth = await fetch(`${BASE}/api/sessions/s-none/context`);
	const missing = await contextOf("s-does-not-exist");
	check("B2 装配记录接口：未登录 401、未知 sessionId 404", unauth.status === 401 && missing.status === 404, `unauth=${unauth.status} missing=${missing.status}`);

	const ev1 = await chatEvents("piper-main", "你好，报个到");
	const sid1 = ev1.find((e) => e.event === "session")?.data?.sessionId as string;
	const ctx1 = await waitFor(async () => {
		const r = await contextOf(sid1);
		return r.status === 200 ? r.json : null;
	});
	const stages1: any[] = ctx1?.stages ?? [];
	check(
		"B3 聊一轮后按 sessionId 读回装配记录：六级按锁定顺序齐全、modelId 为 stub-model、tools/turn 有数字、history before==after（短历史）、无 cacheBreak",
		Boolean(sid1) &&
			ctx1?.botId === "piper-main" &&
			ctx1?.modelId === "stub-model" &&
			JSON.stringify(stages1.map((s) => s.stage)) === JSON.stringify(["system", "tools", "about_me", "memory", "history", "turn"]) &&
			byStage(stages1, "tools")?.tokensBefore > 0 &&
			byStage(stages1, "turn")?.tokensBefore > 0 &&
			byStage(stages1, "history")?.tokensBefore === byStage(stages1, "history")?.tokensAfter &&
			stages1.every((s) => s.cacheBreak === undefined),
		`sid=${sid1} ctx=${JSON.stringify(ctx1).slice(0, 400)}`,
	);

	await req("/api/settings/model", { method: "PUT", body: JSON.stringify({ baseUrl: MODEL_BASE, modelId: "stub-model-2", apiKey: "ctx-model-key" }) });
	const ev2 = await chatEvents("piper-main", "再聊一句");
	const sid2 = ev2.find((e) => e.event === "session")?.data?.sessionId as string;
	const ctx2 = await waitFor(async () => {
		const r = await contextOf(sid2);
		return r.status === 200 ? r.json : null;
	});
	const ctx1Again = await contextOf(sid1);
	check(
		"B4 换模型后再聊：新会话 system 级带 model_switch、modelId 为 stub-model-2；旧会话记录仍是 stub-model 且无击穿（记录按 session 隔离）",
		Boolean(sid2) &&
			sid2 !== sid1 &&
			ctx2?.modelId === "stub-model-2" &&
			byStage(ctx2?.stages ?? [], "system")?.cacheBreak === "model_switch" &&
			ctx1Again.json?.modelId === "stub-model" &&
			(ctx1Again.json?.stages ?? []).every((s: any) => s.cacheBreak === undefined),
		`ctx2=${JSON.stringify(ctx2).slice(0, 300)} ctx1=${JSON.stringify(ctx1Again.json).slice(0, 200)}`,
	);
} finally {
	proc?.kill("SIGKILL");
	modelStub.close();
	rmSync(tmpA, { recursive: true, force: true });
	rmSync(tmpB, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n== test-context-assembler: ${results.length - failed.length}/${results.length} passed ==`);
if (failed.length) process.exit(1);
