// 右栏业务组件：当前 bot 的「桌面」三页签——例程 / 产物 / 记忆，数据全部走现有 API。
// 例程与产物按当前选中 bot 隔离：例程在前端按 botId 过滤；产物走服务端过滤
//（GET /api/artifacts?botId=，R10），切 bot 时重新拉取。选中主 bot 时不得出现
// 仓库管家的例程或日报。页签用 shadcn Tabs（在本组件内覆写为基线分段控件样式）；
// 产物详情用 AI Elements 的 Artifact 组件（components/ai-elements/artifact，真引入源码）。
// 视觉（feat/ui-desktop-panel）：zinc 灰阶 + 发丝边框 + 明度分层，例程与产物用
// 两行式行卡，状态用「点 + 文字」，空状态为图标 + 文案的居中构图；只改呈现，
// 不改数据与交互语义。
import {
	CalendarClockIcon,
	FileIcon,
	FileTextIcon,
	LockIcon,
	NewspaperIcon,
	PlayIcon,
	RefreshCwIcon,
	StickyNoteIcon,
	TriangleAlertIcon,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { getArtifact, getMemory, listArtifacts, listRoutines, runMorningScan, UnauthorizedError } from "./api";
import { Artifact, ArtifactActions, ArtifactClose, ArtifactContent, ArtifactDescription, ArtifactHeader, ArtifactTitle } from "@/components/ai-elements/artifact";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { Artifact as ArtifactData, ArtifactMeta, Bot, Routine } from "./model";

type Tab = "routines" | "artifacts" | "memory";

export type DesktopProps = {
	bot: Bot | null;
	onUnauthorized: () => void;
};

// 分段控件：覆写 shadcn Tabs 的默认激活态（ bg-background + shadow ）为基线口径——
// 发丝边框容器 + 激活态靠 sidebar-accent 明度差，无阴影，切换只动颜色 150ms。
// dark: 变体与 ui/tabs.tsx 的同名变体同特异性，靠 cn 的合并顺序取后者胜出。
const tabTriggerClass =
	"text-[13px] text-muted-foreground shadow-none transition-colors duration-150 hover:text-foreground data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-sidebar-accent";

function TabCount({ n }: { n: number }) {
	return <span className="text-[11px] font-normal text-muted-foreground tabular-nums">{n}</span>;
}

// 空状态构图：弱化描边圆里的 lucide 图标 + 一句既有文案，居中排布。
function EmptyState({ icon: Icon, children }: { icon: ComponentType<{ className?: string }>; children: ReactNode }) {
	return (
		<div className="flex flex-col items-center gap-2.5 px-4 py-10 text-center">
			<span className="flex size-9 items-center justify-center rounded-full border bg-background/50 text-muted-foreground">
				<Icon className="size-4" />
			</span>
			<p className="text-sm text-muted-foreground">{children}</p>
		</div>
	);
}

// 产物图标按 kind 取：晨间日报、便签、报告各有其形，其余（含 file）回落通用文件图标。
function artifactIcon(kind: string): ComponentType<{ className?: string }> {
	switch (kind) {
		case "morning-scan":
		case "morning-report":
			return NewspaperIcon;
		case "note":
			return StickyNoteIcon;
		case "report":
			return FileTextIcon;
		default:
			return FileIcon;
	}
}

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
		listArtifacts(bot?.id)
			.then(setArtifacts)
			.catch(guard);
	}, [bot, guard]);

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

	const visibleRoutines = bot ? routines.filter((r) => r.botId === bot.id) : [];
	// 产物已按当前 bot 在服务端过滤，这里直接用拉回的列表（bot 为空时为空列表）。
	const visibleArtifacts = bot ? artifacts : [];

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
			<div className="px-4 pt-4 pb-3">
				<div className="truncate pb-3 text-sm">
					{bot ? (
						<>
							<span className="font-semibold tracking-tight">{bot.name}</span>
							<span className="text-muted-foreground"> 的桌面</span>
						</>
					) : (
						<span className="font-medium text-muted-foreground">未选择 bot</span>
					)}
				</div>
				<TabsList className="grid h-9 w-full grid-cols-3 rounded-lg border bg-background/40 p-1 shadow-none">
					<TabsTrigger value="routines" className={tabTriggerClass}>
						例程
						<TabCount n={visibleRoutines.length} />
					</TabsTrigger>
					<TabsTrigger value="artifacts" className={tabTriggerClass}>
						产物
						<TabCount n={visibleArtifacts.length} />
					</TabsTrigger>
					<TabsTrigger value="memory" className={tabTriggerClass}>
						记忆
					</TabsTrigger>
				</TabsList>
			</div>

			{err ? (
				<div className="mx-4 mb-2 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
					<TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
					<span>{err}</span>
				</div>
			) : null}

			<ScrollArea className="min-h-0 flex-1">
				<div className="px-4 pb-4">
					<TabsContent value="routines" className="mt-0 flex flex-col gap-3">
						{visibleRoutines.length === 0 ? (
							<EmptyState icon={CalendarClockIcon}>该 bot 暂无例程</EmptyState>
						) : null}
						{visibleRoutines.map((r) => (
							<div key={r.id} className="rounded-lg border bg-card px-4 py-3.5">
								<div className="flex items-center gap-2">
									<span className="min-w-0 flex-1 truncate text-sm font-medium">{r.name}</span>
									{r.lastStatus ? (
										<span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
											<span
												className={cn(
													"size-1.5 rounded-full",
													r.lastStatus === "ok" ? "bg-emerald-400" : "bg-destructive",
												)}
											/>
											{r.lastStatus}
										</span>
									) : null}
								</div>
								{r.description ? (
									<p className="pt-1.5 text-[13px] leading-relaxed text-muted-foreground">{r.description}</p>
								) : null}
								<div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-2.5 text-xs text-muted-foreground">
									<span className="flex items-start gap-1.5">
										<CalendarClockIcon className="mt-px size-3.5 shrink-0" />
										<span>计划：{r.scheduleText || `每日 ${r.schedule}`}</span>
									</span>
									<span>上次运行：{r.lastRunAt || "从未"}</span>
									{r.nextRunAt ? <span>下次运行：{new Date(r.nextRunAt).toLocaleString()}</span> : null}
								</div>
								{r.id === "morning-scan" ? (
									<div className="pt-3">
										<Button type="button" size="sm" disabled={running} onClick={onRunScan}>
											<PlayIcon />
											{running ? "运行中…" : "立即运行"}
										</Button>
									</div>
								) : null}
							</div>
						))}
					</TabsContent>

					<TabsContent value="artifacts" className="mt-0 flex flex-col gap-1">
						{visibleArtifacts.length === 0 ? (
							<EmptyState icon={FileTextIcon}>该 bot 暂无产物，运行一次晨间扫描试试。</EmptyState>
						) : null}
						{visibleArtifacts.map((a) => {
							const Icon = artifactIcon(a.kind);
							return (
								<button
									key={a.id}
									type="button"
									className={cn(
										"flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150",
										openArtifact?.id === a.id ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
									)}
									onClick={() => onOpenArtifact(a)}
								>
									<Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
									<span className="min-w-0 flex-1">
										<span className="block truncate text-sm">{a.title}</span>
										<span className="block pt-0.5 text-xs text-muted-foreground tabular-nums">
											{a.kind} · {(a.createdAt || "").slice(0, 10)}
										</span>
									</span>
								</button>
							);
						})}
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

					<TabsContent value="memory" className="mt-0 flex flex-col gap-5">
						<section>
							<div className="flex items-center gap-2 px-1 pb-2">
								<h4 className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">Bot 记忆</h4>
								<span className="flex items-center gap-1 text-[11px] text-muted-foreground">
									<LockIcon className="size-3" />
									只读
								</span>
								<Button type="button" size="icon-sm" variant="ghost" title="刷新" onClick={loadMemory} className="ml-auto">
									<RefreshCwIcon />
									<span className="sr-only">刷新</span>
								</Button>
							</div>
							<pre className="max-h-72 overflow-y-auto rounded-lg border bg-card p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
								{memory?.markdown || "（暂无 memory.md）"}
							</pre>
						</section>
						<section>
							<h4 className="px-1 pb-2 text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
								账号级「关于我」
							</h4>
							<p className="px-1 pb-2 text-xs text-muted-foreground">全 bot 可读、仅主 bot 可写。</p>
							<pre className="max-h-72 overflow-y-auto rounded-lg border bg-card p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
								{memory?.aboutMe || "（暂无「关于我」）"}
							</pre>
						</section>
					</TabsContent>
				</div>
			</ScrollArea>
		</Tabs>
	);
}
