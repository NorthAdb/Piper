// Composer 底部工具行的思考挡位 chip：展示当前挡位，点开小菜单改挡。
// 数据来自 GET /api/settings/model（thinkingLevel 已存挡位 + thinkingLevels
// 该模型可选挡位），选中即 PUT {thinkingLevel}（部分更新，后端热生效、
// 下一轮对话生效）。设置页模型表单是同一份数据的表单版，两处各自加载、
// 互不感知。加载失败时退化为只展示挡位不可点（拿不到已存值，按服务端
// 缺省 off 展示）；轮次进行中保存照常允许，UI 不特判下一轮才生效。
import { BrainIcon, CheckIcon, ChevronDownIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getModelSettings, UnauthorizedError, updateThinkingLevel } from "./api";
import { cn } from "@/lib/utils";

// 七挡词表的中文展示（菜单里英文原词作副文本；词表外的值回退原词）
const LEVEL_LABELS: Record<string, string> = {
	off: "关闭",
	minimal: "极简",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "极高",
	max: "最大",
};

export function ThinkingLevelChip({ onUnauthorized }: { onUnauthorized: () => void }) {
	const [level, setLevel] = useState<string | null>(null);
	const [levels, setLevels] = useState<string[] | null>(null);
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		let cancelled = false;
		getModelSettings()
			.then((v) => {
				if (cancelled) return;
				setLevel(v.thinkingLevel || "off");
				setLevels(v.thinkingLevels);
			})
			.catch((e: unknown) => {
				if (cancelled) return;
				if (e instanceof UnauthorizedError) onUnauthorized();
				setLevel("off");
			});
		return () => {
			cancelled = true;
		};
	}, [onUnauthorized]);

	// 菜单非 modal：点外部即收起，composer 输入不被打断
	useEffect(() => {
		if (!open) return;
		const close = (e: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [open]);

	const save = (next: string) => {
		setOpen(false);
		void updateThinkingLevel(next)
			.then((v) => {
				setLevel(v.thinkingLevel || "off");
				setLevels(v.thinkingLevels);
			})
			.catch((e: unknown) => {
				if (e instanceof UnauthorizedError) onUnauthorized();
			});
	};

	// 首次加载未返回前不渲染：先显示「关闭」再跳实际值是假的挡位变化；
	// 失败路径会把 level 置 off，降级展示不受影响
	if (level === null) return null;
	// 加载失败时 levels 为 null：chip 只展示、不可点
	const current = level ?? "off";
	const selectable = levels !== null;
	return (
		<div
			ref={rootRef}
			className="relative"
			onKeyDown={(e) => {
				if (e.key === "Escape") setOpen(false);
			}}
		>
			<button
				type="button"
				disabled={!selectable}
				aria-expanded={open}
				aria-label="思考挡位"
				title={selectable ? "思考挡位" : undefined}
				onClick={() => setOpen((v) => !v)}
				className={cn(
					"flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors",
					current === "off"
						? "border-border text-muted-foreground hover:text-foreground"
						: "border-primary/30 bg-primary/10 text-primary",
				)}
			>
				<BrainIcon className="size-3.5 shrink-0" />
				<span>{LEVEL_LABELS[current] ?? current}</span>
				{selectable ? <ChevronDownIcon className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-180")} /> : null}
			</button>
			{open && levels ? (
				<div aria-label="选择思考挡位" className="absolute bottom-full left-0 z-50 mb-1.5 min-w-36 rounded-lg border bg-popover p-1 shadow-md">
					{levels.map((l) => (
						<button
							key={l}
							type="button"
							aria-current={l === current ? "true" : undefined}
							onClick={() => save(l)}
							className={cn(
								"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground",
								l === current ? "text-primary" : "text-foreground",
							)}
						>
							<span>{LEVEL_LABELS[l] ?? l}</span>
							<span className="ml-auto font-mono text-[10px] text-muted-foreground">{l}</span>
							{l === current ? <CheckIcon className="size-3.5 shrink-0" /> : null}
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}
