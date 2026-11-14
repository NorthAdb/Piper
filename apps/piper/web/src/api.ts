// Piper 后端 API 客户端：cookie 会话（与 server.ts 一致），401 时抛 UnauthorizedError 交给界面回登录页。
import type {
	Approval,
	ApprovalExecution,
	Artifact,
	ArtifactMeta,
	Bot,
	BotDraft,
	ChatEvent,
	Connector,
	GithubSelfCheck,
	HistoryEntry,
	InboxItem,
	ModelProvider,
	ModelSettings,
	NotificationEntry,
	ModelSettingsInput,
	ProfileSettings,
	Routine,
	ToolApprovalItem,
	ToolRegistryItem,
	TraceData,
} from "./model";

export class UnauthorizedError extends Error {
	constructor() {
		super("未登录");
	}
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
	if (res.status === 401) throw new UnauthorizedError();
	const data = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
	if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
	return data as T;
}

export async function login(token: string): Promise<void> {
	const res = await fetch("/api/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token }),
	});
	if (!res.ok) throw new Error("口令不正确");
}

export function getSession(): Promise<{ authenticated: boolean; modelConfigured: boolean }> {
	return api("/api/session");
}

export async function listBots(): Promise<Bot[]> {
	return (await api<{ bots: Bot[] }>("/api/bots")).bots;
}

export type BotInput = Pick<Bot, "name" | "systemPrompt" | "tools" | "memoryScope" | "repos">;

export async function createBot(input: BotInput): Promise<Bot> {
	return (await api<{ bot: Bot }>("/api/bots", { method: "POST", body: JSON.stringify(input) })).bot;
}

export async function updateBot(id: string, input: BotInput): Promise<Bot> {
	return (await api<{ bot: Bot }>(`/api/bots/${id}`, { method: "PUT", body: JSON.stringify(input) })).bot;
}

export async function deleteBot(id: string): Promise<void> {
	await api(`/api/bots/${id}`, { method: "DELETE" });
}

export async function confirmDraft(draft: BotDraft): Promise<Bot> {
	return (await api<{ bot: Bot }>("/api/bots/draft-confirm", { method: "POST", body: JSON.stringify({ draft }) })).bot;
}

export async function listMessages(botId: string): Promise<HistoryEntry[]> {
	return (await api<{ messages: HistoryEntry[] }>(`/api/bots/${botId}/messages`)).messages;
}

// 工具注册表（P2-5）：该 bot 的工具清单全文，供桌面「工具」页签核对；
// presetGaps 是预置 bot 缺失的种子工具声明（P2-9 试用后修复）。
export async function listBotTools(botId: string): Promise<{ tools: ToolRegistryItem[]; presetGaps: string[] }> {
	return api<{ tools: ToolRegistryItem[]; presetGaps: string[] }>(`/api/bots/${botId}/tools`);
}

// 预置声明补齐（P2-9 试用后修复）：只加不删地把缺失的种子声明补回
// 该 bot 的工具集，回补齐后的注册表全文与剩余缺口。
export async function backfillPresetTools(botId: string): Promise<{ added: string[]; tools: ToolRegistryItem[]; presetGaps: string[] }> {
	return api<{ added: string[]; tools: ToolRegistryItem[]; presetGaps: string[] }>(`/api/bots/${botId}/preset-tools/backfill`, {
		method: "POST",
		body: "{}",
	});
}

// 轨迹（PR-E）：当前 bot 会话流水的按轮归一化视图，形状见 model.ts 的 TraceData。
export function getTrace(botId: string): Promise<TraceData> {
	return api(`/api/bots/${botId}/trace`);
}

export async function listRoutines(): Promise<Routine[]> {
	return (await api<{ routines: Routine[] }>("/api/routines")).routines;
}

export async function runMorningScan(): Promise<void> {
	await api("/api/routines/morning-scan/run", { method: "POST", body: "{}" });
}

