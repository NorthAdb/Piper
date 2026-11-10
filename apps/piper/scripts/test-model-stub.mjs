// R9 模型链路离线回归：本地 OpenAI 兼容 stub 打通 L0-2 验收 3/4 的链路，全程不打活网。
// 用法（在 apps/piper 下）：node scripts/test-model-stub.mjs（或 npm run test:model-stub）
// 覆盖：
//   - 保存 stub 配置后 GET 读回只有掩码、响应不含 Key 全文；
//   - 测试连接走 stub 返回 ok（completeSimple 非流式路径）；
//   - 一次对话 SSE 中 delta ≥ 2 且拼合等于 stub 回复全文，会话 JSONL 落了助手文本且不含 Key；
//   - 失败分类可区分：端点不通 → SSE error code 为 MODEL_ERROR（不是 BASE_NOT_BUILT、
//     也不是 MODEL_NOT_CONFIGURED），测试连接的 error 文本不含「基座未构建」；
//   - 清除 Key 后对话回 MODEL_NOT_CONFIGURED。
// 隔离：server 子进程带 PIPER_DATA_DIR 临时目录、PIPER_GITHUB_API_BASE 本地桩，
// 与用户真实 data/ 无关；结束清理临时目录。
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.MODEL_STUB_PORT || 4397);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "piper-dev";
const FAKE_KEY = "sk-r9-stub-1234567890qwer";
const STUB_TEXT_PARTS = ["你好", "，这里是本地", " stub 的回复。"];
const STUB_TEXT = STUB_TEXT_PARTS.join("");

const TMP_ROOT = mkdtempSync(join(tmpdir(), "piper-model-stub-"));
const TMP_DATA = join(TMP_ROOT, "data");

