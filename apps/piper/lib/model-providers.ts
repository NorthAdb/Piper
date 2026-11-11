// 模型服务商目录：派生自 Pi 基座 pi-ai 的内置目录，不再手写名单。
//
// 派生方式（与 lib/kernel.ts 同一懒加载口径）：动态 import 基座
// packages/ai/dist/providers/all.js，用 builtinProviders() 枚举服务商
// （id / name / baseUrl），用 getBuiltinModels(id) 取该服务商的 chat 模型。
//
// 筛选口径（内核兼容性）：Piper 内核只用 pi-ai 的 openAICompletionsApi 建
// provider、模型 api 恒为 "openai-completions"（见 lib/kernel.ts），所以：
//   - 服务商至少要有一个 api === "openai-completions" 的 chat 模型；
//   - 目录里该服务商的模型名单只含这类模型（混合 api 的服务商只列兼容子集）；
//   - baseUrl 取兼容子集第一个模型的 baseUrl，且必须非空（azure 的兼容模型
//     baseUrl 为空、需要用户自备部署端点，按此条不进目录）。
// 纯 anthropic-messages / bedrock / responses / google 等 api 的服务商
// （anthropic、amazon-bedrock、openai、google、mistral 等）不出现——不是
// 名单取舍，是内核现在说不了那种协议；要用这类端点（如 OpenAI 官方）
// 仍可走「自定义端点」手填 baseUrl + Key。
// 基座 dist 不存在或加载失败时目录回落为只有 custom——设置页仍可手填接入。
//
// 目录里每个模型条目带 supportedThinkingLevels：用 pi-ai 的
// getSupportedThinkingLevels 对该模型现算（reasoning 为假只有 off；否则按
// thinkingLevelMap 过滤，xhigh/max 须显式映射）——与 Pi 自带 /thinking
// 选择器的同一条链，Piper 不另维护挡位表。原始 Model 另存索引供内核取用。
//
// 本模块还提供 fetchUpstreamModels：设置页填了端点与 Key 后从端点
// GET {baseUrl}/models 拉取真实模型名单。Key 的使用守卫在 server 路由层
// （缺省 Key 只许复用到与已保存配置完全一致的端点，见 server.ts 的
// fetch-models 路由）；本函数只负责带 Key 出站与解析，错误文本一律脱敏、
// 不带 Key。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { APP_DIR } from "./store.js";
import { THINKING_LEVELS } from "./settings.js";
import { redact, REDACTED } from "./redact.js";

const REPO_ROOT = join(APP_DIR, "..", "..");

export const COMPATIBLE_MODEL_API = "openai-completions";

export const CUSTOM_PROVIDER = { id: "custom", name: "自定义端点", baseUrl: "", models: [] };

let catalogPromise = null;
// 目录原始模型索引（providerId -> Map(modelId -> pi-ai Model)）：只含兼容子集，
// 供内核按 (provider, modelId) 取回原始 Model（reasoning / thinkingLevelMap 是
// pi-ai 做挡位吸附与厂商参数翻译的依据，见 lib/kernel.ts）。
let catalogModelIndex = new Map();

async function buildCatalog() {
	const allPath = join(REPO_ROOT, "packages", "ai", "dist", "providers", "all.js");
	const indexPath = join(REPO_ROOT, "packages", "ai", "dist", "index.js");
	if (!existsSync(allPath) || !existsSync(indexPath)) return [{ ...CUSTOM_PROVIDER }];
	try {
		const all = await import(pathToFileURL(allPath).href);
		// getSupportedThinkingLevels 在 pi-ai 主入口（models.ts）：挡位支持集一律
		// 用它对每个目录模型现算，不在 Piper 侧另维护挡位表。
		const ai = await import(pathToFileURL(indexPath).href);
		const providers = [];
		const index = new Map();
		for (const provider of all.builtinProviders()) {
			const compat = all.getBuiltinModels(provider.id).filter((m) => m.api === COMPATIBLE_MODEL_API);
			if (!compat.length) continue;
			const baseUrl = compat.find((m) => m.baseUrl)?.baseUrl ?? "";
			if (!baseUrl) continue;
			index.set(provider.id, new Map(compat.map((m) => [m.id, m])));
			providers.push({
				id: provider.id,
				name: provider.name,
				baseUrl,
				models: compat.map((m) => ({ id: m.id, supportedThinkingLevels: ai.getSupportedThinkingLevels(m) })),
			});
		}
		catalogModelIndex = index;
		return [...providers, { ...CUSTOM_PROVIDER }];
	} catch {
		return [{ ...CUSTOM_PROVIDER }];
	}
}

// 目录（含末尾的 custom）只算一次：派生要 import 整个 pi-ai 目录，进程内缓存。
export function loadModelProviders() {
	if (!catalogPromise) catalogPromise = buildCatalog();
	return catalogPromise;
}

export async function getModelProvider(id) {
	const providers = await loadModelProviders();
	return providers.find((p) => p.id === id) ?? null;
}

