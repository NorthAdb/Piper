// shadcn 标准的 cn 工具：clsx 合并 class 并以 tailwind-merge 解冲突。
import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
