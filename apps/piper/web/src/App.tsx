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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
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
						<CardDescription>单用户口令登录（本地开发默认 piper-dev，可用环境变量 PIPER_TOKEN 修改）。</CardDescription>
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
		return <Inbox bots={bots} onBack={() => setView("main")} onUnauthorized={onUnauthorized} />;
	}

	if (view === "settings") {
		return (
			<Settings
				initialTab={settingsTab}
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
		<div className="grid h-dvh grid-cols-[264px_minmax(0,1fr)_360px]">
			<aside className="min-h-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
				<BotList
					bots={bots}
					currentBotId={currentBotId}
					busyBotIds={busyBotIds}
					onSelect={setCurrentBotId}
					onNew={() => setForm({ open: true, bot: null })}
					onEdit={(bot) => setForm({ open: true, bot })}
					onOpenInbox={() => setView("inbox")}
					onOpenSettings={() => {
						setSettingsTab("model");
						setView("settings");
					}}
					onOpenNotifications={() => {
						setSettingsTab("notifications");
						setView("settings");
					}}
				/>
			</aside>

			<main className="flex min-h-0 min-w-0 flex-col bg-background">
				<header className="flex h-13 shrink-0 items-center gap-3 border-b px-5">
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
					<Badge variant="outline" className="ml-auto gap-1.5">
						<span className={cn("size-1.5 rounded-full", modelConfigured ? "bg-emerald-400" : "bg-amber-400")} />
						{modelConfigured ? "模型已配置" : "未配置模型"}
					</Badge>
					{!modelConfigured ? (
						<span className="hidden text-xs text-muted-foreground xl:block">对话会明确提示，草案卡走规则兜底</span>
					) : null}
				</header>
				{currentBot ? (
					<ChatPane
						key={currentBot.id}
						bot={currentBot}
						onRunningChange={onRunningChange}
						onDraftConfirmed={() => void reloadBots()}
						onUnauthorized={onUnauthorized}
					/>
				) : null}
			</main>

			<aside className="min-h-0 border-l border-sidebar-border bg-sidebar text-sidebar-foreground">
				<Desktop bot={currentBot} onUnauthorized={onUnauthorized} />
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
