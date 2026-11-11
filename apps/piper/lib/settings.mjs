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

// 思考挡位词表：与 pi-ai / pi-agent-core 的 ThinkingLevel 完全一致（七挡），
// 不自造。每款模型实际支持哪几挡由 pi-ai 目录元数据决定（见
// lib/model-providers.mjs 的 supportedThinkingLevels），这里只管词表合法性。
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function isThinkingLevel(value) {
	return typeof value === "string" && THINKING_LEVELS.includes(value);
}

// 部分更新：字段出现才改；apiKey 传空字符串表示清除已保存的 Key。
// provider 是服务商归属标记（目录 id，见 lib/model-providers.mjs）；合法性由
// server 路由校验，本函数只落盘字符串。旧文件没有该字段，读回按 custom 处理。
// thinkingLevel 同理：路由先校验词表，本函数只落盘；旧文件无此字段，读回按 off。
export function saveModelSettingsFile(patch) {
	const next = { ...readModelSettingsFile() };
	if (patch.provider !== undefined) next.provider = String(patch.provider).trim();
	if (patch.baseUrl !== undefined) next.baseUrl = String(patch.baseUrl).trim();
	if (patch.modelId !== undefined) next.modelId = String(patch.modelId).trim();
	if (patch.thinkingLevel !== undefined) next.thinkingLevel = String(patch.thinkingLevel).trim();
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

// ---------- 网页查询（L0-6）：抓取开关 + 搜索端点/密钥，与其他设置文件同一套规则 ----------

const WEB_SETTINGS_FILE = join(DATA_DIR, "settings-web.json");

export function readWebSettingsFile() {
	if (!existsSync(WEB_SETTINGS_FILE)) return {};
	try {
		const parsed = JSON.parse(readFileSync(WEB_SETTINGS_FILE, "utf8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

// 部分更新：字段出现才改；searchApiKey 传空字符串表示清除已保存的密钥。
export function saveWebSettingsFile(patch) {
	const next = { ...readWebSettingsFile() };
	if (patch.fetchEnabled !== undefined) next.fetchEnabled = Boolean(patch.fetchEnabled);
	if (patch.searchEndpoint !== undefined) next.searchEndpoint = String(patch.searchEndpoint).trim();
	if (patch.searchApiKey !== undefined) {
		if (patch.searchApiKey) next.searchApiKey = String(patch.searchApiKey);
		else delete next.searchApiKey;
	}
	writeSettingsFile(WEB_SETTINGS_FILE, next);
	return next;
}

export function webFetchEnabled() {
	return readWebSettingsFile().fetchEnabled === true;
}

// 搜索配置：端点与密钥都齐才算可用，缺一即未配置（工具不注册、对话里如实说没有）。
export function webSearchConfig() {
	const saved = readWebSettingsFile();
	const endpoint = typeof saved.searchEndpoint === "string" ? saved.searchEndpoint.trim() : "";
	const apiKey = typeof saved.searchApiKey === "string" ? saved.searchApiKey : "";
	if (!endpoint || !apiKey) return null;
	return { endpoint, apiKey };
}

// 网页查询的可用范围：默认只有主 bot；其他 bot 须在自己的 tools 里声明
// web.fetch / web.search 才进范围。连接器卡的 bots 与内核注册工具都用这一份。
export function webToolBots() {
	const declared = listBots()
		.filter((b) => (b.tools ?? []).some((t) => t === "web.fetch" || t === "web.search" || t.startsWith("web.")))
		.map((b) => b.id);
	return [...new Set(["piper-main", ...declared])];
}

// 连接器统一形状：id / name / purpose / status(placeholder|unconfigured|connected) /
// statusNote（点开看的口径）/ bots（可用范围）/ access（读写级别）/ configurable。
// tokenHint 只出现在 GitHub 卡上，且只有末四位掩码。
export function listConnectors() {
	const token = githubToken();
	const web = { fetchEnabled: webFetchEnabled(), search: webSearchConfig() };
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
			purpose: "只读打开公开网页并在对话里引用内容；配置搜索端点后，还能按关键词搜索网页。",
			status: web.fetchEnabled ? "connected" : "unconfigured",
			statusNote: web.fetchEnabled
				? `已启用：可用范围内的 bot 可只读抓取公开网页（超时 10 秒、单页最多 1 MB、引用文本最多 8000 字），本机 / 私网 / 元数据地址一律拒绝。${
						web.search ? "搜索已配置，可按关键词搜索。" : "搜索尚未配置：在下方填入搜索端点与密钥后可用。"
					}`
				: "尚未启用：启用后可用范围内的 bot 可只读抓取公开网页（带超时与体积上限，本机 / 私网 / 元数据地址一律拒绝）。搜索需另行配置搜索端点与密钥后才可用。",
			bots: webToolBots(),
			access: "read",
			configurable: true,
			fetchEnabled: web.fetchEnabled,
			searchConfigured: Boolean(web.search),
			searchEndpoint: web.search?.endpoint ?? "",
			searchKeyHint: web.search ? secretHint(web.search.apiKey) : "",
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
