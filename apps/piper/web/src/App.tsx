// Piper 前端入口：单口令登录门 + 三栏布局（左 bot 列表 / 中 Chat / 右 bot 桌面）。
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { getSession, listBots, login } from "./api";
import { BotForm } from "./BotForm";
import { BotList } from "./BotList";
import { ChatPane } from "./ChatPane";
import { Desktop } from "./Desktop";
import type { Bot } from "./model";

type FormState = { open: boolean; bot: Bot | null };

export function App() {
	const [authed, setAuthed] = useState<boolean | null>(null);
	const [modelConfigured, setModelConfigured] = useState(false);
	const [bots, setBots] = useState<Bot[]>([]);
	const [currentBotId, setCurrentBotId] = useState<string | null>(null);
	const [busyBotIds, setBusyBotIds] = useState<ReadonlySet<string>>(new Set());
	const [form, setForm] = useState<FormState>({ open: false, bot: null });
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
		return <div className="boot-loading">加载中…</div>;
	}

	if (!authed) {
		return (
			<form id="login" onSubmit={onLogin}>
				<h2>Piper</h2>
				<p className="muted">单用户口令登录（本地开发默认 piper-dev，可用环境变量 PIPER_TOKEN 修改）。</p>
				<input type="password" placeholder="口令" value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
				<button type="submit" className="primary wide-btn">
					登录
				</button>
				{loginErr ? <p className="form-err">{loginErr}</p> : null}
			</form>
		);
	}

	const currentBot = bots.find((b) => b.id === currentBotId) ?? null;

	return (
		<div id="app">
			<aside className="col bots-col">
				<BotList
					bots={bots}
					currentBotId={currentBotId}
					busyBotIds={busyBotIds}
					onSelect={setCurrentBotId}
					onNew={() => setForm({ open: true, bot: null })}
					onEdit={(bot) => setForm({ open: true, bot })}
				/>
			</aside>

			<main className="chat-col">
				<div className="chat-header">
					<b>{currentBot ? `与「${currentBot.name}」对话` : "选择一个 bot 开始对话"}</b>{" "}
					<span className="muted">
						{modelConfigured ? "（模型已配置）" : "（未配置模型：对话会明确提示，草案卡走规则兜底）"}
					</span>
				</div>
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

			<aside className="col desk-col">
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
