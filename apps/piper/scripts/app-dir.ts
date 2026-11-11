// 工装脚本专用：定位 Piper 应用根目录（apps/piper）。
// 规则与 lib/store.ts 的 findAppDir 相同——从本文件目录向上逐级找 package.json
// 所在目录。脚本源文件在 scripts/、编译产物在 dist/scripts/，两处到应用根的
// 层数不同，固定层数推导必然有一处错位，故不能写死上跳层数。
// 本模块只找根目录：不 import store（store 加载时会固化 DATA_DIR，必须等脚本
// 先设好 PIPER_DATA_DIR 等环境变量后再加载）、不读设置、不写盘。
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function findAppDir(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) throw new Error("无法定位 Piper 应用根目录（向上未找到 package.json）");
		dir = parent;
	}
}

export const APP_DIR = findAppDir();
