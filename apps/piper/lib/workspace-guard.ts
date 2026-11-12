// 每 bot 文件工作区硬闸（P2-2）：文件工具执行前必须先过这里。
// 判定口径：候选路径经 realpath（最长已存在前缀）后，必须落在该 bot 的
// 工作区根内，或该 bot 的 workspaceAllowedRoots 某个根内；其余一律 escape。
// 策略层（PolicyEngine）即便放行，execute() 仍要再过本闸——策略不能把
// 越界改成允许，本闸是最后一道、也是唯一算数的边界。
import { isAbsolute, resolve } from "node:path";
import { botWorkspace, DATA_DIR, getBot, isPathWithin, realpathExistingPrefix } from "./store.ts";

export type WorkspaceResolveResult = { ok: true; path: string } | { ok: false; reason: "escape" };

const ESCAPE: WorkspaceResolveResult = { ok: false, reason: "escape" };

export class WorkspaceGuard {
	// 返回的 path 是归一化后的字面绝对路径（供 fs 操作）；是否越界按其实
	// realpath 判定，因此符号链接指向根外、.. 穿越、未授权绝对路径都逃不掉。
	static resolve(botId: string, rawPath: string): WorkspaceResolveResult {
		if (typeof rawPath !== "string" || rawPath.length === 0) return ESCAPE;
		let root: string;
		try {
			root = botWorkspace(botId);
		} catch {
			// botId 非法或工作区本身已被链接出界：对工具层一律按越界处理，不抛
			return ESCAPE;
		}
		const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
		const candidateReal = realpathExistingPrefix(candidate);
		if (isPathWithin(candidateReal, realpathExistingPrefix(root))) {
			return { ok: true, path: candidate };
		}
		const bot = getBot(botId);
		for (const allowed of bot?.workspaceAllowedRoots ?? []) {
			if (typeof allowed !== "string" || allowed.length === 0) continue;
			const allowedAbs = isAbsolute(allowed) ? resolve(allowed) : resolve(DATA_DIR, allowed);
			if (isPathWithin(candidateReal, realpathExistingPrefix(allowedAbs))) {
				return { ok: true, path: candidate };
			}
		}
		return ESCAPE;
	}
}
