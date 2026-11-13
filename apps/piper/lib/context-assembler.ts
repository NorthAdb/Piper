// 可观测的上下文装配器（P2-6）：一趟 streamChat 的上下文按锁定顺序
// 装配，并逐级留下数字——每一级装配前/后各多少 token、丢掉了什么、
// 缓存为何击穿。本模块不换压缩算法、不写记忆层：它只做装配、度量与
// 历史窗口裁剪（裁剪走基座 transformContext 钩子，见 kernel.ts 接线），
// 数字经会话流水（kind: "context_assembly"）落盘、按 sessionId 可读。
//
// 装配顺序锁定（调换必须在被调换的级上记 cacheBreak: "reorder"）：
//   1. system（bot 人设 + botSelfFacts + 凭据红线；工具说明散文附卷尾
//      一并计入本级——tools 级只计工具声明本身的序列化）
//   2. tools（注册表 offered 工具的声明；顺序稳定口径 = 按 name 排序，
//      装配器真排序、kernel 用排序后的数组建 Agent，记录与线上一致）
//   3. about_me（about-me.md 当前内容）
//   4. memory（预留段：本件为空段，仍占位并出数字——以后插入记忆层时
//      不打乱它前面的前缀）
//   5. history（本轮之前的会话消息；窗口裁剪在本级发生）
//   6. turn（本轮用户消息）
//
// token 估算口径：字符数 / 4 向上取整（与 pi-ai estimate 的启发式同
// 族）；消息级估算按内容块累加（text / thinking 取字符数，toolCall 取
// name + 参数 JSON 长度）。这是装配器自己的记账口径，不冒充服务商的
// 真实分词数。
//
// 前缀级（system / tools / about_me / memory）本件不做裁剪，
// tokensBefore == tokensAfter；history 级的 before 是窗口裁剪前、
// after 是裁剪后。history 的 before 若达到「上下文窗 − 预留」阈值
// （预留 16384，沿用 coding-agent 压缩口径），history 记录带
// cacheBreak: "compact"——含义是「按 coding-agent 口径这里已越过
// 压缩触发点」；Piper 的 agent-core 路径没有摘要压缩，本路径实际
// 发生的削减就是窗口裁剪，before/after 两侧数字把这件事摊开给人看。
// cacheBreak: "ttl" 是词表预留值，本件不产生。
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type AssemblerStage = "system" | "tools" | "about_me" | "memory" | "history" | "turn";

export interface AssemblerStageRecord {
	stage: AssemblerStage;
	tokensBefore: number;
	tokensAfter: number;
	dropped: { ids: string[]; reason: string } | null;
	cacheBreak?: "compact" | "model_switch" | "ttl" | "reorder";
}

export const ASSEMBLY_STAGE_ORDER: readonly AssemblerStage[] = ["system", "tools", "about_me", "memory", "history", "turn"];

// 历史窗口：与 toPiMessages 既有的最近 20 条口径一致。P2-6 起 streamChat
// 路径的这道裁剪由装配器在 transformContext 里做（留下 dropped 与数字）；
// resumeToolApproval 的 transcript 重建不经装配器，仍走 toPiMessages 自带
// 的 slice，口径不变。
export const HISTORY_WINDOW_MESSAGES = 20;

// 压缩触发点的预留 token（coding-agent compaction 的 reserveTokens 口径）。
export const COMPACTION_RESERVE_TOKENS = 16384;

const CHARS_PER_TOKEN = 4;

export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// 消息内容块的字符数（估算用）：AgentMessage 含基座自定义消息种类，
// 内容形状开放，这里按已知块类型逐个读，读不出的块计 0——这是估算的
// 信任边界，与 pi-ai estimateMessageTokens 的读法同构。
function messageChars(message: AgentMessage): number {
	const content: unknown = (message as { content?: unknown }).content;
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: unknown; text?: unknown; thinking?: unknown; name?: unknown; arguments?: unknown };
		if (b.type === "text" && typeof b.text === "string") chars += b.text.length;
		else if (b.type === "thinking" && typeof b.thinking === "string") chars += b.thinking.length;
		else if (b.type === "toolCall") {
			chars += typeof b.name === "string" ? b.name.length : 0;
			try {
				chars += JSON.stringify(b.arguments ?? {})?.length ?? 0;
			} catch {
				/* 不可序列化的参数按 0 计，估算不因此抛错 */
			}
		} else if (typeof b.text === "string") chars += b.text.length;
	}
	return chars;
}

