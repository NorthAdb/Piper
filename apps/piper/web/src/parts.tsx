// 中栏消息 part 的自定义渲染：assistant-ui MessagePrimitive.Parts 的组件槽位实现。
// 工具卡与状态呈现借鉴 shadcn/ui AI Elements 的 Tool 组件形态（头部状态徽标 + 可折叠内容区），
// 按其公开形态自行实现等价组件，未引入 AI Elements 本体（借鉴清单见 README）。
import type { DataMessagePartComponent, TextMessagePartComponent, ToolCallMessagePartComponent } from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { createContext, useContext, useState } from "react";
import remarkGfm from "remark-gfm";
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

export const PlainText: TextMessagePartComponent = ({ text }) => <span className="user-text">{text}</span>;

// ---- 工具卡（借鉴 AI Elements Tool：标题行 + 状态徽标 + 折叠详情） ----

export type ToolArgs = { phase: string; detail: JsonValue };

export const ToolCard: ToolCallMessagePartComponent<ToolArgs> = ({ toolName, args, status }) => {
	const [open, setOpen] = useState(false);
	const phase = args?.phase ?? "";
	const running = status.type === "running" || phase === "start";
	return (
		<div className={`tool-card${running ? " is-running" : ""}`}>
			<button type="button" className="tool-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
				<svg className="tool-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
					<path
						d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L14 13l-3-3 3.7-3.7z"
						fill="currentColor"
					/>
				</svg>
				<span className="tool-name">{toolName}</span>
				<span className={`badge ${running ? "badge-run" : "badge-done"}`}>{running ? "运行中" : "完成"}</span>
				{phase ? <span className="tool-phase">{phase}</span> : null}
				<span className={`chev${open ? " open" : ""}`}>▸</span>
			</button>
			{open ? (
				<div className="tool-body">
					<div className="tool-body-label">详情</div>
					<pre>{JSON.stringify(args?.detail ?? null, null, 2)}</pre>
				</div>
			) : null}
		</div>
	);
};

// ---- 系统 / 错误提示卡 ----

export type SystemPartData = { kind: string; text: string };

export const SystemCard: DataMessagePartComponent<SystemPartData> = ({ data }) => (
	<div className="sys-card">
		<span className="sys-kind">{data.kind}</span>
		<span>{data.text}</span>
	</div>
);

export type ErrorPartData = { code: string; message: string };

export const ErrorCard: DataMessagePartComponent<ErrorPartData> = ({ data }) => (
	<div className="err-card">
		<span className="err-code">{data.code}</span>
		<span>{data.message}</span>
	</div>
);

// ---- Bot 草案卡（特殊消息卡：确认才落库，对接 draft-confirm 接口） ----

export type DraftPartData = { partId: string; draft: BotDraft; readOnly: boolean; confirmedBotName?: string };

export type DraftActions = {
	onConfirm: (partId: string, draft: BotDraft) => Promise<void>;
	onDiscard: (partId: string) => void;
};

export const DraftActionsContext = createContext<DraftActions | null>(null);

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
		<div className="draft-card">
			<div className="draft-head">
				<b>Bot 草案卡</b>
				<span className="badge badge-src">{draft.source === "model" ? "模型抽取" : "规则兜底"}</span>
				{data.confirmedBotName ? <span className="badge badge-done">已创建</span> : null}
			</div>
			<dl className="draft-fields">
				<dt>名字</dt>
				<dd>{draft.name}</dd>
				<dt>职责</dt>
				<dd>{draft.systemPrompt}</dd>
				<dt>工具</dt>
				<dd>{draft.tools.join(", ") || "无"}</dd>
				<dt>绑定仓库</dt>
				<dd>{draft.repos.join(", ") || "无"}</dd>
				<dt>记忆范围</dt>
				<dd>{draft.memoryScope}</dd>
			</dl>
			{data.confirmedBotName ? (
				<p className="draft-done">已创建 bot「{data.confirmedBotName}」，未确认前不会落库的约定已满足。</p>
			) : settled ? (
				<p className="draft-note">历史草案（只读）。</p>
			) : (
				<>
					<p className="draft-note">未确认不会创建。</p>
					<div className="draft-actions">
						<button type="button" className="primary" disabled={busy || !actions} onClick={onConfirm}>
							{busy ? "创建中…" : "确认创建"}
						</button>
						<button type="button" disabled={busy || !actions} onClick={() => actions?.onDiscard(data.partId)}>
							放弃
						</button>
					</div>
					{err ? <p className="draft-err">{err}</p> : null}
				</>
			)}
		</div>
	);
};
