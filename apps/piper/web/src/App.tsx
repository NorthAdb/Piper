// Piper 前端入口：单口令登录门 + 三栏布局（左 bot 列表 / 中 Chat / 右 bot 桌面）。
// 视觉走设计系统：深色主题、sidebar 侧栏面、中栏顶部会话标题栏（bot 名 + 模型状态徽标）。
import { BotIcon, Loader2Icon, LogInIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { getSession, listBots, login } from "./api";
import { BotForm } from "./BotForm";
import { BotList } from "./BotList";
import { ChatPane } from "./ChatPane";
import { Desktop } from "./Desktop";
import { Inbox } from "./Inbox";
import { Settings } from "./Settings";
import { TraceView } from "./TraceView";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useColumnWidths } from "./column-widths";
import type { Bot } from "./model";

type FormState = { open: boolean; bot: Bot | null };

export function App() {
	const [authed, setAuthed] = useState<boolean | null>(null);
	const [modelConfigured, setModelConfigured] = useState(false);
	const [bots, setBots] = useState<Bot[]>([]);
	const [currentBotId, setCurrentBotId] = useState<string | null>(null);
	const [busyBotIds, setBusyBotIds] = useState<ReadonlySet<string>>(new Set());
	const [form, setForm] = useState<FormState>({ open: false, bot: null });
	const [view, setView] = useState<"main" | "settings" | "inbox">("main");
	// 左右栏拖拽调宽（窄窗口自动保住中栏）
	const columns = useColumnWidths();
	// 通知「查看事项」直达：目标 Finding id，收件箱据此滚动定位并高亮（命中已关闭项时展开历史区）
	const [inboxFocusId, setInboxFocusId] = useState<string | null>(null);
	// 中栏视图（对话 / 轨迹，PR-E）：轨迹窗格首次打开后保持挂载，两个窗格靠
	// visibility 叠放切换——ChatPane 不卸载，滚动位置与输入草稿不丢。
	const [paneView, setPaneView] = useState<"chat" | "trace">("chat");
	const [traceSeen, setTraceSeen] = useState(false);
	const [settingsTab, setSettingsTab] = useState("model");
	const [token, setToken] = useState("");
	const [loginErr, setLoginErr] = useState("");

	const reloadBots = useCallback(async (selectId?: string) => {
		const list = await listBots();
		setBots(list);
		setCurrentBotId((cur) => selectId ?? (cur && list.some((b) => b.id === cur) ? cur : (list[0]?.id ?? null)));
	}, []);

	const boot = useCallback(async () => {
		try {
			const s = await getSession();
			setModelConfigured(s.modelConfigured);
			setAuthed(true);
			await reloadBots();
		} catch {
			setAuthed(false);
		}
	}, [reloadBots]);

	useEffect(() => {
		void boot();
	}, [boot]);

	const onUnauthorized = useCallback(() => setAuthed(false), []);

	const onRunningChange = useCallback((botId: string, running: boolean) => {
		setBusyBotIds((prev) => {
			if (prev.has(botId) === running) return prev;
			const next = new Set(prev);
			if (running) next.add(botId);
			else next.delete(botId);
			return next;
		});
	}, []);

	const onLogin = async (e: FormEvent) => {
		e.preventDefault();
		try {
			await login(token);
			setLoginErr("");
			await boot();
		} catch {
			setLoginErr("口令不正确");
		}
	};

	if (authed === null) {
		return (
			<div className="flex h-dvh items-center justify-center gap-2 text-sm text-muted-foreground">
				<Loader2Icon className="size-4 animate-spin" />
				加载中…
			</div>
		);
	}

	if (!authed) {
		return (
			<div className="flex min-h-dvh items-center justify-center bg-background p-4">
				<Card className="w-full max-w-sm gap-0 py-0">
					<CardHeader className="flex flex-col items-center gap-2 px-6 pt-8 pb-2 text-center">
						<span className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
							<BotIcon className="size-5.5" />
						</span>
						<CardTitle className="text-lg tracking-tight">Piper</CardTitle>
						<CardDescription>单用户口令登录（口令由服务端配置；使用默认口令时仅限本机回环访问）。</CardDescription>
					</CardHeader>
					<CardContent className="px-6 pt-4 pb-8">
						<form onSubmit={onLogin} className="flex flex-col gap-4">
							<div className="flex flex-col gap-2">
								<Label htmlFor="login-token">口令</Label>
								<Input
									id="login-token"
									type="password"
									placeholder="口令"
									value={token}
									onChange={(e) => setToken(e.target.value)}
									autoFocus
								/>
							</div>
							<Button type="submit" className="w-full">
								<LogInIcon />
								登录
							</Button>
							{loginErr ? <p className="text-center text-sm text-destructive">{loginErr}</p> : null}
						</form>
					</CardContent>
				</Card>
			</div>
		);
	}

	const currentBot = bots.find((b) => b.id === currentBotId) ?? null;

	if (view === "inbox") {
		return <Inbox bots={bots} onBack={() => setView("main")} onUnauthorized={onUnauthorized} focusId={inboxFocusId} />;
	}

	if (view === "settings") {
		return (
			<Settings
				initialTab={settingsTab}
				onOpenFinding={(findingId) => {
					setInboxFocusId(findingId);
					setView("inbox");
				}}
				onBack={() => setView("main")}
				onModelSaved={() => {
					void getSession()
						.then((s) => setModelConfigured(s.modelConfigured))
						.catch(() => {});
				}}
				onUnauthorized={onUnauthorized}
			/>
		);
	}

	return (
		<div className="grid h-dvh" style={{ gridTemplateColumns: `${columns.widths.left}px minmax(0, 1fr) ${columns.widths.right}px` }}>
			<aside className="relative min-h-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
				<BotList
					bots={bots}
					currentBotId={currentBotId}
					busyBotIds={busyBotIds}
					onSelect={setCurrentBotId}
					onNew={() => setForm({ open: true, bot: null })}
					onEdit={(bot) => setForm({ open: true, bot })}
					onOpenInbox={() => {
						setInboxFocusId(null);
						setView("inbox");
					}}
					onOpenSettings={() => {
						setSettingsTab("model");
						setView("settings");
					}}
					onOpenNotifications={() => {
						setSettingsTab("notifications");
						setView("settings");
					}}
				/>
				<button
					type="button"
					aria-hidden
					tabIndex={-1}
					onPointerDown={columns.startDrag("left")}
					className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize transition-colors duration-150 hover:bg-primary/25"
				/>
			</aside>

			<main className="flex min-h-0 min-w-0 flex-col bg-background">
				<header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
					{currentBot ? (
						<>
							<span className="flex size-7 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold text-secondary-foreground">
								{(currentBot.name.trim()[0] ?? "?").toUpperCase()}
							</span>
							<span className="truncate text-sm font-semibold">{currentBot.name}</span>
						</>
					) : (
						<span className="text-sm font-medium text-muted-foreground">选择一个 bot 开始对话</span>
					)}
					{currentBot ? (
						<div className="flex h-9 shrink-0 items-center rounded-lg border bg-muted/40 p-1" role="tablist" aria-label="主栏视图切换">
							<button
								type="button"
								role="tab"
								aria-selected={paneView === "chat"}
								onClick={() => setPaneView("chat")}
								className={cn(
									"flex h-full items-center rounded-md px-3 text-[13px] transition-colors duration-150",
									paneView === "chat" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
								)}
							>
								对话
							</button>
							<button
								type="button"
								role="tab"
								aria-selected={paneView === "trace"}
								onClick={() => {
									setPaneView("trace");
									setTraceSeen(true);
								}}
								className={cn(
									"flex h-full items-center rounded-md px-3 text-[13px] transition-colors duration-150",
									paneView === "trace" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
								)}
							>
								轨迹
							</button>
						</div>
					) : null}
					<Badge variant="outline" className="ml-auto gap-1.5">
						<span className={cn("size-1.5 rounded-full", modelConfigured ? "bg-emerald-400" : "bg-amber-400")} />
						{modelConfigured ? "模型已配置" : "未配置模型"}
					</Badge>
					{!modelConfigured ? (
						<span className="hidden text-xs text-muted-foreground xl:block">对话会明确提示，草案卡走规则兜底</span>
					) : null}
				</header>
				{currentBot ? (
					<div className="relative min-h-0 flex-1">
						<div
							className={cn("absolute inset-0 flex flex-col", paneView === "chat" ? "visible" : "invisible")}
							aria-hidden={paneView !== "chat"}
						>
							<ChatPane
								key={currentBot.id}
								bot={currentBot}
								onRunningChange={onRunningChange}
								onDraftConfirmed={() => void reloadBots()}
								onUnauthorized={onUnauthorized}
							/>
						</div>
						{traceSeen ? (
							<div
								className={cn("absolute inset-0 flex flex-col", paneView === "trace" ? "visible" : "invisible")}
								aria-hidden={paneView !== "trace"}
							>
								<TraceView key={currentBot.id} bot={currentBot} onUnauthorized={onUnauthorized} />
							</div>
						) : null}
					</div>
				) : null}
			</main>

			<aside className="relative min-h-0 border-l border-sidebar-border bg-sidebar text-sidebar-foreground">
				<Desktop bot={currentBot} onUnauthorized={onUnauthorized} onBotUpdated={() => void reloadBots()} />
				<button
					type="button"
					aria-hidden
					tabIndex={-1}
					onPointerDown={columns.startDrag("right")}
					className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize transition-colors duration-150 hover:bg-primary/25"
				/>
			</aside>

			{form.open ? (
				<BotForm
					initial={form.bot}
					onClose={() => setForm({ open: false, bot: null })}
					onSaved={(bot) => {
						setForm({ open: false, bot: null });
						void reloadBots(bot.id);
					}}
					onDeleted={() => {
						setForm({ open: false, bot: null });
						void reloadBots();
					}}
				/>
			) : null}
		</div>
	);
}
