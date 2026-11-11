// 模型服务商选择单测：目录形状与归属判定（单元）、目录接口未登录 401、
// 选 deepseek 保存→读回（provider/baseUrl 预置/Key 只掩码）、未知 provider 400、
// custom 保存任意端点、旧格式文件（无 provider）读回 custom 且原值不丢。
// 用临时 PIPER_DATA_DIR 起真 server，全程离线。
// 用法（在 apps/piper 下）：node scripts/test-model-providers.mjs（或 npm run test:model-providers）
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP_ROOT = mkdtempSync(join(tmpdir(), "piper-providers-"));
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

const DEEPSEEK_KEY = "sk-deepseek-test-key-abcdef123456";
const CUSTOM_KEY = "sk-custom-test-key-654321fedcba";
const LEGACY_KEY = "sk-legacy-test-key-zzzz9999aaaa";

async function unitPart() {
	const { MODEL_PROVIDERS, getModelProvider, isKnownModelProvider, resolveModelProviderId } = await import("../lib/model-providers.mjs");
	const settings = await import("../lib/settings.mjs");

	const expectedIds = ["deepseek", "openai", "moonshot", "zhipu", "dashscope", "siliconflow", "openrouter", "custom"];
	check(
		"目录恰含 8 个服务商 id（deepseek/openai/moonshot/zhipu/dashscope/siliconflow/openrouter/custom）",
		MODEL_PROVIDERS.length === expectedIds.length && expectedIds.every((id) => getModelProvider(id)),
		`实际 ${MODEL_PROVIDERS.map((p) => p.id).join(",")}`,
	);
	check(
		"非 custom 条目 baseUrl 均为 https 且 models 非空；custom 的 baseUrl 为空、models 为空",
		MODEL_PROVIDERS.every((p) => (p.id === "custom" ? p.baseUrl === "" && p.models.length === 0 : /^https:\/\//.test(p.baseUrl) && p.models.length > 0)),
	);
	const ds = getModelProvider("deepseek");
	check(
		"deepseek 预置准确：baseUrl 与 deepseek-chat/deepseek-reasoner",
		ds.baseUrl === "https://api.deepseek.com/v1" && ds.models.includes("deepseek-chat") && ds.models.includes("deepseek-reasoner"),
		JSON.stringify(ds),
	);
	check("resolveModelProviderId：无 provider 字段 → custom", resolveModelProviderId({}) === "custom" && resolveModelProviderId(null) === "custom");
	check(
		"resolveModelProviderId：合法 id 原样、未知 id → custom；isKnownModelProvider 同口径",
		resolveModelProviderId({ provider: "deepseek" }) === "deepseek" &&
			resolveModelProviderId({ provider: "nope" }) === "custom" &&
			isKnownModelProvider("zhipu") &&
			!isKnownModelProvider("nope"),
	);

	settings.saveModelSettingsFile({ provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-chat", apiKey: DEEPSEEK_KEY });
	const saved = settings.readModelSettingsFile();
	check("saveModelSettingsFile 落盘 provider 字段", saved.provider === "deepseek", JSON.stringify(saved.provider));

	// 旧格式：直接写一份没有 provider 的文件，读回应原值不丢、归属 custom。
	writeFileSync(
		join(TMP_DATA, "settings-model.json"),
		JSON.stringify({ baseUrl: "https://legacy.example.com/v1", modelId: "legacy-model", apiKey: LEGACY_KEY }) + "\n",
		{ mode: 0o600 },
	);
	const legacy = settings.readModelSettingsFile();
	check(
		"旧格式文件（无 provider）读回原值不丢且归属 custom",
		legacy.baseUrl === "https://legacy.example.com/v1" && legacy.modelId === "legacy-model" && legacy.apiKey === LEGACY_KEY && resolveModelProviderId(legacy) === "custom",
		JSON.stringify({ ...legacy, apiKey: legacy.apiKey ? "***" : "" }),
	);
}

// ---------- 子进程部分：真 server 上的目录接口与保存/读回 ----------
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
	const env = { ...process.env, PORT: String(port), PIPER_TOKEN: "providers-test-token", PIPER_DATA_DIR: dataDir, PIPER_GITHUB_API_BASE: "http://127.0.0.1:9" };
	for (const k of ["PIPER_MODEL_API_KEY", "OPENAI_API_KEY", "PIPER_MODEL_BASE_URL", "PIPER_MODEL_ID", "GITHUB_TOKEN", "PIPER_HOST"]) delete env[k];
	const proc = spawn("node", ["server.mjs"], { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
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

async function serverPart() {
	const PORT = 4423;
	const dataDir = join(TMP_ROOT, "data-server");
	const { proc, getLog } = startServer(PORT, dataDir);
	const api = apiFor(PORT, "providers-test-token");
	try {
		const ready = await waitReady(proc, PORT);
		check("子进程 server 启动成功", ready, getLog().slice(-400));
		if (!ready) return;

		const unauth = await api("/api/model-providers", {}, false);
		check("GET /api/model-providers 未登录返回 401", unauth.status === 401, `实际 ${unauth.status}`);

		const catalog = await api("/api/model-providers");
		const dsEntry = catalog.json?.providers?.find((p) => p.id === "deepseek");
		check(
			"GET /api/model-providers 登录后 200 且形状完整（8 条、deepseek 字段齐）",
			catalog.status === 200 &&
				Array.isArray(catalog.json?.providers) &&
				catalog.json.providers.length === 8 &&
				dsEntry?.name === "DeepSeek" &&
				dsEntry?.baseUrl === "https://api.deepseek.com/v1" &&
				Array.isArray(dsEntry?.models) &&
				dsEntry.models.includes("deepseek-reasoner"),
			`status=${catalog.status} body=${catalog.text.slice(0, 200)}`,
		);

		const save = await api("/api/settings/model", {
			method: "PUT",
			body: JSON.stringify({ provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-chat", apiKey: DEEPSEEK_KEY }),
		});
		check(
			"PUT 保存 deepseek：回 provider=deepseek、预置 baseUrl、Key 只末四位掩码且响应无全文",
			save.status === 200 &&
				save.json?.provider === "deepseek" &&
				save.json?.baseUrl === "https://api.deepseek.com/v1" &&
				save.json?.modelId === "deepseek-chat" &&
				save.json?.configured === true &&
				save.json?.apiKeyHint === `••••${DEEPSEEK_KEY.slice(-4)}` &&
				!save.text.includes(DEEPSEEK_KEY),
			`status=${save.status} body=${save.text.slice(0, 300)}`,
		);

		const view = await api("/api/settings/model");
		check(
			"GET /api/settings/model 读回同为 deepseek + 掩码，响应无 Key 全文",
			view.status === 200 && view.json?.provider === "deepseek" && view.json?.apiKeyHint === `••••${DEEPSEEK_KEY.slice(-4)}` && !view.text.includes(DEEPSEEK_KEY),
			`status=${view.status} body=${view.text.slice(0, 300)}`,
		);

		const modelFile = join(dataDir, "settings-model.json");
		const onDisk = existsSync(modelFile) ? readFileSync(modelFile, "utf8") : "";
		check(
			"落盘 settings-model.json 含 provider=deepseek 且权限 0600",
			onDisk.includes('"provider": "deepseek"') && (statSync(modelFile).mode & 0o777) === 0o600,
			onDisk.slice(0, 200),
		);

		const bad = await api("/api/settings/model", { method: "PUT", body: JSON.stringify({ provider: "nope" }) });
		const afterBad = await api("/api/settings/model");
		check(
			"PUT 未知 provider 返回 400 且已有配置不变",
			bad.status === 400 && afterBad.json?.provider === "deepseek",
			`status=${bad.status} provider=${afterBad.json?.provider}`,
		);

		const custom = await api("/api/settings/model", {
			method: "PUT",
			body: JSON.stringify({ provider: "custom", baseUrl: "http://127.0.0.1:9/v1", modelId: "any-model-x", apiKey: CUSTOM_KEY }),
		});
		check(
			"PUT 保存 custom 任意端点与任意模型名可用，读回 provider=custom",
			custom.status === 200 && custom.json?.provider === "custom" && custom.json?.baseUrl === "http://127.0.0.1:9/v1" && custom.json?.modelId === "any-model-x",
			`status=${custom.status} body=${custom.text.slice(0, 300)}`,
		);

		const legacyPatch = await api("/api/settings/model", { method: "PUT", body: JSON.stringify({ modelId: "legacy-patched" }) });
		check(
			"PUT 旧客户端形状（无 provider 字段）部分更新不清空已存 provider",
			legacyPatch.status === 200 && legacyPatch.json?.provider === "custom" && legacyPatch.json?.modelId === "legacy-patched",
			`status=${legacyPatch.status} body=${legacyPatch.text.slice(0, 300)}`,
		);
	} finally {
		proc.kill("SIGTERM");
	}
}

async function legacyServerPart() {
	const PORT = 4424;
	const dataDir = join(TMP_ROOT, "data-legacy");
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(
		join(dataDir, "settings-model.json"),
		JSON.stringify({ baseUrl: "https://legacy.example.com/v1", modelId: "legacy-model", apiKey: LEGACY_KEY }) + "\n",
		{ mode: 0o600 },
	);
	const { proc, getLog } = startServer(PORT, dataDir);
	const api = apiFor(PORT, "providers-test-token");
	try {
		const ready = await waitReady(proc, PORT);
		check("旧格式种子 server 启动成功", ready, getLog().slice(-400));
		if (!ready) return;
		const view = await api("/api/settings/model");
		check(
			"旧格式文件起服读回：provider=custom、baseUrl/modelId 原值、configured、Key 只掩码无全文",
			view.status === 200 &&
				view.json?.provider === "custom" &&
				view.json?.baseUrl === "https://legacy.example.com/v1" &&
				view.json?.modelId === "legacy-model" &&
				view.json?.configured === true &&
				view.json?.apiKeyHint === `••••${LEGACY_KEY.slice(-4)}` &&
				!view.text.includes(LEGACY_KEY),
			`status=${view.status} body=${view.text.slice(0, 300)}`,
		);
	} finally {
		proc.kill("SIGTERM");
	}
}

try {
	await unitPart();
	await serverPart();
	await legacyServerPart();
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