export function estimateMessageTokens(message: AgentMessage): number {
	return Math.ceil(messageChars(message) / CHARS_PER_TOKEN);
}

export interface ContextAssemblerOptions {
	sessionId: string;
	modelId: string;
	// 同一会话上一轮装配记录里的模型（kernel 从会话流水的上一条
	// context_assembly 条目取）；与本轮不同 → system 级记 model_switch。
	previousModelId?: string | null;
	contextWindow: number;
	reserveTokens?: number;
	// 装配顺序覆盖（仅测试用来故意调序验证 reorder 记录）；产品路径
	// 不传，恒为 ASSEMBLY_STAGE_ORDER。
	stageOrder?: readonly AssemblerStage[];
}

// 一趟装配一份实例（kernel 在 streamChat 里建）：compose/orderTools
// 先行（建 Agent 前），prepareRequest / transformContext 是基座钩子
// 本体（每个请求前跑；只有第一次调用定型记录，之后同趟内幂等）。
export class ContextAssembler {
	readonly sessionId: string;
	readonly modelId: string;
	private readonly previousModelId: string | null;
	private readonly contextWindow: number;
	private readonly reserveTokens: number;
	private readonly order: AssemblerStage[];
	private systemText = "";
	private trailingNoteText = "";
	private aboutMeText = "";
	private toolsTokens = 0;
	private prefixMaterialized = false;
	private readonly stageRecords = new Map<AssemblerStage, AssemblerStageRecord>();
	private historyCount = 0;
	private historyIds: string[] = [];
	private historyDroppedCount = 0;
	private historyRecorded = false;

	constructor(options: ContextAssemblerOptions) {
		this.sessionId = options.sessionId;
		this.modelId = options.modelId;
		this.previousModelId = options.previousModelId ?? null;
		this.contextWindow = options.contextWindow;
		this.reserveTokens = options.reserveTokens ?? COMPACTION_RESERVE_TOKENS;
		this.order = [...(options.stageOrder ?? ASSEMBLY_STAGE_ORDER)];
	}

	// system 级组装：人设段 + about_me 段按产品既有格式拼（段间两个空
	// 行），工具说明散文附卷尾（与 P2-6 前线上字节序一致）。memory 段
	// 是空串占位，物理上不产生字节。返回拼好的 systemPrompt 全文。
	composeSystemPrompt(parts: { system: string; aboutMe: string; trailingNote?: string }): string {
		this.systemText = parts.system;
		this.aboutMeText = parts.aboutMe;
		this.trailingNoteText = parts.trailingNote ?? "";
		return `${parts.system}\n\n\n${parts.aboutMe}${this.trailingNoteText}`;
	}

	// tools 级：按 name 排序（稳定顺序口径，见文件头）并度量声明序列化
	// 后的 token。返回排序后的数组，kernel 用它建 Agent——记录里的
	// 顺序就是实际发给模型的顺序。
	orderTools<T extends { name: string; description?: string; parameters?: unknown }>(tools: readonly T[]): T[] {
		const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		this.toolsTokens = sorted.reduce(
			(sum, t) => sum + estimateTextTokens(JSON.stringify({ name: t.name, description: t.description ?? "", parameters: t.parameters ?? {} }) ?? ""),
			0,
		);
		return sorted;
	}

	// history 级的源头（kernel 在建 Agent 前调用）：本轮之前的消息条数
	// 与逐条 id（id 口径 = 会话流水条目下标 m<index>，见 kernel 的
	// convertHistory）。本轮 user 条目不算 history（按 sessionId 在
	// kernel 侧剔除），它记在 turn 级。
	setHistorySource(count: number, ids: string[]): void {
		this.historyCount = count;
		this.historyIds = ids.slice(0, count);
	}