export async function listArtifacts(botId?: string): Promise<ArtifactMeta[]> {
	const query = botId ? `?botId=${encodeURIComponent(botId)}` : "";
	return (await api<{ artifacts: ArtifactMeta[] }>(`/api/artifacts${query}`)).artifacts;
}

export async function getArtifact(id: string): Promise<Artifact> {
	return (await api<{ artifact: Artifact }>(`/api/artifacts/${id}`)).artifact;
}

export async function listApprovals(): Promise<{ approvals: InboxItem[]; closed: InboxItem[] }> {
	return api<{ approvals: InboxItem[]; closed: InboxItem[] }>("/api/approvals");
}

export async function approveApproval(id: string, intentHash: string): Promise<{ approval: Approval; execution: ApprovalExecution }> {
	return api(`/api/approvals/${id}/approve`, { method: "POST", body: JSON.stringify({ intentHash }) });
}

export async function rejectApproval(id: string): Promise<Approval> {
	return (await api<{ approval: Approval }>(`/api/approvals/${id}/reject`, { method: "POST", body: "{}" })).approval;
}

// 改评论正文（切片二）：approved 状态下改文会作废原批准（返回的 approval 回到 open）
export async function editApprovalBody(id: string, body: string): Promise<Approval> {
	return (await api<{ approval: Approval }>(`/api/approvals/${id}/edit`, { method: "POST", body: JSON.stringify({ body }) })).approval;
}

// 对话工具待批（P2-4）：批准只触发循环放行、接口不等待执行完，结果回流到
// 对话与收件箱状态；改正文只发 body，锁定字段由服务端校验（改了回 400）
export async function approveToolApproval(id: string): Promise<ToolApprovalItem> {
	return (await api<{ approval: ToolApprovalItem }>(`/api/approvals/${id}/approve`, { method: "POST", body: "{}" })).approval;
}

export async function rejectToolApproval(id: string): Promise<ToolApprovalItem> {
	return (await api<{ approval: ToolApprovalItem }>(`/api/approvals/${id}/reject`, { method: "POST", body: "{}" })).approval;
}

export async function editToolApprovalBody(id: string, body: string): Promise<ToolApprovalItem> {
	return (await api<{ approval: ToolApprovalItem }>(`/api/approvals/${id}/edit`, { method: "POST", body: JSON.stringify({ body }) })).approval;
}

// 该 bot 是否有活动 run（#36 审计 MINOR）：含停在待批与已批准在途执行；
// 对话窗格在 SSE 收尾后据此保留中止入口
export async function getRunState(botId: string): Promise<{ active: boolean }> {
	return api<{ active: boolean }>(`/api/chats/${botId}/run-state`);
}

// 中止当前 run（P2-4）：无活动 run 时 aborted 为 false；停在待批上的记录
// 会随之中止（cancelledToolApprovals 带回被取消的记录 id）
export async function abortChat(botId: string): Promise<{ aborted: boolean; sessionId?: string; cancelledToolApprovals?: string[] }> {
	return api(`/api/chats/${botId}/abort`, { method: "POST", body: "{}" });
}

// 即席开单（切片二）：对指定 PR 即时取证开事项；已有同键事项时 existing=true
export async function createAdHocApproval(repo: string, prNumber: number): Promise<{ approval: Approval; existing?: boolean }> {
	return api<{ approval: Approval; existing?: boolean }>("/api/findings/ad-hoc", {
		method: "POST",
		body: JSON.stringify({ repo, prNumber }),
	});
}

export function getMemory(botId: string): Promise<{ botId: string; markdown: string; aboutMe: string }> {
	return api(`/api/memory/${botId}`);
}

export function getModelProviders(): Promise<{ providers: ModelProvider[] }> {
	return api("/api/model-providers");
}

export function getModelSettings(): Promise<ModelSettings> {
	return api("/api/settings/model");
}