const results = [];
let seq = 0;
function check(name, ok, detail = "") {
	seq += 1;
	results.push({ seq, name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${String(seq).padStart(2, "0")} ${name}${ok ? "" : ` — ${detail}`}`);
}

// ---- 本地 GitHub 桩（安静数据：扫描就算被调度触发也不开 Finding、不打活网） ----
const ghStub = createServer((reqHttp, resHttp) => {
	const u = new URL(reqHttp.url ?? "/", "http://stub.invalid");
	resHttp.setHeader("Content-Type", "application/json");
	let payload;
	if (u.pathname.includes("/actions/runs")) payload = { workflow_runs: [] };
	else if (/\/(commits|pulls|issues)$/.test(u.pathname) || u.pathname.includes("/reviews")) payload = [];
	else if (/^\/repos\/[^/]+\/[^/]+$/.test(u.pathname))
		payload = { stargazers_count: 1, forks_count: 0, default_branch: "main", pushed_at: "2026-11-10T00:00:00Z" };
	else {
		resHttp.statusCode = 404;
		payload = { message: "Not Found" };
	}
	resHttp.end(JSON.stringify(payload));
});
await new Promise((r) => ghStub.listen(0, "127.0.0.1", r));
const GH_BASE = `http://127.0.0.1:${ghStub.address().port}`;

// ---- 本地 OpenAI 兼容 stub：stream 走 SSE 分片，非 stream 回整段 JSON ----
const seenAuth = [];
const modelStub = createServer((reqHttp, resHttp) => {
	if (!reqHttp.url?.startsWith("/v1/chat/completions")) {
		resHttp.statusCode = 404;
		resHttp.end(JSON.stringify({ error: { message: "not found" } }));
		return;
	}
	seenAuth.push(reqHttp.headers.authorization ?? "");
	let raw = "";
	reqHttp.on("data", (c) => (raw += c));
	reqHttp.on("end", () => {
		let body = {};
		try {
			body = JSON.parse(raw || "{}");
		} catch {
			/* 忽略 */
		}
		const model = body.model || "stub-model";
		if (body.stream) {
			resHttp.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
			const chunk = (delta, finishReason = null) =>
				`data: ${JSON.stringify({
					id: "chatcmpl-stub",
					object: "chat.completion.chunk",
					created: 1762732800,
					model,
					choices: [{ index: 0, delta, finish_reason: finishReason }],
				})}\n\n`;
			resHttp.write(chunk({ role: "assistant" }));
			for (const part of STUB_TEXT_PARTS) resHttp.write(chunk({ content: part }));
			resHttp.write(chunk({}, "stop"));
			resHttp.end("data: [DONE]\n\n");
		} else {
			resHttp.writeHead(200, { "Content-Type": "application/json" });
			resHttp.end(
				JSON.stringify({
					id: "chatcmpl-stub",
					object: "chat.completion",
					created: 1762732800,
					model,
					choices: [
						{ index: 0, message: { role: "assistant", content: STUB_TEXT }, finish_reason: "stop" },
					],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				}),
			);
		}
	});
});
await new Promise((r) => modelStub.listen(0, "127.0.0.1", r));
const MODEL_BASE = `http://127.0.0.1:${modelStub.address().port}/v1`;

// ---- 起被测 server（隔离环境） ----
const env = { ...process.env, PORT: String(PORT), PIPER_DATA_DIR: TMP_DATA, PIPER_GITHUB_API_BASE: GH_BASE };
delete env.PIPER_TOKEN;
delete env.PIPER_HOST;
for (const k of ["PIPER_MODEL_API_KEY", "OPENAI_API_KEY", "PIPER_MODEL_BASE_URL", "PIPER_MODEL_ID", "GITHUB_TOKEN"]) delete env[k];
const proc = spawn("node", ["server.mjs"], { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
proc.stdout.on("data", (d) => (serverLog += d));
proc.stderr.on("data", (d) => (serverLog += d));

let cookie = "";
async function req(path, init = {}) {
	const res = await fetch(BASE + path, {
		...init,
		headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(init.headers || {}) },
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		/* 非 JSON */
	}
	return { status: res.status, json, text };
}

async function chatEvents(message) {
	const res = await fetch(`${BASE}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Cookie: cookie },
		body: JSON.stringify({ botId: "piper-main", message }),
		signal: AbortSignal.timeout(60000),
	});
	const raw = await res.text();
	const events = [];
	for (const block of raw.split("\n\n")) {
		const ev = /event: (.*)/.exec(block)?.[1];
		const data = /data: (.*)/s.exec(block)?.[1];
		if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
	}
	return events;
}

async function waitReady() {
	for (let i = 0; i < 60; i++) {
		if (proc.exitCode !== null) return false;
		try {
			const res = await fetch(`${BASE}/api/bots`);
			if (res.status === 401) return true;
		} catch {
			/* 还没起来 */
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}

try {
	check("被测 server 在隔离目录启动成功", await waitReady(), serverLog.slice(-400));

	const login = await fetch(`${BASE}/api/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token: TOKEN }),
	});
	cookie = (login.headers.get("set-cookie") || "").split(";")[0];
	check("登录成功拿到会话 cookie", login.status === 200 && Boolean(cookie), `实际 ${login.status}`);

	// 保存 stub 配置：读回只有掩码、响应不含 Key 全文
	await req("/api/settings/model", {
		method: "PUT",
		body: JSON.stringify({ baseUrl: MODEL_BASE, modelId: "stub-model", apiKey: FAKE_KEY }),
	});
	const view = await req("/api/settings/model");
	check(
		"保存 stub 配置后 GET configured=true、apiKeyHint 只回末四位掩码且响应不含 Key 全文",
		view.json?.configured === true &&
			String(view.json?.apiKeyHint ?? "").endsWith("qwer") &&
			!JSON.stringify(view.json).includes(FAKE_KEY),
		`实际 ${JSON.stringify(view.json)}`,
	);

	// 测试连接走已保存配置（请求体不带 baseUrl，不触发 R7 的外送守卫）
	const test = await req("/api/settings/model/test", { method: "POST", body: "{}" });
	check("POST /api/settings/model/test 用已保存 stub 配置返回 ok:true", test.json?.ok === true, `实际 ${JSON.stringify(test.json)}`);

	// 流式对话：delta ≥2、拼合等于 stub 全文、无 error、末尾 done；且 stub 收到的是保存的 Key
	const ev = await chatEvents("你好，请回一句话");
	const deltas = ev.filter((e) => e.event === "delta");
	const joined = deltas.map((e) => e.data?.text ?? "").join("");
	const errEv = ev.find((e) => e.event === "error");
	check(
		"对话 SSE 的 delta ≥ 2 且拼合等于 stub 回复全文、无 error 事件",
		deltas.length >= 2 && joined === STUB_TEXT && !errEv,
		`delta=${deltas.length} 拼合=${JSON.stringify(joined)} err=${JSON.stringify(errEv?.data ?? null)}`,
	);
	check(
		"stub 收到的 Authorization 是保存的 Key（链路真的用了设置里的 Key）",
		seenAuth.length > 0 && seenAuth.every((a) => a === `Bearer ${FAKE_KEY}`),
		`请求数=${seenAuth.length}`,
	);

	// 会话 JSONL：落了助手文本、不含 Key 全文
	const sessionFile = join(TMP_DATA, "sessions", "piper-main.jsonl");
	const sessionText = existsSync(sessionFile) ? readFileSync(sessionFile, "utf8") : "";
	check(
		"会话 JSONL 含助手回复全文且不含 Key 全文",
		sessionText.includes(STUB_TEXT) && !sessionText.includes(FAKE_KEY),
		`文件存在=${existsSync(sessionFile)} 含回复=${sessionText.includes(STUB_TEXT)} 含Key=${sessionText.includes(FAKE_KEY)}`,
	);

	// 失败分类一：端点不通（死端口）→ 测试连接 error 不含「基座未构建」，对话 error code 为 MODEL_ERROR
	const DEAD_BASE = "http://127.0.0.1:9/v1";
	const deadTest = await req("/api/settings/model/test", {
		method: "POST",
		body: JSON.stringify({ baseUrl: DEAD_BASE, apiKey: FAKE_KEY }),
	});
	check(
		"死端点测试连接 ok:false 且 error 不含「基座未构建」（端点不通类，与基座未构建可区分）",
		deadTest.json?.ok === false &&
			typeof deadTest.json?.error === "string" &&
			deadTest.json.error.length > 0 &&
			!deadTest.json.error.includes("基座未构建"),
		`实际 ${JSON.stringify(deadTest.json)}`,
	);
	await req("/api/settings/model", { method: "PUT", body: JSON.stringify({ baseUrl: DEAD_BASE }) });
	const deadEv = await chatEvents("你好");
	const deadErr = deadEv.find((e) => e.event === "error");
	check(
		"死端点对话 SSE error code 为 MODEL_ERROR（端点不通；不是 BASE_NOT_BUILT / MODEL_NOT_CONFIGURED）",
		deadErr?.data?.code === "MODEL_ERROR",
		`实际 ${JSON.stringify(deadErr?.data ?? null)}`,
	);

	// 失败分类二：清除 Key → 回到未配置
	const clear = await req("/api/settings/model", { method: "PUT", body: JSON.stringify({ apiKey: "" }) });
	const clearEv = await chatEvents("你好");
	const clearErr = clearEv.find((e) => e.event === "error");
	check(
		"清除 Key 后 configured=false 且对话再回 MODEL_NOT_CONFIGURED",
		clear.json?.configured === false && clearErr?.data?.code === "MODEL_NOT_CONFIGURED",
		`clear=${JSON.stringify(clear.json)} err=${JSON.stringify(clearErr?.data ?? null)}`,
	);
} finally {
	proc.kill("SIGTERM");
	ghStub.close();
	modelStub.close();
	rmSync(TMP_ROOT, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
	console.log(`server 输出（节选）：\n${serverLog.slice(-800)}`);
	process.exit(1);
}
