// Piper 前端数据模型：与后端 API / SSE 契约对齐的线格式类型，以及前端自持的消息模型。
// 后端契约见 server.ts 文件头注释，迁移前后保持不变。

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type Bot = {
	id: string;
	name: string;
	systemPrompt: string;
	tools: string[];
	memoryScope: string;
	repos: string[];
	routines: string[];
	isMain: boolean;
	canManageBots: boolean;
	createdAt: string;
};

export type BotDraft = {
	name: string;
	systemPrompt: string;
	tools: string[];
	repos: string[];
	memoryScope: string;
	source: string;
};

export type Routine = {
	id: string;
	botId: string;
	name: string;
	description: string;
	// schedule 是机器可解析的 "HH:MM"（P1-4），scheduleText 是给人看的文案，nextRunAt 由调度状态附带
	schedule: string;
	scheduleText?: string;
	nextRunAt?: string | null;
	lastRunAt: string | null;
	lastArtifactId: string | null;
	lastStatus: string | null;
};

export type ArtifactMeta = {
	id: string;
	botId: string | null;
	kind: string;
	title: string;
	createdAt: string | null;
};

export type Artifact = ArtifactMeta & { body: string };

// 思考挡位词表（与 pi-ai 的 ThinkingLevel 一致，七挡）；每款模型实际可选
// 哪几挡由服务端随目录下发 supportedThinkingLevels（pi-ai
// getSupportedThinkingLevels 现算），目录外模型回落全词表
export const ALL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// 前端版挡位吸附（与 pi-ai clampThinkingLevel 同语义）：已选挡位不在支持集时，
// 先向上找最近的可用挡，再向下找；只用于设置页提示实际生效值，不改存量。
export function clampThinkingLevel(levels: string[], level: string): string {
	if (levels.includes(level)) return level;
	const idx = ALL_THINKING_LEVELS.indexOf(level);
	if (idx < 0) return levels[0] ?? "off";
	for (let i = idx; i < ALL_THINKING_LEVELS.length; i++) if (levels.includes(ALL_THINKING_LEVELS[i])) return ALL_THINKING_LEVELS[i];
	for (let i = idx - 1; i >= 0; i--) if (levels.includes(ALL_THINKING_LEVELS[i])) return ALL_THINKING_LEVELS[i];
	return levels[0] ?? "off";
}

// 模型服务商目录（GET /api/model-providers）：服务端派生自 pi-ai 内置目录，
// 只含 openai-completions 兼容服务商（models 为其兼容子集）+ custom；
// baseUrl 与模型名都允许改填，模型名还能从端点实时拉取
export type CatalogModel = {
	id: string;
	supportedThinkingLevels: string[];
};

export type ModelProvider = {
	id: string;
	name: string;
	baseUrl: string;
	models: CatalogModel[];
};

// 模型设置（GET/PUT /api/settings/model 的线格式）：apiKeyHint 只有末四位掩码，绝无全文。
// thinkingLevel 是已存的思考挡位选择；thinkingLevels 是当前模型的可选挡位
// （服务端按 pi-ai 目录现算，目录外模型为全词表）
export type ModelSettings = {
	configured: boolean;
	provider: string;
	baseUrl: string;
	modelId: string;
	apiKeyHint: string;
	thinkingLevel: string;
	thinkingLevels: string[];
};

export type ModelSettingsInput = {
	provider?: string;
	baseUrl?: string;
	modelId?: string;
	apiKey?: string;
	thinkingLevel?: string;
};

// 基础资料（GET/PUT /api/settings/profile 的线格式）；「关于我」正文走 /api/about-me，不在此重复
export type ProfileSettings = {
	displayName: string;
	timezone: string;
};

// 应用内通知（GET /api/notifications 的线格式）：approval.* 自 P1-6 起真正写入
export type NotificationEntry = {
	id: string;
	type: "routine.completed" | "routine.failed" | "approval.pending" | "approval.executed" | "approval.failed";
	title: string;
	body: string;
	routineId: string | null;
	artifactId: string | null;
	findingId?: string | null;
	read: boolean;
	createdAt: string;
};

// 连接器（GET /api/settings/connectors 的线格式）：统一槽位形状；tokenHint 只有末四位掩码
export type Connector = {
	id: string;
	name: string;
	purpose: string;
	status: "placeholder" | "unconfigured" | "connected";
	statusNote: string;
	bots: string[];
	access: string;
	configurable: boolean;
	tokenHint?: string;
	// 网页查询卡专属（L0-6）：抓取开关、搜索是否已配置、端点与密钥末四位掩码
	fetchEnabled?: boolean;
	searchConfigured?: boolean;
	searchEndpoint?: string;
	searchKeyHint?: string;
};

