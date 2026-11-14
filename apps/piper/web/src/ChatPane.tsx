// 中栏 Chat：assistant-ui 为组件底。后端 SSE 契约不变，前端用 useExternalStoreRuntime 自持消息，
// convertMessage 把自有 part 模型映射为 ThreadMessageLike：tool 事件走 tool-call part（AI Elements Tool 渲染），
// draft/system/error 走 data-* part（by_name 分发到对应卡片）。
// 视觉按 assistant-ui 官方 registry thread 的实现方式：消息列居中定宽、用户气泡、
// 助手整幅无气泡、Composer 为悬浮圆角卡片（输入区 + 底部工具行）。
// 对话区收尾（feat/ui-chat-polish）：轮次节奏为轮内紧、轮间松（用户 pt-4 /
// 助手 pb-4），消息列与 Composer 列同宽同内边距对齐（Viewport 不再另加 px）。
// 空状态为垂直居中构图（问候标题 + 建议 prompt chips）；消息 hover 时下方浮现
// 复制钮（复制/反馈交给 ActionBarPrimitive.Copy），错误卡的重试经
// ChatActionsContext 注入 onRetryLastUser，也走 sendMessage 追加一轮。
import {
	ActionBarPrimitive,
	AssistantRuntimeProvider,
	ComposerPrimitive,
	MessagePrimitive,
	ThreadPrimitive,
	useAuiState,
	useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { AppendMessage, ThreadMessageLike } from "@assistant-ui/react";
import { ArrowUpIcon, CheckIcon, CopyIcon, Loader2Icon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { abortChat, approveToolApproval, confirmDraft, getRunState, listApprovals, listMessages, rejectToolApproval, streamChat, UnauthorizedError } from "./api";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Bot, ChatMessage, ChatPart, ToolApprovalItem } from "./model";
import { historyToMessages, nextId } from "./model";
import type { ChatActions, DraftActions, ToolApprovalActions } from "./parts";
import {
	ChatActionsContext,
	DraftActionsContext,
	DraftCard,
	ErrorCard,
	MarkdownText,
	PlainText,
	ReasoningCard,
	SystemCard,
	ToolApprovalActionsContext,
	ToolCard,
} from "./parts";
import { ThinkingLevelChip } from "./ThinkingLevelChip";

type LikePart = Exclude<ThreadMessageLike["content"], string>[number];

function partToLike(part: ChatPart): LikePart {
	switch (part.type) {
		case "text":
			return { type: "text", text: part.text };
		case "reasoning":
			return {
				type: "data-reasoning",
				data: { text: part.text, truncated: part.truncated ?? false, level: part.level, durationMs: part.durationMs, startedAt: part.startedAt },
			};
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

// 消息 hover 操作行的复制钮（放在消息 Root 内才能读到该消息的 scope）：
// 复制文本与「已复制」反馈由 ActionBarPrimitive.Copy 托管（默认
// navigator.clipboard，isCopied 短暂为真），这里只管图标切换与样式。
function CopyMessageButton() {
	const copied = useAuiState((s) => s.message.isCopied);
	return (
		<ActionBarPrimitive.Copy
			aria-label="复制"
			className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "size-7 text-muted-foreground hover:text-foreground")}
		>
			{copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
		</ActionBarPrimitive.Copy>
	);
}

// hover 操作行：默认 opacity-0 且 pointer-events-none（不占布局、触屏不挡正文
// 选择），group-hover / group-focus-within 时浮现并恢复可点，键盘 Tab 聚焦即可达。
function MessageActions({ className }: { className: string }) {
	return (
		<div
			className={cn(
				"pointer-events-none absolute flex h-7 translate-y-2 opacity-0 transition-opacity duration-150 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100",
				className,
			)}
		>
			<CopyMessageButton />
		</div>
	);
}

function UserMessage() {
	return (
		<MessagePrimitive.Root className="group relative animate-in fade-in slide-in-from-bottom-1 mx-auto flex w-full max-w-3xl justify-end px-2 pt-4 pb-1.5 duration-150">
			<div className="max-w-[85%] rounded-2xl bg-secondary px-4 py-2.5 text-sm leading-relaxed break-words text-secondary-foreground">
				<MessagePrimitive.Parts components={{ Text: PlainText }} />
			</div>
			<MessageActions className="top-1/2 right-full mr-1 -translate-y-1/2" />
		</MessagePrimitive.Root>
	);
}

function AssistantMessage() {
	return (
		<MessagePrimitive.Root className="group relative animate-in fade-in mx-auto w-full max-w-3xl px-2 pt-1.5 pb-4 duration-150">
			<div className="flex flex-col gap-3 leading-relaxed break-words">
				<MessagePrimitive.Parts
					components={{
						Text: MarkdownText,
						Empty: TypingDots,
						tools: { Fallback: ToolCard },
						data: { by_name: { draft: DraftCard, reasoning: ReasoningCard, system: SystemCard, error: ErrorCard } },
					}}
				/>
			</div>
			<MessageActions className="left-2" />
		</MessagePrimitive.Root>
	);
}

// 空状态建议 prompt（构图密度参考 chat-demo Welcome）：点击即按 sendMessage
// 开一轮；建 bot 一句与 composer placeholder 的引导呼应。
const SUGGESTIONS = ["介绍一下你自己", "创建一个代码审查 bot，负责审查 PR 的代码质量"];

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
	// SSE 收尾后 run 仍可能停在待批或在途执行（#36 审计 MINOR）：轮询
	// run-state 保留状态行与中止入口；run 落定后重拉一次历史让工具卡更新。
	const [serverRunActive, setServerRunActive] = useState(false);
	const serverRunActiveRef = useRef(false);
	const messagesRef = useRef<ChatMessage[]>([]);

	useEffect(() => {
		if (!running) return;
		setTickNow(Date.now());
		const t = setInterval(() => setTickNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [running]);

	// 待批轮询（#36 审计 MINOR + 复审留项）：本端不在 running（SSE 已按
	// 契约收尾）但服务端 run 可能还活着时——对话里有待批准工具卡、或挂
	// 载时探到活动 run——每 3 秒问一次 run-state；run 落定（active 由真
	// 变假）后重拉历史，工具卡从待批准切到终态。轮询同时查待批记录
	// 状态：历史仍是 pending 时，已批准在途与真待批要分开报（复审留项：
	// 状态行不能把正在执行说成等待批准）；没有待批卡但 run 仍活跃
	// （例如批准后续跑还在生成）时同样保留状态行与中止入口。
	const pendingToolPart = messages
		.flatMap((m) => m.parts)
		.filter((p): p is Extract<ChatPart, { type: "tool" }> => p.type === "tool" && p.phase === "pending")
		.at(-1);
	const hasPendingTool = pendingToolPart !== undefined;
	const [watchRun, setWatchRun] = useState(false);
	const [pendingRecordStatus, setPendingRecordStatus] = useState<string | null>(null);
	// 待批卡内批准（P2-9 试用后修复）：按 toolCallId 索引的待批记录与
	// 可操作集合，供 ToolCard 经 context 渲染批准 / 驳回按钮；数据与
	// 收件箱同源（listApprovals），轮询与动作后刷新。
	const approvalByCallRef = useRef(new Map<string, ToolApprovalItem>());
	const pendingToolCallIdRef = useRef<string | null>(null);
	pendingToolCallIdRef.current = pendingToolPart?.id ?? null;
	const [actionableIds, setActionableIds] = useState<ReadonlySet<string>>(new Set());
	const [busyApprovalIds, setBusyApprovalIds] = useState<ReadonlySet<string>>(new Set());
	const refreshApprovals = () => {
		listApprovals()
			.then(({ approvals, closed }) => {
				const map = new Map<string, ToolApprovalItem>();
				const pending = new Set<string>();
				for (const a of [...approvals, ...closed]) {
					if (a.kind !== "tool_call" || !a.toolCallId) continue;
					map.set(a.toolCallId, a);
					if (a.status === "pending") pending.add(a.toolCallId);
				}
				approvalByCallRef.current = map;
				setActionableIds(pending);
				const cur = pendingToolCallIdRef.current;
				setPendingRecordStatus(cur ? (map.get(cur)?.status ?? null) : null);
			})
			.catch(() => {});
	};
	const actOnApproval = (toolCallId: string, act: (id: string) => Promise<ToolApprovalItem>) => {
		const rec = approvalByCallRef.current.get(toolCallId);
		if (!rec) return;
		setBusyApprovalIds((prev) => new Set(prev).add(toolCallId));
		act(rec.id)
			.catch(() => {})
			.finally(() => {
				setBusyApprovalIds((prev) => {
					const next = new Set(prev);
					next.delete(toolCallId);
					return next;
				});
				refreshApprovals();
			});
	};
	const toolApprovalActions: ToolApprovalActions = {
		actionableToolCallIds: actionableIds,
		busyToolCallIds: busyApprovalIds,
		onApprove: (toolCallId) => actOnApproval(toolCallId, approveToolApproval),
		onReject: (toolCallId) => actOnApproval(toolCallId, rejectToolApproval),
	};
	useEffect(() => {
		if (hasPendingTool) setWatchRun(true);
	}, [hasPendingTool]);
	// 挂载时探一次：run 活跃但历史里没有待批准卡也要进轮询（复审留项）。
	useEffect(() => {
		let cancelled = false;
		getRunState(bot.id)
			.then((r) => {
				if (!cancelled && r.active) {
					serverRunActiveRef.current = true;
					setServerRunActive(true);
					setWatchRun(true);
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [bot.id]);
	useEffect(() => {
		if (running || !watchRun) return;
		let cancelled = false;
		const check = () => {
			getRunState(bot.id)
				.then((r) => {
					if (cancelled) return;
					if (!r.active) {
						if (serverRunActiveRef.current) {
							listMessages(bot.id)
								.then((entries) => {
									if (!cancelled) setMessages(historyToMessages(entries));
								})
								.catch(() => {});
						}
						serverRunActiveRef.current = false;
						setServerRunActive(false);
						setWatchRun(false);
						return;
					}
					serverRunActiveRef.current = true;
					setServerRunActive(true);
					if (pendingToolPart) refreshApprovals();
				})
				.catch((e: unknown) => {
					if (!cancelled && e instanceof UnauthorizedError) onUnauthorized();
				});
		};
		check();
		const t = setInterval(check, 3000);
		return () => {
			cancelled = true;
			clearInterval(t);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [running, watchRun, bot.id]);

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
	// 思考段关闭时补记 durationMs（段首个增量到此刻）：ReasoningCard 据此从
	// 「思考中」切到折叠摘要；历史还原的段落盘自带 durationMs，不走这里。
	const stampLastReasoning = (parts: ChatPart[]): ChatPart[] => {
		const last = parts[parts.length - 1];
		if (last?.type === "reasoning" && last.durationMs === undefined && last.startedAt !== undefined) {
			return [...parts.slice(0, -1), { ...last, durationMs: Math.max(0, Date.now() - last.startedAt) }];
		}
		return parts;
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

	// 追加一轮对话的唯一入口：composer 的 onNew、空状态建议 chips、错误卡重试都汇到这里
	const sendMessage = async (text: string) => {
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
						patchParts(asstId, (parts0) => {
							// 正文出现即关闭当前思考段（先补记它的 durationMs）
							const parts = stampLastReasoning(parts0);
							const last = parts[parts.length - 1];
							if (last?.type === "text") {
								return [...parts.slice(0, -1), { type: "text", text: last.text + e.data.text }];
							}
							return [...parts, { type: "text", text: e.data.text }];
						});
						break;
					case "thinking": {
						// 思考增量按 seg 拼成段：同段拼进同一个 reasoning part，被
						// 工具卡/正文打断（或 seg 变化）后另起一段，按到达顺序排列。
						patchParts(asstId, (parts) => {
							const last = parts[parts.length - 1];
							const sameSeg =
								last?.type === "reasoning" && (e.data.seg === undefined || last.seg === undefined || e.data.seg === last.seg);
							if (last?.type === "reasoning" && sameSeg) {
								return [...parts.slice(0, -1), { ...last, text: last.text + e.data.text }];
							}
							return [
								...stampLastReasoning(parts),
								{ type: "reasoning", text: e.data.text, level: e.data.level, seg: e.data.seg, startedAt: Date.now() } as ChatPart,
							];
						});
						break;
					}
					case "tool": {
						// 一次调用一张卡：call/start/end 按 toolCallId 合并到同一个 part，
						// phase 推进状态，call/start 的 detail 是参数、end 的 detail 是结果摘要。
						const toolId = e.data.toolCallId ?? nextId("tool");
						patchParts(asstId, (parts) => {
							const idx = parts.findIndex((p) => p.type === "tool" && p.id === toolId);
							if (idx < 0) {
								return [
									...stampLastReasoning(parts),
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
					case "aborted":
						// 用户主动中止（P2-9 试用后修复）：不是错误——半截文本
						// 已在 parts 里，只补一条中性系统提示，与落盘的
						// run_aborted 条目同文案。
						patchParts(asstId, (parts) => [...parts, { type: "system", kind: "run_aborted", text: "本轮已由用户中止" }]);
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
			// 回合结束：仍开着的思考段补记时长；空思考段（只有空白）不留痕，
			// 流式中出现过的头部随回合结束一并消失。
			patchMessage(asstId, (m) => ({
				...m,
				running: false,
				parts: m.parts
					.map((p) =>
						p.type === "reasoning" && p.durationMs === undefined && p.startedAt !== undefined
							? { ...p, durationMs: Math.max(0, Date.now() - p.startedAt) }
							: p,
					)
					.filter((p) => p.type !== "reasoning" || p.text.trim().length > 0),
			}));
			setRunning(false);
			setRunStartedAt(null);
			onRunningChange(bot.id, false);
		}
	};

	const onNew = (append: AppendMessage) =>
		sendMessage(
			append.content
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join(""),
		);

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

	// 错误卡重试：会话 append-only，不重写历史，把最后一条 user 消息的文本作为
	// 新一轮再发一次；running 时 composer 本就不可发送，重试与之同口径。
	const chatActions: ChatActions = {
		onRetryLastUser: () => {
			if (running) return;
			const lastUserText = [...messagesRef.current]
				.reverse()
				.find((m) => m.role === "user")
				?.parts.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join("");
			if (!lastUserText?.trim()) return;
			void sendMessage(lastUserText);
		},
	};

	// 进行时状态行口径（由现有 SSE 事件与本地状态推导）：
	// 有未 end 的工具 → 正在调用该工具；已有文本在流出 → 正在生成回答；思考
	// 已经开始（有 reasoning part）→ 状态行让位给思考区头部，不再重复「正在
	// 思考…」（statusLabel 为 null 时整行不渲染）；尚无任何产出（等首字）→
	// 正在思考。
	const activeMessage = running ? messages[messages.length - 1] : undefined;
	const runningToolPart = activeMessage?.parts
		.filter((p): p is Extract<ChatPart, { type: "tool" }> => p.type === "tool" && p.phase !== "end")
		.at(-1);
	const statusLabel: string | null = runningToolPart
		? runningToolPart.phase === "pending"
			? `等待批准：${runningToolPart.name}`
			: `正在调用 ${runningToolPart.name}…`
		: activeMessage?.parts.some((p) => p.type === "text" && p.text.length > 0)
			? "正在生成回答…"
			: activeMessage?.parts.some((p) => p.type === "reasoning")
				? null
				: "正在思考…";

	// 中止（P2-4）：调服务端中止接口，run 自己收尾（待批转取消、未开始的
	// 调用不再执行）；本端不直接改消息状态，收尾事件仍走 SSE 回来。
	const onAbort = () => {
		void abortChat(bot.id).catch((e: unknown) => {
			if (e instanceof UnauthorizedError) onUnauthorized();
		});
	};
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
				<ToolApprovalActionsContext.Provider value={toolApprovalActions}>
					<ChatActionsContext.Provider value={chatActions}>
						<ThreadPrimitive.Root className="flex h-full flex-col">
							<ThreadPrimitive.Viewport className="flex flex-1 flex-col overflow-y-auto scroll-smooth px-0 pt-6">
								<ThreadPrimitive.Empty>
									<div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-5 px-2 py-12 text-center">
										<h2 className="text-2xl font-semibold tracking-tight">你好，我是「{bot.name}」</h2>
										<div className="flex flex-wrap items-center justify-center gap-2">
											{SUGGESTIONS.map((text) => (
												<button
													key={text}
													type="button"
													onClick={() => sendMessage(text)}
													className="rounded-full border bg-card px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
												>
													{text}
												</button>
											))}
										</div>
									</div>
								</ThreadPrimitive.Empty>
								<ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
							</ThreadPrimitive.Viewport>
							{running && runStartedAt !== null && statusLabel !== null ? (
								<div className="mx-auto w-full max-w-3xl px-2 pt-2" aria-live="polite">
									<div className="flex items-center gap-2 text-xs text-muted-foreground/80">
										<Loader2Icon className="size-3.5 animate-spin" />
										<span>{statusLabel}</span>
										<span className="tabular-nums">· 已用 {elapsedSec} 秒</span>
									</div>
								</div>
							) : null}
							{!running && serverRunActive ? (
								<div className="mx-auto w-full max-w-3xl px-2 pt-2" aria-live="polite">
									<div className="flex items-center gap-2 text-xs text-muted-foreground/80">
										<Loader2Icon className="size-3.5 animate-spin" />
										<span>
											{pendingToolPart
												? pendingRecordStatus === "approved"
													? `已批准，正在执行：${pendingToolPart.name}…`
													: `等待批准：${pendingToolPart.name}（可在工具卡上批准 / 驳回，或到待批收件箱处理）`
												: "正在后台运行…（可在下方中止本轮）"}
										</span>
									</div>
								</div>
							) : null}
							<div className="mx-auto w-full max-w-3xl px-2 pt-2 pb-4">
								{/* 注意：ComposerPrimitive.Root 不得传 onSubmit——assistant-ui
									用 composeEventHandlers 组合提交处理，外层 handler 一旦
									preventDefault，其内部 send 就被跳过；Enter 发送正是走
									form requestSubmit 这条路（发送按钮走 click 直达不受
									影响），曾因此出现「Enter 无效、只能点发送」（P2-9
									试用后修复）。其内部 handler 自己会 preventDefault，
									页面不会重载。 */}
								<ComposerPrimitive.Root className="flex w-full flex-col rounded-2xl border bg-card shadow-md transition-[border-color,box-shadow] duration-150 focus-within:border-ring/60 focus-within:shadow-lg focus-within:ring-2 focus-within:ring-ring/30">
									<ComposerPrimitive.Input
										className="max-h-40 min-h-10 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm outline-none placeholder:text-muted-foreground"
										placeholder="输入消息；对主 bot 说「创建一个 XX bot，负责……」可生成草案卡"
										submitOnEnter
									/>
									<div className="flex items-center justify-between gap-2 px-3 pb-2.5">
										{/* 左簇：思考挡位 chip 在前，运行提示 / 中止钮随后（chip 常驻，提示窄屏隐藏） */}
										<div className="flex min-w-0 items-center gap-2">
											<ThinkingLevelChip onUnauthorized={onUnauthorized} />
											{running || serverRunActive ? (
												<button
													type="button"
													onClick={onAbort}
													className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
												>
													<SquareIcon className="size-3.5" />
													中止本轮
												</button>
											) : (
												<span className="hidden text-xs text-muted-foreground sm:block">Enter 发送 · Shift+Enter 换行</span>
											)}
										</div>
										<ComposerPrimitive.Send aria-label="发送" className={cn(buttonVariants({ size: "icon-sm" }), "ml-auto rounded-full")}>
											<ArrowUpIcon className="size-4" />
										</ComposerPrimitive.Send>
									</div>
								</ComposerPrimitive.Root>
							</div>
						</ThreadPrimitive.Root>
					</ChatActionsContext.Provider>
				</ToolApprovalActionsContext.Provider>
			</DraftActionsContext.Provider>
		</AssistantRuntimeProvider>
	);
}
