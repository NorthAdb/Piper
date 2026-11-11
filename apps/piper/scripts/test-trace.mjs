// 轨迹数据层单测（PR-D）：会话落盘补时间字段 + GET /api/bots/:id/trace 归一化接口。
// 口径：appendSession 的落盘戳 ts 是 ISO 字符串（存量格式，前端 HistoryEntry.ts
// 也是 string），新增的事件时刻字段 startedAt/endedAt/durationMs 用 epoch 毫秒数；
// 轨迹接口把两类时间统一归一化为 epoch 毫秒输出，无证据的时间一律 null，不编造。
// 老会话文件（无 ts/无时间字段）读出 null 且不报错、不回写。
// 用法（在 apps/piper 下）：node scripts/test-trace.mjs（或 npm run test:trace）
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP_ROOT = mkdtempSync(join(tmpdir(), "piper-trace-"));
const TMP_DATA = join(TMP_ROOT, "data");
process.env.PIPER_DATA_DIR = TMP_DATA;
for (const k of ["PIPER_MODEL_API_KEY", "OPENAI_API_KEY", "PIPER_MODEL_BASE_URL", "PIPER_MODEL_ID", "GITHUB_TOKEN"]) delete process.env[k];

const results = [];
let seq = 0;
function check(name, ok, detail = "") {
	seq += 1;
	results.push({ seq, name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${String(seq).padStart(2, "0")} ${name}${ok ? "" : ` — ${detail}`}`);
}

const CHAT_KEY = "sk-trace-test-key-abcdef123456";
const FAKE_SECRET = `ghp_${"A".repeat(24)}`;

// ---------- 单元部分：lib/trace.mjs 的 buildTrace 归一化 ----------
async function unitPart() {
	let buildTrace = null;
	try {
		const mod = await import("../dist/lib/trace.js");
		buildTrace = typeof mod.buildTrace === "function" ? mod.buildTrace : null;
	} catch {
		buildTrace = null;
	}
	check("lib/trace.mjs 导出 buildTrace 函数", typeof buildTrace === "function", `buildTrace=${typeof buildTrace}`);
	const bt = buildTrace ?? (() => ({ turns: [] }));

	const T0 = Date.parse("2026-11-11T00:01:00.000Z");
	const iso = (ms) => new Date(ms).toISOString();
	// 新形状：leading system 条目 + 一轮（user → thinking → tool → assistant）
	const entries = [
		{ role: "system", kind: "bot-created", text: "草案确认，已创建 bot：X", ts: iso(T0 - 60_000) },
		{ role: "user", text: "问题一", ts: iso(T0), sessionId: "s-1" },
		{ role: "thinking", text: "想一想", truncated: false, seq: 0, durationMs: 1200, level: "high", startedAt: T0 + 1000, ts: iso(T0 + 6000), sessionId: "s-1" },
		{
			role: "tool",
			toolCallId: "c1",
			name: "web_fetch",
			args: { url: "https://example.com" },
			status: "complete",
			result: { isError: false, status: 200 },
			seq: 1,
			startedAt: T0 + 3000,
			endedAt: T0 + 4500,
			durationMs: 1500,
			ts: iso(T0 + 6000),
			sessionId: "s-1",
		},
		{ role: "assistant", text: "回答一", ts: iso(T0 + 6000), sessionId: "s-1" },
	];
	const { turns } = bt(entries);
	check(
		"分组：首条 user 之前的 system 条目自成一组，其后一轮为第二组，index 依次 0/1",
		turns.length === 2 && turns[0].index === 0 && turns[1].index === 1 && turns[0].events.length === 1 && turns[0].events[0].kind === "system",
		`turns=${JSON.stringify(turns.map((t) => ({ index: t.index, n: t.events.length })))}`,
	);
	const turn = turns[1] ?? { events: [] };
	check(
		"一轮内事件顺序与种类：user → thinking → tool → assistant（kind 取 role 原值）",
		JSON.stringify(turn.events.map((e) => e.kind)) === JSON.stringify(["user", "thinking", "tool", "assistant"]),
		JSON.stringify(turn.events.map((e) => e.kind)),
	);
	const [userEv, thinkEv, toolEv, asstEv] = turn.events;
	check(
		"时间归一化：user/assistant 的 ISO ts 解析为 epoch 毫秒；thinking/tool 的事件时刻取 startedAt",
		userEv?.ts === T0 && asstEv?.ts === T0 + 6000 && thinkEv?.ts === T0 + 1000 && toolEv?.ts === T0 + 3000,
		`user=${userEv?.ts} think=${thinkEv?.ts} tool=${toolEv?.ts} asst=${asstEv?.ts}`,
	);
	check(
		"轮次时间：startedAt=user.ts、endedAt=本轮最大事件时刻、durationMs=endedAt-startedAt",
		turn.startedAt === T0 && turn.endedAt === T0 + 6000 && turn.durationMs === 6000,
		`turn=${JSON.stringify({ startedAt: turn.startedAt, endedAt: turn.endedAt, durationMs: turn.durationMs })}`,
	);
	check(
		"tool 事件摘要：name/status/toolCallId/startedAt/endedAt/durationMs 与 args/result 原样带出",
		toolEv?.name === "web_fetch" &&
			toolEv?.status === "complete" &&
			toolEv?.toolCallId === "c1" &&
			toolEv?.startedAt === T0 + 3000 &&
			toolEv?.endedAt === T0 + 4500 &&
			toolEv?.durationMs === 1500 &&
			JSON.stringify(toolEv?.args) === JSON.stringify({ url: "https://example.com" }) &&
			JSON.stringify(toolEv?.result) === JSON.stringify({ isError: false, status: 200 }),
		JSON.stringify(toolEv)?.slice(0, 300),
	);
	check(
		"thinking 事件摘要：level/chars/durationMs/truncated；正文类带 textChars 与 textPreview；system 带 subKind",
		thinkEv?.level === "high" &&
			thinkEv?.textChars === 3 &&
			thinkEv?.durationMs === 1200 &&
			thinkEv?.truncated === false &&
			userEv?.textChars === 3 &&
			userEv?.textPreview === "问题一" &&
			turns[0].events[0].subKind === "bot-created",
		`think=${JSON.stringify(thinkEv)} sys=${JSON.stringify(turns[0]?.events[0])}`,
	);

	// 老形状：条目没有任何时间字段（落盘戳引入前的文件）
	const legacy = bt([
		{ role: "user", text: "老问题", sessionId: "s-old" },
		{ role: "tool", toolCallId: "old1", name: "web_fetch", args: { url: "https://example.com" }, status: "complete", result: { isError: false }, sessionId: "s-old" },
		{ role: "assistant", text: "老回答", sessionId: "s-old" },
	]);
	const lt = legacy.turns[0] ?? { events: [] };
	check(
		"老形状容忍：无时间字段的条目读出 ts/durationMs/startedAt/endedAt 全 null，不抛错",
		legacy.turns.length === 1 &&
			lt.events.every((e) => e.ts === null && e.durationMs === null) &&
			lt.events[1]?.startedAt === null &&
			lt.events[1]?.endedAt === null &&
			lt.startedAt === null &&
			lt.endedAt === null &&
			lt.durationMs === null,
		JSON.stringify(lt).slice(0, 300),
	);

	// 未知 role 原样映射；预览脱敏与截断
	const misc = bt([
		{ role: "user", text: `令牌是 ${FAKE_SECRET} 别外传`, ts: iso(T0) },
		{ role: "notice", text: "x".repeat(500) },
	]);
	const [secEv, longEv] = misc.turns[0]?.events ?? [];
	check(
		"出接口脱敏：textPreview 里的令牌形状串被替换为 [REDACTED]，textChars 仍为原文长度",
		typeof secEv?.textPreview === "string" && !secEv.textPreview.includes(FAKE_SECRET) && secEv.textPreview.includes("[REDACTED]") && secEv.textChars === `令牌是 ${FAKE_SECRET} 别外传`.length,
		`preview=${secEv?.textPreview}`,
	);
	check(
		"未知 role 原样映射为 kind，超长正文预览截断到 200 字、textChars 记全文长度",
		longEv?.kind === "notice" && longEv?.textPreview?.length === 200 && longEv?.textChars === 500,
		`kind=${longEv?.kind} previewLen=${longEv?.textPreview?.length} chars=${longEv?.textChars}`,
	);
	check("空/坏输入容忍：buildTrace([]) 与 buildTrace(undefined) 都回 {turns: []}", bt([]).turns.length === 0 && bt(undefined).turns.length === 0);
}

// ---------- 子进程部分：真 server 对话落盘 + 轨迹接口 ----------
async function waitReady(proc, port, timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) return false;
		try {
			const res = await fetch(`http://127.0.0.1:${port}/api/bots`);
			if (res.status === 401) return true;
		} catch {
			/* 还没起来 */
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}

function startServer(port, dataDir) {
	const env = { ...process.env, PORT: String(port), PIPER_TOKEN: "trace-test-token", PIPER_DATA_DIR: dataDir, PIPER_GITHUB_API_BASE: "http://127.0.0.1:9" };
	for (const k of ["PIPER_MODEL_API_KEY", "OPENAI_API_KEY", "PIPER_MODEL_BASE_URL", "PIPER_MODEL_ID", "GITHUB_TOKEN", "PIPER_HOST"]) delete env[k];
	const proc = spawn("node", ["dist/server.js"], { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
	let log = "";
	proc.stdout.on("data", (d) => (log += d));
	proc.stderr.on("data", (d) => (log += d));
	return { proc, getLog: () => log };
}

function apiFor(port, token) {
	return async (path, init = {}, authed = true) => {
		const res = await fetch(`http://127.0.0.1:${port}${path}`, {
			...init,
			headers: { "Content-Type": "application/json", ...(authed ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) },
		});
		const text = await res.text();
		let json = null;
		try {
			json = JSON.parse(text);
		} catch {
			/* 非 JSON */
		}
		return { status: res.status, json, text };
	};
}

const SEG_A = "第一段思考：先抓页面再判断。";
const SEG_B = "第二段思考：结合页面内容作答。";

async function serverPart() {
	// 夹具页：延迟 80ms 返回，保证 web_fetch 的实测耗时明显大于 0
	const fixture = createServer((reqHttp, resHttp) => {
		setTimeout(() => {
			resHttp.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			resHttp.end("<html><head><title>轨迹夹具</title></head><body><p>轨迹夹具特征句：河狸在溪边垒了坝。</p></body></html>");
		}, 80);
	});
	await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
	const FIX_URL = `http://127.0.0.1:${fixture.address().port}/page`;

	const modelStub = createServer((reqHttp, resHttp) => {
		if (!reqHttp.url?.startsWith("/v1/chat/completions")) {
			resHttp.statusCode = 404;
			resHttp.end("{}");
			return;
		}
		let raw = "";
		reqHttp.on("data", (c) => (raw += c));
		reqHttp.on("end", () => {
			let body = {};
			try {
				body = JSON.parse(raw || "{}");
			} catch {
				/* 忽略 */
			}
			const model = body.model || "stub";
			const messages = body.messages ?? [];
			const last = messages[messages.length - 1] ?? {};
			const lastUser = [...messages].reverse().find((m) => m.role === "user");
			const userText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
			const toolNames = (body.tools ?? []).map((t) => t?.function?.name ?? t?.name);
			if (!body.stream) {
				resHttp.writeHead(200, { "Content-Type": "application/json" });
				resHttp.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1762732800, model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
				return;
			}
			resHttp.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
			const chunk = (delta, finishReason = null) =>
				`data: ${JSON.stringify({ id: "chatcmpl-trace", object: "chat.completion.chunk", created: 1762732800, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
			resHttp.write(chunk({ role: "assistant" }));
			const finish = (reason) => {
				resHttp.write(chunk({}, reason));
				resHttp.end("data: [DONE]\n\n");
			};
			if (last.role === "tool") {
				resHttp.write(chunk({ reasoning_content: SEG_B }));
				resHttp.write(chunk({ content: "轨迹答案。" }));
				finish("stop");
				return;
			}
			if (userText.includes("轨迹分段") && toolNames.includes("web_fetch") && typeof body.reasoning_effort === "string") {
				resHttp.write(chunk({ reasoning_content: SEG_A }));
				const args = JSON.stringify({ url: FIX_URL });
				resHttp.write(chunk({ tool_calls: [{ index: 0, id: "call_trace_fetch", type: "function", function: { name: "web_fetch", arguments: "" } }] }));
				resHttp.write(chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }));
				finish("tool_calls");
				return;
			}
			resHttp.write(chunk({ reasoning_content: "简单想一想。" }));
			resHttp.write(chunk({ content: "普通答案。" }));
			finish("stop");
		});
	});
	await new Promise((r) => modelStub.listen(0, "127.0.0.1", r));
	const STUB_V1 = `http://127.0.0.1:${modelStub.address().port}/v1`;

	const PORT = 4431;
	const dataDir = join(TMP_ROOT, "data-server");
	process.env.PIPER_TEST_MODE = "1";
	process.env.PIPER_WEB_FETCH_TEST_ALLOW = `127.0.0.1:${fixture.address().port}`;
	const { proc, getLog } = startServer(PORT, dataDir);
	const api = apiFor(PORT, "trace-test-token");
	const chat = async (message) => {
		const res = await fetch(`http://127.0.0.1:${PORT}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer trace-test-token" },
			body: JSON.stringify({ botId: "piper-main", message }),
			signal: AbortSignal.timeout(60000),
		});
		return res.text();
	};
	const sessionEntries = () => {
		const file = join(dataDir, "sessions", "piper-main.jsonl");
		if (!existsSync(file)) return [];
		return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	};
	try {
		const ready = await waitReady(proc, PORT);
		check("轨迹 server 启动成功", ready, getLog().slice(-400));
		if (!ready) return;

		const unauth = await api("/api/bots/piper-main/trace", {}, false);
		check("GET /api/bots/:id/trace 未登录返回 401", unauth.status === 401, `实际 ${unauth.status}`);
		const missing = await api("/api/bots/no-such-bot/trace");
		check("GET /api/bots/:id/trace bot 不存在返回 404 {error: bot 不存在}", missing.status === 404 && missing.json?.error === "bot 不存在", `status=${missing.status} body=${missing.text.slice(0, 120)}`);
		// 新建 bot 没有任何会话文件（repo-keeper 在起服时会被调度补跑写一条
		// system 播报，不适合当「空」的样本，故用刚创建的 bot）。
		const created = await api("/api/bots", { method: "POST", body: JSON.stringify({ name: "轨迹空 bot" }) });
		const empty = await api(`/api/bots/${created.json?.bot?.id}/trace`);
		check(
			"无会话文件的 bot：轨迹回 200 且 turns 为空数组",
			created.status === 201 && empty.status === 200 && Array.isArray(empty.json?.turns) && empty.json.turns.length === 0,
			`create=${created.status} status=${empty.status} body=${empty.text.slice(0, 120)}`,
		);

		await api("/api/settings/model", {
			method: "PUT",
			body: JSON.stringify({ provider: "deepseek", baseUrl: STUB_V1, modelId: "deepseek-flash", apiKey: CHAT_KEY, thinkingLevel: "high" }),
		});
		await api("/api/settings/connectors/web", { method: "PUT", body: JSON.stringify({ fetchEnabled: true }) });

		await chat(`轨迹分段测试：打开 ${FIX_URL} 看看`);
		const entries = sessionEntries();
		const userEntry = entries.find((e) => e.role === "user");
		const toolEntry = entries.find((e) => e.role === "tool");
		const thinkEntries = entries.filter((e) => e.role === "thinking");
		const asstEntry = entries.find((e) => e.role === "assistant");
		check(
			"落盘时间戳：user 与 assistant 条目带 ts（appendSession 落盘戳），本轮条目齐全",
			Boolean(userEntry?.ts) && Boolean(asstEntry?.ts) && Boolean(toolEntry) && thinkEntries.length === 2,
			`user=${JSON.stringify(userEntry?.ts)} asst=${JSON.stringify(asstEntry?.ts)} tools=${entries.filter((e) => e.role === "tool").length} thinks=${thinkEntries.length}`,
		);
		check(
			"落盘 tool 时间：startedAt/endedAt/durationMs 均为毫秒数、endedAt≥startedAt、durationMs=endedAt-startedAt 且 ≥30（夹具延迟 80ms）",
			typeof toolEntry?.startedAt === "number" &&
				typeof toolEntry?.endedAt === "number" &&
				typeof toolEntry?.durationMs === "number" &&
				toolEntry.endedAt >= toolEntry.startedAt &&
				toolEntry.durationMs === toolEntry.endedAt - toolEntry.startedAt &&
				toolEntry.durationMs >= 30,
			JSON.stringify({ startedAt: toolEntry?.startedAt, endedAt: toolEntry?.endedAt, durationMs: toolEntry?.durationMs }),
		);
		check(
			"落盘 thinking 时间：每段带 startedAt（段首时刻）与 durationMs，段序与工具时序交错自洽（段一 startedAt ≤ tool.startedAt ≤ tool.endedAt ≤ 段二 startedAt）",
			thinkEntries.length === 2 &&
				thinkEntries.every((e) => typeof e.startedAt === "number" && typeof e.durationMs === "number" && e.durationMs >= 0) &&
				thinkEntries[0].startedAt <= toolEntry.startedAt &&
				toolEntry.endedAt <= thinkEntries[1].startedAt,
			`thinks=${JSON.stringify(thinkEntries.map((e) => ({ startedAt: e.startedAt, durationMs: e.durationMs })))} tool=${JSON.stringify({ s: toolEntry?.startedAt, e: toolEntry?.endedAt })}`,
		);

		const trace = await api("/api/bots/piper-main/trace");
		const t0 = trace.json?.turns?.[0];
		check(
			"轨迹接口一轮：turns 恰 1 轮，事件顺序 user→thinking→tool→thinking→assistant",
			trace.status === 200 &&
				trace.json?.turns?.length === 1 &&
				JSON.stringify(t0?.events?.map((e) => e.kind)) === JSON.stringify(["user", "thinking", "tool", "thinking", "assistant"]),
			`status=${trace.status} kinds=${JSON.stringify(t0?.events?.map((e) => e.kind))}`,
		);
		const toolEv = t0?.events?.find((e) => e.kind === "tool");
		const thinkEvs = t0?.events?.filter((e) => e.kind === "thinking") ?? [];
		check(
			"轨迹接口时间与摘要：turn.startedAt=user 条目 ts 的毫秒值、durationMs=endedAt-startedAt；tool durationMs 与落盘一致；thinking 带 level=high 与 chars",
			t0?.startedAt === Date.parse(userEntry.ts) &&
				typeof t0?.endedAt === "number" &&
				t0?.durationMs === t0.endedAt - t0.startedAt &&
				toolEv?.durationMs === toolEntry.durationMs &&
				toolEv?.ts === toolEntry.startedAt &&
				thinkEvs.length === 2 &&
				thinkEvs.every((e) => e.level === "high") &&
				thinkEvs[0]?.textChars === SEG_A.length &&
				thinkEvs[1]?.textChars === SEG_B.length,
			`turn=${JSON.stringify({ startedAt: t0?.startedAt, endedAt: t0?.endedAt, durationMs: t0?.durationMs })}`,
		);

		await chat("普通问题，不用抓页面");
		const trace2 = await api("/api/bots/piper-main/trace");
		check(
			"第二轮后 turns 为 2，第二轮 index=1 且事件顺序 user→thinking→assistant",
			trace2.json?.turns?.length === 2 &&
				trace2.json.turns[1].index === 1 &&
				JSON.stringify(trace2.json.turns[1].events.map((e) => e.kind)) === JSON.stringify(["user", "thinking", "assistant"]),
			`turns=${trace2.json?.turns?.length} kinds2=${JSON.stringify(trace2.json?.turns?.[1]?.events?.map((e) => e.kind))}`,
		);
	} finally {
		proc.kill("SIGTERM");
		modelStub.close();
		fixture.close();
		delete process.env.PIPER_TEST_MODE;
		delete process.env.PIPER_WEB_FETCH_TEST_ALLOW;
	}
}

// ---------- 老文件部分：手工种子的无时间字段 JSONL，读出 null 且文件不被回写 ----------
async function legacyPart() {
	const PORT = 4432;
	const dataDir = join(TMP_ROOT, "data-legacy");
	mkdirSync(join(dataDir, "sessions"), { recursive: true });
	const legacyLines = [
		{ role: "user", text: "老问题", sessionId: "s-old" },
		{ role: "tool", toolCallId: "old1", name: "web_fetch", args: { url: "https://example.com" }, status: "complete", result: { isError: false }, sessionId: "s-old" },
		{ role: "assistant", text: "老回答", ts: "2026-11-01T08:00:00.000Z", sessionId: "s-old" },
	];
	const file = join(dataDir, "sessions", "piper-main.jsonl");
	const raw = legacyLines.map((l) => JSON.stringify(l)).join("\n") + "\n";
	writeFileSync(file, raw);
	const { proc, getLog } = startServer(PORT, dataDir);
	const api = apiFor(PORT, "trace-test-token");
	try {
		const ready = await waitReady(proc, PORT);
		check("老文件 server 启动成功", ready, getLog().slice(-400));
		if (!ready) return;
		const trace = await api("/api/bots/piper-main/trace");
		const t0 = trace.json?.turns?.[0];
		const byKind = Object.fromEntries((t0?.events ?? []).map((e) => [e.kind, e]));
		check(
			"老文件轨迹：200 且分轮正常；无 ts 的 user/tool 事件时间全 null，带 ISO 戳的 assistant 解析为毫秒",
			trace.status === 200 &&
				trace.json?.turns?.length === 1 &&
				byKind.user?.ts === null &&
				byKind.tool?.ts === null &&
				byKind.tool?.durationMs === null &&
				byKind.tool?.startedAt === null &&
				byKind.assistant?.ts === Date.parse("2026-11-01T08:00:00.000Z") &&
				t0?.startedAt === null &&
				t0?.durationMs === null,
			`status=${trace.status} body=${trace.text.slice(0, 300)}`,
		);
		await api("/api/bots/piper-main/messages");
		check("读路径不回写：GET trace 与 GET messages 后老会话文件字节不变", readFileSync(file, "utf8") === raw);
	} finally {
		proc.kill("SIGTERM");
	}
}

try {
	await unitPart();
	await serverPart();
	await legacyPart();
} finally {
	rmSync(TMP_ROOT, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
	console.log("失败项：");
	for (const f of failed) console.log(`  ${String(f.seq).padStart(2, "0")} ${f.name}`);
	process.exit(1);
}