// 待批项（GET /api/approvals 的线格式，P1-5）：带 writeIntent 的 Finding 的审批视图，
// id 与 findingId 同值（Finding 是唯一事实源，不另存一份 approvals）。
export type WriteIntent = {
	kind: string;
	prNumber: number;
	body: string;
};

export type Approval = {
	id: string;
	findingId: string;
	botId: string;
	repo: string;
	type: string;
	title: string;
	summary: string;
	evidenceUrl: string;
	suggestedAction: string;
	writeIntent: WriteIntent;
	status: string;
	expiresAt: string | null;
	createdAt: string;
	updatedAt: string;
	// 批准记录（R1）：approvalId 为批准后落的记录 id（未批准时为 null）；intentHash 是
	// 批准内容的哈希，批准时必须原样带回，内容变了服务端回 409 要求重新查看
	approvalId: string | null;
	intentHash: string;
	// 来自审计（P1-6）：最近一次执行失败原因与已执行的评论链接
	lastError: string | null;
	commentUrl: string | null;
};

// 批准执行的网关结果（POST /api/approvals/:id/approve 的 execution 字段，P1-6）
export type ApprovalExecution = {
	ok: boolean;
	result: string;
	reason?: string;
	commentUrl?: string | null;
	artifactId?: string;
};

// 会话流水条目（GET /api/bots/:id/messages 的元素，来自 sessions/<botId>.jsonl）
// role:"tool" 是工具调用条目：回合结束时按最终态落盘（见 server.ts handleChat），
// historyToMessages 把它还原成工具卡 part，挂到紧随其后的 assistant 消息开头。
// role:"thinking" 是思考链条目：按段落盘（一段一条，超长截断时 truncated=true），
// 带 seq（与同轮 tool 条目共用递增序号）、durationMs（段时长）与 level（生效
// 挡位），还原成 reasoning part，位置与 tool 条目按流水顺序一同挂到 assistant
// 开头。旧落盘形状（整轮一条、无 seq/durationMs/level）读回兼容：字段缺省
// 时照旧还原为一段，摘要行不带秒数。
export type HistoryEntry = {
	ts?: string;
	role: "user" | "assistant" | "system" | "tool" | "thinking";
	text?: string;
	kind?: string;
	code?: string;
	draft?: BotDraft;
	toolCallId?: string;
	name?: string;
	args?: JsonValue;
	status?: string;
	result?: JsonValue;
	truncated?: boolean;
	seq?: number;
	durationMs?: number;
	level?: string;
};

// 轨迹（GET /api/bots/:id/trace 的线格式，PR-D 出数、PR-E 消费）：会话流水
// 经服务端 lib/trace.ts 的 buildTrace 按轮归一化。时间口径：ts / startedAt /
// endedAt / durationMs 均为 epoch 毫秒；无证据一律 null（界面显示「—」，不
// 编造）。textPreview 是脱敏后截断 200 字的预览（textChars 是全文长度）；
// tool 的 args/result 是落盘的已脱敏版本。kind 取会话条目 role 原值（user /
// thinking / tool / assistant / system，未知 role 原样透传）；system 的子类
// 在 subKind（draft / bot-created / error / routine）。
export type TraceEvent = {
	kind: string;
	subKind: string | null;
	ts: number | null;
	durationMs: number | null;
	seq: number | null;
	textChars: number | null;
	textPreview: string | null;
	// thinking 专属
	level?: string;
	truncated?: boolean;
	// tool 专属
	name?: string;
	status?: string;
	toolCallId?: string;
	startedAt?: number;
	endedAt?: number;
	args?: JsonValue;
	result?: JsonValue;
};

export type TraceTurn = {
	index: number;
	startedAt: number | null;
	endedAt: number | null;
	durationMs: number | null;
	events: TraceEvent[];
};

export type TraceData = {
	turns: TraceTurn[];
};

