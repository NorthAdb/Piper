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
//   思考挡位（thinkingLevel）也在设置文件里：词表与 pi-ai 的 ThinkingLevel 一致
//   （off/minimal/low/medium/high/xhigh/max），缺省 off；生效值在
//   buildModelsAndModel 里按 pi-ai 目录模型的支持集吸附（clampThinkingLevel）。
//
// 说明：这里用动态 import 懒加载基座 dist——基座未构建时 app 的其余 API（bot CRUD/例程/产物）
// 仍须可用，所以不能在模块顶层静态 import 一个可能不存在的 dist；失败原因会原样上报。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isThinkingLevel, readModelSettingsFile } from "./settings.ts";
import type { ThinkingLevel } from "./settings.ts";
import { getCatalogModel, resolveModelProviderId } from "./model-providers.ts";
import { redact } from "./redact.ts";
import { APP_DIR, getBot, readSession } from "./store.ts";
import type { Bot, SessionEntry } from "./store.ts";
import { PolicyEngine } from "./policy.ts";
import { createToolApproval, findToolApprovalByToolCall, snapshotConflictReason, updateToolApproval } from "./tool-approvals.ts";
import { GITHUB_COMMENT_TOOL_NAME } from "./github-comment.ts";
import { agentToolsForBot } from "./tool-registry.ts";
import type { Api, ApiKeyAuth, AssistantMessage, CreateProviderOptions, Message, Model, ModelThinkingLevel, MutableModels, Provider, ProviderStreams, ToolCall, Usage } from "@earendil-works/pi-ai";
import type { Agent, AgentTool, AgentToolResult, ThinkingLevel as AgentThinkingLevel } from "@earendil-works/pi-agent-core";

const REPO_ROOT = join(APP_DIR, "..", "..");

export interface ModelConfig {
	configured: boolean;
	apiKey: string;
	baseUrl: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
}

// 流式对话的结构化事件（server.ts 的 SSE 与落盘口径都以此为准）。
export type ChatEvent =
	| { type: "delta"; text: string }
	| { type: "thinking"; text: string; level: string }
	| { type: "tool"; phase: "call" | "pending" | "start" | "end"; name: string; toolCallId: string; detail: unknown };

export interface BotDraft {
	name: string;
	systemPrompt: string;
	tools: string[];
	repos: string[];
	memoryScope: string;
	source: string;
}

export function modelConfig(): ModelConfig {
	const saved = readModelSettingsFile();
	const apiKey = saved.apiKey || process.env.PIPER_MODEL_API_KEY || process.env.OPENAI_API_KEY || "";
	return {
		configured: Boolean(apiKey),
		apiKey,
		baseUrl: saved.baseUrl || process.env.PIPER_MODEL_BASE_URL || "https://api.openai.com/v1",
		modelId: saved.modelId || process.env.PIPER_MODEL_ID || "gpt-4o-mini",
		// 思考挡位只来自设置文件（无 env 兜底）；文件里的值不在七挡词表内
		// （手改文件写错）按 off 读，不把坏值传给 Agent。
		thinkingLevel: isThinkingLevel(saved.thinkingLevel) ? saved.thinkingLevel : "off",
	};
}

// 动态 import 的是基座 dist 文件路径，编译期无法按路径解析模块类型（运行时
// 加载方式不变，仍是 pathToFileURL 动态 import）；下面按实际用到的成员标注
// 最小面，成员签名锚 pi-ai / pi-agent-core 的真实 .d.ts（createModels /
// createProvider / clampThinkingLevel / Agent 构造）。
interface PiAiRuntime {
	createModels(): MutableModels;
	createProvider(input: CreateProviderOptions<"openai-completions">): Provider<"openai-completions">;
	clampThinkingLevel(model: Model<Api>, level: ModelThinkingLevel): ModelThinkingLevel;
}

interface PiRuntime {
	ai: PiAiRuntime;
	agentCore: { Agent: typeof Agent };
	openAICompletionsApi: () => ProviderStreams;
}

let runtimePromise: Promise<PiRuntime> | null = null;

async function loadRuntime(): Promise<PiRuntime> {
	if (!runtimePromise) {
		runtimePromise = (async (): Promise<PiRuntime> => {
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
			return { ai, agentCore, openAICompletionsApi: completions.openAICompletionsApi } as PiRuntime;
		})();
	}
	return runtimePromise;
}

