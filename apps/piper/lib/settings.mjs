// Piper 设置存储（文件优先）：L0-2 落模型组，L0-3 落基础资料组，L0-4 落连接器组（GitHub 令牌槽）。
// 文件：apps/piper/data/settings-{model,profile,github}.json（data/ 已 gitignore，秘密不进 git）。
// 语义：设置文件是配置的第一来源；模型文件不存在或字段缺失时，kernel 回退环境变量。
// 本模块只负责读写文件——绝不把环境变量里的秘密自动写进文件。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, ensureData, listBots } from "./store.mjs";

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

// ---------- 连接器（L0-4）：统一槽位。GitHub 令牌是唯一真配置项，其余先占位。 ----------

const GITHUB_SETTINGS_FILE = join(DATA_DIR, "settings-github.json");

export function readGithubSettingsFile() {
	if (!existsSync(GITHUB_SETTINGS_FILE)) return {};
	try {
		const parsed = JSON.parse(readFileSync(GITHUB_SETTINGS_FILE, "utf8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

// token 传空字符串表示清除已保存的令牌。
export function saveGithubSettingsFile(patch) {
	const next = { ...readGithubSettingsFile() };
	if (patch.token !== undefined) {
		if (patch.token) next.token = String(patch.token);
		else delete next.token;
	}
	ensureData();
	writeFileSync(GITHUB_SETTINGS_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
	return next;
}

// GitHub 令牌的唯一读取入口：设置文件优先，缺失时回退 GITHUB_TOKEN 环境变量。
// scan、（后续）网关写调用都只能经这里取令牌，不许再有第二套入口。
export function githubToken() {
	return readGithubSettingsFile().token || process.env.GITHUB_TOKEN || "";
}

// 连接器统一形状：id / name / purpose / status(placeholder|unconfigured|connected) /
// statusNote（点开看的口径）/ bots（可用范围）/ access（读写级别）/ configurable。
// tokenHint 只出现在 GitHub 卡上，且只有末四位掩码。
export function listConnectors() {
	const token = githubToken();
	const githubBots = listBots()
		.filter((b) => (b.tools ?? []).some((t) => t.startsWith("github")))
		.map((b) => b.id);
	return [
		{
			id: "github",
			name: "GitHub",
			purpose: "绑定仓库的只读扫描（日报、PR / issue / CI 概况）；令牌就绪后供分诊闭环的有闸写入使用。",
			status: token ? "connected" : "unconfigured",
			statusNote: token
				? "令牌已配置，扫描请求会带上它（限额更高）。写入仍未开放：评论等写操作要等分诊闭环的薄网关（P1-6）。"
				: "未配置令牌：当前走公开 API 只读，限额较低。在下方粘贴 PAT 即可保存，之后扫描自动使用。",
			bots: githubBots.length ? githubBots : ["repo-keeper"],
			access: "read",
			configurable: true,
			tokenHint: token ? `••••${token.slice(-4)}` : "",
		},
		{
			id: "web",
			name: "网页查询",
			purpose: "主 bot 只读打开公开网页（web.fetch）并在对话里引用内容。",
			status: "unconfigured",
			statusNote: "即将接入（L0-6）：只读抓取，带超时与体积上限，并拒绝本机 / 私网 / 元数据地址（防 SSRF）。web.search 仅在配置搜索端点后可用。",
			bots: ["piper-main"],
			access: "read",
			configurable: false,
		},
		{
			id: "calendar",
			name: "日历",
			purpose: "日程读取，以及经网关确认后的日程写入。",
			status: "placeholder",
			statusNote: "尚未接入：真连接排在有闸分诊闭环之后。只读可以先行；可写必须进网关、先确认后生效。",
			bots: [],
			access: "read-write-gated",
			configurable: false,
		},
		{
			id: "mail",
			name: "邮件",
			purpose: "邮件收取与监控；发送是副作用，必须受控。",
			status: "placeholder",
			statusNote: "尚未接入：真连接排在有闸分诊闭环之后。收与监控可规划；「发」必须先落成草稿、经全局收件箱确认后才发出，不能在对话里直接发送。",
			bots: [],
			access: "read-write-gated",
			configurable: false,
		},
	];
}