export function saveModelSettings(input: ModelSettingsInput): Promise<ModelSettings> {
	return api("/api/settings/model", { method: "PUT", body: JSON.stringify(input) });
}

// 思考挡位单独保存（PUT /api/settings/model 的部分更新）：后端热生效，下一轮对话用新挡位
export function updateThinkingLevel(level: string): Promise<ModelSettings> {
	return saveModelSettings({ thinkingLevel: level });
}

export function testModelSettings(input: ModelSettingsInput): Promise<{ ok: boolean; error?: string }> {
	return api("/api/settings/model/test", { method: "POST", body: JSON.stringify(input) });
}

// 从端点拉取模型名单：apiKey 缺省时服务端只许端点与已保存配置一致时复用已保存 Key。
export function fetchModelList(input: { baseUrl: string; apiKey?: string }): Promise<{ ok: boolean; models?: string[]; status?: number; error?: string }> {
	return api("/api/settings/model/fetch-models", { method: "POST", body: JSON.stringify(input) });
}

export function getProfileSettings(): Promise<ProfileSettings> {
	return api("/api/settings/profile");
}

export function saveProfileSettings(input: Partial<ProfileSettings>): Promise<ProfileSettings> {
	return api("/api/settings/profile", { method: "PUT", body: JSON.stringify(input) });
}

export async function getAboutMe(): Promise<string> {
	return (await api<{ markdown: string }>("/api/about-me")).markdown;
}

export async function saveAboutMe(markdown: string): Promise<string> {
	return (await api<{ markdown: string }>("/api/about-me", { method: "PUT", body: JSON.stringify({ markdown }) })).markdown;
}

export async function getConnectors(): Promise<Connector[]> {
	return (await api<{ connectors: Connector[] }>("/api/settings/connectors")).connectors;
}

export async function saveGithubToken(token: string): Promise<Connector> {
	return (await api<{ connector: Connector }>("/api/settings/connectors/github", { method: "PUT", body: JSON.stringify({ token }) })).connector;
}

// 令牌自检（切片三）：只读验证身份并对全部绑定仓库对账（可达/可写）
export async function checkGithubToken(): Promise<GithubSelfCheck> {
	return (await api<{ check: GithubSelfCheck }>("/api/settings/connectors/github/check", { method: "POST", body: "{}" })).check;
}

export async function saveWebSettings(patch: { fetchEnabled?: boolean; searchEndpoint?: string; searchApiKey?: string }): Promise<Connector> {
	return (await api<{ connector: Connector }>("/api/settings/connectors/web", { method: "PUT", body: JSON.stringify(patch) })).connector;
}

export function getNotifications(): Promise<{ notifications: NotificationEntry[]; unread: number }> {
	return api("/api/notifications");
}

export function markNotificationsRead(ids?: string[]): Promise<{ notifications: NotificationEntry[]; unread: number }> {
	return api("/api/notifications/read", { method: "POST", body: JSON.stringify(ids ? { ids } : {}) });
}

// POST /api/chat 的 SSE 流：逐事件回调；事件形状保持后端契约（session/delta/tool/system/draft/error/done）
export async function streamChat(botId: string, message: string, onEvent: (e: ChatEvent) => void): Promise<void> {
	const res = await fetch("/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ botId, message }),
	});
	if (res.status === 401) throw new UnauthorizedError();
	if (!res.ok || !res.body) {
		const data = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(data.error || `HTTP ${res.status}`);
	}
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		let idx = buf.indexOf("\n\n");
		while (idx >= 0) {
			const chunk = buf.slice(0, idx);
			buf = buf.slice(idx + 2);
			const event = /event: (.*)/.exec(chunk)?.[1];
			const raw = /data: (.*)/s.exec(chunk)?.[1];
			if (event && raw) onEvent({ event, data: JSON.parse(raw) } as ChatEvent);
			idx = buf.indexOf("\n\n");
		}
	}
}
