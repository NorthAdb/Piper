// 模型服务商选择单测（改版口径）：目录派生自 Pi 基座 pi-ai 的内置目录
// （dist/providers/all 的 builtinProviders + getBuiltinModels），只保留与内核
// 兼容的服务商——内核只建 api="openai-completions" 的 provider，所以某服务商
// 至少要有一个该 api 的 chat 模型、且该模型 baseUrl 非空才进目录；目录内模型
// 名单只含该 api 的模型。外加 POST /api/settings/model/fetch-models：填了 Key
// 即可从端点 GET /models 拉取模型名单；缺省 Key 时只有端点与已保存配置完全
// 一致才许复用已保存 Key（R7 守卫）。用临时 PIPER_DATA_DIR 起真 server +
// 本地 stub 上游，全程离线。
// 用法（在 apps/piper 下）：node scripts/test-model-providers.mjs（或 npm run test:model-providers）
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(APP_DIR, "..", "..");
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
const STUB_KEY = "sk-stub-fetch-key-0123456789abcdef";
const TYPED_WRONG_KEY = "sk-wrong-typed-key-0000000000";

// ---------- 本地 stub 上游：/v1/models 要 Bearer STUB_KEY，其余路径造各种坏响应 ----------
const stubHits = [];
const stub = createServer((reqHttp, resHttp) => {
	const u = new URL(reqHttp.url ?? "/", "http://stub.invalid");
	stubHits.push({ path: u.pathname, auth: reqHttp.headers.authorization ?? "" });
	if (u.pathname === "/v1/models") {
		if (reqHttp.headers.authorization !== `Bearer ${STUB_KEY}`) {
			resHttp.writeHead(401, { "Content-Type": "application/json" });
			resHttp.end(JSON.stringify({ error: { message: "invalid api key (upstream echo: sk-upstreamecho1234567890abcdef)" } }));
			return;
		}
		resHttp.writeHead(200, { "Content-Type": "application/json" });
		resHttp.end(
			JSON.stringify({
				object: "list",
				data: [{ id: "stub-model-b" }, { id: "stub-model-a" }, { id: "stub-model-a" }, { id: 42 }, { name: "no-id" }],
			}),
		);
		return;
	}
	if (u.pathname === "/bad/models") {
		resHttp.writeHead(200, { "Content-Type": "application/json" });
		resHttp.end("this is not json");
		return;
	}
	if (u.pathname === "/nodata/models") {
		resHttp.writeHead(200, { "Content-Type": "application/json" });
		resHttp.end(JSON.stringify({ object: "list" }));
		return;
	}
	if (u.pathname === "/hang/models") return; // 永不响应，靠客户端超时
	if (u.pathname === "/big/models") {
		resHttp.writeHead(200, { "Content-Type": "application/json" });
		resHttp.end(JSON.stringify({ data: [{ id: "x".repeat(5000) }] }));
		return;
	}
	resHttp.statusCode = 404;
	resHttp.end("{}");
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const STUB_BASE = `http://127.0.0.1:${stub.address().port}`;
const STUB_V1 = `${STUB_BASE}/v1`;
const modelsHitCount = () => stubHits.filter((h) => h.path === "/v1/models").length;

async function unitPart() {
	const mp = await import("../lib/model-providers.mjs");
	const settings = await import("../lib/settings.mjs");

	check(
		"lib 导出 loadModelProviders 与 fetchUpstreamModels（目录改为异步派生 + 拉取函数）",
		typeof mp.loadModelProviders === "function" && typeof mp.fetchUpstreamModels === "function",
		`loadModelProviders=${typeof mp.loadModelProviders} fetchUpstreamModels=${typeof mp.fetchUpstreamModels}`,
	);
	const providers = typeof mp.loadModelProviders === "function" ? await mp.loadModelProviders() : [];
	const byId = (id) => providers.find((p) => p.id === id);

	check("派生目录服务商数量远大于手写 8 条（≥25，含 custom）", providers.length >= 25, `实际 ${providers.length}`);
	check(
		"custom 恒为最后一项且 baseUrl 为空、models 为空",
		providers.length > 0 && providers[providers.length - 1].id === "custom" && byId("custom")?.baseUrl === "" && byId("custom")?.models.length === 0,
		JSON.stringify(providers[providers.length - 1]),
	);
	const ds = byId("deepseek");
	check(
		"deepseek 来自 pi-ai 目录：name=DeepSeek、baseUrl=https://api.deepseek.com、模型含 deepseek-flash 与 deepseek-v4-pro",
		ds?.name === "DeepSeek" &&
			ds?.baseUrl === "https://api.deepseek.com" &&
			ds.models.some((m) => m.id === "deepseek-flash") &&
			ds.models.some((m) => m.id === "deepseek-v4-pro"),
		JSON.stringify(ds),
	);
	// 思考挡位随目录下发：每条模型带 pi-ai getSupportedThinkingLevels 现算的
	// supportedThinkingLevels（挡位词表与模型支持集都以 pi-ai 为准，不自造）。
	const VOCAB = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	const flashLevels = ds?.models.find((m) => m.id === "deepseek-flash")?.supportedThinkingLevels;
	const proLevels = ds?.models.find((m) => m.id === "deepseek-v4-pro")?.supportedThinkingLevels;
	check(
		"deepseek 两款模型的 supportedThinkingLevels 与 pi-ai 现算一致：flash=[off,low,high,max]、v4-pro=[off,high,max]",
		JSON.stringify(flashLevels) === JSON.stringify(["off", "low", "high", "max"]) && JSON.stringify(proLevels) === JSON.stringify(["off", "high", "max"]),
		`flash=${JSON.stringify(flashLevels)} pro=${JSON.stringify(proLevels)}`,
	);
	check(
		"每个目录模型条目都带 supportedThinkingLevels（非空、元素都在七挡词表内；thinkingLevelMap.off=null 的常开思考模型可以没有 off）",
		providers
			.filter((p) => p.id !== "custom")
			.every(
				(p) =>
					p.models.every(
						(m) =>
							typeof m.id === "string" &&
							Array.isArray(m.supportedThinkingLevels) &&
							m.supportedThinkingLevels.length > 0 &&
							m.supportedThinkingLevels.every((l) => VOCAB.includes(l)),
					),
			),
	);
	check(
		"getCatalogModel 取回 pi-ai 原始模型（deepseek-v4-pro reasoning=true），查不到回 null；thinkingLevelsFor 目录外回落全词表",
		typeof mp.getCatalogModel === "function" &&
			typeof mp.thinkingLevelsFor === "function" &&
			(await mp.getCatalogModel("deepseek", "deepseek-v4-pro"))?.reasoning === true &&
			(await mp.getCatalogModel("deepseek", "no-such-model")) === null &&
			JSON.stringify(await mp.thinkingLevelsFor("deepseek", "deepseek-flash")) === JSON.stringify(["off", "low", "high", "max"]) &&
			JSON.stringify(await mp.thinkingLevelsFor("custom", "whatever")) === JSON.stringify(VOCAB),
	);
	check(
		"settings 导出思考词表与校验：THINKING_LEVELS 为七挡、isThinkingLevel 只认词表内",
		JSON.stringify(settings.THINKING_LEVELS) === JSON.stringify(VOCAB) &&
			typeof settings.isThinkingLevel === "function" &&
			settings.isThinkingLevel("high") &&
			!settings.isThinkingLevel("ludicrous") &&
			!settings.isThinkingLevel(""),
		JSON.stringify(settings.THINKING_LEVELS),
	);
	check(
		"不兼容 api 的服务商不出现：anthropic / amazon-bedrock / azure / openai / google / mistral 均不在目录",
		["anthropic", "amazon-bedrock", "azure", "openai", "google", "mistral"].every((id) => !byId(id)),
		providers.map((p) => p.id).join(","),
	);
	check(
		"每个非 custom 条目 baseUrl 非空且 models 非空",
		providers.filter((p) => p.id !== "custom").every((p) => p.baseUrl && p.models.length > 0),
	);

	// 与 pi-ai dist 交叉核对：混合 api 的服务商，我们列出的模型恰为其 openai-completions 子集。
	const all = await import(pathToFileURL(join(REPO_ROOT, "packages", "ai", "dist", "providers", "all.js")).href);
	let subsetOk = true;
	let subsetDetail = "";
	for (const pid of ["fireworks", "github-copilot", "opencode"]) {
		const compatIds = all
			.getBuiltinModels(pid)
			.filter((m) => m.api === "openai-completions")
			.map((m) => m.id)
			.sort();
		const ours = [...(byId(pid)?.models ?? [])].map((m) => m.id).sort();
		if (JSON.stringify(compatIds) !== JSON.stringify(ours)) {
			subsetOk = false;
			subsetDetail = `${pid}: pi-ai 子集 ${compatIds.length} 条 vs 我们 ${ours.length} 条`;
			break;
		}
	}
	check("混合 api 服务商（fireworks/github-copilot/opencode）的名单恰为 pi-ai 的 openai-completions 子集", subsetOk, subsetDetail);

	const isKnown = async (id) => (typeof mp.isKnownModelProvider === "function" ? await mp.isKnownModelProvider(id) : false);
	const resolve = async (saved) => (typeof mp.resolveModelProviderId === "function" ? await mp.resolveModelProviderId(saved) : "custom");
	check(
		"归属判定按 pi-ai id：deepseek/moonshotai/openrouter 识别；旧手写 id（moonshot/zhipu/dashscope/siliconflow）回落 custom",
		(await isKnown("deepseek")) &&
			(await isKnown("moonshotai")) &&
			!(await isKnown("moonshot")) &&
			(await resolve({ provider: "deepseek" })) === "deepseek" &&
			(await resolve({ provider: "moonshot" })) === "custom" &&
			(await resolve({ provider: "zhipu" })) === "custom" &&
			(await resolve({ provider: "dashscope" })) === "custom" &&
			(await resolve({ provider: "siliconflow" })) === "custom" &&
			(await resolve({})) === "custom" &&
			(await resolve(null)) === "custom",
	);

	settings.saveModelSettingsFile({ provider: "moonshotai-cn", baseUrl: "https://api.moonshot.cn/v1", modelId: "kimi-k2-turbo-preview", apiKey: DEEPSEEK_KEY });
	const saved = settings.readModelSettingsFile();
	check("saveModelSettingsFile 落盘 pi-ai 风格 provider id（moonshotai-cn）", saved.provider === "moonshotai-cn", JSON.stringify(saved.provider));

	// 旧格式：直接写一份没有 provider 的文件，读回应原值不丢、归属 custom。
	writeFileSync(
		join(TMP_DATA, "settings-model.json"),
		JSON.stringify({ baseUrl: "https://legacy.example.com/v1", modelId: "legacy-model", apiKey: LEGACY_KEY }) + "\n",
		{ mode: 0o600 },
	);
	const legacy = settings.readModelSettingsFile();
	check(
		"旧格式文件（无 provider）读回原值不丢且归属 custom",
		legacy.baseUrl === "https://legacy.example.com/v1" && legacy.modelId === "legacy-model" && legacy.apiKey === LEGACY_KEY && (await resolve(legacy)) === "custom",
		JSON.stringify({ ...legacy, apiKey: legacy.apiKey ? "***" : "" }),
	);

	// ---------- fetchUpstreamModels 单元（对本地 stub） ----------
	const fetchModels = typeof mp.fetchUpstreamModels === "function" ? mp.fetchUpstreamModels : async () => ({ ok: false, status: 0, error: "函数不存在" });
	const okRes = await fetchModels({ baseUrl: STUB_V1, apiKey: STUB_KEY });
	check(
		"fetchUpstreamModels 正常解析：data[].id 去重排序、忽略无 id 项",
		okRes.ok === true && JSON.stringify(okRes.models) === JSON.stringify(["stub-model-a", "stub-model-b"]),
		JSON.stringify(okRes).slice(0, 200),
	);
	check(
		"拉取时带上了 Bearer Key（stub 记录到的 Authorization）",
		stubHits.some((h) => h.path === "/v1/models" && h.auth === `Bearer ${STUB_KEY}`),
	);
	const unauthRes = await fetchModels({ baseUrl: STUB_V1, apiKey: TYPED_WRONG_KEY });
	check(
		"上游 401：ok=false、status=401，错误文本不含候选 Key、也不含上游回显的 sk- 串（已脱敏）",
		unauthRes.ok === false &&
			unauthRes.status === 401 &&
			!String(unauthRes.error).includes(TYPED_WRONG_KEY) &&
			!String(unauthRes.error).includes("sk-upstreamecho"),
		JSON.stringify(unauthRes).slice(0, 300),
	);
	const badJson = await fetchModels({ baseUrl: `${STUB_BASE}/bad`, apiKey: STUB_KEY });
	check("上游返回坏 JSON：ok=false", badJson.ok === false, JSON.stringify(badJson).slice(0, 200));
	const noData = await fetchModels({ baseUrl: `${STUB_BASE}/nodata`, apiKey: STUB_KEY });
	check("上游响应缺 data 数组：ok=false", noData.ok === false, JSON.stringify(noData).slice(0, 200));
	const t0 = Date.now();
	const hang = await fetchModels({ baseUrl: `${STUB_BASE}/hang`, apiKey: STUB_KEY }, { timeoutMs: 300 });
	check(
		"上游永不响应：按超时返回 ok=false（注入 300ms，实际 <4s）",
		hang.ok === false && Date.now() - t0 < 4000,
		`elapsed=${Date.now() - t0}ms ${JSON.stringify(hang).slice(0, 120)}`,
	);
	const big = await fetchModels({ baseUrl: `${STUB_BASE}/big`, apiKey: STUB_KEY }, { maxBytes: 1024 });
	check("上游响应超过体积上限：ok=false（注入 maxBytes=1024）", big.ok === false, JSON.stringify(big).slice(0, 200));
	check(
		"生产常量钉死：FETCH_MODELS_TIMEOUT_MS ≤ 10000、FETCH_MODELS_MAX_BYTES ≤ 1000000",
		typeof mp.FETCH_MODELS_TIMEOUT_MS === "number" && mp.FETCH_MODELS_TIMEOUT_MS <= 10_000 && typeof mp.FETCH_MODELS_MAX_BYTES === "number" && mp.FETCH_MODELS_MAX_BYTES <= 1_000_000,
		`timeout=${mp.FETCH_MODELS_TIMEOUT_MS} maxBytes=${mp.FETCH_MODELS_MAX_BYTES}`,
	);
}

// ---------- 子进程部分：真 server 上的目录接口、保存/读回与拉取接口 ----------
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
		const catProviders = catalog.json?.providers ?? [];
		const dsEntry = catProviders.find((p) => p.id === "deepseek");
		check(
			"GET /api/model-providers 200：派生目录 ≥25 条、deepseek 字段与 pi-ai 一致、无 anthropic、custom 在末尾",
			catalog.status === 200 &&
				catProviders.length >= 25 &&
				dsEntry?.name === "DeepSeek" &&
				dsEntry?.baseUrl === "https://api.deepseek.com" &&
				Array.isArray(dsEntry?.models) &&
				dsEntry.models.some((m) => m.id === "deepseek-v4-pro") &&
				!catProviders.some((p) => p.id === "anthropic") &&
				catProviders[catProviders.length - 1]?.id === "custom",
			`status=${catalog.status} count=${catProviders.length} body=${catalog.text.slice(0, 200)}`,
		);
		check(
			"目录接口下发思考挡位：deepseek-flash 条目带 supportedThinkingLevels=[off,low,high,max]",
			JSON.stringify(dsEntry?.models.find((m) => m.id === "deepseek-flash")?.supportedThinkingLevels) === JSON.stringify(["off", "low", "high", "max"]),
			JSON.stringify(dsEntry?.models.find((m) => m.id === "deepseek-flash")),
		);

		const save = await api("/api/settings/model", {
			method: "PUT",
			body: JSON.stringify({ provider: "deepseek", baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-pro", apiKey: DEEPSEEK_KEY }),
		});
		check(
			"PUT 保存 deepseek：回 provider=deepseek、pi-ai baseUrl、Key 只末四位掩码且响应无全文",
			save.status === 200 &&
				save.json?.provider === "deepseek" &&
				save.json?.baseUrl === "https://api.deepseek.com" &&
				save.json?.modelId === "deepseek-v4-pro" &&
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
		check(
			"模型设置视图带思考挡位：未存 thinkingLevel 时为 off，thinkingLevels 为当前模型（deepseek-v4-pro）的 [off,high,max]",
			view.json?.thinkingLevel === "off" && JSON.stringify(view.json?.thinkingLevels) === JSON.stringify(["off", "high", "max"]),
			`thinkingLevel=${view.json?.thinkingLevel} thinkingLevels=${JSON.stringify(view.json?.thinkingLevels)}`,
		);
		const saveLevel = await api("/api/settings/model", { method: "PUT", body: JSON.stringify({ thinkingLevel: "high" }) });
		check(
			"PUT 合法思考挡位 high：保存成功且读回 thinkingLevel=high（其余字段不变）",
			saveLevel.status === 200 && saveLevel.json?.thinkingLevel === "high" && saveLevel.json?.provider === "deepseek" && saveLevel.json?.modelId === "deepseek-v4-pro",
			`status=${saveLevel.status} body=${saveLevel.text.slice(0, 300)}`,
		);
		const badLevel = await api("/api/settings/model", { method: "PUT", body: JSON.stringify({ thinkingLevel: "ludicrous" }) });
		const afterBadLevel = await api("/api/settings/model");
		const diskAfterBad = existsSync(join(dataDir, "settings-model.json")) ? readFileSync(join(dataDir, "settings-model.json"), "utf8") : "";
		check(
			"PUT 非法思考挡位回 400 且文件不变（读回与落盘仍是 high）",
			badLevel.status === 400 && afterBadLevel.json?.thinkingLevel === "high" && diskAfterBad.includes('"thinkingLevel": "high"'),
			`status=${badLevel.status} view=${afterBadLevel.json?.thinkingLevel} disk=${diskAfterBad.slice(0, 200)}`,
		);

		const modelFile = join(dataDir, "settings-model.json");
		const onDisk = existsSync(modelFile) ? readFileSync(modelFile, "utf8") : "";
		check(
			"落盘 settings-model.json 含 provider=deepseek 且权限 0600",
			onDisk.includes('"provider": "deepseek"') && (statSync(modelFile).mode & 0o777) === 0o600,
			onDisk.slice(0, 200),
		);

		const bad = await api("/api/settings/model", { method: "PUT", body: JSON.stringify({ provider: "nope" }) });
		const oldId = await api("/api/settings/model", { method: "PUT", body: JSON.stringify({ provider: "moonshot" }) });
		const afterBad = await api("/api/settings/model");
		check(
			"PUT 未知 provider 与旧手写 id（moonshot）均返回 400 且已有配置不变",
			bad.status === 400 && oldId.status === 400 && afterBad.json?.provider === "deepseek",
			`nope=${bad.status} moonshot=${oldId.status} provider=${afterBad.json?.provider}`,
		);

		const custom = await api("/api/settings/model", {
			method: "PUT",
			body: JSON.stringify({ provider: "custom", baseUrl: STUB_V1, modelId: "stub-model-a", apiKey: STUB_KEY }),
		});
		check(
			"PUT 保存 custom 任意端点（指向 stub）可用，读回 provider=custom",
			custom.status === 200 && custom.json?.provider === "custom" && custom.json?.baseUrl === STUB_V1 && custom.json?.modelId === "stub-model-a",
			`status=${custom.status} body=${custom.text.slice(0, 300)}`,
		);

		// ---------- fetch-models 路由 ----------
		const fmUnauth = await api("/api/settings/model/fetch-models", { method: "POST", body: JSON.stringify({ baseUrl: STUB_V1 }) }, false);
		check("POST fetch-models 未登录返回 401", fmUnauth.status === 401, `实际 ${fmUnauth.status}`);

		const hitsBefore = modelsHitCount();
		const fmSaved = await api("/api/settings/model/fetch-models", { method: "POST", body: JSON.stringify({ baseUrl: STUB_V1 }) });
		check(
			"fetch-models 缺省 Key + 端点与已保存一致：复用已保存 Key 拉到 stub 模型（去重排序）",
			fmSaved.status === 200 &&
				fmSaved.json?.ok === true &&
				JSON.stringify(fmSaved.json?.models) === JSON.stringify(["stub-model-a", "stub-model-b"]) &&
				modelsHitCount() === hitsBefore + 1 &&
				stubHits[stubHits.length - 1]?.auth === `Bearer ${STUB_KEY}`,
			`status=${fmSaved.status} body=${fmSaved.text.slice(0, 300)}`,
		);

		const hitsBeforeMismatch = modelsHitCount();
		const fmMismatch = await api("/api/settings/model/fetch-models", { method: "POST", body: JSON.stringify({ baseUrl: `${STUB_V1}-other` }) });
		check(
			"fetch-models 缺省 Key + 端点与已保存不一致：400 且没有向上游发出任何请求（R7 守卫）",
			fmMismatch.status === 400 && modelsHitCount() === hitsBeforeMismatch,
			`status=${fmMismatch.status} hits=${modelsHitCount() - hitsBeforeMismatch} body=${fmMismatch.text.slice(0, 200)}`,
		);

		const fmTyped = await api("/api/settings/model/fetch-models", {
			method: "POST",
			body: JSON.stringify({ baseUrl: STUB_V1, apiKey: TYPED_WRONG_KEY }),
		});
		check(
			"fetch-models 带当次 Key：用候选 Key 拉取（上游 401 → ok=false/status=401），响应不含候选 Key",
			fmTyped.status === 200 &&
				fmTyped.json?.ok === false &&
				fmTyped.json?.status === 401 &&
				!fmTyped.text.includes(TYPED_WRONG_KEY) &&
				stubHits[stubHits.length - 1]?.auth === `Bearer ${TYPED_WRONG_KEY}`,
			`status=${fmTyped.status} body=${fmTyped.text.slice(0, 300)}`,
		);

		const fmBadJson = await api("/api/settings/model/fetch-models", {
			method: "POST",
			body: JSON.stringify({ baseUrl: `${STUB_BASE}/bad`, apiKey: STUB_KEY }),
		});
		check(
			"fetch-models 上游坏 JSON：ok=false 且带错误说明",
			fmBadJson.status === 200 && fmBadJson.json?.ok === false && typeof fmBadJson.json?.error === "string" && fmBadJson.json.error.length > 0,
			`status=${fmBadJson.status} body=${fmBadJson.text.slice(0, 300)}`,
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
		check(
			"旧格式文件（无 thinkingLevel）读回：thinkingLevel=off，目录外模型的 thinkingLevels 回落完整七挡",
			view.json?.thinkingLevel === "off" &&
				JSON.stringify(view.json?.thinkingLevels) === JSON.stringify(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
			`thinkingLevel=${view.json?.thinkingLevel} thinkingLevels=${JSON.stringify(view.json?.thinkingLevels)}`,
		);
	} finally {
		proc.kill("SIGTERM");
	}
}

// ---------- 思考链路部分：带 reasoning 的模型 stub + 真 server 对话 ----------
// stub 记录每个 chat 请求体；请求带 reasoning_effort 时才回 reasoning_content
// 增量（模拟真服务商：不请求思考就不回推理），否则只回正文。
const REASONING_PARTS = ["先想一想：", "把问题拆开，", "得到结论。"];
const REASONING_TEXT = REASONING_PARTS.join("");
const ANSWER_TEXT = "答案如下。";
const CHAT_KEY = "sk-chat-thinking-key-abcdef123456";

async function thinkingPart() {
	const chatBodies = [];
	const chatStub = createServer((reqHttp, resHttp) => {
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
			chatBodies.push(body);
			const model = body.model || "stub";
			const wantsReasoning = typeof body.reasoning_effort === "string" && body.reasoning_effort !== "";
			if (body.stream) {
				resHttp.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
				const chunk = (delta, finishReason = null) =>
					`data: ${JSON.stringify({ id: "chatcmpl-think", object: "chat.completion.chunk", created: 1762732800, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
				resHttp.write(chunk({ role: "assistant" }));
				if (wantsReasoning) for (const part of REASONING_PARTS) resHttp.write(chunk({ reasoning_content: part }));
				resHttp.write(chunk({ content: ANSWER_TEXT }));
				resHttp.write(chunk({}, "stop"));
				resHttp.end("data: [DONE]\n\n");
			} else {
				resHttp.writeHead(200, { "Content-Type": "application/json" });
				resHttp.end(
					JSON.stringify({
						id: "chatcmpl-think",
						object: "chat.completion",
						created: 1762732800,
						model,
						choices: [
							{
								index: 0,
								message: { role: "assistant", content: ANSWER_TEXT, ...(wantsReasoning ? { reasoning_content: REASONING_TEXT } : {}) },
								finish_reason: "stop",
							},
						],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}),
				);
			}
		});
	});
	await new Promise((r) => chatStub.listen(0, "127.0.0.1", r));
	const CHAT_V1 = `http://127.0.0.1:${chatStub.address().port}/v1`;

	const PORT = 4425;
	const dataDir = join(TMP_ROOT, "data-thinking");
	const { proc, getLog } = startServer(PORT, dataDir);
	const api = apiFor(PORT, "providers-test-token");
	const chat = async (message) => {
		const res = await fetch(`http://127.0.0.1:${PORT}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer providers-test-token" },
			body: JSON.stringify({ botId: "piper-main", message }),
			signal: AbortSignal.timeout(60000),
		});
		const rawText = await res.text();
		const events = [];
		for (const block of rawText.split("\n\n")) {
			const ev = /event: (.*)/.exec(block)?.[1];
			const data = /data: (.*)/s.exec(block)?.[1];
			if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
		}
		return events;
	};
	try {
		const ready = await waitReady(proc, PORT);
		check("思考链路 server 启动成功", ready, getLog().slice(-400));
		if (!ready) return;

		const save = await api("/api/settings/model", {
			method: "PUT",
			body: JSON.stringify({ provider: "deepseek", baseUrl: CHAT_V1, modelId: "deepseek-flash", apiKey: CHAT_KEY, thinkingLevel: "high" }),
		});
		check(
			"保存 deepseek-flash + thinkingLevel=high：视图 thinkingLevels=[off,low,high,max]",
			save.status === 200 && save.json?.thinkingLevel === "high" && JSON.stringify(save.json?.thinkingLevels) === JSON.stringify(["off", "low", "high", "max"]),
			`status=${save.status} body=${save.text.slice(0, 300)}`,
		);

		const ev1 = await chat("请先思考再回答");
		const thinkText1 = ev1
			.filter((e) => e.event === "thinking")
			.map((e) => e.data?.text ?? "")
			.join("");
		const deltaText1 = ev1
			.filter((e) => e.event === "delta")
			.map((e) => e.data?.text ?? "")
			.join("");
		const body1 = chatBodies[chatBodies.length - 1] ?? {};
		check(
			"thinkingLevel=high：请求体带 reasoning_effort=high（pi-ai 通用分支按 thinkingLevelMap 翻译）",
			body1.reasoning_effort === "high",
			`body=${JSON.stringify(body1).slice(0, 300)}`,
		);
		check(
			"SSE 出现 thinking 事件且拼合等于 stub 的 reasoning_content 全文，正文 delta 完整、无 error",
			thinkText1 === REASONING_TEXT && deltaText1 === ANSWER_TEXT && !ev1.some((e) => e.event === "error"),
			`thinking=${JSON.stringify(thinkText1)} delta=${JSON.stringify(deltaText1)}`,
		);

		const msgs = await api("/api/bots/piper-main/messages");
		const thinkEntry = (msgs.json?.messages ?? []).find((m) => m.role === "thinking");
		const sessionRaw = existsSync(join(dataDir, "sessions", "piper-main.jsonl")) ? readFileSync(join(dataDir, "sessions", "piper-main.jsonl"), "utf8") : "";
		check(
			"回合后会话历史含 role=thinking 条目且文本完整，会话文件不含 Key 全文",
			thinkEntry?.text === REASONING_TEXT && !sessionRaw.includes(CHAT_KEY),
			`entry=${JSON.stringify(thinkEntry)?.slice(0, 200)}`,
		);

		// clamp：存量 low 不改写，生效值按 v4-pro 的支持集吸附到 high。
		const save2 = await api("/api/settings/model", {
			method: "PUT",
			body: JSON.stringify({ modelId: "deepseek-v4-pro", thinkingLevel: "low" }),
		});
		const ev2 = await chat("再想一想");
		const body2 = chatBodies[chatBodies.length - 1] ?? {};
		check(
			"clamp：deepseek-v4-pro 存 low → 请求体 reasoning_effort=high（吸附），存量仍是 low、SSE 仍有完整 thinking",
			save2.json?.thinkingLevel === "low" &&
				body2.reasoning_effort === "high" &&
				ev2
					.filter((e) => e.event === "thinking")
					.map((e) => e.data?.text ?? "")
					.join("") === REASONING_TEXT,
			`saved=${save2.json?.thinkingLevel} effort=${body2.reasoning_effort}`,
		);

		// off：不带任何 reasoning 参数、无 thinking 事件（工具/正文链路不受影响）。
		await api("/api/settings/model", { method: "PUT", body: JSON.stringify({ thinkingLevel: "off" }) });
		const ev3 = await chat("不用思考");
		const body3 = chatBodies[chatBodies.length - 1] ?? {};
		check(
			"thinkingLevel=off：请求体无 reasoning_effort / thinking 字段，SSE 无 thinking 事件、正文照常",
			!("reasoning_effort" in body3) &&
				!("thinking" in body3) &&
				!ev3.some((e) => e.event === "thinking") &&
				ev3
					.filter((e) => e.event === "delta")
					.map((e) => e.data?.text ?? "")
					.join("") === ANSWER_TEXT,
			`body keys=${Object.keys(body3).join(",")}`,
		);
	} finally {
		proc.kill("SIGTERM");
		chatStub.close();
	}
}

try {
	await unitPart();
	await serverPart();
	await legacyServerPart();
	await thinkingPart();
} finally {
	stub.close();
	rmSync(TMP_ROOT, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
	console.log("失败项：");
	for (const f of failed) console.log(`  ${String(f.seq).padStart(2, "0")} ${f.name}`);
	process.exit(1);
}
