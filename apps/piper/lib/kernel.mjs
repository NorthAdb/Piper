// Piper 对话内核：源码级接入 Pi 基座（不是 SDK 嵌入、不是子进程 CLI）。
//
// 接入点（实测对应基座 v1.5.1 源码）：
//   @earendil-works/pi-agent-core  -> Agent 类（packages/agent/src/agent.ts）
//     new Agent({ initialState: { systemPrompt, model, messages }, streamFn })
//     agent.subscribe(listener) 收 AgentEvent（message_update / tool_execution_* / agent_end）
//     agent.prompt(text) 驱动一轮
//   @earendil-works/pi-ai          -> createModels / createProvider / envApiKeyAuth / openAICompletionsApi
//     （packages/ai/src/models.ts、auth/helpers.ts、api/openai-completions.lazy.ts）
//     Models.streamSimple(model, context, options) 正好是 Agent 需要的 StreamFn 形状
//     （packages/agent/src/types.ts 注释原文：`Models.streamSimple` satisfies this shape）
//
// 模型配置（规格四：只接一个 OpenAI 兼容端点）：
//   第一来源是设置文件 data/settings-model.json（L0-2，设置页保存、热生效）；
//   文件缺失的字段回退环境变量 PIPER_MODEL_API_KEY（或 OPENAI_API_KEY）、
//   PIPER_MODEL_BASE_URL（默认 https://api.openai.com/v1）、PIPER_MODEL_ID（默认 gpt-4o-mini）。
//   环境变量里的秘密不会被自动写进设置文件。无 Key 时 configured=false，
//   调用方发「未配置模型」事件，不崩溃。modelConfig() 每次现读文件，保存后下一次 prompt 即生效。
//
// 说明：这里用动态 import 懒加载基座 dist——基座未构建时 app 的其余 API（bot CRUD/例程/产物）
// 仍须可用，所以不能在模块顶层静态 import 一个可能不存在的 dist；失败原因会原样上报。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readModelSettingsFile } from "./settings.mjs";
import { redact } from "./redact.mjs";
import { APP_DIR } from "./store.mjs";

const REPO_ROOT = join(APP_DIR, "..", "..");

export function modelConfig() {
	const saved = readModelSettingsFile();
	const apiKey = saved.apiKey || process.env.PIPER_MODEL_API_KEY || process.env.OPENAI_API_KEY || "";
	return {
		configured: Boolean(apiKey),
		apiKey,
		baseUrl: saved.baseUrl || process.env.PIPER_MODEL_BASE_URL || "https://api.openai.com/v1",
		modelId: saved.modelId || process.env.PIPER_MODEL_ID || "gpt-4o-mini",
	};
}

let runtimePromise = null;

async function loadRuntime() {
	if (!runtimePromise) {
		runtimePromise = (async () => {
			const aiDist = join(REPO_ROOT, "packages", "ai", "dist", "index.js");
			const agentDist = join(REPO_ROOT, "packages", "agent", "dist", "index.js");
			for (const p of [aiDist, agentDist]) {
				if (!existsSync(p)) {
					throw Object.assign(
						new Error(`Pi 基座未构建：缺少 ${p}。先在仓库根目录执行 npm install 并构建 packages/ai、packages/agent。`),
						{ code: "BASE_NOT_BUILT" },
					);
				}
			}
			const ai = await import(pathToFileURL(aiDist).href);
			const agentCore = await import(pathToFileURL(agentDist).href);
			// openAICompletionsApi 不在 pi-ai 主入口导出，位于 api 子路径（package exports 的 "./api/*"）
			const completions = await import(pathToFileURL(join(REPO_ROOT, "packages", "ai", "dist", "api", "openai-completions.lazy.js")).href);
			return { ai, agentCore, openAICompletionsApi: completions.openAICompletionsApi };
		})();
	}
	return runtimePromise;
}

