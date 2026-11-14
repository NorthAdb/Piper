// 三栏布局左右栏的拖拽调宽（App 三栏 grid 的列宽状态）：宽度持久化在本浏览器，
// 渲染与拖拽都按当前窗口宽收口，中栏永远保留最小可读宽度——窄窗口下压两侧，
// 而不是把对话区挤没。
import { type PointerEvent as ReactPointerEvent, useEffect, useState } from "react";

const MIDDLE_MIN = 320;
// 极窄窗口下两侧可被压到的绝对下限（低于各自 min，保中栏优先）
const FLOOR = 160;

const LIMITS = {
	left: { min: 220, max: 400, fallback: 264 },
	right: { min: 280, max: 560, fallback: 360 },
} as const;

type Side = keyof typeof LIMITS;

const storageKey = (side: Side) => `piper-col-${side}`;

const readStored = (side: Side): number => {
	try {
		const raw = Number(localStorage.getItem(storageKey(side)));
		if (Number.isFinite(raw) && raw >= LIMITS[side].min) return raw;
	} catch {
		// localStorage 不可写（隐私模式等）：用缺省宽，本次会话内拖拽仍生效
	}
	return LIMITS[side].fallback;
};

const persist = (side: Side, width: number) => {
	try {
		localStorage.setItem(storageKey(side), String(Math.round(width)));
	} catch {}
};

// 先收左列再收右列：右列以收口后的左列做上限，一次求值即稳定不回摆
const clampPair = (raw: { left: number; right: number }) => {
	const usable = Math.max(window.innerWidth - MIDDLE_MIN, LIMITS.left.min + LIMITS.right.min);
	const leftUpper = Math.min(LIMITS.left.max, usable - LIMITS.right.min);
	const left = Math.min(Math.max(raw.left, LIMITS.left.min), Math.max(leftUpper, FLOOR));
	const rightUpper = Math.min(LIMITS.right.max, usable - left);
	const right = Math.min(Math.max(raw.right, LIMITS.right.min), Math.max(rightUpper, FLOOR));
	return { left, right };
};

/** 左右栏宽度状态与拖拽启动器：widths 是按窗口收口后的实际列宽，startDrag 供两栏内缘的手柄绑定。 */
export function useColumnWidths() {
	const [raw, setRaw] = useState(() => ({ left: readStored("left"), right: readStored("right") }));
	// 窗口缩放时重渲染，让 clamp 按新窗口宽重新收口
	const [, setResizeTick] = useState(0);
	useEffect(() => {
		const onResize = () => setResizeTick((v) => v + 1);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	const startDrag = (side: Side) => (event: ReactPointerEvent<HTMLButtonElement>) => {
		const bar = event.currentTarget.parentElement;
		if (!bar) return;
		const rect = bar.getBoundingClientRect();
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		const onMove = (move: PointerEvent) => {
			setRaw((prev) => ({ ...prev, [side]: side === "left" ? move.clientX - rect.left : rect.right - move.clientX }));
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			setRaw((prev) => {
				persist(side, prev[side]);
				return prev;
			});
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};

	return { widths: clampPair(raw), startDrag };
}
