// 中栏 Chat：assistant-ui 为组件底。后端 SSE 契约不变，前端用 useExternalStoreRuntime 自持消息，
// convertMessage 把自有 part 模型映射为 ThreadMessageLike：tool 事件走 tool-call part（ToolCard 渲染），
// draft/system/error 走 data-* part（by_name 分发到对应卡片）。
import {
	AssistantRuntimeProvider,
	ComposerPrimitive,
	MessagePrimitive,
	ThreadPrimitive,
	useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { AppendMessage, ThreadMessageLike } from "@assistant-ui/react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { confirmDraft, listMessages, streamChat, UnauthorizedError } from "./api";
import type { Bot, ChatMessage, ChatPart } from "./model";
import { historyToMessages, nextId } from "./model";
import type { DraftActions } from "./parts";
import { DraftActionsContext, DraftCard, ErrorCard, MarkdownText, PlainText, SystemCard, ToolCard } from "./parts";

type LikePart = Exclude<ThreadMessageLike["content"], string>[number];

function partToLike(part: ChatPart): LikePart {
	switch (part.type) {
		case "text":
			return { type: "text", text: part.text };
		case "tool":
			return {
				type: "tool-call",
				toolCallId: part.id,
				toolName: part.name,
				args: { phase: part.phase, detail: part.detail },
			};
		case "draft":
			return {
				type: "data-draft",
				data: { partId: part.partId, draft: part.draft, readOnly: part.readOnly, confirmedBotName: part.confirmedBotName },
			};
		case "system":
			return { type: "data-system", data: { kind: part.kind, text: part.text } };
		case "error":
			return { type: "data-error", data: { code: part.code, message: part.message } };
	}
}

function convertMessage(m: ChatMessage): ThreadMessageLike {
	return {
		id: m.id,
		role: m.role,
		status: m.role === "assistant" ? (m.running ? { type: "running" } : { type: "complete", reason: "stop" }) : undefined,
		content: m.parts.map(partToLike),
	};
}

function TypingDots() {
	return (
		<span className="typing" aria-label="正在生成">
			<i />
			<i />
			<i />
		</span>
	);
}

function UserMessage() {
	return (
		<MessagePrimitive.Root className="msg msg-user">
			<MessagePrimitive.Parts components={{ Text: PlainText }} />
		</MessagePrimitive.Root>
	);
}

function AssistantMessage() {
	return (
		<MessagePrimitive.Root className="msg msg-assistant">
			<MessagePrimitive.Parts
				components={{
					Text: MarkdownText,
					Empty: TypingDots,
					tools: { Fallback: ToolCard },
					data: { by_name: { draft: DraftCard, system: SystemCard, error: ErrorCard } },
				}}
			/>
		</MessagePrimitive.Root>
	);
}

export type ChatPaneProps = {
	bot: Bot;
	onRunningChange: (botId: string, running: boolean) => void;
	onDraftConfirmed: (bot: Bot) => void;
	onUnauthorized: () => void;
};

export function ChatPane({ bot, onRunningChange, onDraftConfirmed, onUnauthorized }: ChatPaneProps) {
	const [messages, setMessagesState] = useState<ChatMessage[]>([]);
	const [loading, setLoading] = useState(true);
	const [running, setRunning] = useState(false);
	const messagesRef = useRef<ChatMessage[]>([]);

	const setMessages = (next: readonly ChatMessage[]) => {
		messagesRef.current = [...next];
		setMessagesState(messagesRef.current);
	};
	const patchMessage = (id: string, fn: (m: ChatMessage) => ChatMessage) => {
		setMessages(messagesRef.current.map((m) => (m.id === id ? fn(m) : m)));
	};
	const patchParts = (id: string, fn: (parts: ChatPart[]) => ChatPart[]) => {
		patchMessage(id, (m) => ({ ...m, parts: fn(m.parts) }));
	};
	const patchDraftPart = (partId: string, fn: (part: Extract<ChatPart, { type: "draft" }>) => ChatPart) => {
		setMessages(
			messagesRef.current.map((m) => ({
				...m,
				parts: m.parts.map((p) => (p.type === "draft" && p.partId === partId ? fn(p) : p)),
			})),
		);
	};

	useEffect(() => {
		let cancelled = false;
		listMessages(bot.id)
			.then((entries) => {
				if (!cancelled) {
					setMessages(historyToMessages(entries));
					setLoading(false);
				}
			})
			.catch((e: unknown) => {
				if (cancelled) return;
				if (e instanceof UnauthorizedError) onUnauthorized();
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
		// 每个 bot 的 ChatPane 由父级以 key={bot.id} 独立挂载，挂载时加载一次历史
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [bot.id]);

	const onNew = async (append: AppendMessage) => {
		const text = append.content
			.filter((p) => p.type === "text")
			.map((p) => p.text)
			.join("");
		if (!text.trim()) return;
		const asstId = nextId("m");
		setMessages([
			...messagesRef.current,
			{ id: nextId("m"), role: "user", parts: [{ type: "text", text }], running: false },
			{ id: asstId, role: "assistant", parts: [], running: true },
		]);
		setRunning(true);
		onRunningChange(bot.id, true);
		try {
			await streamChat(bot.id, text, (e) => {
				switch (e.event) {
					case "delta":
						patchParts(asstId, (parts) => {
							const last = parts[parts.length - 1];
							if (last?.type === "text") {
								return [...parts.slice(0, -1), { type: "text", text: last.text + e.data.text }];
							}
							return [...parts, { type: "text", text: e.data.text }];
						});
						break;
					case "tool":
						patchParts(asstId, (parts) => [
							...parts,
							{ type: "tool", id: nextId("tool"), name: e.data.name, phase: e.data.phase, detail: e.data.detail },
						]);
						break;
					case "system":
						patchParts(asstId, (parts) => [...parts, { type: "system", kind: e.data.kind, text: e.data.text }]);
						break;
					case "draft":
						patchParts(asstId, (parts) => [
							...parts,
							{ type: "draft", partId: nextId("draft"), draft: e.data.draft, readOnly: false },
						]);
						break;
					case "error":
						patchParts(asstId, (parts) => [...parts, { type: "error", code: e.data.code, message: e.data.message }]);
						break;
					default:
						break;
				}
			});
		} catch (err) {
			if (err instanceof UnauthorizedError) {
				onUnauthorized();
			} else {
				patchParts(asstId, (parts) => [
					...parts,
					{ type: "error", code: "ERROR", message: err instanceof Error ? err.message : String(err) },
				]);
			}
		} finally {
			patchMessage(asstId, (m) => ({ ...m, running: false }));
			setRunning(false);
			onRunningChange(bot.id, false);
		}
	};

	const draftActions: DraftActions = {
		onConfirm: async (partId, draft) => {
			const created = await confirmDraft(draft);
			patchDraftPart(partId, (p) => ({ ...p, confirmedBotName: created.name }));
			onDraftConfirmed(created);
		},
		onDiscard: (partId) => {
			patchDraftPart(partId, () => ({ type: "system", kind: "draft", text: "已放弃该 Bot 草案卡。" }));
		},
	};

	const runtime = useExternalStoreRuntime<ChatMessage>({
		messages,
		setMessages,
		onNew,
		convertMessage,
		isRunning: running,
	});

	if (loading) return <div className="chat-loading">加载会话…</div>;

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<DraftActionsContext.Provider value={draftActions}>
				<ThreadPrimitive.Root className="thread">
					<ThreadPrimitive.Viewport className="thread-viewport">
						<ThreadPrimitive.Empty>
							<p className="thread-empty">暂无消息，和「{bot.name}」打个招呼吧。</p>
						</ThreadPrimitive.Empty>
						<ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
					</ThreadPrimitive.Viewport>
					<ComposerPrimitive.Root
						className="composer"
						onSubmit={(e: FormEvent) => e.preventDefault()}
					>
						<ComposerPrimitive.Input
							className="composer-input"
							placeholder="输入消息；对主 bot 说「创建一个 XX bot，负责……」可生成草案卡"
							submitOnEnter
						/>
						<ComposerPrimitive.Send className="primary send-btn">发送</ComposerPrimitive.Send>
					</ComposerPrimitive.Root>
				</ThreadPrimitive.Root>
			</DraftActionsContext.Provider>
		</AssistantRuntimeProvider>
	);
}
