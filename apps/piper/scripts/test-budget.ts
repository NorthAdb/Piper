// 预算熔断测试（P2-8）：单次 run 的步数 / token / 外部调用硬上限。
// 用法（在 apps/piper 下）：node dist/scripts/test-budget.js（或 npm run test:budget）
// A 段进程内：策略读取（缺省 / settings-budget.json / 环境变量三级与
// 无效值忽略）、跟踪器跳闸点（steps / tokens / external_calls、
// onTrip 只触发一次）、execute 闸（达上限后真的不再调 execute）。
// B 段真实 server + 模型/搜索/GitHub 替身，按场景换预算环境变量重启：
//   S1 maxSteps=2：模型连环要工具 → 只发出 2 次模型请求便停，审计有
//      budget_exceeded（steps），装配记录带计数，服务仍在、文本保留；
//   S2 maxTokens=100000、每轮 usage 60000 → 2 轮跳闸（tokens=120000）；
//   S3 maxExternalCalls=1：web_search 第二次 execute 不发生（替身只
//      收到 1 次请求），被拦结果在会话里可见；
//   S4 maxSteps=1 + github_comment 待批：待批保持 pending、批准后
//      恰好发 1 条评论、记录 executed，续跑段跳闸审计落盘；
//   S5 缺省预算：普通对话不跳闸。
// 数据目录指向临时目录，替身全在本地，不访问真实网络。
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_DIR } from "./app-dir.ts";

