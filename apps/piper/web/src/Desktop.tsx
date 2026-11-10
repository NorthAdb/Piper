// 右栏业务组件：当前 bot 的「桌面」三页签——例程 / 产物 / 记忆，数据全部走现有 API。
// 产物详情用借鉴 shadcn/ui AI Elements Artifact 形态的卡片（标题栏 + 元信息 + 内容区）呈现，自行实现。
import { useCallback, useEffect, useState } from "react";
import { getArtifact, getMemory, listArtifacts, listRoutines, runMorningScan, UnauthorizedError } from "./api";
import type { Artifact, ArtifactMeta, Bot, Routine } from "./model";

type Tab = "routines" | "artifacts" | "memory";

export type DesktopProps = {
	bot: Bot | null;
	onUnauthorized: () => void;
};

export function Desktop({ bot, onUnauthorized }: DesktopProps) {
	const [tab, setTab] = useState<Tab>("routines");
	const [routines, setRoutines] = useState<Routine[]>([]);
	const [artifacts, setArtifacts] = useState<ArtifactMeta[]>([]);
	const [openArtifact, setOpenArtifact] = useState<Artifact | null>(null);
	const [memory, setMemory] = useState<{ markdown: string; aboutMe: string } | null>(null);
	const [running, setRunning] = useState(false);
	const [err, setErr] = useState("");

	const guard = useCallback(
		(e: unknown) => {
			if (e instanceof UnauthorizedError) onUnauthorized();
			else setErr(e instanceof Error ? e.message : String(e));
		},
		[onUnauthorized],
	);

	const loadRoutines = useCallback(() => {
		listRoutines()
			.then(setRoutines)
			.catch(guard);
	}, [guard]);

	const loadArtifacts = useCallback(() => {
		listArtifacts()
			.then(setArtifacts)
			.catch(guard);
	}, [guard]);

	const loadMemory = useCallback(() => {
		if (!bot) return;
		getMemory(bot.id)
			.then((d) => setMemory({ markdown: d.markdown, aboutMe: d.aboutMe }))
			.catch(guard);
	}, [bot, guard]);

	useEffect(() => {
		loadRoutines();
		loadArtifacts();
	}, [loadRoutines, loadArtifacts]);

	useEffect(() => {
		setMemory(null);
		setOpenArtifact(null);
		loadMemory();
	}, [loadMemory]);

	const onRunScan = async () => {
		setRunning(true);
		setErr("");
		try {
			await runMorningScan();
			loadRoutines();
			loadArtifacts();
		} catch (e) {
			guard(e);
		} finally {
			setRunning(false);
		}
	};

	const onOpenArtifact = async (meta: ArtifactMeta) => {
		if (openArtifact?.id === meta.id) {
			setOpenArtifact(null);
			return;
		}
		try {
			setOpenArtifact(await getArtifact(meta.id));
		} catch (e) {
			guard(e);
		}
	};

	return (
		<div className="desktop">
			<div className="tabs">
				<button type="button" className={tab === "routines" ? "active" : ""} onClick={() => setTab("routines")}>
					例程
				</button>
				<button type="button" className={tab === "artifacts" ? "active" : ""} onClick={() => setTab("artifacts")}>
					产物
				</button>
				<button type="button" className={tab === "memory" ? "active" : ""} onClick={() => setTab("memory")}>
					记忆
				</button>
			</div>
			{err ? <p className="desk-err">{err}</p> : null}

			{tab === "routines" ? (
				<div>
					{routines.length === 0 ? <p className="muted">暂无例程</p> : null}
					{routines.map((r) => (
						<div key={r.id} className="routine-card">
							<b>{r.name}</b>
							<p className="muted">
								{r.description}
								<br />
								计划：{r.schedule}
								<br />
								上次运行：{r.lastRunAt || "从未"}
								{r.lastStatus ? `（${r.lastStatus}）` : ""}
							</p>
							{r.id === "morning-scan" ? (
								<button type="button" className="primary" disabled={running} onClick={onRunScan}>
									{running ? "运行中…" : "立即运行"}
								</button>
							) : null}
						</div>
					))}
				</div>
			) : null}

			{tab === "artifacts" ? (
				<div>
					{artifacts.length === 0 ? <p className="muted">暂无产物，运行一次晨间扫描试试。</p> : null}
					{artifacts.map((a) => (
						<div key={a.id} className="artifact-row">
							<button type="button" className="artifact-link" onClick={() => onOpenArtifact(a)}>
								{a.title}
							</button>
							<span className="muted">{(a.createdAt || "").slice(0, 10)}</span>
						</div>
					))}
					{openArtifact ? (
						<div className="artifact-card">
							<div className="artifact-head">
								<b className="artifact-title">{openArtifact.title}</b>
								<span className="muted">
									{openArtifact.kind} · {(openArtifact.createdAt || "").slice(0, 10)}
								</span>
								<button type="button" className="artifact-close" onClick={() => setOpenArtifact(null)}>
									收起
								</button>
							</div>
							<pre className="artifact-body">{openArtifact.body}</pre>
						</div>
					) : null}
				</div>
			) : null}

			{tab === "memory" ? (
				<div>
					<p className="muted">该 bot 的记忆（雏形只读）：</p>
					<pre className="md">{memory?.markdown || "（暂无 memory.md）"}</pre>
					<p className="muted">账号级「关于我」（全 bot 可读、仅主 bot 可写）：</p>
					<pre className="md">{memory?.aboutMe ?? ""}</pre>
					<button type="button" onClick={loadMemory}>
						刷新
					</button>
				</div>
			) : null}
		</div>
	);
}
