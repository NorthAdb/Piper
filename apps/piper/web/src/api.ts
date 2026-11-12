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
	HistoryEntry,
	ModelProvider,
	ModelSettings,
	NotificationEntry,
	ModelSettingsInput,
	ProfileSettings,
	Routine,
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

export async function listApprovals(): Promise<{ approvals: Approval[]; closed: Approval[] }> {
	return api<{ approvals: Approval[]; closed: Approval[] }>("/api/approvals");
}

export async function approveApproval(id: string, intentHash: string): Promise<{ approval: Approval; execution: ApprovalExecution }> {
	return api(`/api/approvals/${id}/approve`, { method: "POST", body: JSON.stringify({ intentHash }) });
}

export async function rejectApproval(id: string): Promise<Approval> {
	return (await api<{ approval: Approval }>(`/api/approvals/${id}/reject`, { method: "POST", body: "{}" })).approval;
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