// POST /api/chat 的 SSE 事件（event 名 -> data 形状）
export type ChatEvent =
	| { event: "session"; data: { botId: string; sessionId: string } }
	| { event: "delta"; data: { text: string } }
	| { event: "thinking"; data: { text: string; level?: string; seg?: number; segStart?: boolean } }
	| { event: "tool"; data: { phase: string; name: string; toolCallId?: string; detail: JsonValue } }
	| { event: "system"; data: { kind: string; text: string } }
	| { event: "draft"; data: { draft: BotDraft } }
	| { event: "error"; data: { code: string; message: string } }
	| { event: "done"; data: { botId: string } };

// 前端消息模型：external-store runtime 自持，convertMessage 转成 assistant-ui 的 ThreadMessageLike
// tool part 是「一次调用一张卡」的合并模型：phase 随 call/start/end 推进，
// args 是调用参数（call/start 的 detail），result 是 end 的结果摘要 detail
//（{isError, url?, status?, truncated?, count?, error?}），历史还原时 phase 恒为 end。
// reasoning part 是一段思考：流式增量按 seg 拼进同一个 part，被工具/正文
// 打断后另起一段；level 是生效挡位，durationMs 是段时长（直播时在段关闭时
// 由 startedAt 补记，历史还原则来自落盘条目），渲染为弱化色竖条的折叠区。
export type ChatPart =
	| { type: "text"; text: string }
	| { type: "reasoning"; text: string; truncated?: boolean; level?: string; durationMs?: number; startedAt?: number; seg?: number }
	| { type: "tool"; id: string; name: string; phase: string; args: JsonValue; result: JsonValue }
	| { type: "system"; kind: string; text: string }
	| { type: "draft"; partId: string; draft: BotDraft; readOnly: boolean; confirmedBotName?: string }
	| { type: "error"; code: string; message: string };

export type ChatMessage = {
	id: string;
	role: "user" | "assistant";
	parts: ChatPart[];
	running: boolean;
};

let seq = 0;
export function nextId(prefix: string): string {
	seq += 1;
	return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

// 历史流水 -> 前端消息模型（系统条目挂到 assistant 消息上以卡片 part 呈现）
// thinking / tool 条目按流水顺序先攒着：紧随其后的 assistant 正文（或以错误
// 收尾时的 error 条目）把它们作为开头 parts 带走，思考区/工具卡在前、正文/
// 错误在后；若后面没有这样的条目（异常截断），单独成一条 assistant 消息
// 显示，不丢内容。旧会话没有这两类条目，行为不变。
export function historyToMessages(entries: HistoryEntry[]): ChatMessage[] {
	const out: ChatMessage[] = [];
	let pendingLead: ChatPart[] = [];
	const flushLead = () => {
		if (!pendingLead.length) return;
		out.push({ id: nextId("hist"), role: "assistant", parts: pendingLead, running: false });
		pendingLead = [];
	};
	for (const e of entries) {
		if (e.role === "thinking") {
			pendingLead.push({
				type: "reasoning",
				text: e.text ?? "",
				truncated: e.truncated === true,
				durationMs: typeof e.durationMs === "number" ? e.durationMs : undefined,
				level: e.level,
			});
		} else if (e.role === "tool") {
			pendingLead.push({
				type: "tool",
				id: e.toolCallId ?? nextId("tool"),
				name: e.name ?? "tool",
				phase: "end",
				args: e.args ?? null,
				result: e.result ?? (e.status === "error" ? { isError: true } : null),
			});
		} else if (e.role === "user") {
			flushLead();
			out.push({ id: nextId("hist"), role: "user", parts: [{ type: "text", text: e.text ?? "" }], running: false });
		} else if (e.role === "assistant") {
			const parts: ChatPart[] = [...pendingLead, { type: "text", text: e.text ?? "" }];
			pendingLead = [];
			out.push({ id: nextId("hist"), role: "assistant", parts, running: false });
		} else if (e.draft) {
			flushLead();
			out.push({
				id: nextId("hist"),
				role: "assistant",
				parts: [{ type: "draft", partId: nextId("draft"), draft: e.draft, readOnly: true }],
				running: false,
			});
		} else if (e.code) {
			const parts: ChatPart[] = [...pendingLead, { type: "error", code: e.code, message: e.text ?? "" }];
			pendingLead = [];
			out.push({ id: nextId("hist"), role: "assistant", parts, running: false });
		} else {
			flushLead();
			out.push({
				id: nextId("hist"),
				role: "assistant",
				parts: [{ type: "system", kind: e.kind ?? "system", text: e.text ?? "" }],
				running: false,
			});
		}
	}
	flushLead();
	return out;
}