	// prepareRequest 钩子本体：每个请求前由基座调用。本趟第一次调用
	// 时定型前缀四级记录；请求实际带的模型若与本趟装配模型不同（趟内
	// 换模型），给 system 级补记 model_switch。恒回 undefined（不替换
	// 运行时上下文/模型，只做度量）。钩子契约：不得抛错。
	notePrepareRequest(modelId?: string | null): void {
		try {
			this.materializePrefix();
			if (modelId && modelId !== this.modelId) {
				const rec = this.stageRecords.get("system");
				if (rec && !rec.cacheBreak) rec.cacheBreak = "model_switch";
			}
		} catch {
			/* 度量失败不挡请求 */
		}
	}

	// transformContext 钩子本体：每个请求前由基座调用（在
	// prepareRequest 之后）。第一次调用时对 history 前缀做窗口裁剪并
	// 定型 history / turn 两级记录；之后同趟调用原样返回（裁剪已生效、
	// 不重复记账）。钩子契约：不得抛错，出错回原数组。
	async transformContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		try {
			if (this.historyRecorded) return messages;
			this.historyRecorded = true;
			const prefix = messages.slice(0, this.historyCount);
			const rest = messages.slice(this.historyCount);
			const tokensBefore = prefix.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
			let kept = prefix;
			let dropped: { ids: string[]; reason: string } | null = null;
			if (prefix.length > HISTORY_WINDOW_MESSAGES) {
				const dropCount = prefix.length - HISTORY_WINDOW_MESSAGES;
				dropped = {
					ids: this.historyIds.slice(0, dropCount),
					reason: `超出历史窗口（仅保留最近 ${HISTORY_WINDOW_MESSAGES} 条）`,
				};
				kept = prefix.slice(dropCount);
				this.historyDroppedCount = dropCount;
			}
			const tokensAfter = kept.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
			const record: AssemblerStageRecord = { stage: "history", tokensBefore, tokensAfter, dropped };
			if (tokensBefore >= this.contextWindow - this.reserveTokens) record.cacheBreak = "compact";
			this.putRecord(record);
			const turnMessage = rest.find((m) => (m as { role?: unknown }).role === "user");
			const turnTokens = turnMessage ? estimateMessageTokens(turnMessage) : 0;
			this.putRecord({ stage: "turn", tokensBefore: turnTokens, tokensAfter: turnTokens, dropped: null });
			return [...kept, ...rest];
		} catch {
			return messages;
		}
	}

	// 本趟记录（按本趟装配顺序输出；未定型的级不出现——正常一趟跑完
	// 六级齐全，模型在首个请求前就失败时只有前缀级）。
	records(): AssemblerStageRecord[] {
		this.materializePrefix();
		const out: AssemblerStageRecord[] = [];
		for (const stage of this.order) {
			const rec = this.stageRecords.get(stage);
			if (rec) out.push(rec);
		}
		return out;
	}

	hasRecords(): boolean {
		return this.stageRecords.size > 0 || this.systemText !== "" || this.toolsTokens > 0;
	}

	private putRecord(record: AssemblerStageRecord): void {
		// 调序标记：本级在本趟顺序里的位置与锁定顺序不一致 → reorder
		// （已有更高优先级的击穿原因时不覆盖，如 system 的 model_switch）。
		const lockedIndex = ASSEMBLY_STAGE_ORDER.indexOf(record.stage);
		if (this.order.indexOf(record.stage) !== lockedIndex && !record.cacheBreak) {
			record.cacheBreak = "reorder";
		}
		this.stageRecords.set(record.stage, record);
	}

	private materializePrefix(): void {
		if (this.prefixMaterialized) return;
		this.prefixMaterialized = true;
		const systemTokens = estimateTextTokens(this.systemText) + estimateTextTokens(this.trailingNoteText);
		const systemRecord: AssemblerStageRecord = { stage: "system", tokensBefore: systemTokens, tokensAfter: systemTokens, dropped: null };
		if (this.previousModelId && this.previousModelId !== this.modelId) systemRecord.cacheBreak = "model_switch";
		this.putRecord(systemRecord);
		this.putRecord({ stage: "tools", tokensBefore: this.toolsTokens, tokensAfter: this.toolsTokens, dropped: null });
		const aboutMeTokens = estimateTextTokens(this.aboutMeText);
		this.putRecord({ stage: "about_me", tokensBefore: aboutMeTokens, tokensAfter: aboutMeTokens, dropped: null });
		this.putRecord({ stage: "memory", tokensBefore: 0, tokensAfter: 0, dropped: null });
	}
}
