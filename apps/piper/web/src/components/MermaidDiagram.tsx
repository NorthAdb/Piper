// mermaid 图表渲染（懒加载边界）：mermaid 体积大，其静态 import 只存在于本文件，
// 经 parts.tsx 的 React.lazy 在首个 mermaid 围栏出现时才拉取对应 chunk。渲染成功
// 显示 svg（居中限宽、宽图横向滚动），失败给错误占位卡（可展开原始代码）；图表
// 主题跟随应用主题（dark→dark / light→neutral），切换经 theme 订阅重渲染。
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import mermaid from "mermaid";
import { getTheme, subscribeTheme } from "@/theme";
import { cn } from "@/lib/utils";

type RenderState = { phase: "pending" } | { phase: "done"; svg: string } | { phase: "failed" };

// mermaid.render 以 id 建临时 DOM（含 svg 根节点），需全局唯一，模块内自增即可
let renderSeq = 0;

// mermaid 默认输出响应式 svg（width="100%" + style max-width: 自然宽），整图随
// 容器缩放、永不滚动；把根节点的 max-width 改写成显式 width，宽图才走容器横向
// 滚动（自然宽来自 mermaid 自算的 max-width 值，缺失时保留响应式兜底）
function naturalWidthSvg(svg: string): string {
	const match = /max-width: ([\d.]+)px/.exec(svg);
	if (!match) return svg;
	return svg.replace(/<svg[^>]*>/, (root) => root.replace(' width="100%"', "").replace(/max-width: [\d.]+px/, `width: ${match[1]}px`));
}

export default function MermaidDiagram({ code }: { code: string }) {
	const theme = useSyncExternalStore(subscribeTheme, getTheme);
	const [render, setRender] = useState<RenderState>({ phase: "pending" });
	const [sourceOpen, setSourceOpen] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setRender({ phase: "pending" });
		mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: theme === "dark" ? "dark" : "neutral" });
		mermaid
			.render(`piper-mermaid-${++renderSeq}`, code)
			.then((r) => {
				if (!cancelled) setRender({ phase: "done", svg: naturalWidthSvg(r.svg) });
			})
			.catch(() => {
				if (!cancelled) setRender({ phase: "failed" });
			});
		return () => {
			cancelled = true;
		};
	}, [code, theme]);

	if (render.phase === "done") {
		return <div data-mermaid dangerouslySetInnerHTML={{ __html: render.svg }} />;
	}
	if (render.phase === "failed") {
		return (
			<div data-mermaid>
				<div className="rounded-lg border bg-muted/40 px-3 py-2.5 text-sm">
					<p className="m-0 text-muted-foreground">图表渲染失败，源码可能不是合法的 mermaid 语法。</p>
					<button
						type="button"
						className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
						aria-expanded={sourceOpen}
						onClick={() => setSourceOpen(!sourceOpen)}
					>
						<ChevronDownIcon className={cn("size-3.5 transition-transform duration-150", sourceOpen ? "" : "-rotate-90")} />
						原始代码
					</button>
					{sourceOpen ? <pre className="mt-2 mb-0 max-h-64 overflow-auto"><code>{code}</code></pre> : null}
				</div>
			</div>
		);
	}
	return (
		<div data-mermaid>
			<p className="py-1 text-center text-xs text-muted-foreground">正在渲染图表…</p>
		</div>
	);
}