export async function isKnownModelProvider(id) {
	return typeof id === "string" && Boolean(await getModelProvider(id));
}

// 一份已保存的模型设置归属哪个服务商：文件里的 provider 是派生目录中的
// id 就用它；没有该字段、或 id 已不在目录里（例如上一版手写的 moonshot /
// zhipu）一律按 custom 读——不猜、不丢原值。
export async function resolveModelProviderId(saved) {
	const id = saved && typeof saved.provider === "string" ? saved.provider : "";
	return (await isKnownModelProvider(id)) ? id : "custom";
}

// 按 (providerId, modelId) 取目录里的 pi-ai 原始 Model（仅兼容子集）；
// 查不到（自定义端点、目录外模型名）回 null。
export async function getCatalogModel(providerId, modelId) {
	await loadModelProviders();
	return catalogModelIndex.get(providerId)?.get(modelId) ?? null;
}

// 某 (provider, modelId) 的可选思考挡位：命中目录模型时用 pi-ai
// getSupportedThinkingLevels 现算的结果（与目录接口下发的同一份）；目录里
// 查不到的自定义模型无元数据可依，回落完整七挡词表（内核对这类模型把挡位
// 原样传给 Agent，服务商不认时错误走既有脱敏出口）。
export async function thinkingLevelsFor(providerId, modelId) {
	const providers = await loadModelProviders();
	const entry = providers.find((p) => p.id === providerId)?.models.find((m) => m.id === modelId);
	return entry ? [...entry.supportedThinkingLevels] : [...THINKING_LEVELS];
}

// ---------- 从端点拉取模型名单（GET {baseUrl}/models） ----------

export const FETCH_MODELS_TIMEOUT_MS = 10_000;
export const FETCH_MODELS_MAX_BYTES = 1_000_000;

// 错误文本先抹掉当次候选 Key 本身（它可能还没保存进设置文件，redact 的
// 已知秘密集合里没有它），再过统一 redact，最后截断。
function sanitizeFetchError(text, apiKey) {
	let out = String(text ?? "");
	if (apiKey && apiKey.length >= 6 && out.includes(apiKey)) out = out.split(apiKey).join(REDACTED);
	return redact(out).slice(0, 300);
}

async function readBodyCapped(res, maxBytes) {
	if (!res.body) return { text: await res.text(), tooLarge: false };
	const reader = res.body.getReader();
	const chunks = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			return { text: "", tooLarge: true };
		}
		chunks.push(value);
	}
	return { text: Buffer.concat(chunks).toString("utf8"), tooLarge: false };
}

// 拉取一个 OpenAI 兼容端点的模型名单。成功回 { ok:true, status, models }
// （data[].id 去重、排序）；失败回 { ok:false, status, error }，status 为
// 上游 HTTP 状态码，网络/超时/解析失败时为 0。deps.timeoutMs / deps.maxBytes
// 只供测试注入更小的值，生产恒用上面的常量。
export async function fetchUpstreamModels({ baseUrl, apiKey } = {}, deps = {}) {
	const timeoutMs = deps.timeoutMs ?? FETCH_MODELS_TIMEOUT_MS;
	const maxBytes = deps.maxBytes ?? FETCH_MODELS_MAX_BYTES;
	const root = String(baseUrl ?? "").trim().replace(/\/+$/, "");
	let url;
	try {
		url = new URL(`${root}/models`);
	} catch {
		return { ok: false, status: 0, error: "baseUrl 不是合法 URL" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { ok: false, status: 0, error: "baseUrl 必须是 http/https 地址" };
	}
	let res;
	try {
		res = await fetch(url, {
			headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
			signal: AbortSignal.timeout(timeoutMs),
			redirect: "follow",
		});
	} catch (err) {
		const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
		return {
			ok: false,
			status: 0,
			error: sanitizeFetchError(`拉取模型列表${timedOut ? "超时" : "失败"}：${err?.message ?? err}`, apiKey),
		};
	}
	let body;
	try {
		body = await readBodyCapped(res, maxBytes);
	} catch (err) {
		return { ok: false, status: res.status, error: sanitizeFetchError(`读取模型列表响应失败：${err?.message ?? err}`, apiKey) };
	}
	if (body.tooLarge) {
		return { ok: false, status: res.status, error: `端点 /models 响应超过 ${maxBytes} 字节上限，已中止` };
	}
	if (!res.ok) {
		return {
			ok: false,
			status: res.status,
			error: sanitizeFetchError(`端点返回 ${res.status}${body.text ? `：${body.text}` : ""}`, apiKey),
		};
	}
	let parsed;
	try {
		parsed = JSON.parse(body.text);
	} catch {
		return { ok: false, status: res.status, error: "端点 /models 返回的不是合法 JSON" };
	}
	if (!Array.isArray(parsed?.data)) {
		return { ok: false, status: res.status, error: "端点 /models 响应缺少 data 数组" };
	}
	const models = [...new Set(parsed.data.map((d) => (typeof d?.id === "string" ? d.id : "")).filter(Boolean))].sort();
	return { ok: true, status: res.status, models };
}