const results: { seq: number; name: string; ok: boolean }[] = [];
let seq = 0;
function check(name: string, ok: boolean, detail = "") {
	seq += 1;
	results.push({ seq, name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${String(seq).padStart(2, "0")} ${name}${ok ? "" : ` — ${detail}`}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ================= A 段：进程内 =================
const tmpA = mkdtempSync(join(tmpdir(), "piper-budget-a-"));
process.env.PIPER_DATA_DIR = join(tmpA, "data");
for (const k of ["PIPER_BUDGET_MAX_STEPS", "PIPER_BUDGET_MAX_TOKENS", "PIPER_BUDGET_MAX_EXTERNAL_CALLS"]) delete process.env[k];

const { BudgetTracker, readBudgetPolicy, withBudgetGate, DEFAULT_BUDGET_POLICY } = await import("../lib/budget.ts");

{
	const p = readBudgetPolicy();
	check("A1 缺省策略：20 步 / 100000 token / 30 外部调用（与锁定默认值一致）", p.maxSteps === 20 && p.maxTokens === 100_000 && p.maxExternalCalls === 30 && DEFAULT_BUDGET_POLICY.maxSteps === 20, JSON.stringify(p));
}
{
	mkdirSync(join(tmpA, "data"), { recursive: true });
	writeFileSync(join(tmpA, "data", "settings-budget.json"), JSON.stringify({ maxSteps: 3, maxTokens: "x", maxExternalCalls: 7 }), "utf8");
	const p = readBudgetPolicy();
	check("A2 settings-budget.json 覆盖：合法字段生效、非法值忽略回缺省", p.maxSteps === 3 && p.maxTokens === 100_000 && p.maxExternalCalls === 7, JSON.stringify(p));
	process.env.PIPER_BUDGET_MAX_STEPS = "5";
	const p2 = readBudgetPolicy();
	delete process.env.PIPER_BUDGET_MAX_STEPS;
	check("A3 环境变量优先于设置文件（maxSteps 5 胜 3）", p2.maxSteps === 5 && p2.maxExternalCalls === 7, JSON.stringify(p2));
}
{
	let trips = 0;
	const t = new BudgetTracker({ maxSteps: 2, maxTokens: 1000, maxExternalCalls: 30 }, () => (trips += 1));
	t.noteTurn(100);
	const after1 = t.tripped;
	t.noteTurn(100);
	t.noteTurn(100);
	check("A4 steps 跳闸：第 2 轮达上限即跳、onTrip 只触发一次、计数定格", after1 === null && t.tripped === "steps" && trips === 1 && t.steps === 3 && t.tokens === 300, `tripped=${t.tripped} trips=${trips} steps=${t.steps}`);
}
{
	const t = new BudgetTracker({ maxSteps: 20, maxTokens: 150, maxExternalCalls: 30 });
	t.noteTurn(100);
	const after1 = t.tripped;
	t.noteTurn(100);
	check("A5 tokens 跳闸：累计 200 ≥ 150 在第 2 轮跳闸（跨限轮已消费、挡后续）", after1 === null && t.tripped === "tokens" && t.tokens === 200, `tripped=${t.tripped} tokens=${t.tokens}`);
}
{
	const t = new BudgetTracker({ maxSteps: 20, maxTokens: 100_000, maxExternalCalls: 2 });
	const r = [t.tryExecuteExternal(), t.tryExecuteExternal(), t.tryExecuteExternal(), t.tryExecuteExternal()];
	check("A6 外部调用闸：前 2 次放行计数、第 3 次起拦下且不再计数、跳闸项 external_calls", r.join() === "true,true,false,false" && t.externalCalls === 2 && t.tripped === "external_calls", `r=${r} calls=${t.externalCalls}`);
}
{
	let realCalls = 0;
	const tools = [
		{
			name: "web_fetch",
			execute: async () => {
				realCalls += 1;
				return { content: [{ type: "text", text: "ok" }], details: {}, isError: false };
			},
		},
		{ name: "workspace_read", execute: async () => ({ content: [{ type: "text", text: "local" }], details: {}, isError: false }) },
	];
	const t = new BudgetTracker({ maxSteps: 20, maxTokens: 100_000, maxExternalCalls: 1 });
	type LooseTool = { name: string; execute: (id: string, args: unknown) => Promise<{ isError?: boolean; content?: { text?: string }[] }> };
	const gated = withBudgetGate(tools, t) as unknown as LooseTool[];
	const first = await gated[0].execute("c1", {});
	const second = await gated[0].execute("c2", {});
	const local = await gated[1].execute("c3", {});
	check(
		"A7 execute 闸包装：外部工具达上限后真的不再调 execute（回预算错误结果），本地工具不拦",
		first.isError === false && second.isError === true && String(second.content?.[0]?.text ?? "").includes("预算已用完") && realCalls === 1 && local.isError === false && (gated[1] as unknown) === tools[1],
		`realCalls=${realCalls} second=${JSON.stringify(second).slice(0, 160)}`,
	);
}

rmSync(tmpA, { recursive: true, force: true });

// ================= B 段：真实 server + 替身 =================
type Mode = "loop-list" | "loop-search" | "comment" | "text";
let mode: Mode = "text";
let usageTotal = 10;
let modelRequests = 0;
let searchHits = 0;
const ghPosts: string[] = [];

const modelStub: Server = createServer((reqHttp, resHttp) => {
	if (!reqHttp.url?.startsWith("/v1/chat/completions")) {
		resHttp.writeHead(404, { "Content-Type": "application/json" });
		resHttp.end(JSON.stringify({ error: { message: "not found" } }));
		return;
	}
	let raw = "";
	reqHttp.on("data", (c) => (raw += c));
	reqHttp.on("end", () => {
		modelRequests += 1;
		let body: any = {};
		try {
			body = JSON.parse(raw || "{}");
		} catch {
			/* 忽略 */
		}
		const model = body.model || "stub-model";
		const usage = { prompt_tokens: Math.max(0, usageTotal - 5), completion_tokens: 5, total_tokens: usageTotal };
		if (!body.stream) {
			resHttp.writeHead(200, { "Content-Type": "application/json" });
			resHttp.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1762732800, model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage }));
			return;
		}
		resHttp.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
		const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
			`data: ${JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1762732800, model, choices: [{ index: 0, delta, finish_reason: finishReason }], usage })}\n\n`;
		resHttp.write(chunk({ role: "assistant" }));
		const messages: any[] = body.messages ?? [];
		const last = messages[messages.length - 1] ?? {};
		const alreadyTool = messages.some((m: any) => m.role === "assistant" && JSON.stringify(m.content ?? "").includes("github_comment"));
		if (mode === "comment" && last.role !== "tool" && !alreadyTool) {
			const argsJson = JSON.stringify({ repo: "NorthAdb/LinkForge", kind: "pr_comment", number: 1, body: "预算测试评论" });
			resHttp.write(chunk({ tool_calls: [{ index: 0, id: "call_budget_1", type: "function", function: { name: "github_comment", arguments: "" } }] }));
			resHttp.write(chunk({ tool_calls: [{ index: 0, function: { arguments: argsJson } }] }));
			resHttp.write(chunk({}, "tool_calls"));
		} else if (mode === "loop-list") {
			resHttp.write(chunk({ tool_calls: [{ index: 0, id: `call_list_${modelRequests}`, type: "function", function: { name: "workspace_list", arguments: "" } }] }));
			resHttp.write(chunk({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }));
			resHttp.write(chunk({}, "tool_calls"));
		} else if (mode === "loop-search") {
			resHttp.write(chunk({ tool_calls: [{ index: 0, id: `call_search_${modelRequests}`, type: "function", function: { name: "web_search", arguments: "" } }] }));
			resHttp.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ query: "piper" }) } }] }));
			resHttp.write(chunk({}, "tool_calls"));
		} else {
			resHttp.write(chunk({ content: "这是替身的普通回复。" }));
			resHttp.write(chunk({}, "stop"));
		}
		resHttp.end("data: [DONE]\n\n");
	});
});
await new Promise<void>((r) => modelStub.listen(0, "127.0.0.1", () => r()));
const MODEL_BASE = `http://127.0.0.1:${(modelStub.address() as { port: number }).port}/v1`;

