// 中栏消息 part 的自定义渲染：assistant-ui MessagePrimitive.Parts 的组件槽位实现。
// 工具卡用 AI Elements 的 Tool 组件（components/ai-elements/tool，真引入源码）；
// 草案/系统/错误卡用 shadcn Card/Badge/Button 与设计系统色调实现。
import type { DataMessagePartComponent, TextMessagePartComponent, ToolCallMessagePartComponent } from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { BotIcon, CheckIcon, InfoIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { createContext, useContext, useState } from "react";
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

// ---- 工具卡（AI Elements Tool：Collapsible + 状态徽标 + CodeBlock 详情） ----
// 后端 tool 事件的 phase 是 call/start/end：进行中映射 input-available，
// end 映射 output-available，end 且 detail.isError 为真映射 output-error。

export type ToolArgs = { phase: string; detail: JsonValue };

function toolState(phase: string, detail: JsonValue): ToolPart["state"] {
	if (phase !== "end") return "input-available";
	if (typeof detail === "object" && detail !== null && !Array.isArray(detail) && detail.isError === true) {
		return "output-error";
	}
	return "output-available";
}

export const ToolCard: ToolCallMessagePartComponent<ToolArgs> = ({ toolName, args }) => {
	const phase = args?.phase ?? "";
	const detail = args?.detail ?? null;
	const state = toolState(phase, detail);
	return (
		<Tool className="mb-0 border-border bg-card/60">
			<ToolHeader type={`tool-${toolName}` as `tool-${string}`} state={state} title={toolName} />
			<ToolContent>
				{phase === "end" ? (
					<ToolOutput output={detail} errorText={state === "output-error" ? "工具执行出错" : undefined} />
				) : (
					<ToolInput input={detail ?? {}} />
				)}
			</ToolContent>
		</Tool>
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
		<Card className="gap-0 overflow-hidden border-primary/40 py-0 shadow-none">
			<CardHeader className="flex flex-row items-center gap-2 border-b bg-primary/10 px-4 py-3">
				<BotIcon className="size-4 text-primary" />
				<CardTitle className="text-sm">Bot 草案卡</CardTitle>
				<Badge variant="secondary">{draft.source === "model" ? "模型抽取" : "规则兜底"}</Badge>
				{data.confirmedBotName ? (
					<Badge className="border-transparent bg-emerald-500/15 text-emerald-400">
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
					<p className="mt-3 text-sm text-emerald-400">已创建 bot「{data.confirmedBotName}」，未确认前不会落库的约定已满足。</p>
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