async function buildModelsAndModel(cfg) {
	const { ai, openAICompletionsApi } = await loadRuntime();
	const model = {
		id: cfg.modelId,
		name: cfg.modelId,
		api: "openai-completions",
		provider: "piper",
		baseUrl: cfg.baseUrl,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 128000,
		maxTokens: 8192,
	};
	// 自定义 ApiKeyAuth：直接解析 modelConfig() 已合并好的 Key（设置文件优先、环境变量兜底），
	// 不再走 envApiKeyAuth——否则设置页保存的 Key 喂不进 provider。
	const keyAuth = {
		name: "Piper model",
		resolve: async () => (cfg.apiKey ? { auth: { apiKey: cfg.apiKey }, source: "piper model config" } : undefined),
	};
	const provider = ai.createProvider({
		id: "piper",
		name: "Piper (OpenAI-compatible)",
		baseUrl: cfg.baseUrl,
		auth: { apiKey: keyAuth },
		models: [model],
		api: openAICompletionsApi(),
	});
	const models = ai.createModels();
	models.setProvider(provider);
	return { models, model };
}

function toPiMessages(history, cfg) {
	const zeroUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return history
		.filter((h) => (h.role === "user" || h.role === "assistant") && typeof h.text === "string" && h.text)
		.slice(-20)
		.map((h) =>
			h.role === "user"
				? { role: "user", content: [{ type: "text", text: h.text }], timestamp: Date.now() }
				: {
						role: "assistant",
						content: [{ type: "text", text: h.text }],
						api: "openai-completions",
						provider: "piper",
						model: cfg.modelId,
						usage: zeroUsage,
						stopReason: "stop",
						timestamp: Date.now(),
					},
		);
}

function textOf(message) {
	if (!message || !Array.isArray(message.content)) return "";
	return message.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("");
}

// 模型厂商错误的安全出口（R7）：厂商错误文本会回显请求里的 Key（实测 401 响应体
// 原样带 Key），进会话 JSONL / SSE / 接口返回值之前只保留状态码 + 截断 200 字的
// 脱敏文本，绝不把原文抛给上层。
export function modelErrorMessage(raw) {
	const text = String(raw ?? "");
	const status = /\b([45]\d\d)\b/.exec(text)?.[1];
	const clean = redact(text).slice(0, 200);
	return status ? `模型调用失败（HTTP ${status}）：${clean}` : `模型调用失败：${clean}`;
}

// 流式对话：onEvent 收结构化事件 {type:"delta",text} / {type:"tool",phase,name,detail}。
// 返回最终助手文本。失败抛错（err.code 区分 BASE_NOT_BUILT / MODEL_ERROR 等），由路由层转 SSE error 事件。
export async function streamChat({ systemPrompt, history = [], message, onEvent }) {
	const cfg = modelConfig();
	if (!cfg.configured) {
		throw Object.assign(new Error("未配置模型：请在设置中配置模型（端点与 API Key），或设置 PIPER_MODEL_API_KEY 后重试。"), {
			code: "MODEL_NOT_CONFIGURED",
		});
	}
	const { agentCore } = await loadRuntime();
	const { models, model } = await buildModelsAndModel(cfg);
	const agent = new agentCore.Agent({
		initialState: {
			systemPrompt,
			model,
			messages: toPiMessages(history, cfg),
			tools: [],
			thinkingLevel: "off",
		},
		streamFn: (m, context, options) => models.streamSimple(m, context, options),
	});
	let finalText = "";
	const unsubscribe = agent.subscribe((event) => {
		if (event.type === "message_update") {
			const ame = event.assistantMessageEvent;
			if (ame?.type === "text_delta" && ame.delta) onEvent({ type: "delta", text: ame.delta });
			if (ame?.type === "toolcall_end" && ame.toolCall) {
				onEvent({ type: "tool", phase: "call", name: ame.toolCall.name, detail: ame.toolCall.arguments ?? null });
			}
		} else if (event.type === "tool_execution_start") {
			onEvent({ type: "tool", phase: "start", name: event.toolName, detail: event.args ?? null });
		} else if (event.type === "tool_execution_end") {
			onEvent({ type: "tool", phase: "end", name: event.toolName, detail: { isError: event.isError } });
		} else if (event.type === "message_end" && event.message?.role === "assistant") {
			finalText = textOf(event.message) || finalText;
		}
	});
	try {
		await agent.prompt(message);
	} catch (err) {
		throw Object.assign(new Error(modelErrorMessage(err?.message ?? err)), { code: "MODEL_ERROR" });
	} finally {
		unsubscribe();
	}
	if (agent.state?.errorMessage) {
		throw Object.assign(new Error(modelErrorMessage(agent.state.errorMessage)), { code: "MODEL_ERROR" });
	}
	return { text: finalText };
}

