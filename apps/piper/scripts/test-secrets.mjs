// R7 秘密面单测：设置文件权限 0600、统一 redact（当前/历史/环境/前缀模式）、
// 短 Key 固定掩码、模型测试接口不外送已保存 Key、厂商错误回显 Key 时会话 JSONL 与
// SSE 不落 Key。用临时 PIPER_DATA_DIR 与本地模型桩，全程离线。
// 用法（在 apps/piper 下）：node scripts/test-secrets.mjs（或 npm run test:secrets）
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP_ROOT = mkdtempSync(join(tmpdir(), "piper-secrets-"));
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

const MODEL_KEY = "sk-saved-model-key-abcdef123456";
const TOKEN_A = "github_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_B = "github_pat_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const ENV_TOKEN = "ghp_envtokenenvtokenenvtokenenvtoken1234";

function modeOf(file) {
	return statSync(file).mode & 0o777;
}

async function unitPart() {
	const settings = await import("../dist/lib/settings.js");
	let redact = null;
	let containsSecret = null;
	let redactLoadError = "";
	try {
		({ redact, containsSecret } = await import("../dist/lib/redact.js"));
	} catch (err) {
		redactLoadError = err.message;
	}

	// ---- 设置文件 chmod 0600 ----
	settings.saveModelSettingsFile({ apiKey: MODEL_KEY, baseUrl: "https://api.openai.com/v1", modelId: "gpt-4o-mini" });
	const modelFile = join(TMP_DATA, "settings-model.json");
	check("保存后 settings-model.json 权限为 0600", modeOf(modelFile) === 0o600, `实际 ${modeOf(modelFile).toString(8)}`);

	const githubFile = join(TMP_DATA, "settings-github.json");
	writeFileSync(githubFile, "{}\n", { mode: 0o644 });
	settings.saveGithubSettingsFile({ token: TOKEN_A });
	check("已存在的 settings-github.json 保存后权限被收紧为 0600", modeOf(githubFile) === 0o600, `实际 ${modeOf(githubFile).toString(8)}`);

	settings.saveProfileSettings({ displayName: "测试" });
	const profileFile = join(TMP_DATA, "settings-profile.json");
	check("保存后 settings-profile.json 权限为 0600", modeOf(profileFile) === 0o600, `实际 ${modeOf(profileFile).toString(8)}`);

	// ---- 统一 redact ----
	if (!redact) {
		check("lib/redact.mjs 存在并导出 redact/containsSecret", false, redactLoadError);
		for (const n of ["当前 GitHub 令牌", "当前模型 Key", "轮换前的旧令牌", "环境变量令牌", "前缀模式", "干净文本", "containsSecret"]) {
			check(`redact 覆盖：${n}`, false, "redact 未加载");
		}
	} else {
		check("redact 替换当前设置文件里的 GitHub 令牌", !redact(`令牌是 ${TOKEN_A} 请保密`).includes(TOKEN_A));
		check("redact 替换当前设置文件里的模型 Key", !redact(`key=${MODEL_KEY}`).includes(MODEL_KEY));

		// 轮换：TOKEN_A 曾被收集过，换成 TOKEN_B 后 A 仍须被脱敏（进程内历史）。
		settings.saveGithubSettingsFile({ token: TOKEN_B });
		check("redact 替换轮换前的旧 GitHub 令牌（进程内历史）", !redact(`旧令牌 ${TOKEN_A} 泄漏`).includes(TOKEN_A));
		check("redact 替换轮换后的现 GitHub 令牌", !redact(`新令牌 ${TOKEN_B}`).includes(TOKEN_B));

		process.env.GITHUB_TOKEN = ENV_TOKEN;
		check("redact 替换环境变量里的 GitHub 令牌", !redact(`env ${ENV_TOKEN}`).includes(ENV_TOKEN));
		delete process.env.GITHUB_TOKEN;

		const patternSamples = [
			`ghp_${"C".repeat(36)}`,
			`github_pat_${"D".repeat(40)}`,
			`sk-proj-${"E".repeat(24)}`,
			`sk-${"F".repeat(24)}`,
		];
		const joined = patternSamples.join(" ");
		const out = redact(joined);
		check("redact 替换未保存过的前缀模式秘密（ghp_/github_pat_/sk-）", patternSamples.every((s) => !out.includes(s)), out);

		check("redact 不误伤普通文本", redact("普通文本 hello 123，PR #42 已合并") === "普通文本 hello 123，PR #42 已合并");

		check(
			"containsSecret：旧令牌/前缀模式判有、干净文本判无",
			containsSecret(`正文含 ${TOKEN_A}`) === true && containsSecret(`ghp_${"G".repeat(36)}`) === true && containsSecret("干净的评论正文") === false,
		);
	}

	// ---- 短 Key 固定掩码 ----
	const hint = typeof settings.secretHint === "function" ? settings.secretHint : null;
	check(
		"secretHint：≤8 位 Key 返回固定掩码（不含真实字符）",
		Boolean(hint) && hint("k1234567") === "••••••••",
		hint ? `实际 ${hint("k1234567")}` : "settings.secretHint 不存在",
	);
	check(
		"secretHint：长 Key 仍为末四位掩码、空 Key 为空串",
		Boolean(hint) && hint(MODEL_KEY).endsWith(MODEL_KEY.slice(-4)) && hint("") === "",
		hint ? `实际 ${hint(MODEL_KEY)}` : "settings.secretHint 不存在",
	);
}

