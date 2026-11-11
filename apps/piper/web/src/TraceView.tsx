// 中栏轨迹视图（PR-E）：消费 GET /api/bots/:id/trace（PR-D，lib/trace.mjs
// 的 buildTrace 按轮归一化），把当前 bot 的会话流水画成统计 + 分段时长条 +
// 分轮时间线。只读呈现：不改落盘、不发消息、不用 SSE。
//
// 数据诚实口径（与接口契约一致，不在前端补数据）：
// - durationMs / ts 无证据时接口给 null：界面显示「—」，旧会话整轮无时间
//   数据的轮次不进时长条，并在时间线上方注明「N 轮旧记录无时间数据」；
//   统计只汇总有据字段（总时长 = 各轮 durationMs 之和，全无则「—」）。
// - textPreview 是接口脱敏后截断 200 字的预览：展开区只展示它并明确标注
//   「预览」，不冒充全文；tool 的 args/result 是落盘的已脱敏版本。
// - 事件种类以接口 kind 原值为准（user/thinking/tool/assistant/system），
//   小签只做中文映射，未知 kind 原样显示，不发明接口没有的种类。
import { ChevronDownIcon, HistoryIcon, RefreshCwIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getTrace, UnauthorizedError } from "./api";
import { ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Bot, JsonValue, TraceData, TraceEvent, TraceTurn } from "./model";

const KIND_LABEL: Record<string, string> = {
	user: "用户",
	thinking: "思考",
	tool: "工具",
	assistant: "助手",
	system: "系统",
};

const SUBKIND_LABEL: Record<string, string> = {
	draft: "草案",
	"bot-created": "创建 Bot",
	error: "错误",
	routine: "例程播报",
};

// 时长条类别：模型产出（思考 + 正文）走 primary 绿，工具走弱化 amber，
// 其余（用户 / 系统）走 zinc。
type SegCategory = "model" | "tool" | "other";

function segCategory(kind: string): SegCategory {
	if (kind === "thinking" || kind === "assistant") return "model";
	if (kind === "tool") return "tool";
	return "other";
}

const SEG_CLASS: Record<SegCategory, string> = {
	model: "bg-primary",
	tool: "bg-amber-500/70",
	other: "bg-zinc-500",
};

// 时长格式化：null（无证据）一律「—」；亚秒给毫秒，分钟内给秒（至多一位
// 小数），更长给分秒。调用方只传真实数值，不在这里补零或估算。
export function fmtDuration(ms: number | null): string {
	if (ms === null || !Number.isFinite(ms)) return "—";
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) {
		const s = ms / 1000;
		return `${Number.isInteger(s) ? s : s.toFixed(1)} 秒`;
	}
	const m = Math.floor(ms / 60_000);
	const s = Math.round((ms % 60_000) / 1000);
	return s === 0 ? `${m} 分` : `${m} 分 ${s} 秒`;
}