// 设置页「测试连接」：用候选配置（overrides 覆盖已生效配置的对应字段）打一次最小请求。
// 只回 {ok} 或 {ok:false, error}，不抛错、不把 Key 写进返回值。15 秒超时，坏端点不会挂死进程。
export async function testModelConfig(overrides = {}) {
	const base = modelConfig();
	const cfg = {
		apiKey: overrides.apiKey || base.apiKey,
		baseUrl: overrides.baseUrl || base.baseUrl,
		modelId: overrides.modelId || base.modelId,
	};
	cfg.configured = Boolean(cfg.apiKey);
	if (!cfg.configured) return { ok: false, error: "未配置 API Key" };
	try {
		const { models, model } = await buildModelsAndModel(cfg);
		const res = await models.completeSimple(
			model,
			{ messages: [{ role: "user", content: [{ type: "text", text: "ping" }], timestamp: Date.now() }] },
			{ maxTokens: 8, signal: AbortSignal.timeout(15000) },
		);
		if (res?.stopReason === "error") {
			return { ok: false, error: redact(String(res.errorMessage || "模型返回错误")).slice(0, 300) };
		}
		return { ok: true };
	} catch (err) {
		return { ok: false, error: redact(String(err?.message || err)).slice(0, 300) };
	}
}

// 用模型从用户消息抽取 Bot 草案字段；失败返回 null，调用方走规则兜底。
export async function extractDraftWithModel(message) {
	const cfg = modelConfig();
	if (!cfg.configured) return null;
	try {
		const { models, model } = await buildModelsAndModel(cfg);
		const res = await models.completeSimple(model, {
			systemPrompt:
				"你负责把用户的建 bot 需求抽成 JSON。只输出一个 JSON 对象，字段：name（bot 名字）、systemPrompt（职责描述，即 system prompt 主体）、tools（字符串数组，可空）、repos（GitHub 仓库 owner/repo 数组，可空）。不要输出任何其他文字。",
			messages: [{ role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() }],
		});
		const text = textOf(res);
		const m = text.match(/\{[\s\S]*\}/);
		if (!m) return null;
		const parsed = JSON.parse(m[0]);
		if (!parsed.name || !parsed.systemPrompt) return null;
		return {
			name: String(parsed.name).slice(0, 60),
			systemPrompt: String(parsed.systemPrompt),
			tools: Array.isArray(parsed.tools) ? parsed.tools.map(String) : [],
			repos: Array.isArray(parsed.repos) ? parsed.repos.map(String) : [],
			memoryScope: "self+about-me",
			source: "model",
		};
	} catch {
		return null;
	}
}

// 规则兜底抽取：识别「创建 bot / 创建一个 X bot / 名叫 X」等说法。
export function extractDraftByRules(message) {
	const text = String(message);
	let name = null;
	const patterns = [
		/名叫\s*[「"']?([^\s」"']{1,30})/,
		/名字(?:是|叫)\s*[「"']?([^\s」"']{1,30})/,
		/创建(?:一个|个)?\s*[「"']?([^\s，。,「」"']{1,30})[」"']?\s*(?:bot|机器人|Bot|BOT)/,
		/创建一个\s*[「"']?([^\s，。,「」"']{1,30})/,
	];
	for (const re of patterns) {
		const m = text.match(re);
		if (m) {
			name = m[1].replace(/^(bot|Bot|BOT)$/, "") || null;
			if (name) break;
		}
	}
	const duty = text
		.replace(/.*?(?:负责|用来|用于|帮我|职责是|职责为)\s*/, (s) => (s.includes("负责") || s.includes("职责") ? "" : s))
		.trim();
	return {
		name: name || "新 Bot",
		systemPrompt: duty && duty !== text ? duty : `你是由主 bot 协助创建的 bot。原始需求：${text}`,
		tools: [],
		repos: [...text.matchAll(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g)].map((m) => m[1]).filter((r) => !r.includes("..")),
		memoryScope: "self+about-me",
		source: "rules",
	};
}

export function looksLikeCreateBotIntent(message) {
	const t = String(message);
	return /(创建|新建|建一?个|加一?个).{0,12}(bot|Bot|BOT|机器人)/.test(t) || /(bot|Bot|BOT|机器人).{0,8}(创建|新建)/.test(t);
}
