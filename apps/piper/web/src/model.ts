// Piper 前端数据模型：与后端 API / SSE 契约对齐的线格式类型，以及前端自持的消息模型。
// 后端契约见 server.mjs 文件头注释，迁移前后保持不变。

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

// 模型设置（GET/PUT /api/settings/model 的线格式）：apiKeyHint 只有末四位掩码，绝无全文
export type ModelSettings = {
	configured: boolean;
	baseUrl: string;
	modelId: string;
	apiKeyHint: string;
};

export type ModelSettingsInput = {
	baseUrl?: string;
	modelId?: string;
	apiKey?: string;
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
export type HistoryEntry = {
	ts?: string;
	role: "user" | "assistant" | "system";
	text?: string;
	kind?: string;
	code?: string;
	draft?: BotDraft;
};

// POST /api/chat 的 SSE 事件（event 名 -> data 形状）
export type ChatEvent =
	| { event: "session"; data: { botId: string; sessionId: string } }
	| { event: "delta"; data: { text: string } }
	| { event: "tool"; data: { phase: string; name: string; detail: JsonValue } }
	| { event: "system"; data: { kind: string; text: string } }
	| { event: "draft"; data: { draft: BotDraft } }
	| { event: "error"; data: { code: string; message: string } }
	| { event: "done"; data: { botId: string } };

// 前端消息模型：external-store runtime 自持，convertMessage 转成 assistant-ui 的 ThreadMessageLike
export type ChatPart =
	| { type: "text"; text: string }
	| { type: "tool"; id: string; name: string; phase: string; detail: JsonValue }
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
export function historyToMessages(entries: HistoryEntry[]): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const e of entries) {
		if (e.role === "user") {
			out.push({ id: nextId("hist"), role: "user", parts: [{ type: "text", text: e.text ?? "" }], running: false });
		} else if (e.role === "assistant") {
			out.push({ id: nextId("hist"), role: "assistant", parts: [{ type: "text", text: e.text ?? "" }], running: false });
		} else if (e.draft) {
			out.push({
				id: nextId("hist"),
				role: "assistant",
				parts: [{ type: "draft", partId: nextId("draft"), draft: e.draft, readOnly: true }],
				running: false,
			});
		} else if (e.code) {
			out.push({
				id: nextId("hist"),
				role: "assistant",
				parts: [{ type: "error", code: e.code, message: e.text ?? "" }],
				running: false,
			});
		} else {
			out.push({
				id: nextId("hist"),
				role: "assistant",
				parts: [{ type: "system", kind: e.kind ?? "system", text: e.text ?? "" }],
				running: false,
			});
		}
	}
	return out;
}
