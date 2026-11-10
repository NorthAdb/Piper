// Piper 设置存储（文件优先）：L0-2 落模型组，L0-3 落基础资料组。
// 文件：apps/piper/data/settings-model.json、settings-profile.json（data/ 已 gitignore，秘密不进 git）。
// 语义：设置文件是配置的第一来源；模型文件不存在或字段缺失时，kernel 回退环境变量。
// 本模块只负责读写文件——绝不把环境变量里的秘密自动写进文件。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, ensureData } from "./store.mjs";

const MODEL_SETTINGS_FILE = join(DATA_DIR, "settings-model.json");

export function readModelSettingsFile() {
	if (!existsSync(MODEL_SETTINGS_FILE)) return {};
	try {
		const parsed = JSON.parse(readFileSync(MODEL_SETTINGS_FILE, "utf8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

// 部分更新：字段出现才改；apiKey 传空字符串表示清除已保存的 Key。
export function saveModelSettingsFile(patch) {
	const next = { ...readModelSettingsFile() };
	if (patch.baseUrl !== undefined) next.baseUrl = String(patch.baseUrl).trim();
	if (patch.modelId !== undefined) next.modelId = String(patch.modelId).trim();
	if (patch.apiKey !== undefined) {
		if (patch.apiKey) next.apiKey = String(patch.apiKey);
		else delete next.apiKey;
	}
	ensureData();
	writeFileSync(MODEL_SETTINGS_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
	return next;
}

// ---------- 基础资料（L0-3）：称呼与时区。「关于我」正文不在这里存——只有一份 about-me.md（store.writeAboutMe）。 ----------

const PROFILE_SETTINGS_FILE = join(DATA_DIR, "settings-profile.json");
export const DEFAULT_TIMEZONE = "Asia/Hong_Kong";

export function readProfileSettings() {
	let saved = {};
	if (existsSync(PROFILE_SETTINGS_FILE)) {
		try {
			const parsed = JSON.parse(readFileSync(PROFILE_SETTINGS_FILE, "utf8"));
			if (parsed && typeof parsed === "object") saved = parsed;
		} catch {
			saved = {};
		}
	}
	return {
		displayName: typeof saved.displayName === "string" ? saved.displayName : "",
		timezone: typeof saved.timezone === "string" && saved.timezone ? saved.timezone : DEFAULT_TIMEZONE,
	};
}

// 部分更新：字段出现才改。时区传空串视为恢复缺省。
export function saveProfileSettings(patch) {
	const next = { ...readProfileSettings() };
	if (patch.displayName !== undefined) next.displayName = String(patch.displayName).trim().slice(0, 40);
	if (patch.timezone !== undefined) next.timezone = String(patch.timezone).trim() || DEFAULT_TIMEZONE;
	ensureData();
	writeFileSync(PROFILE_SETTINGS_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
	return next;
}
