// 中栏消息 part 的自定义渲染：assistant-ui MessagePrimitive.Parts 的组件槽位实现。
// 工具卡用 AI Elements 的 Tool 组件（components/ai-elements/tool，真引入源码）；
// 草案/系统/错误卡用 shadcn Card/Badge/Button 与设计系统色调实现。
import type { DataMessagePartComponent, TextMessagePartComponent, ToolCallMessagePartComponent } from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { BotIcon, BrainIcon, CheckIcon, ChevronDownIcon, InfoIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";
import remarkGfm from "remark-gfm";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import type { ToolPart } from "@/components/ai-elements/tool";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import type { BotDraft, JsonValue } from "./model";

// ---- 文本 ----

export const MarkdownText: TextMessagePartComponent = ({ text, status }) => {
	if (!text && status.type === "running") {
		return (
			<span className="typing" aria-label="正在生成">
				<i />
				<i />
				<i />
			</span>
		);
	}
	return <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} className="aui-md" smooth={false} />;
};

export const PlainText: TextMessagePartComponent = ({ text }) => <span className="whitespace-pre-wrap">{text}</span>;

// ---- 工具卡（AI Elements Tool：Collapsible + 状态点与文字 + CodeBlock 详情） ----
// 卡面与右栏行卡同一语言（feat/ui-chat-polish）：发丝边框 + bg-card 实底，
// 状态在 Tool 组件内以「点 + 文字」呈现，不用彩色徽章。
// 一次调用一张卡（ChatPane 按 toolCallId 合并 call/start/end 三段事件）：
// phase 非 end 映射 input-available（Running），end 映射 output-available
//（Completed），end 且 result.isError 为真映射 output-error（Error）。
// 待批（P2-4）：phase "pending" 映射 AI Elements 的 approval-requested
//（状态文案「待批准」），只展示参数、不得显示成运行中或已成功——批准 /
// 驳回在待批收件箱里做，批准后会话重拉，卡片随流水终态变完成或已拒绝。
// 卡内同时留参数与结果摘要，end 后不必重开卡看执行结果。

export type ToolArgs = { phase: string; args: JsonValue; result: JsonValue };

function resultRecord(result: JsonValue): { [key: string]: JsonValue } | null {
	return typeof result === "object" && result !== null && !Array.isArray(result) ? result : null;
}

function toolState(phase: string, result: JsonValue): ToolPart["state"] {
	if (phase === "pending") return "approval-requested";
	if (phase !== "end") return "input-available";
	return resultRecord(result)?.isError === true ? "output-error" : "output-available";
}

// 结果摘要行：一眼看清关键信息，不必展开 JSON（web_fetch：HTTP 200 · 内容已截断；
// web_search：N 条结果；出错时就是错误文本本身）。
function toolSummary(result: JsonValue): string | null {
	const r = resultRecord(result);
	if (!r) return null;
	if (r.isError === true) return typeof r.error === "string" && r.error ? r.error : "工具执行出错";
	const bits: string[] = [];
	if (typeof r.status === "number") bits.push(`HTTP ${r.status}`);
	if (r.truncated === true) bits.push("内容已截断");
	if (typeof r.count === "number") bits.push(`${r.count} 条结果`);
	return bits.length ? bits.join(" · ") : null;
}

export const ToolCard: ToolCallMessagePartComponent<ToolArgs> = ({ toolName, args }) => {
	const phase = args?.phase ?? "";
	const input = args?.args ?? null;
	const result = args?.result ?? null;
	const state = toolState(phase, result);
	const summary = phase === "end" ? toolSummary(result) : null;
	return (
		<Tool className="mb-0 bg-card">
			<ToolHeader type={`tool-${toolName}` as `tool-${string}`} state={state} title={toolName} />
			<ToolContent>
				{input !== null ? <ToolInput input={input} /> : null}
				{phase === "pending" ? (
					<p className="text-sm text-muted-foreground">待批准：这项写操作还没有执行。请到待批收件箱批准或驳回。</p>
				) : null}
				{phase === "end" ? (
					<>
						{summary && state !== "output-error" ? <p className="text-sm text-muted-foreground">{summary}</p> : null}
						<ToolOutput output={result} errorText={state === "output-error" ? (summary ?? "工具执行出错") : undefined} />
					</>
				) : null}
			</ToolContent>
		</Tool>
	);
};

// ---- 思考过程（reasoning part：一段思考的弱权重呈现，与正文、工具卡分开） ----
// 内容是服务商回传的推理文本（SSE thinking 事件按 seg 流式拼入，或历史流水
// 按段还原）。呈现规格（定稿）：不用边框卡片，左侧 2px 弱化色竖条 + 弱化色
// 文字，视觉次序明确低于正文与工具卡；流式中展开（头部：思考中… + 已用秒数
// + 生效挡位），段关闭/回合结束自动折叠为一行摘要「已思考 Ns · 约 M 字」，
// 点击展开全文；历史还原永远初始折叠。段是否已关闭看 durationMs（直播在段
// 关闭时由 ChatPane 补记，历史来自落盘条目）；旧落盘无 durationMs 时摘要
// 不带秒数。空段不渲染。

export type ReasoningPartData = { text: string; truncated?: boolean; level?: string; durationMs?: number; startedAt?: number };