async function buildModelsAndModel(cfg: ModelConfig): Promise<{ models: MutableModels; model: Model<"openai-completions">; thinkingLevel: AgentThinkingLevel }> {
	const { ai, openAICompletionsApi } = await loadRuntime();
	// 思考挡位的依据必须落在构造出的 Model 上：pi-ai 的 openai-completions 在
	// 发请求前会拿这个 Model 做 clampThinkingLevel 并按 thinkingLevelMap 翻译
	// 厂商参数，reasoning 为假时则完全不发思考参数。所以命中 pi-ai 目录的
	// 模型要把目录 Model 的 reasoning 与 thinkingLevelMap 原样带过来，并先用
	// clampThinkingLevel 把已存挡位吸附到该模型的支持集，得到的生效挡位才
	// 传给 Agent；目录里查不到的自定义模型无元数据可依，按支持 reasoning
	// 处理（无 thinkingLevelMap）、挡位原样传 Agent，服务商不认时其错误走
	// modelErrorMessage 的脱敏出口。
	const saved = readModelSettingsFile();
	const providerId = await resolveModelProviderId(saved);
	const catalogModel = await getCatalogModel(providerId, cfg.modelId);
	const model: Model<"openai-completions"> = {
		id: cfg.modelId,
		name: cfg.modelId,
		api: "openai-completions",
		provider: "piper",
		baseUrl: cfg.baseUrl,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: catalogModel ? Boolean(catalogModel.reasoning) : true,
		...(catalogModel?.thinkingLevelMap ? { thinkingLevelMap: catalogModel.thinkingLevelMap } : {}),
		contextWindow: 128000,
		maxTokens: 8192,
	};
	const thinkingLevel: AgentThinkingLevel = catalogModel ? ai.clampThinkingLevel(catalogModel, cfg.thinkingLevel) : cfg.thinkingLevel;
	// 自定义 ApiKeyAuth：直接解析 modelConfig() 已合并好的 Key（设置文件优先、环境变量兜底），
	// 不再走 envApiKeyAuth——否则设置页保存的 Key 喂不进 provider。
	const keyAuth: ApiKeyAuth = {
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
	return { models, model, thinkingLevel };
}

function toPiMessages(history: SessionEntry[], cfg: ModelConfig): Message[] {
	const zeroUsage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return history
		.filter((h): h is SessionEntry & { text: string } => (h.role === "user" || h.role === "assistant") && typeof h.text === "string" && Boolean(h.text))
		.slice(-20)
		.map((h): Message =>
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

// 从任意消息形状里掏纯文本（AgentMessage / AssistantMessage 的 content 块）。
function textOf(message: unknown): string {
	const m = message as { content?: unknown } | null | undefined;
	if (!m || !Array.isArray(m.content)) return "";
	return (m.content as Array<{ type?: string; text?: string }>)
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("");
}

// 模型厂商错误的安全出口（R7）：厂商错误文本会回显请求里的 Key（实测 401 响应体
// 原样带 Key），进会话 JSONL / SSE / 接口返回值之前只保留状态码 + 截断 200 字的
// 脱敏文本，绝不把原文抛给上层。
export function modelErrorMessage(raw: unknown): string {
	const text = String(raw ?? "");
	const status = /\b([45]\d\d)\b/.exec(text)?.[1];
	const clean = redact(text).slice(0, 200);
	return status ? `模型调用失败（HTTP ${status}）：${clean}` : `模型调用失败：${clean}`;
}

// ---------- 工具物化（P2-5）：只经 lib/tool-registry.ts ----------
// 网页查询（L0-6）、工作区文件、github_comment 三类工具的实现与登记都在
// 注册表里：streamChat 与 resumeToolApproval 只用 agentToolsForBot 物化
// （implemented 且 offered 的项），本文件不再有第二条工具组装路径。
// 网页工具的注册与否仍由连接器状态 + bot 可用范围决定（注册表内判定）。

// Bot 自我事实（P1-7 试用暴露的问题）：对话里的 bot 不知道自己的绑定仓库与扫描
// 子系统的存在，被问「你能看哪些仓库」时回答「什么都看不见」，还反过来向用户
// 索要 PAT——用户真贴进对话，密钥就进了会话记录。本段由服务端在每轮对话时按
// bot 的当前配置现拼（绑定变更即时生效），钉死三件事实：绑定清单、仓库动态的
// 取证边界、凭据红线。
export function botSelfFacts(bot: Bot, { runsMorningScan = false }: { runsMorningScan?: boolean } = {}): string {
	const repos = bot.repos ?? [];
	const lines = [
		"## 关于你自己（系统事实，以本段为准）",
		`- 你是 Piper 里的 bot「${bot.name}」。`,
		repos.length
			? `- 你绑定的 GitHub 仓库是：${repos.join("、")}。被问到你能看哪些仓库时，按这份清单回答。`
			: "- 你当前没有绑定任何 GitHub 仓库。被问到时如实说未绑定，不要编造仓库名。",
		"- 仓库的 PR 待审、CI 失败等动态由晨间扫描子系统取证，结果落在日报产物与「待批收件箱」里；你在对话里没有直接查询 GitHub 的工具，无法实时确认某个 PR 或 CI 的当前状态。被问到这类动态时，说明以最近一轮扫描的日报为准、指引用户去看日报或待批收件箱，不要凭记忆或猜测编造 PR/CI 状态。",
	];
	if (runsMorningScan) {
		lines.push("- 晨间仓库扫描例程挂在你名下：到点（或用户手动触发）时系统自动扫描你绑定的仓库并生成日报，发现需要人拍板的写操作会开成待批事项进收件箱——扫描不是你在对话里手动做的，被问到时按此说明。");
	}
	lines.push(
		"- 凭据红线：GitHub 令牌、模型 API Key 等凭据只能由用户在「设置」页填写。绝不要请用户在对话里把令牌或 Key 发给你；用户主动要在对话里提供时，明确请他改去设置页填写，不要复述、保存或使用他在对话中贴出的任何疑似密钥。",
	);
	return lines.join("\n");
}

// ---------- 循环闸的宿主接线（P2-3）：策略、待批落盘、等待与恢复 ----------
// 每个进行中的会话至多一个活 Agent：批准接口先在 liveAgents 里找原 Agent，
// 找到就 resolveToolCall 在原 run 里放行；找不到（进程重启过）走
// resumeToolApproval 从会话 JSONL 重建 transcript 再 resolve。
// backgroundRuns 给「SSE 已结束但 run 还停在待批」的浮动 promise 续命：
// 没有这层引用，整条 promise 链可能被 GC 掉，批准就再也唤不醒它。
const liveAgents = new Map<string, Agent>();
const backgroundRuns = new Set<Promise<unknown>>();
// 按 bot 索引的活 run（P2-4 中止接口用）：同一 bot 同时至多一轮在跑，
// streamChat / resumeToolApproval 在建 Agent 时登记、run 结束时按身份摘除。
const liveRunsByBot = new Map<string, { sessionId: string; agent: Agent }>();

export function trackBackgroundRun(promise: Promise<unknown>): void {
	backgroundRuns.add(promise);
	const done = (): void => {
		backgroundRuns.delete(promise);
	};
	promise.then(done, done);
}

export function getLiveAgent(sessionId: string): Agent | null {
	return liveAgents.get(sessionId) ?? null;
}

function registerLiveRun(botId: string, sessionId: string, agent: Agent): void {
	liveRunsByBot.set(botId, { sessionId, agent });
}

function clearLiveRun(botId: string, agent: Agent): void {
	if (liveRunsByBot.get(botId)?.agent === agent) liveRunsByBot.delete(botId);
}

// 中止某 bot 当前的 run（P2-4）：基座 abort 会把停在待批等待上的调用以
// deny 结算（循环按「已取消」收尾成错误结果），正在执行的调用跑完当前这
// 一步后其余同批调用不再开始。没有活 run 时回 { aborted: false }，不抛错。
export function abortLiveRun(botId: string): { aborted: boolean; sessionId?: string } {
	const entry = liveRunsByBot.get(botId);
	if (!entry) return { aborted: false };
	entry.agent.abort();
	return { aborted: true, sessionId: entry.sessionId };
}

// 该 bot 此刻是否有活动 run（含停在待批等待、已批准在途执行）：对话
// 窗格的 run-state 轮询据此保留中止入口（#36 审计 MINOR）。
export function hasLiveRun(botId: string): boolean {
	return liveRunsByBot.has(botId);
}

// 闸的三个钩子（botId 在场时才装）：beforeToolCall 问 PolicyEngine——
// deny 原样返回（本引擎的 deny 没有任何后续钩子能翻案，钩子链里它就是
// 唯一裁决者）；ask 不带改参（本件不支持钩子改参放行，参数以模型原提
// 为快照）；onToolApprovalPending 在等待之前把待批记录落盘（内核 await
// 它之后才发 pending 事件、才进等待）；waitForToolApproval 本身只停泊——
// 决定经 Agent.resolveToolCall 由基座的等待桥交付（agent.ts 内部 race），
// 停泊的 promise 永不自行 settle，abort 时基座按取消处理。
function gateHooks(botId: string, sessionId: string) {
	return {
		toolExecution: "sequential" as const,
		sessionId,
		beforeToolCall: async (ctx: { toolCall: { name: string }; args: unknown }) => {
			const decision = PolicyEngine.decide({
				botId,
				toolName: ctx.toolCall.name,
				args: ctx.args && typeof ctx.args === "object" ? (ctx.args as Record<string, unknown>) : {},
			});
			if (decision === "deny") return { decision: "deny" as const, reason: `策略拒绝：工具 ${ctx.toolCall.name} 的本次调用不被允许` };
			if (decision === "ask") return { decision: "ask" as const };
			return { decision: "allow" as const };
		},
		onToolApprovalPending: async (ctx: { toolCallId: string; toolName: string; args: unknown }) => {
			createToolApproval({ botId, sessionId, toolCallId: ctx.toolCallId, toolName: ctx.toolName, argsSnapshot: ctx.args ?? null });
		},
		waitForToolApproval: async () => new Promise<never>(() => {}),
	};
}

// 本地工具待批记录的执行定型（P2-5）：github_comment 的记录生命周期归
// 网关管（暂时性失败保持 approved + error 等重试，见 gateway.ts），本
// 函数跳过它；其余 ask 工具（工作区写/编辑）没有第二方定型者——run 的
// tool_execution_end 就是终点：approved → executed（工具出错时把错误
// 文本记进 error，状态仍为 executed：批准已被消费、结果成败看会话里
// 的工具结果，bot 要改会重新提出新调用）。定型失败不挡 run 本身。
function settleLocalToolApproval(sessionId: string, toolCallId: string, isError: boolean, errorText: string | null): void {
	try {
		const rec = findToolApprovalByToolCall(sessionId, toolCallId);
		if (!rec || rec.status !== "approved" || rec.toolName === GITHUB_COMMENT_TOOL_NAME) return;
		updateToolApproval(rec.id, { status: "executed", error: isError ? errorText : null });
	} catch {
		/* 记录定型失败不挡 run 本身 */
	}
}

// Agent 事件 → ChatEvent 的映射（streamChat 与 resumeToolApproval 共用）：
// thinking 带生效挡位；tool 的 pending 来自基座 tool_approval_pending 事件
// （落盘已在此前完成）；end 的 detail 并入工具结果 details，出错再带 error。
function subscribeChatEvents(
	agent: Agent,
	onEvent: (event: ChatEvent) => void,
	thinkingLevel: string,
	state: { finalText: string },
	sessionId?: string,
): () => void {
	return agent.subscribe((event) => {
		if (event.type === "message_update") {
			const ame = event.assistantMessageEvent;
			if (ame?.type === "text_delta" && ame.delta) onEvent({ type: "delta", text: ame.delta });
			if (ame?.type === "thinking_delta" && ame.delta) onEvent({ type: "thinking", text: ame.delta, level: thinkingLevel });
			if (ame?.type === "toolcall_end" && ame.toolCall) {
				onEvent({ type: "tool", phase: "call", name: ame.toolCall.name, toolCallId: ame.toolCall.id, detail: ame.toolCall.arguments ?? null });
			}
		} else if (event.type === "tool_approval_pending") {
			onEvent({ type: "tool", phase: "pending", name: event.toolName, toolCallId: event.toolCallId, detail: event.args ?? null });
		} else if (event.type === "tool_execution_start") {
			onEvent({ type: "tool", phase: "start", name: event.toolName, toolCallId: event.toolCallId, detail: event.args ?? null });
		} else if (event.type === "tool_execution_end") {
			const details =
				event.result?.details && typeof event.result.details === "object" && !Array.isArray(event.result.details) ? event.result.details : {};
			const detail = { isError: event.isError, ...details };
			if (event.isError && typeof detail.error !== "string") {
				const errText = Array.isArray(event.result?.content)
					? event.result.content.find((c: any) => c?.type === "text" && typeof c.text === "string")?.text
					: undefined;
				if (errText) detail.error = errText.slice(0, 300);
			}
			onEvent({ type: "tool", phase: "end", name: event.toolName, toolCallId: event.toolCallId, detail });
			if (sessionId) settleLocalToolApproval(sessionId, event.toolCallId, event.isError, typeof detail.error === "string" ? detail.error : null);
		} else if (event.type === "message_end" && event.message?.role === "assistant") {
			state.finalText = textOf(event.message) || state.finalText;
		}
	});
}

// 流式对话：onEvent 收结构化事件 {type:"delta",text} / {type:"thinking",text,level} /
// {type:"tool",phase,name,toolCallId,detail}。thinking 是思考链增量：pi-ai 的
// openai-completions 已把服务商回的 reasoning_content / reasoning /
// reasoning_text 解析成 thinking 内容，pi-agent-core 以 message_update 的
// thinking_delta 往外送，这里原样转发并带上生效挡位 level（已 clamp 的值，
// 供前端思考区头部与服务端按段落盘标注；挡位为 off 或服务商不回推理时不出现）。
// tool 事件的 call/pending/start/end 四段带同一个 toolCallId（前端按它把一次调用
// 合并成一张卡、服务端按它收集落盘）；end 的 detail 除 isError 外并入工具结果的
// details（web_fetch 的 {url,status,truncated}、web_search 的 {count}），出错时
// 再带 error 文本。botId/sessionId 在场时装上循环闸（见 gateHooks）。
// 返回最终助手文本。失败抛错（err.code 区分 BASE_NOT_BUILT / MODEL_ERROR 等），由路由层转 SSE error 事件。
export async function streamChat({
	systemPrompt,
	history = [],
	message,
	onEvent,
	botId,
	sessionId,
}: {
	systemPrompt: string;
	history?: SessionEntry[];
	message: string;
	onEvent: (event: ChatEvent) => void;
	botId?: string;
	sessionId?: string;
}): Promise<{ text: string }> {
	const cfg = modelConfig();
	if (!cfg.configured) {
		throw Object.assign(new Error("未配置模型：请在设置中配置模型（端点与 API Key），或设置 PIPER_MODEL_API_KEY 后重试。"), {
			code: "MODEL_NOT_CONFIGURED",
		});
	}
	// 工具只从注册表物化（P2-5）：调用方不再传工具数组，本文件与
	// resumeToolApproval 是仅有的两个物化点，且共用同一函数。
	const tools = botId ? agentToolsForBot(getBot(botId), sessionId ?? "") : [];
	const { agentCore } = await loadRuntime();
	const { models, model, thinkingLevel } = await buildModelsAndModel(cfg);
	const toolNote = tools.length
		? `\n\n你可以使用这些工具：${tools.map((t) => t.name).join("、")}。其中写操作工具会先经用户批准才会真正执行；工具被拒绝或失败时，把原因如实告诉用户，不要编造结果。`
		: "";
	const agent = new agentCore.Agent({
		initialState: {
			systemPrompt: systemPrompt + toolNote,
			model,
			messages: toPiMessages(history, cfg),
			tools,
			thinkingLevel,
		},
		streamFn: (m, context, options) => models.streamSimple(m, context, options),
		...(botId ? gateHooks(botId, sessionId ?? "") : {}),
	});
	const state = { finalText: "" };
	const unsubscribe = subscribeChatEvents(agent, onEvent, thinkingLevel, state, sessionId);
	if (sessionId) liveAgents.set(sessionId, agent);
	if (botId && sessionId) registerLiveRun(botId, sessionId, agent);
	try {
		await agent.prompt(message);
	} catch (err) {
		throw Object.assign(new Error(modelErrorMessage((err as { message?: unknown } | null | undefined)?.message ?? err)), { code: "MODEL_ERROR" });
	} finally {
		unsubscribe();
		if (sessionId && liveAgents.get(sessionId) === agent) liveAgents.delete(sessionId);
		if (botId) clearLiveRun(botId, agent);
	}
	if (agent.state?.errorMessage) {
		throw Object.assign(new Error(modelErrorMessage(agent.state.errorMessage)), { code: "MODEL_ERROR" });
	}
	return { text: state.finalText };
}

// 待批恢复（进程重启后批准）：从会话 JSONL 重建 transcript——本轮之前的
// 对话按文本历史（toPiMessages 同口径），本轮 = user 条目 + 一条只含待批
// 工具调用的 assistant 消息（待批集合的取法见函数内注释：按 toolCallId
// 取最后一条且仍为 pending、且 ToolApproval 记录未终结，按 seq 排序）；
// 新建 Agent 后走 resolveToolCall（不得用 continue()，
// 基座在 last 为 assistant 时会抛错）。续跑的事件经 onEvent 交回调用方
// 落盘；若续跑中又有同批调用进 ask，本函数返回的 promise 会停泊在那次
// 等待上（调用方应以 trackBackgroundRun 托住、不要直接 await 到底）。
export async function resumeToolApproval({
	botId,
	sessionId,
	toolCallId,
	decision,
	onEvent,
}: {
	botId: string;
	sessionId: string;
	toolCallId: string;
	decision: "allow" | "deny";
	onEvent: (event: ChatEvent) => void;
}): Promise<{ text: string }> {
	const bot = getBot(botId);
	if (!bot) throw Object.assign(new Error(`bot 不存在: ${botId}`), { code: "BOT_NOT_FOUND" });
	const cfg = modelConfig();
	if (!cfg.configured) {
		throw Object.assign(new Error("未配置模型：请在设置中配置模型（端点与 API Key），或设置 PIPER_MODEL_API_KEY 后重试。"), {
			code: "MODEL_NOT_CONFIGURED",
		});
	}
	const entries = readSession(botId);
	const turn = entries.filter((e) => e.sessionId === sessionId);
	const userEntry = turn.find((e) => e.role === "user");
	// 待批集合的取法（P2-4，#35 审计留项）：同一 toolCallId 在流水里有
	// pending 与终态两条（先落盘 pending、终态后补一条），按 toolCallId 取
	// 最后一条为准——最后一条仍是 pending 才算待批。还要再看 ToolApproval
	// 记录本身：记录已是终态（executed / rejected / cancelled / failed）
	// 的调用绝不重建进 transcript——典型场景是同批第一个调用已在原 run
	// 里执行完、进程停在第二个待批上时被杀：第一个调用的终态条目还没来
	// 得及落盘（回合浮动收尾未跑），只看流水会把它当待批重新批准、重复
	// 发评论。记录为 pending / approved 的才可恢复；无记录（异常）时按
	// 流水口径保留。
	const lastToolByCall = new Map<string, SessionEntry>();
	for (const e of turn) {
		if (e.role === "tool" && e.toolCallId) lastToolByCall.set(String(e.toolCallId), e);
	}
	const pendingTools = [...lastToolByCall.values()]
		.filter((e) => e.status === "pending")
		.filter((e) => {
			const rec = findToolApprovalByToolCall(sessionId, String(e.toolCallId));
			return !rec || rec.status === "pending" || rec.status === "approved";
		})
		.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
	if (!userEntry || !pendingTools.some((t) => t.toolCallId === toolCallId)) {
		throw Object.assign(new Error("会话记录里找不到该待批调用，无法恢复执行"), { code: "RESUME_NOT_FOUND" });
	}
	// 快照回传与冲突拒绝（P2-5，#33 MAJOR-2 宿主契约）：transcript 里的
	// 是模型原始参数，被批准的是落盘记录的 argsSnapshot（正文可能已在
	// pending 时被改过）。恢复放行必须把快照经 resolveToolCall 的
	// arguments 传回；流水参数与快照在 body 之外对不上（落盘被篡改或
	// 写坏）时由 ToolApproval 层判冲突、这里拒绝恢复，绝不执行对不上
	// 的参数。记录缺失（异常）时无快照可传，按流水原参数走基座默认。
	const targetTool = pendingTools.find((t) => t.toolCallId === toolCallId);
	const approvalRecord = findToolApprovalByToolCall(sessionId, toolCallId);
	if (approvalRecord) {
		const conflict = snapshotConflictReason(approvalRecord, targetTool?.args);
		if (conflict) {
			throw Object.assign(new Error(`待批记录与会话流水不一致（${conflict}），已拒绝恢复执行`), { code: "SNAPSHOT_CONFLICT" });
		}
	}
	const { agentCore } = await loadRuntime();
	const { models, model, thinkingLevel } = await buildModelsAndModel(cfg);
	const zeroUsage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: pendingTools.map((t) => ({
			type: "toolCall" as const,
			id: String(t.toolCallId),
			name: String(t.name),
			arguments: (t.args ?? {}) as ToolCall["arguments"],
		})),
		api: "openai-completions",
		provider: "piper",
		model: cfg.modelId,
		usage: zeroUsage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	const messages: Message[] = [
		...toPiMessages(entries.filter((e) => e.sessionId !== sessionId), cfg),
		{ role: "user", content: [{ type: "text", text: String(userEntry.text ?? "") }], timestamp: Date.now() },
		assistantMessage,
	];
	const tools = agentToolsForBot(bot, sessionId);
	const agent = new agentCore.Agent({
		initialState: {
			systemPrompt: bot.systemPrompt,
			model,
			messages,
			tools,
			thinkingLevel,
		},
		streamFn: (m, context, options) => models.streamSimple(m, context, options),
		...gateHooks(botId, sessionId),
	});
	const state = { finalText: "" };
	const unsubscribe = subscribeChatEvents(agent, onEvent, thinkingLevel, state, sessionId);
	liveAgents.set(sessionId, agent);
	registerLiveRun(botId, sessionId, agent);
	try {
		await agent.resolveToolCall(toolCallId, {
			decision,
			...(decision === "allow" && approvalRecord?.argsSnapshot != null ? { arguments: approvalRecord.argsSnapshot } : {}),
		});
	} catch (err) {
		throw Object.assign(new Error(modelErrorMessage((err as { message?: unknown } | null | undefined)?.message ?? err)), { code: "MODEL_ERROR" });
	} finally {
		unsubscribe();
		if (liveAgents.get(sessionId) === agent) liveAgents.delete(sessionId);
		clearLiveRun(botId, agent);
	}
	if (agent.state?.errorMessage) {
		throw Object.assign(new Error(modelErrorMessage(agent.state.errorMessage)), { code: "MODEL_ERROR" });
	}
	return { text: state.finalText };
}
// 设置页「测试连接」：用候选配置（overrides 覆盖已生效配置的对应字段）打一次最小请求。
// 只回 {ok} 或 {ok:false, error}，不抛错、不把 Key 写进返回值。15 秒超时，坏端点不会挂死进程。
export async function testModelConfig(overrides: { apiKey?: string; baseUrl?: string; modelId?: string } = {}): Promise<{ ok: boolean; error?: string }> {
	const base = modelConfig();
	const cfg: ModelConfig = {
		configured: false,
		apiKey: overrides.apiKey || base.apiKey,
		baseUrl: overrides.baseUrl || base.baseUrl,
		modelId: overrides.modelId || base.modelId,
		// 测试连接不消费思考挡位（completeSimple 不传挡位），沿用当前生效值占位。
		thinkingLevel: base.thinkingLevel,
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
		return { ok: false, error: redact(String((err as { message?: unknown } | null | undefined)?.message || err)).slice(0, 300) };
	}
}

// 用模型从用户消息抽取 Bot 草案字段；失败返回 null，调用方走规则兜底。
export async function extractDraftWithModel(message: string): Promise<BotDraft | null> {
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
		// 模型输出是外部数据：JSON 形状在下方逐字段收窄后才组装草案。
		const parsed: any = JSON.parse(m[0]);
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
export function extractDraftByRules(message: unknown): BotDraft {
	const text = String(message);
	let name: string | null = null;
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

export function looksLikeCreateBotIntent(message: unknown): boolean {
	const t = String(message);
	return /(创建|新建|建一?个|加一?个).{0,12}(bot|Bot|BOT|机器人)/.test(t) || /(bot|Bot|BOT|机器人).{0,8}(创建|新建)/.test(t);
}