// ---------- 子进程部分：模型测试接口与错误回显 ----------
const STUB_PORT = 4417;
const SRV_PORT = 4418;
const STUB_BASE = `http://127.0.0.1:${STUB_PORT}/v1`;
const SRV_TOKEN = "r7-test-token";
const SAVED_KEY = "sk-saved-r7-key-abcdef123456";
const PROVIDED_KEY = "sk-provided-r7-key-654321fedcba";
const ECHO_KEY = "sk-echo-r7-key-zzzz9999";

function startStub() {
	const hits = [];
	let mode = "ok";
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (d) => (raw += d));
		req.on("end", () => {
			const auth = req.headers.authorization || "";
			if (!req.url.startsWith("/v1/")) {
				res.writeHead(404, { "Content-Type": "application/json" });
				return res.end(JSON.stringify({ message: "not found" }));
			}
			hits.push({ url: req.url, auth });
			if (mode === "echo401") {
				const key = auth.replace(/^Bearer\s+/i, "");
				res.writeHead(401, { "Content-Type": "application/json" });
				return res.end(JSON.stringify({ error: { message: `Invalid API key provided: ${key}`, code: "invalid_api_key" } }));
			}
			let body = {};
			try {
				body = JSON.parse(raw || "{}");
			} catch {
				/* 忽略 */
			}
			if (body.stream) {
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				const chunk = (delta, finish = null) =>
					`data: ${JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", created: 0, model: "stub-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
				res.write(chunk({ role: "assistant", content: "po" }));
				res.write(chunk({ content: "ng" }));
				res.write(chunk({}, "stop"));
				return res.end("data: [DONE]\n\n");
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					id: "chatcmpl-stub",
					object: "chat.completion",
					created: 0,
					model: "stub-model",
					choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				}),
			);
		});
	});
	return {
		hits,
		setMode: (m) => (mode = m),
		listen: () => new Promise((r) => server.listen(STUB_PORT, "127.0.0.1", r)),
		close: () => new Promise((r) => server.close(r)),
	};
}

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

async function serverPart() {
	const stub = startStub();
	await stub.listen();
	const dataDir = join(TMP_ROOT, "data-server");
	const env = { ...process.env, PORT: String(SRV_PORT), PIPER_TOKEN: SRV_TOKEN, PIPER_DATA_DIR: dataDir, PIPER_GITHUB_API_BASE: `http://127.0.0.1:${STUB_PORT}` };
	for (const k of ["PIPER_MODEL_API_KEY", "OPENAI_API_KEY", "PIPER_MODEL_BASE_URL", "PIPER_MODEL_ID", "GITHUB_TOKEN", "PIPER_HOST"]) delete env[k];
	const proc = spawn("node", ["dist/server.js"], { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
	let serverLog = "";
	proc.stdout.on("data", (d) => (serverLog += d));
	proc.stderr.on("data", (d) => (serverLog += d));
	const api = async (path, init = {}) => {
		const res = await fetch(`http://127.0.0.1:${SRV_PORT}${path}`, {
			...init,
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${SRV_TOKEN}`, ...(init.headers || {}) },
		});
		const text = await res.text();
		let json = null;
		try {
			json = JSON.parse(text);
		} catch {
			/* SSE 等非 JSON */
		}
		return { status: res.status, json, text };
	};
	try {
		const ready = await waitReady(proc, SRV_PORT);
		check("子进程 server 启动成功", ready, serverLog.slice(-400));
		if (!ready) return;

		const save = await api("/api/settings/model", {
			method: "PUT",
			body: JSON.stringify({ baseUrl: STUB_BASE, modelId: "stub-model", apiKey: SAVED_KEY }),
		});
		check("PUT /api/settings/model 保存桩配置成功", save.status === 200 && save.json?.configured === true, `实际 ${save.status}`);

		// 只传 baseUrl：必须 400，且桩不得收到任何请求（已保存 Key 绝不外送）。
		const hitsBefore = stub.hits.length;
		const onlyBase = await api("/api/settings/model/test", { method: "POST", body: JSON.stringify({ baseUrl: STUB_BASE }) });
		check(
			"POST /api/settings/model/test 只传 baseUrl 返回 400 且桩零请求（不外送已保存 Key）",
			onlyBase.status === 400 && stub.hits.length === hitsBefore,
			`status=${onlyBase.status} 桩新增请求=${stub.hits.length - hitsBefore}`,
		);

		const badProto = await api("/api/settings/model/test", {
			method: "POST",
			body: JSON.stringify({ baseUrl: "ftp://example.invalid/v1", apiKey: "sk-whatever-1234567890" }),
		});
		check("POST /api/settings/model/test 非 http/https 的 baseUrl 返回 400", badProto.status === 400, `实际 ${badProto.status}`);

		// baseUrl + apiKey 一起给：正常测试，且桩收到的只能是请求体给的 Key。
		stub.setMode("ok");
		const withKey = await api("/api/settings/model/test", {
			method: "POST",
			body: JSON.stringify({ baseUrl: STUB_BASE, apiKey: PROVIDED_KEY }),
		});
		const lastAuth = stub.hits[stub.hits.length - 1]?.auth;
		check(
			"POST /api/settings/model/test 同时给 baseUrl+apiKey 正常执行且只用请求体的 Key",
			withKey.status === 200 && withKey.json?.ok === true && lastAuth === `Bearer ${PROVIDED_KEY}`,
			`status=${withKey.status} json=${JSON.stringify(withKey.json)} auth=${lastAuth}`,
		);

		// 厂商错误回显 Key：test 接口返回值、chat 的 SSE、会话 JSONL 都不得含 Key。
		stub.setMode("echo401");
		const echoTest = await api("/api/settings/model/test", { method: "POST", body: JSON.stringify({ apiKey: ECHO_KEY }) });
		check(
			"模型 test 接口在厂商错误回显 Key 时返回值不含 Key 全文",
			echoTest.status === 200 && !(echoTest.text || "").includes(ECHO_KEY),
			`响应=${(echoTest.text || "").slice(0, 200)}`,
		);

		const chat = await api("/api/chat", { method: "POST", body: JSON.stringify({ botId: "piper-main", message: "你好" }) });
		check("chat 在厂商 401 回显 Key 时 SSE 不含已保存 Key 全文", !(chat.text || "").includes(SAVED_KEY), `SSE 片段=${(chat.text || "").slice(0, 300)}`);
		const sessionFile = join(dataDir, "sessions", "piper-main.jsonl");
		const sessionText = existsSync(sessionFile) ? readFileSync(sessionFile, "utf8") : "";
		check("会话 JSONL 在厂商错误回显 Key 时不含 Key 全文", !sessionText.includes(SAVED_KEY), sessionText.slice(-300));
	} finally {
		proc.kill("SIGTERM");
		await stub.close();
	}
}

try {
	await unitPart();
	await serverPart();
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