export const ReasoningCard: DataMessagePartComponent<ReasoningPartData> = ({ data, status }) => {
	const [override, setOverride] = useState<boolean | null>(null);
	const [, setTick] = useState(0);
	const streaming = status?.type === "running" && data.durationMs === undefined;
	useEffect(() => {
		if (!streaming) return;
		const t = setInterval(() => setTick((v) => v + 1), 1000);
		return () => clearInterval(t);
	}, [streaming]);
	if (!streaming && !(data.text ?? "").trim()) return null;
	const open = override ?? streaming;
	const chars = (data.text ?? "").length;
	const elapsedSec = data.startedAt !== undefined ? Math.max(0, Math.floor((Date.now() - data.startedAt) / 1000)) : null;
	const summary =
		data.durationMs !== undefined ? `已思考 ${Math.ceil(data.durationMs / 1000)} 秒 · 约 ${chars} 字` : `思考过程 · 约 ${chars} 字`;
	return (
		<div className="border-l-2 border-muted-foreground/25 pl-3">
			<button
				type="button"
				className="flex w-full items-center gap-2 py-0.5 text-left text-[13px] text-muted-foreground"
				onClick={() => setOverride(!open)}
				aria-expanded={open}
			>
				<BrainIcon className="size-4 shrink-0" />
				{streaming ? (
					<>
						<span className="font-medium">思考中…</span>
						{elapsedSec !== null ? <span className="text-xs tabular-nums">{elapsedSec} 秒</span> : null}
						{data.level ? <span className="text-xs">挡位 {data.level}</span> : null}
					</>
				) : (
					<span className="font-medium">{summary}</span>
				)}
				<ChevronDownIcon className={`ml-auto size-4 shrink-0 transition-transform duration-150 ${open ? "" : "-rotate-90"}`} />
			</button>
			{open ? (
				<div className="pt-1 pb-1.5">
					<p className="text-[13px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">{data.text}</p>
					{data.truncated ? <p className="mt-2 text-xs text-muted-foreground">（内容过长，历史中仅保留前一部分）</p> : null}
				</div>
			) : null}
		</div>
	);
};

// ---- 系统 / 错误提示卡 ----

export type SystemPartData = { kind: string; text: string };

export const SystemCard: DataMessagePartComponent<SystemPartData> = ({ data }) => (
	<div className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm">
		<InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
		<div className="min-w-0">
			<Badge variant="outline" className="mr-2 align-middle text-[11px]">
				{data.kind}
			</Badge>
			<span className="align-middle text-foreground/90">{data.text}</span>
		</div>
	</div>
);

export type ErrorPartData = { code: string; message: string };

export const ErrorCard: DataMessagePartComponent<ErrorPartData> = ({ data }) => (
	<div className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm">
		<TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
		<div className="min-w-0">
			<span className="mr-2 font-mono text-xs font-semibold text-destructive">{data.code}</span>
			<span className="text-foreground/90">{data.message}</span>
		</div>
	</div>
);

// ---- Bot 草案卡（特殊消息卡：确认才落库，对接 draft-confirm 接口） ----

export type DraftPartData = { partId: string; draft: BotDraft; readOnly: boolean; confirmedBotName?: string };

export type DraftActions = {
	onConfirm: (partId: string, draft: BotDraft) => Promise<void>;
	onDiscard: (partId: string) => void;
};

export const DraftActionsContext = createContext<DraftActions | null>(null);

const draftFields: { label: string; value: (d: BotDraft) => string }[] = [
	{ label: "名字", value: (d) => d.name },
	{ label: "职责", value: (d) => d.systemPrompt },
	{ label: "工具", value: (d) => d.tools.join(", ") || "无" },
	{ label: "绑定仓库", value: (d) => d.repos.join(", ") || "无" },
	{ label: "记忆范围", value: (d) => d.memoryScope },
];

export const DraftCard: DataMessagePartComponent<DraftPartData> = ({ data }) => {
	const actions = useContext(DraftActionsContext);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const { draft } = data;
	const settled = data.readOnly || Boolean(data.confirmedBotName);
	const onConfirm = async () => {
		if (!actions) return;
		setBusy(true);
		setErr("");
		try {
			await actions.onConfirm(data.partId, draft);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Card className="gap-0 overflow-hidden py-0 shadow-none">
			<CardHeader className="flex flex-row items-center gap-2 border-b bg-muted/40 px-4 py-3">
				<BotIcon className="size-4 text-primary" />
				<CardTitle className="text-sm">Bot 草案卡</CardTitle>
				<Badge variant="secondary">{draft.source === "model" ? "模型抽取" : "规则兜底"}</Badge>
				{data.confirmedBotName ? (
					<Badge className="border-transparent bg-primary/15 text-primary">
						<CheckIcon className="size-3" />
						已创建
					</Badge>
				) : null}
			</CardHeader>
			<CardContent className="px-4 py-3">
				<dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1.5 text-sm">
					{draftFields.map((f) => (
						<div key={f.label} className="contents">
							<dt className="text-muted-foreground">{f.label}</dt>
							<dd className="m-0 break-words whitespace-pre-wrap">{f.value(draft)}</dd>
						</div>
					))}
				</dl>
				{data.confirmedBotName ? (
					<p className="mt-3 text-sm text-primary">已创建 bot「{data.confirmedBotName}」，未确认前不会落库的约定已满足。</p>
				) : settled ? (
					<p className="mt-3 text-sm text-muted-foreground">历史草案（只读）。</p>
				) : (
					<p className="mt-3 text-sm text-muted-foreground">未确认不会创建。</p>
				)}
				{err ? <p className="mt-2 text-sm text-destructive">{err}</p> : null}
			</CardContent>
			{!settled ? (
				<CardFooter className="gap-2 border-t px-4 py-3">
					<Button type="button" size="sm" disabled={busy || !actions} onClick={onConfirm}>
						<CheckIcon />
						{busy ? "创建中…" : "确认创建"}
					</Button>
					<Button type="button" size="sm" variant="ghost" disabled={busy || !actions} onClick={() => actions?.onDiscard(data.partId)}>
						<XIcon />
						放弃
					</Button>
				</CardFooter>
			) : null}
		</Card>
	);
};