const searchStub: Server = createServer((reqHttp, resHttp) => {
	searchHits += 1;
	resHttp.writeHead(200, { "Content-Type": "application/json" });
	resHttp.end(JSON.stringify({ results: [{ title: "stub", url: "http://example.invalid/", description: "stub result" }] }));
});
await new Promise<void>((r) => searchStub.listen(0, "127.0.0.1", () => r()));
const SEARCH_BASE = `http://127.0.0.1:${(searchStub.address() as { port: number }).port}/search`;

const ghStub: Server = createServer((reqHttp, resHttp) => {
	const url = reqHttp.url ?? "";
	let raw = "";
	reqHttp.on("data", (c) => (raw += c));
	reqHttp.on("end", () => {
		const send = (b: unknown) => {
			resHttp.writeHead(200, { "Content-Type": "application/json" });
			resHttp.end(JSON.stringify(b));
		};
		let m: RegExpExecArray | null;
		if ((m = /^\/repos\/(.+)\/pulls\/(\d+)$/.exec(url))) return send({ state: "open", draft: false, head: { sha: "stub-head" } });
		if ((m = /^\/repos\/(.+)\/issues\/(\d+)\/comments$/.exec(url)) && reqHttp.method === "POST") {
			ghPosts.push(url);
			return send({ id: 1, html_url: `http://gh.invalid/${m[1]}/issues/${m[2]}#c1`, body: (JSON.parse(raw || "{}") as { body?: string }).body ?? "" });
		}
		if ((m = /^\/repos\/(.+)\/issues\/(\d+)\/comments\?/.exec(url))) return send([]);
		if ((m = /^\/repos\/(.+)\/issues\/(\d+)$/.exec(url))) return send({ state: "open" });
		return send({});
	});
});
await new Promise<void>((r) => ghStub.listen(0, "127.0.0.1", () => r()));
const GH_BASE = `http://127.0.0.1:${(ghStub.address() as { port: number }).port}`;

const PORT = Number(process.env.BUDGET_PORT || 4505);
const BASE = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess | null = null;
let serverLog = "";
let cookie = "";
let DATA_B = "";

