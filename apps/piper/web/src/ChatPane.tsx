// 中栏 Chat：assistant-ui 为组件底。后端 SSE 契约不变，前端用 useExternalStoreRuntime 自持消息，
// convertMessage 把自有 part 模型映射为 ThreadMessageLike：tool 事件走 tool-call part（AI Elements Tool 渲染），
// draft/system/error 走 data-* part（by_name 分发到对应卡片）。
// 视觉按 assistant-ui 官方 registry thread 的实现方式：消息列居中定宽、用户气泡、
// 助手整幅无气泡、Composer 为悬浮圆角卡片（输入区 + 底部工具行）。
import {
	AssistantRuntimeProvider,
	ComposerPrimitive,
	MessagePrimitive,
	ThreadPrimitive,
	useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { AppendMessage, ThreadMessageLike } from "@assistant-ui/react";
import { ArrowUpIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { confirmDraft, listMessages, streamChat, UnauthorizedError } from "./api";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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
				args: { phase: part.phase, args: part.args, result: part.result },
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
		<MessagePrimitive.Root className="animate-in fade-in slide-in-from-bottom-1 mx-auto flex w-full max-w-3xl justify-end px-2 py-1.5 duration-150">
			<div className="max-w-[85%] rounded-3xl bg-secondary px-4 py-2.5 break-words text-secondary-foreground">
				<MessagePrimitive.Parts components={{ Text: PlainText }} />
			</div>
		</MessagePrimitive.Root>
	);
}

function AssistantMessage() {
	return (
		<MessagePrimitive.Root className="animate-in fade-in mx-auto w-full max-w-3xl px-2 py-1.5 duration-150">
			<div className="flex flex-col gap-3 leading-relaxed break-words">
				<MessagePrimitive.Parts
					components={{
						Text: MarkdownText,
						Empty: TypingDots,
						tools: { Fallback: ToolCard },
						data: { by_name: { draft: DraftCard, system: SystemCard, error: ErrorCard } },
					}}
				/>
			</div>
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
	// 进行时状态行用：本轮起点 + 每秒 tick（仅 running 期间挂定时器）
	const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
	const [tickNow, setTickNow] = useState(() => Date.now());
	const messagesRef = useRef<ChatMessage[]>([]);

	useEffect(() => {
		if (!running) return;
		setTickNow(Date.now());
		const t = setInterval(() => setTickNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [running]);

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
		setRunStartedAt(Date.now());
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
					case "tool": {
						// 一次调用一张卡：call/start/end 按 toolCallId 合并到同一个 part，
						// phase 推进状态，call/start 的 detail 是参数、end 的 detail 是结果摘要。
						const toolId = e.data.toolCallId ?? nextId("tool");
						patchParts(asstId, (parts) => {
							const idx = parts.findIndex((p) => p.type === "tool" && p.id === toolId);
							if (idx < 0) {
								return [
									...parts,
									{
										type: "tool",
										id: toolId,
										name: e.data.name,
										phase: e.data.phase,
										args: e.data.phase === "end" ? null : e.data.detail,
										result: e.data.phase === "end" ? e.data.detail : null,
									} as ChatPart,
								];
							}
							const prev = parts[idx] as Extract<ChatPart, { type: "tool" }>;
							const merged: ChatPart = {
								...prev,
								phase: e.data.phase,
								args: e.data.phase === "end" ? prev.args : (e.data.detail ?? prev.args),
								result: e.data.phase === "end" ? e.data.detail : prev.result,
							};
							const next = [...parts];
							next[idx] = merged;
							return next;
						});
						break;
					}
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
			setRunStartedAt(null);
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

	// 进行时状态行口径（由现有 SSE 事件与本地状态推导，不新增事件类型）：
	// 有未 end 的工具 → 正在调用该工具；已有文本在流出 → 正在生成回答；其余 → 正在思考。
	const activeMessage = running ? messages[messages.length - 1] : undefined;
	const runningToolPart = activeMessage?.parts
		.filter((p): p is Extract<ChatPart, { type: "tool" }> => p.type === "tool" && p.phase !== "end")
		.at(-1);
	const statusLabel = runningToolPart
		? `正在调用 ${runningToolPart.name}…`
		: activeMessage?.parts.some((p) => p.type === "text" && p.text.length > 0)
			? "正在生成回答…"
			: "正在思考…";
	const elapsedSec = runStartedAt ? Math.max(0, Math.floor((tickNow - runStartedAt) / 1000)) : 0;

	const runtime = useExternalStoreRuntime<ChatMessage>({
		messages,
		setMessages,
		onNew,
		convertMessage,
		isRunning: running,
	});

	if (loading) {
		return (
			<div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
				<Loader2Icon className="size-4 animate-spin" />
				加载会话…
			</div>
		);
	}

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<DraftActionsContext.Provider value={draftActions}>
				<ThreadPrimitive.Root className="flex h-full flex-col">
					<ThreadPrimitive.Viewport className="flex flex-1 flex-col overflow-y-auto scroll-smooth px-3 pt-6">
						<ThreadPrimitive.Empty>
							<div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-3 px-2 py-16 text-center">
								<span className="flex size-11 items-center justify-center rounded-full border bg-card">
									<SparklesIcon className="size-5 text-primary" />
								</span>
								<p className="text-sm text-muted-foreground">暂无消息，和「{bot.name}」打个招呼吧。</p>
							</div>
						</ThreadPrimitive.Empty>
						<ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
					</ThreadPrimitive.Viewport>
					{running && runStartedAt !== null ? (
						<div className="mx-auto w-full max-w-3xl px-2 pt-2" aria-live="polite">
							<div className="flex items-center gap-2 text-xs text-muted-foreground">
								<Loader2Icon className="size-3.5 animate-spin" />
								<span>{statusLabel}</span>
								<span>· 已用 {elapsedSec} 秒</span>
							</div>
						</div>
					) : null}
					<div className="mx-auto w-full max-w-3xl px-2 pt-2 pb-4">
						<ComposerPrimitive.Root
							className="flex w-full flex-col rounded-2xl border bg-card shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-ring/40"
							onSubmit={(e: FormEvent) => e.preventDefault()}
						>
							<ComposerPrimitive.Input
								className="max-h-40 min-h-10 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm outline-none placeholder:text-muted-foreground"
								placeholder="输入消息；对主 bot 说「创建一个 XX bot，负责……」可生成草案卡"
								submitOnEnter
							/>
							<div className="flex items-center justify-between gap-2 px-3 pb-2.5">
								<span className="hidden text-xs text-muted-foreground sm:block">Enter 发送 · Shift+Enter 换行</span>
								<ComposerPrimitive.Send className={cn(buttonVariants({ size: "sm" }), "ml-auto rounded-full pr-3 pl-3.5")}>
									发送
									<ArrowUpIcon className="size-4" />
								</ComposerPrimitive.Send>
							</div>
						</ComposerPrimitive.Root>
					</div>
				</ThreadPrimitive.Root>
			</DraftActionsContext.Provider>
		</AssistantRuntimeProvider>
	);
}