function compactJson(value: JsonValue): string {
	const s = JSON.stringify(value) ?? "";
	return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

// 行摘要（一行，超出由 CSS truncate 收尾）：
// 工具 = 工具名 + 参数 JSON 预览（非 complete 的状态缀在后面）；
// 思考 = 挡位 + 字数；系统 = subKind 中文名 + 正文预览；其余 = 正文预览。
function eventSummary(ev: TraceEvent): string {
	switch (ev.kind) {
		case "tool": {
			const head = [ev.name ?? "tool", ev.args != null ? compactJson(ev.args) : ""].filter(Boolean).join(" ");
			return ev.status && ev.status !== "complete" ? `${head} · ${ev.status}` : head;
		}
		case "thinking": {
			const bits: string[] = [];
			if (ev.level) bits.push(`挡位 ${ev.level}`);
			if (ev.textChars != null) bits.push(`约 ${ev.textChars} 字`);
			if (ev.truncated) bits.push("已截断");
			return bits.length ? bits.join(" · ") : (ev.textPreview ?? "");
		}
		case "system": {
			const sub = ev.subKind ? (SUBKIND_LABEL[ev.subKind] ?? ev.subKind) : "系统";
			return ev.textPreview ? `${sub} · ${ev.textPreview}` : sub;
		}
		default:
			return ev.textPreview ?? "";
	}
}

function eventSearchText(ev: TraceEvent): string {
	return [
		KIND_LABEL[ev.kind] ?? ev.kind,
		ev.subKind ?? "",
		ev.name ?? "",
		eventSummary(ev),
		ev.textPreview ?? "",
		ev.args != null ? JSON.stringify(ev.args) : "",
		ev.result != null ? JSON.stringify(ev.result) : "",
	]
		.join(" ")
		.toLowerCase();
}

function resultErrorText(result: JsonValue | undefined): string {
	if (result && typeof result === "object" && !Array.isArray(result)) {
		const err = result.error;
		if (typeof err === "string" && err) return err;
	}
	return "工具执行出错";
}

function TraceEventRow({ ev }: { ev: TraceEvent }) {
	const [open, setOpen] = useState(false);
	const isTool = ev.kind === "tool";
	const expandable = isTool
		? ev.args != null || ev.result != null
		: typeof ev.textPreview === "string" && ev.textPreview.length > 0;
	const label = KIND_LABEL[ev.kind] ?? ev.kind;
	const summary = eventSummary(ev);
	const header = (
		<>
			<span className="flex w-11 shrink-0 items-center justify-center rounded border px-1 py-0.5 text-[11px] leading-none whitespace-nowrap text-muted-foreground">
				{label}
			</span>
			<span className="min-w-0 flex-1 truncate text-[13px]">
				{summary || <span className="text-muted-foreground">（无预览）</span>}
			</span>
			<span className="shrink-0 text-xs text-muted-foreground tabular-nums">{fmtDuration(ev.durationMs)}</span>
			{expandable ? (
				<ChevronDownIcon
					className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-150", open && "rotate-180")}
				/>
			) : (
				<span className="size-4 shrink-0" />
			)}
		</>
	);
	return (
		<div>
			{expandable ? (
				<button
					type="button"
					className="flex w-full items-center gap-3 px-1 py-2 text-left transition-colors duration-150 hover:bg-muted/40"
					onClick={() => setOpen((v) => !v)}
					aria-expanded={open}
				>
					{header}
				</button>
			) : (
				<div className="flex w-full items-center gap-3 px-1 py-2">{header}</div>
			)}
			{open ? (
				<div className="pr-1 pb-3 pl-[3.75rem]">
					{isTool ? (
						<div className="flex flex-col gap-3">
							{ev.args != null ? <ToolInput input={ev.args} /> : null}
							{ev.result != null || ev.status === "error" ? (
								<ToolOutput
									output={ev.result ?? null}
									errorText={ev.status === "error" ? resultErrorText(ev.result) : undefined}
								/>
							) : null}
						</div>
					) : (
						<div>
							<p className="rounded-lg border bg-card p-3 text-[13px] leading-relaxed break-words whitespace-pre-wrap">
								{ev.textPreview}
							</p>
							<p className="pt-1.5 text-[11px] text-muted-foreground">
								{ev.textChars != null && ev.textPreview != null && ev.textChars > ev.textPreview.length
									? `预览：全文约 ${ev.textChars} 字，这里仅显示前 ${ev.textPreview.length} 字`
									: "预览：接口返回的截断预览，非全文"}
							</p>
						</div>
					)}
				</div>
			) : null}
		</div>
	);
}

function TurnSection({ turn }: { turn: TraceTurn }) {
	return (
		<section className="pt-5 first:pt-1">
			<div className="flex items-baseline gap-2 pb-1.5">
				<h3 className="text-[13px] font-medium">第 {turn.index + 1} 轮</h3>
				<span className="ml-auto text-xs text-muted-foreground tabular-nums">{fmtDuration(turn.durationMs)}</span>
			</div>
			<div className="divide-y divide-border/60 border-y border-border/60">
				{turn.events.map((ev, i) => (
					<TraceEventRow key={`${turn.index}-${ev.seq ?? "x"}-${i}`} ev={ev} />
				))}
			</div>
		</section>
	);
}

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<div className="text-sm font-semibold tabular-nums">{value}</div>
			<div className="pt-0.5 text-[11px] text-muted-foreground">{label}</div>
		</div>
	);
}

export type TraceViewProps = {
	bot: Bot;
	onUnauthorized: () => void;
};

