// 右栏业务组件：当前 bot 的「桌面」三页签——例程 / 产物 / 记忆，数据全部走现有 API。
// 页签用 shadcn Tabs；例程用 shadcn Card；产物详情用 AI Elements 的 Artifact 组件
//（components/ai-elements/artifact，真引入源码）。
import { CalendarClockIcon, FileTextIcon, HistoryIcon, PlayIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getArtifact, getMemory, listArtifacts, listRoutines, runMorningScan, UnauthorizedError } from "./api";
import { Artifact, ArtifactActions, ArtifactClose, ArtifactContent, ArtifactDescription, ArtifactHeader, ArtifactTitle } from "@/components/ai-elements/artifact";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { Artifact as ArtifactData, ArtifactMeta, Bot, Routine } from "./model";

type Tab = "routines" | "artifacts" | "memory";

export type DesktopProps = {
	bot: Bot | null;
	onUnauthorized: () => void;
};

export function Desktop({ bot, onUnauthorized }: DesktopProps) {
	const [tab, setTab] = useState<Tab>("routines");
	const [routines, setRoutines] = useState<Routine[]>([]);
	const [artifacts, setArtifacts] = useState<ArtifactMeta[]>([]);
	const [openArtifact, setOpenArtifact] = useState<ArtifactData | null>(null);
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
		<Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="flex h-full flex-col gap-0">
			<div className="px-3 pt-3 pb-2">
				<div className="truncate px-1 pb-2 text-xs text-muted-foreground">
					{bot ? (
						<>
							<span className="font-medium text-foreground">{bot.name}</span> 的桌面
						</>
					) : (
						"未选择 bot"
					)}
				</div>
				<TabsList className="grid w-full grid-cols-3">
					<TabsTrigger value="routines">例程</TabsTrigger>
					<TabsTrigger value="artifacts">产物</TabsTrigger>
					<TabsTrigger value="memory">记忆</TabsTrigger>
				</TabsList>
			</div>

			{err ? (
				<div className="mx-3 mb-2 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
					<TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
					<span>{err}</span>
				</div>
			) : null}

			<ScrollArea className="min-h-0 flex-1">
				<div className="px-3 pb-3">
					<TabsContent value="routines" className="mt-0 flex flex-col gap-3">
						{routines.length === 0 ? <p className="px-1 text-sm text-muted-foreground">暂无例程</p> : null}
						{routines.map((r) => (
							<Card key={r.id} className="gap-0 py-0 shadow-none">
								<CardHeader className="flex flex-row items-center gap-2 px-4 py-3">
									<CardTitle className="flex-1 truncate text-sm">{r.name}</CardTitle>
									{r.lastStatus ? (
										<Badge
											variant="outline"
											className={cn(
												r.lastStatus === "ok"
													? "border-emerald-500/30 text-emerald-400"
													: "border-destructive/40 text-destructive",
											)}
										>
											{r.lastStatus}
										</Badge>
									) : null}
								</CardHeader>
								<CardContent className="flex flex-col gap-2.5 px-4 pb-4">
									<p className="text-sm text-muted-foreground">{r.description}</p>
									<div className="flex flex-col gap-1 text-xs text-muted-foreground">
										<span className="flex items-center gap-1.5">
											<CalendarClockIcon className="size-3.5" />
											计划：{r.schedule}
										</span>
										<span className="flex items-center gap-1.5">
											<HistoryIcon className="size-3.5" />
											上次运行：{r.lastRunAt || "从未"}
										</span>
									</div>
									{r.id === "morning-scan" ? (
										<div>
											<Button type="button" size="sm" disabled={running} onClick={onRunScan}>
												<PlayIcon />
												{running ? "运行中…" : "立即运行"}
											</Button>
										</div>
									) : null}
								</CardContent>
							</Card>
						))}
					</TabsContent>

					<TabsContent value="artifacts" className="mt-0 flex flex-col gap-1">
						{artifacts.length === 0 ? (
							<p className="px-1 text-sm text-muted-foreground">暂无产物，运行一次晨间扫描试试。</p>
						) : null}
						{artifacts.map((a) => (
							<button
								key={a.id}
								type="button"
								className={cn(
									"flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
									openArtifact?.id === a.id ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
								)}
								onClick={() => onOpenArtifact(a)}
							>
								<FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
								<span className="min-w-0 flex-1 truncate">{a.title}</span>
								<span className="shrink-0 text-xs text-muted-foreground">{(a.createdAt || "").slice(0, 10)}</span>
							</button>
						))}
						{openArtifact ? (
							<Artifact className="mt-2 bg-card">
								<ArtifactHeader>
									<div className="min-w-0">
										<ArtifactTitle className="truncate">{openArtifact.title}</ArtifactTitle>
										<ArtifactDescription>
											{openArtifact.kind} · {(openArtifact.createdAt || "").slice(0, 10)}
										</ArtifactDescription>
									</div>
									<ArtifactActions>
										<ArtifactClose onClick={() => setOpenArtifact(null)} />
									</ArtifactActions>
								</ArtifactHeader>
								<ArtifactContent>
									<pre className="font-mono text-xs break-words whitespace-pre-wrap">{openArtifact.body}</pre>
								</ArtifactContent>
							</Artifact>
						) : null}
					</TabsContent>

					<TabsContent value="memory" className="mt-0 flex flex-col gap-4">
						<section>
							<div className="flex items-center justify-between px-1 pb-2">
								<h4 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Bot 记忆（只读）</h4>
								<Button type="button" size="icon-sm" variant="ghost" title="刷新" onClick={loadMemory}>
									<RefreshCwIcon />
									<span className="sr-only">刷新</span>
								</Button>
							</div>
							<pre className="max-h-72 overflow-y-auto rounded-lg border bg-card p-3 font-mono text-xs break-words whitespace-pre-wrap">
								{memory?.markdown || "（暂无 memory.md）"}
							</pre>
						</section>
						<section>
							<h4 className="px-1 pb-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
								账号级「关于我」
							</h4>
							<p className="px-1 pb-2 text-xs text-muted-foreground">全 bot 可读、仅主 bot 可写。</p>
							<pre className="max-h-72 overflow-y-auto rounded-lg border bg-card p-3 font-mono text-xs break-words whitespace-pre-wrap">
								{memory?.aboutMe ?? ""}
							</pre>
						</section>
					</TabsContent>
				</div>
			</ScrollArea>
		</Tabs>
	);
}
