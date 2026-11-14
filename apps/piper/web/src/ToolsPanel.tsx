// 桌面「工具」页签（P2-5）：当前 bot 的工具注册表全文（GET /api/bots/:id/tools）。
// 回答四件事：这个 bot 现在到底有哪些工具、参数是什么、会不会先问人、
// 模型能不能真正调用。含未物化的声明项（如 github.read、bots.draft）——
// 如实标「未提供给模型」，不假装已挂上。数据与服务端注册表同源，界面只呈现。
import { ChevronDownIcon, WrenchIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { backfillPresetTools, listBotTools, UnauthorizedError } from "./api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ToolRegistryItem } from "./model";

const POLICY_TEXT: Record<ToolRegistryItem["policy"], string> = {
	allow: "允许",
	ask: "须批准",
	deny: "不可用",
};

const EXPOSURE_TEXT: Record<ToolRegistryItem["modelExposure"], string> = {
	offered: "已提供给模型",
	deferred: "未启用 / 未配置，未提供给模型",
	hidden: "未提供给模型",
};

type ParamField = { name: string; type: string; required: boolean; description: string };

// 从 JSON Schema 里取出可展示的字段行：只认 object 形状的 properties；
// 其余形状回 null，界面回落为整段 JSON 展示，不假装解析过。
function paramFields(parameters: unknown): ParamField[] | null {
	if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return null;
	const schema = parameters as { properties?: Record<string, unknown>; required?: unknown };
	if (!schema.properties || typeof schema.properties !== "object") return null;
	const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
	return Object.entries(schema.properties).map(([name, raw]) => {
		const p = raw && typeof raw === "object" ? (raw as { type?: unknown; description?: unknown; enum?: unknown }) : {};
		const type = Array.isArray(p.enum) ? p.enum.map(String).join(" | ") : typeof p.type === "string" ? p.type : "unknown";
		return { name, type, required: required.has(name), description: typeof p.description === "string" ? p.description : "" };
	});
}

function ToolCard({ item }: { item: ToolRegistryItem }) {
	const [open, setOpen] = useState(false);
	const fields = paramFields(item.parameters);
	return (
		<div className="rounded-lg border bg-card px-4 py-3.5">
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 truncate text-sm font-medium">{item.label}</span>
				<span
					className={cn(
						"flex shrink-0 items-center gap-1.5 text-xs",
						item.modelExposure === "offered" ? "text-emerald-400" : "text-muted-foreground",
					)}
				>
					<span className={cn("size-1.5 rounded-full", item.modelExposure === "offered" ? "bg-emerald-400" : "bg-muted-foreground/50")} />
					{EXPOSURE_TEXT[item.modelExposure]}
				</span>
			</div>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1.5 text-xs text-muted-foreground">
				<span className="font-mono">{item.name}</span>
				<span>
					策略：
					<span className={cn(item.policy === "allow" && "text-emerald-400", item.policy === "ask" && "text-amber-400")}>
						{POLICY_TEXT[item.policy]}
					</span>
				</span>
				<span>
					来源：{item.source.kind} · {item.source.id}
				</span>
				{!item.implemented ? <span>尚未实现为工具</span> : null}
			</div>
			{item.description ? <p className="pt-2 text-[13px] leading-relaxed text-muted-foreground">{item.description}</p> : null}
			<button
				type="button"
				className="flex items-center gap-1 pt-2.5 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
				onClick={() => setOpen((v) => !v)}
			>
				<ChevronDownIcon className={cn("size-3.5 transition-transform duration-150", open && "rotate-180")} />
				{open ? "收起参数" : "展开参数"}
			</button>
			{open ? (
				<div className="pt-2">
					{fields === null ? (
						<pre className="overflow-x-auto rounded-md border bg-background/50 p-2.5 font-mono text-xs break-words whitespace-pre-wrap">
							{JSON.stringify(item.parameters, null, 2)}
						</pre>
					) : fields.length === 0 ? (
						<p className="text-xs text-muted-foreground">无参数字段。</p>
					) : (
						<div className="flex flex-col gap-1.5">
							{fields.map((f) => (
								<div key={f.name} className="rounded-md border bg-background/50 px-2.5 py-2 text-xs">
									<span className="font-mono">{f.name}</span>
									<span className="text-muted-foreground"> : {f.type}</span>
									{f.required ? <span className="pl-2 text-amber-400">必填</span> : <span className="pl-2 text-muted-foreground">可选</span>}
									{f.description ? <span className="block pt-1 leading-relaxed text-muted-foreground">{f.description}</span> : null}
								</div>
							))}
						</div>
					)}
				</div>
			) : null}
		</div>
	);
}

export function ToolsPanel({
	botId,
	onUnauthorized,
	onBotUpdated,
}: {
	botId: string | null;
	onUnauthorized: () => void;
	onBotUpdated?: () => void;
}) {
	const [items, setItems] = useState<ToolRegistryItem[]>([]);
	const [presetGaps, setPresetGaps] = useState<string[]>([]);
	const [backfilling, setBackfilling] = useState(false);
	const [err, setErr] = useState("");

	const load = useCallback(() => {
		if (!botId) {
			setItems([]);
			setPresetGaps([]);
			return;
		}
		listBotTools(botId)
			.then(({ tools, presetGaps: gaps }) => {
				setItems(tools);
				setPresetGaps(gaps);
			})
			.catch((e: unknown) => {
				if (e instanceof UnauthorizedError) onUnauthorized();
				else setErr(e instanceof Error ? e.message : String(e));
			});
	}, [botId, onUnauthorized]);

	// 预置声明补齐（P2-9 试用后修复）：只加不删，补完刷新本页签并通知
	// 外层重拉 bot 列表（编辑表单里的工具集随之更新）。
	const onBackfill = () => {
		if (!botId || backfilling) return;
		setBackfilling(true);
		backfillPresetTools(botId)
			.then(({ tools, presetGaps: gaps }) => {
				setItems(tools);
				setPresetGaps(gaps);
				onBotUpdated?.();
			})
			.catch((e: unknown) => {
				if (e instanceof UnauthorizedError) onUnauthorized();
				else setErr(e instanceof Error ? e.message : String(e));
			})
			.finally(() => setBackfilling(false));
	};

	useEffect(() => {
		setErr("");
		load();
	}, [load]);

	if (!botId) return null;
	if (err) {
		return (
			<div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
				<span>{err}</span>
			</div>
		);
	}
	if (items.length === 0) {
		return (
			<div className="flex flex-col items-center gap-2.5 px-4 py-10 text-center">
				<span className="flex size-9 items-center justify-center rounded-full border bg-background/50 text-muted-foreground">
					<WrenchIcon className="size-4" />
				</span>
				<p className="text-sm text-muted-foreground">该 bot 暂无登记工具</p>
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-3">
			{presetGaps.length > 0 ? (
				<div className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-3.5">
					<p className="text-sm font-medium">这个预置 bot 缺少后续版本新增的工具声明</p>
					<p className="pt-1 text-[13px] leading-relaxed text-muted-foreground">
						缺失：<span className="font-mono">{presetGaps.join(", ")}</span>
						。它是旧版本创建的，升级不会自动改已有 bot 的工具集。补齐只会新增这些声明，不动其他设置。
					</p>
					<Button type="button" size="sm" className="mt-2.5" disabled={backfilling} onClick={onBackfill}>
						{backfilling ? "补齐中…" : "补齐声明"}
					</Button>
				</div>
			) : null}
			{items.map((item) => (
				<ToolCard key={item.name} item={item} />
			))}
		</div>
	);
}
