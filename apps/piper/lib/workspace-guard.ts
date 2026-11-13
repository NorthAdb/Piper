// 每 bot 文件工作区硬闸（P2-2）：文件工具执行前必须先过这里。
// 判定口径：候选路径经 resolveRealPath（逐分量展开符号链接，悬挂链接也算
// 出最终落点）后，必须落在该 bot 的工作区根内，或该 bot 的
// workspaceAllowedRoots 某个根内；其余一律 escape。放行时返回的就是判定
// 所用的真实路径，工具直接拿它落盘——检查与写入用同一条路径。
// 策略层（PolicyEngine）即便放行，execute() 仍要再过本闸——策略不能把
// 越界改成允许，本闸是最后一道、也是唯一算数的边界。
import { isAbsolute, resolve } from "node:path";
import { botWorkspace, DATA_DIR, getBot, isPathWithin, resolveRealPath } from "./store.ts";

export type WorkspaceResolveResult = { ok: true; path: string } | { ok: false; reason: "escape" };

const ESCAPE: WorkspaceResolveResult = { ok: false, reason: "escape" };

export class WorkspaceGuard {
	static resolve(botId: string, rawPath: string): WorkspaceResolveResult {
		// NUL 字节在 Guard 层直接 escape：Node 的 fs 会拒，但边界判定不假手他人。
		if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.includes("\0")) return ESCAPE;
		let root: string;
		try {
			root = botWorkspace(botId);
		} catch {
			// botId 非法或工作区本身已被链接出界：对工具层一律按越界处理，不抛
			return ESCAPE;
		}
		const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
		let candidateReal: string;
		let rootReal: string;
		try {
			candidateReal = resolveRealPath(candidate);
			rootReal = resolveRealPath(root);
		} catch {
			// 链接环等无法算清落点的路径，按越界处理
			return ESCAPE;
		}
		if (isPathWithin(candidateReal, rootReal)) {
			return { ok: true, path: candidateReal };
		}
		const bot = getBot(botId);
		for (const allowed of bot?.workspaceAllowedRoots ?? []) {
			if (typeof allowed !== "string" || allowed.length === 0) continue;
			const allowedAbs = isAbsolute(allowed) ? resolve(allowed) : resolve(DATA_DIR, allowed);
			let allowedReal: string;
			try {
				allowedReal = resolveRealPath(allowedAbs);
			} catch {
				continue;
			}
			if (isPathWithin(candidateReal, allowedReal)) {
				return { ok: true, path: candidateReal };
			}
		}
		return ESCAPE;
	}
}