function startServer(extraEnv: Record<string, string>, preseed?: (dataDir: string) => void): ChildProcess {
	const tmp = mkdtempSync(join(tmpdir(), "piper-budget-b-"));
	DATA_B = join(tmp, "data");
	mkdirSync(DATA_B, { recursive: true });
	if (preseed) preseed(DATA_B);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PORT: String(PORT),
		PIPER_DATA_DIR: DATA_B,
		PIPER_GITHUB_API_BASE: GH_BASE,
		GITHUB_TOKEN: ["gh", "stub", "token"].join("-"),
		PIPER_MODEL_BASE_URL: MODEL_BASE,
		PIPER_MODEL_ID: "stub-model",
		PIPER_MODEL_API_KEY: ["stub", "model", "key"].join("-"),
		PIPER_TEST_MODE: "1",
		...extraEnv,
	};
	delete env.PIPER_TOKEN;
	delete env.PIPER_HOST;
	for (const k of ["OPENAI_API_KEY", "PIPER_TOOL_APPROVALS_FILE", "PIPER_AUDIT_FILE", "PIPER_JOBS_FILE", "PIPER_FINDINGS_FILE"]) delete env[k];
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
function auditEntries(): any[] {
	const file = join(DATA_B, "audit.jsonl");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function sessionText(botId: string): string {
	const file = join(DATA_B, "sessions", `${botId}.jsonl`);
	return existsSync(file) ? readFileSync(file, "utf8") : "";
}
async function boot(extraEnv: Record<string, string>, preseed?: (dataDir: string) => void): Promise<boolean> {
	serverLog = "";
	proc = startServer(extraEnv, preseed);
	const ready = await waitReady();
	return ready && (await login());
}
async function shutdown(): Promise<void> {
	if (proc) {
		proc.kill("SIGKILL");
		await sleep(150);
		proc = null;
	}
}

// ---- S1 maxSteps=2 ----
{
	mode = "loop-list";
	usageTotal = 10;
	modelRequests = 0;
	const ok = await boot({ PIPER_BUDGET_MAX_STEPS: "2" });
	const events = ok ? await chatEvents("piper-main", "请反复列目录") : [];
	const sid = events.find((e) => e.event === "session")?.data?.sessionId as string | undefined;
	const trip = auditEntries().find((a) => a.result === "budget_exceeded");
	const ctx = sid ? await req(`/api/sessions/${sid}/context`) : { status: 0, json: null };
	const alive = await req("/api/bots");
	check(
		"S1 步数熔断：maxSteps=2 时模型请求恰 2 次便停、审计 budget_exceeded(steps,2)、装配记录带计数、进程仍在",
		ok &&
			modelRequests === 2 &&
			trip?.reason === "steps" &&
			trip?.budget?.steps === 2 &&
			trip?.sessionId === sid &&
			ctx.json?.budget?.tripped === "steps" &&
			ctx.json?.budget?.steps === 2 &&
			alive.status === 200,
		`reqs=${modelRequests} trip=${JSON.stringify(trip)} ctx=${JSON.stringify(ctx.json?.budget)} log=${serverLog.slice(-200)}`,
	);
	check(
		"S1b 跳闸留痕与保留：会话流水有 budget_trip 提示且已产生的工具条目仍在（文本不删）",
		sessionText("piper-main").includes("budget_trip") && sessionText("piper-main").includes("workspace_list"),
		sessionText("piper-main").slice(-300),
	);
	await shutdown();
}

// ---- S2 maxTokens=100000，每轮 60000 ----
{
	mode = "loop-list";
	usageTotal = 60000;
	modelRequests = 0;
	const ok = await boot({ PIPER_BUDGET_MAX_TOKENS: "100000" });
	const events = ok ? await chatEvents("piper-main", "请反复列目录") : [];
	void events;
	const trip = auditEntries().find((a) => a.result === "budget_exceeded");
	check(
		"S2 token 熔断：每轮 60000、限 100000 → 第 2 轮跳闸（tokens=120000），模型请求恰 2 次",
		ok && modelRequests === 2 && trip?.reason === "tokens" && trip?.budget?.tokens === 120000,
		`reqs=${modelRequests} trip=${JSON.stringify(trip)}`,
	);
	await shutdown();
}

// ---- S3 maxExternalCalls=1，web_search ----
{
	mode = "loop-search";
	usageTotal = 10;
	modelRequests = 0;
	searchHits = 0;
	const ok = await boot({ PIPER_BUDGET_MAX_EXTERNAL_CALLS: "1" }, (dataDir) => {
		writeFileSync(join(dataDir, "settings-web.json"), JSON.stringify({ fetchEnabled: true, searchEndpoint: SEARCH_BASE, searchApiKey: "stub-key" }), "utf8");
	});
	if (ok) await chatEvents("piper-main", "请反复搜索");
	const trip = auditEntries().find((a) => a.result === "budget_exceeded");
	check(
		"S3 外部调用熔断：maxExternalCalls=1 时搜索替身只收到 1 次请求（第二次 execute 不发生），审计 external_calls/1",
		ok && searchHits === 1 && trip?.reason === "external_calls" && trip?.budget?.externalCalls === 1,
		`hits=${searchHits} reqs=${modelRequests} trip=${JSON.stringify(trip)} log=${serverLog.slice(-200)}`,
	);
	check("S3b 被拦结果在会话里可见（含「预算已用完」）", sessionText("piper-main").includes("预算已用完"), sessionText("piper-main").slice(-300));
	await shutdown();
}

// ---- S4 maxSteps=1 + github_comment 待批保持 pending ----
{
	mode = "comment";
	usageTotal = 10;
	modelRequests = 0;
	ghPosts.length = 0;
	const ok = await boot({ PIPER_BUDGET_MAX_STEPS: "1" });
	let chatPromise: Promise<{ event: string; data: any }[]> | null = null;
	let pendingId: string | null = null;
	if (ok) {
		chatPromise = chatEvents("repo-keeper", "请给 LinkForge 的 PR #1 发一条评论：预算测试");
		for (let i = 0; i < 60 && !pendingId; i++) {
			const list = await req("/api/approvals");
			const found = (list.json?.approvals ?? []).find((a: any) => a.kind === "tool_call" && a.status === "pending");
			if (found) pendingId = found.id;
			else await sleep(250);
		}
	}
	check("S4a 待批保持 pending：跳闸预算下 github_comment 停在 pending（不执行、不转 error）", Boolean(pendingId) && ghPosts.length === 0, `pending=${pendingId} posts=${ghPosts.length}`);
	if (pendingId) {
		await req(`/api/approvals/${pendingId}/approve`, { method: "POST", body: JSON.stringify({}) });
		for (let i = 0; i < 60 && ghPosts.length === 0; i++) await sleep(250);
	}
	const events = chatPromise ? await chatPromise : [];
	void events;
	const approvals = await req("/api/approvals");
	const rec = [...(approvals.json?.approvals ?? []), ...(approvals.json?.closed ?? [])].find((a: any) => a.id === pendingId);
	const trip = auditEntries().find((a) => a.result === "budget_exceeded");
	check(
		"S4b 批准后续跑：评论恰发 1 条、待批记录 executed、续跑段步数跳闸审计落盘（steps）",
		ghPosts.length === 1 && rec?.status === "executed" && trip?.reason === "steps",
		`posts=${ghPosts.length} rec=${JSON.stringify(rec)} trip=${JSON.stringify(trip)} log=${serverLog.slice(-200)}`,
	);
	await shutdown();
}

// ---- S5 缺省预算：普通对话不跳闸 ----
{
	mode = "text";
	usageTotal = 10;
	modelRequests = 0;
	const ok = await boot({});
	const events = ok ? await chatEvents("piper-main", "你好") : [];
	const sid = events.find((e) => e.event === "session")?.data?.sessionId as string | undefined;
	const ctx = sid ? await req(`/api/sessions/${sid}/context`) : { status: 0, json: null };
	check(
		"S5 缺省预算不误伤：普通对话完成、无 budget_exceeded 审计、装配记录 tripped 为 null",
		ok && events.some((e) => e.event === "done") && !auditEntries().some((a) => a.result === "budget_exceeded") && ctx.json?.budget?.tripped === null,
		`events=${events.map((e) => e.event).join()} ctx=${JSON.stringify(ctx.json?.budget)}`,
	);
	await shutdown();
}

modelStub.close();
searchStub.close();
ghStub.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