export function TraceView({ bot, onUnauthorized }: TraceViewProps) {
	const [data, setData] = useState<TraceData | null>(null);
	const [loading, setLoading] = useState(true);
	const [err, setErr] = useState("");
	const [query, setQuery] = useState("");
	const [reloadTick, setReloadTick] = useState(0);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		getTrace(bot.id)
			.then((d) => {
				if (cancelled) return;
				setData(d);
				setErr("");
				setLoading(false);
			})
			.catch((e: unknown) => {
				if (cancelled) return;
				if (e instanceof UnauthorizedError) {
					onUnauthorized();
					return;
				}
				setErr(e instanceof Error ? e.message : String(e));
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [bot.id, reloadTick, onUnauthorized]);

	// 统计只汇总有据字段：总时长 = 各轮 durationMs（非 null）之和，全无则 null。
	const stats = useMemo(() => {
		if (!data) return { totalMs: null as number | null, turns: 0, tools: 0 };
		let totalMs: number | null = null;
		let tools = 0;
		for (const t of data.turns) {
			if (t.durationMs != null) totalMs = (totalMs ?? 0) + t.durationMs;
			for (const e of t.events) if (e.kind === "tool") tools += 1;
		}
		return { totalMs, turns: data.turns.length, tools };
	}, [data]);

	// 时长条只收有 durationMs 的事件（逐轮成组、轮内按段成比例）；整轮无
	// 时间数据的轮次计入 legacyCount，不进条、只在时间线上方注明。
	const barTurns = useMemo(() => {
		if (!data) return [];
		return data.turns
			.map((turn) => ({ turn, segs: turn.events.filter((e) => e.durationMs != null && e.durationMs > 0) }))
			.filter((x) => x.segs.length > 0)
			.map((x) => ({ ...x, sum: x.segs.reduce((a, e) => a + (e.durationMs ?? 0), 0) }));
	}, [data]);

	const legacyCount = useMemo(() => {
		if (!data) return 0;
		return data.turns.filter((t) => t.durationMs == null && t.events.every((e) => e.durationMs == null)).length;
	}, [data]);

	const visibleTurns = useMemo(() => {
		if (!data) return [];
		const q = query.trim().toLowerCase();
		if (!q) return data.turns;
		return data.turns
			.map((t) => ({ ...t, events: t.events.filter((e) => eventSearchText(e).includes(q)) }))
			.filter((t) => t.events.length > 0);
	}, [data, query]);

	return (
		<div className="flex h-full flex-col" data-testid="trace-view">
			<div className="shrink-0 border-b">
				<div className="mx-auto w-full max-w-4xl px-4 py-4">
					<div className="flex flex-wrap items-end gap-x-7 gap-y-3">
						<Stat label="总时长" value={fmtDuration(stats.totalMs)} />
						<Stat label="轮次" value={String(stats.turns)} />
						<Stat label="工具调用" value={String(stats.tools)} />
						<div className="ml-auto flex items-center gap-1.5">
							<div className="relative">
								<SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
								<Input
									value={query}
									onChange={(e) => setQuery(e.target.value)}
									placeholder="搜索事件"
									className="h-9 w-52 pl-8"
									aria-label="搜索轨迹事件"
								/>
							</div>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								title="刷新轨迹"
								disabled={loading}
								onClick={() => setReloadTick((v) => v + 1)}
							>
								<RefreshCwIcon className={loading ? "animate-spin" : undefined} />
								<span className="sr-only">刷新轨迹</span>
							</Button>
						</div>
					</div>
					{barTurns.length > 0 ? (
						<div className="pt-4">
							<div className="flex h-2.5 w-full gap-1.5" data-testid="trace-bar" role="img" aria-label="各轮耗时分布条">
								{barTurns.map(({ turn, segs, sum }) => (
									<div key={turn.index} className="flex gap-[3px]" style={{ flexGrow: sum, flexBasis: 0 }}>
										{segs.map((e, i) => (
											<div
												key={i}
												className={cn("rounded-[2px]", SEG_CLASS[segCategory(e.kind)])}
												style={{ flexGrow: e.durationMs ?? 0, flexBasis: 0 }}
												title={`第 ${turn.index + 1} 轮 · ${KIND_LABEL[e.kind] ?? e.kind} · ${fmtDuration(e.durationMs)}`}
											/>
										))}
									</div>
								))}
							</div>
							<div className="flex items-center gap-4 pt-2 text-[11px] text-muted-foreground">
								<span className="flex items-center gap-1.5">
									<span className="size-2 rounded-[2px] bg-primary" />
									模型
								</span>
								<span className="flex items-center gap-1.5">
									<span className="size-2 rounded-[2px] bg-amber-500/70" />
									工具
								</span>
								<span className="flex items-center gap-1.5">
									<span className="size-2 rounded-[2px] bg-zinc-500" />
									其他
								</span>
							</div>
						</div>
					) : null}
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-4xl px-4 pt-3 pb-6">
					{err ? (
						<div className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
							<TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
							<span>轨迹加载失败：{err}</span>
							<Button type="button" size="sm" variant="ghost" className="ml-auto shrink-0" onClick={() => setReloadTick((v) => v + 1)}>
								重试
							</Button>
						</div>
					) : null}

					{loading && data === null ? (
						<div className="animate-pulse pt-2" aria-label="轨迹加载中">
							<div className="h-4 w-24 rounded bg-muted" />
							<div className="mt-3 flex flex-col gap-2">
								<div className="h-8 rounded bg-muted/70" />
								<div className="h-8 rounded bg-muted/70" />
								<div className="h-8 rounded bg-muted/70" />
							</div>
							<div className="mt-6 h-4 w-24 rounded bg-muted" />
							<div className="mt-3 flex flex-col gap-2">
								<div className="h-8 rounded bg-muted/70" />
								<div className="h-8 rounded bg-muted/70" />
							</div>
						</div>
					) : data !== null && data.turns.length === 0 ? (
						<div className="flex flex-col items-center gap-2.5 px-4 py-16 text-center">
							<span className="flex size-9 items-center justify-center rounded-full border bg-card text-muted-foreground">
								<HistoryIcon className="size-4" />
							</span>
							<p className="text-sm text-muted-foreground">暂无轨迹记录</p>
							<p className="text-xs text-muted-foreground">和 bot 对话后，这里会按轮记录每一步的耗时与调用。</p>
						</div>
					) : (
						<>
							{legacyCount > 0 ? <p className="pb-1 text-xs text-muted-foreground">{legacyCount} 轮旧记录无时间数据</p> : null}
							{visibleTurns.map((turn) => (
								<TurnSection key={turn.index} turn={turn} />
							))}
							{query.trim() && visibleTurns.length === 0 ? (
								<p className="py-10 text-center text-sm text-muted-foreground">没有匹配「{query.trim()}」的事件</p>
							) : null}
						</>
					)}
				</div>
			</div>
		</div>
	);
}
