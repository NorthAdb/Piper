// 亮/暗主题状态：单一事实源是 <html> 的 .dark 类（index.css 以 html:not(.dark)
// 出浅色值）。index.html 的防闪烁内联脚本在首帧前按同一 localStorage key 写好
// 类，本模块只负责运行期切换：写类 + 持久化 + 通知订阅者。
export type Theme = "light" | "dark";

const STORAGE_KEY = "piper-theme";

const listeners = new Set<() => void>();

/** 读当前主题（以 html 类为准，避免与内联脚本各持一份状态）。 */
export const getTheme = (): Theme =>
	document.documentElement.classList.contains("dark") ? "dark" : "light";

/** 切换主题并持久化；localStorage 不可写时仅当次会话生效。 */
export function setTheme(theme: Theme): void {
	document.documentElement.classList.toggle("dark", theme === "dark");
	try {
		localStorage.setItem(STORAGE_KEY, theme);
	} catch {}
	for (const notify of listeners) notify();
}

/** 订阅主题变化，返回退订函数。 */
export function subscribeTheme(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
