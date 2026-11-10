// Piper 设置存储（文件优先）：L0-2 落模型组，L0-3 落基础资料组，L0-4 落连接器组（GitHub 令牌槽）。
// 文件：apps/piper/data/settings-{model,profile,github}.json（data/ 已 gitignore，秘密不进 git）。
// 语义：设置文件是配置的第一来源；模型文件不存在或字段缺失时，kernel 回退环境变量。
// 本模块只负责读写文件——绝不把环境变量里的秘密自动写进文件。
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, ensureData, listBots, writeFileAtomicSync } from "./store.mjs";

// 设置文件含秘密（模型 Key、GitHub 令牌）：写盘权限钉死 0600（R7）。mode 作用于
// 临时文件、rename 后即为目标文件权限；随后的 chmodSync 再兜一层。落盘走临时文件
// + rename（R10），写一半崩溃不会把设置文件截成坏 JSON。
function writeSettingsFile(file, data) {
	ensureData();
	writeFileAtomicSync(file, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
	chmodSync(file, 0o600);
}

// 秘密读回掩码的唯一口径：≤8 位的短秘密回固定掩码——末四位掩码在短秘密上等于
// 暴露大半（如 8 位 Key 暴露 4 位），不许回真实末位（R7）；长秘密仍给末四位便于辨认。
export function secretHint(secret) {
	if (!secret) return "";
	if (secret.length <= 8) return "••••••••";
	return `••••${secret.slice(-4)}`;
}

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
	writeSettingsFile(MODEL_SETTINGS_FILE, next);
	return next;
}

// ---------- 基础资料（L0-3）：称呼与时区。「关于我」正文不在这里存——只有一份 about-me.md（store.writeAboutMe）。 ----------

const PROFILE_SETTINGS_FILE = join(DATA_DIR, "settings-profile.json");
export const DEFAULT_TIMEZONE = "Asia/Hong_Kong";

// IANA 时区合法性：以 Intl 试构造为准（与 lib/schedule.mjs 的实际用法同一判据）。
export function isValidTimezone(timezone) {
	if (typeof timezone !== "string" || !timezone) return false;
	try {
		new Intl.DateTimeFormat(undefined, { timeZone: timezone });
		return true;
	} catch {
		return false;
	}
}

// 手改文件写入的非法时区只提示一次（按坏值去重），避免每次读设置都刷日志。
const warnedBadTimezones = new Set();

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
	// 存量文件里的时区若非法（多为手改文件打错字），回落缺省而不是把坏值交给调度层——
	// 坏时区曾让调度在启动 tick 阶段抛 RangeError、整进程退出（审计 B3）。回落只影响
	// 读回与调度，文件本身不改写，用户在设置页保存一次即可修好。
	let timezone = typeof saved.timezone === "string" && saved.timezone ? saved.timezone : DEFAULT_TIMEZONE;
	if (!isValidTimezone(timezone)) {
		if (!warnedBadTimezones.has(timezone)) {
			warnedBadTimezones.add(timezone);
			console.warn(`[piper] settings-profile.json 的时区 "${timezone}" 不是合法 IANA 时区，已回落缺省时区 ${DEFAULT_TIMEZONE}，请在设置页修正。`);
		}
		timezone = DEFAULT_TIMEZONE;
	}
	return {
		displayName: typeof saved.displayName === "string" ? saved.displayName : "",
		timezone,
	};
}

// 部分更新：字段出现才改。时区传空串视为恢复缺省；非空时区必须合法，非法抛 400
// 且不写文件——错别字不能落盘，更不能让常驻进程下次启动时崩在坏时区上（审计 B3）。
export function saveProfileSettings(patch) {
	const next = { ...readProfileSettings() };
	if (patch.displayName !== undefined) next.displayName = String(patch.displayName).trim().slice(0, 40);
	if (patch.timezone !== undefined) {
		const tz = String(patch.timezone).trim();
		if (tz && !isValidTimezone(tz)) {
			const err = new Error(`时区无效："${tz}" 不是合法的 IANA 时区名，未保存`);
			err.status = 400;
			throw err;
		}
		next.timezone = tz || DEFAULT_TIMEZONE;
	}
	writeSettingsFile(PROFILE_SETTINGS_FILE, next);
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
	writeSettingsFile(GITHUB_SETTINGS_FILE, next);
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
			purpose: "绑定仓库的扫描（日报、PR / issue / CI 概况）；经收件箱批准后，可向指定 PR 发表一条评论。",
			status: token ? "connected" : "unconfigured",
			statusNote: token
				? "令牌已配置，扫描请求会带上它（限额更高）。扫描全程只读；评论写入只发生在收件箱批准之后，由网关按批准的那份内容发出。"
				: "未配置令牌：当前走公开 API 只读，限额较低。在下方粘贴 PAT 即可保存，之后扫描自动使用。",
			bots: githubBots.length ? githubBots : ["repo-keeper"],
			access: "read-approved-comment",
			configurable: true,
			tokenHint: token ? secretHint(token) : "",
		},
		{
			id: "web",
			name: "网页查询",
			purpose: "主 bot 只读打开公开网页并在对话里引用内容。",
			status: "unconfigured",
			statusNote: "尚未启用：启用后可只读抓取公开网页，带超时与体积上限，并拒绝本机 / 私网 / 元数据地址。搜索需另行配置搜索端点后才可用。",
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
