// 设置页「外观」组：亮/暗主题选择。主题是每浏览器的本地偏好（localStorage +
// index.html 防闪烁脚本），不进服务端设置文件，所以不与基础资料的服务端表单混同组。
// 卡片结构与「模型」组同构（默认 Card 内边距、无分隔线、左对齐），标题字号一致。
import { MoonIcon, SunIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { getTheme, setTheme, subscribeTheme, type Theme } from "./theme";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// 主题选项与图标指示当前态（深色显 Moon）：选项卡即状态本身，不做二值翻转。
const THEME_OPTIONS: { value: Theme; label: string; icon: typeof SunIcon }[] = [
	{ value: "dark", label: "深色", icon: MoonIcon },
	{ value: "light", label: "浅色", icon: SunIcon },
];

export function AppearanceSettings() {
	const theme = useSyncExternalStore(subscribeTheme, getTheme);
	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">主题</CardTitle>
				<CardDescription>选择界面配色。仅保存在本浏览器，不同步到服务端。</CardDescription>
			</CardHeader>
			<CardContent className="flex gap-2">
				{THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
					<button
						key={value}
						type="button"
						aria-pressed={theme === value}
						onClick={() => setTheme(value)}
						className={cn(
							"flex h-9 items-center gap-2 rounded-lg border px-4 text-sm transition-colors duration-150",
							theme === value ? "border-primary/40 bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
						)}
					>
						<Icon className="size-4" />
						{label}
					</button>
				))}
			</CardContent>
		</Card>
	);
}
