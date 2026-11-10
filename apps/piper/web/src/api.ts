// Piper 后端 API 客户端：cookie 会话（与 server.mjs 一致），401 时抛 UnauthorizedError 交给界面回登录页。
import type { Artifact, ArtifactMeta, Bot, BotDraft, ChatEvent, HistoryEntry, ModelSettings, ModelSettingsInput, Routine } from "./model";

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

export async function listRoutines(): Promise<Routine[]> {
	return (await api<{ routines: Routine[] }>("/api/routines")).routines;
}

export async function runMorningScan(): Promise<void> {
	await api("/api/routines/morning-scan/run", { method: "POST", body: "{}" });
}

export async function listArtifacts(): Promise<ArtifactMeta[]> {
	return (await api<{ artifacts: ArtifactMeta[] }>("/api/artifacts")).artifacts;
}

export async function getArtifact(id: string): Promise<Artifact> {
	return (await api<{ artifact: Artifact }>(`/api/artifacts/${id}`)).artifact;
}

export async function listApprovals(): Promise<unknown[]> {
	return (await api<{ approvals: unknown[] }>("/api/approvals")).approvals;
}

export function getMemory(botId: string): Promise<{ botId: string; markdown: string; aboutMe: string }> {
	return api(`/api/memory/${botId}`);
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
