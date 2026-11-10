// Piper 数据层：文件优先存储。
// 布局（apps/piper/data/，运行时生成，已被 .gitignore 排除）：
//   bots.json                 bot 元数据（规格四：SQLite 只存元数据——雏形先用 JSON 文件，接口不变）
//   about-me.md               账号级「关于我」：全 bot 可读、仅主 bot 可写（写入在服务端按 canManageBots 校验）
//   workspaces/<botId>/       每 bot 隔离工作区；memory.md 为该 bot 的记忆（雏形只读展示）
//   sessions/<botId>.jsonl    每 bot 独立会话流水（一行一条）
//   artifacts/<id>.md         产物（Markdown），文件头注释里带结构化元数据
//   routines.json             routine 定义 + 上次运行结果
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redact } from "./redact.mjs";

export const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
// 数据目录：缺省 apps/piper/data；可用 PIPER_DATA_DIR 覆盖（相对路径按进程 cwd 解析）。
// R4 起所有测试/回归脚本都经它指向临时目录，与用户真实 data/ 完全隔离。
export const DATA_DIR = process.env.PIPER_DATA_DIR ? resolve(process.env.PIPER_DATA_DIR) : join(APP_DIR, "data");
const BOTS_FILE = join(DATA_DIR, "bots.json");
const ROUTINES_FILE = join(DATA_DIR, "routines.json");
const ABOUT_ME_FILE = join(DATA_DIR, "about-me.md");

const SEED_BOTS = [
	{
		id: "piper-main",
		name: "Piper",
		systemPrompt:
			"你是 Piper，用户的总管家 bot。你负责统筹所有 bot：理解用户需求、把活分派给合适的 bot、汇总结果；用户想新建 bot 时，你替他把 Bot 草案卡填好请他确认（未确认不落库）。回答简洁、直接。",
		tools: ["bots.draft", "bots.manage", "about-me.write"],
		memoryScope: "self+about-me",
		repos: [],
		routines: [],
		isMain: true,
		canManageBots: true,
		createdAt: "2026-11-10T00:00:00.000Z",
	},
	{
		id: "repo-keeper",
		name: "仓库管家",
		systemPrompt:
			"你是仓库管家，一个面向开发者运维的 bot，负责盯住绑定的 GitHub 仓库：CI 红绿、待处理 PR 与 issue、最近提交。你只做只读巡检与汇报，不擅自改代码或合并 PR；发现异常先汇报并给出证据链接。",
		tools: ["github.read"],
		memoryScope: "self+about-me",
		repos: ["NorthAdb/LinkForge", "NorthAdb/Loom"],
		routines: ["morning-scan"],
		isMain: false,
		canManageBots: false,
		createdAt: "2026-11-10T00:00:00.000Z",
	},
];

const SEED_ROUTINES = [
	{
		id: "morning-scan",
		botId: "repo-keeper",
		name: "晨间仓库扫描",
		description: "只读扫描绑定仓库的 commits / PR / issue / CI 概况，生成 Markdown 日报存入产物。",
		schedule: "08:00",
		scheduleText: "每日 08:00（Asia/Hong_Kong，进程内定时）",
		lastRunAt: null,
		lastArtifactId: null,
		lastStatus: null,
	},
];

const SEED_ABOUT_ME = `# 关于我

- 身份：研二硕士（网络空间安全），开发者。
- GitHub：NorthAdb；主力仓库 LinkForge（已冻结 3.0.0）、Loom（自托管个人 Agent）。
- 偏好：证据优先——结论要有实测或来源支撑；汇报先给结论与证据，再讲过程。
- 作息：待补充。
`;

function ensureDir(p) {
	mkdirSync(p, { recursive: true });
}

function readJson(file, fallback) {
	if (!existsSync(file)) return fallback;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}

function writeJson(file, data) {
	writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function botWorkspace(botId) {
	return join(DATA_DIR, "workspaces", botId);
}

export function ensureData() {
	ensureDir(DATA_DIR);
	ensureDir(join(DATA_DIR, "workspaces"));
	ensureDir(join(DATA_DIR, "sessions"));
	ensureDir(join(DATA_DIR, "artifacts"));
	if (!existsSync(BOTS_FILE)) writeJson(BOTS_FILE, { bots: SEED_BOTS });
	if (!existsSync(ROUTINES_FILE)) writeJson(ROUTINES_FILE, { routines: SEED_ROUTINES });
	if (!existsSync(ABOUT_ME_FILE)) writeFileSync(ABOUT_ME_FILE, SEED_ABOUT_ME, "utf8");
	for (const bot of listBots()) ensureDir(botWorkspace(bot.id));
}

// ---------- bots ----------

export function listBots() {
	const { bots } = readJson(BOTS_FILE, { bots: [] });
	// 主 bot 置顶，其余按创建时间
	return [...bots].sort((a, b) => Number(b.isMain) - Number(a.isMain) || String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function getBot(id) {
	return listBots().find((b) => b.id === id) ?? null;
}

export function createBot(input) {
	const bots = listBots();
	const id = input.id || `bot-${Date.now().toString(36)}`;
	if (bots.some((b) => b.id === id)) throw Object.assign(new Error(`bot id 已存在: ${id}`), { status: 409 });
	const bot = {
		id,
		name: String(input.name ?? "未命名 Bot").slice(0, 60),
		systemPrompt: String(input.systemPrompt ?? ""),
		tools: Array.isArray(input.tools) ? input.tools.map(String) : [],
		memoryScope: String(input.memoryScope ?? "self"),
		repos: Array.isArray(input.repos) ? input.repos.map(String) : [],
		routines: Array.isArray(input.routines) ? input.routines.map(String) : [],
		isMain: false,
		canManageBots: Boolean(input.canManageBots),
		createdAt: new Date().toISOString(),
	};
	writeJson(BOTS_FILE, { bots: [...bots, bot] });
	ensureDir(botWorkspace(bot.id));
	return bot;
}

export function updateBot(id, patch) {
	const bots = listBots();
	const idx = bots.findIndex((b) => b.id === id);
	if (idx < 0) return null;
	const cur = bots[idx];
	const next = {
		...cur,
		...(patch.name !== undefined ? { name: String(patch.name).slice(0, 60) } : {}),
		...(patch.systemPrompt !== undefined ? { systemPrompt: String(patch.systemPrompt) } : {}),
		...(patch.tools !== undefined ? { tools: patch.tools.map(String) } : {}),
		...(patch.memoryScope !== undefined ? { memoryScope: String(patch.memoryScope) } : {}),
		...(patch.repos !== undefined ? { repos: patch.repos.map(String) } : {}),
		...(patch.routines !== undefined ? { routines: patch.routines.map(String) } : {}),
		// isMain / canManageBots 不允许通过普通编辑摘掉主 bot 的管理权
		isMain: cur.isMain,
		canManageBots: cur.isMain ? true : Boolean(patch.canManageBots ?? cur.canManageBots),
	};
	bots[idx] = next;
	writeJson(BOTS_FILE, { bots });
	return next;
}

export function deleteBot(id) {
	const bots = listBots();
	const bot = bots.find((b) => b.id === id);
	if (!bot) return false;
	if (bot.isMain) throw Object.assign(new Error("主 bot 不可删除"), { status: 400 });
	writeJson(BOTS_FILE, { bots: bots.filter((b) => b.id !== id) });
	rmSync(botWorkspace(id), { recursive: true, force: true });
	return true;
}

// ---------- about-me ----------

// 「关于我」会注入每一轮对话的 system prompt，体积必须有上限（L0-3）。
export const ABOUT_ME_MAX_CHARS = 20000;

export function readAboutMe() {
	return existsSync(ABOUT_ME_FILE) ? readFileSync(ABOUT_ME_FILE, "utf8") : "";
}

// 写入唯一的 about-me.md（设置页、右栏记忆、对话注入三处同源，只此一份）。
// 超限在落盘前拒绝，原文件不动；落盘走临时文件 + rename，避免写一半损坏。
export function writeAboutMe(markdown) {
	const text = String(markdown ?? "");
	if (text.length > ABOUT_ME_MAX_CHARS) {
		throw Object.assign(new Error(`「关于我」超过 ${ABOUT_ME_MAX_CHARS} 字符上限（当前 ${text.length}）`), { status: 413 });
	}
	ensureDir(DATA_DIR);
	const tmp = `${ABOUT_ME_FILE}.tmp`;
	writeFileSync(tmp, text, "utf8");
	renameSync(tmp, ABOUT_ME_FILE);
	return text;
}

// ---------- sessions ----------

function sessionFile(botId) {
	return join(DATA_DIR, "sessions", `${botId}.jsonl`);
}

export function appendSession(botId, entry) {
	ensureDir(join(DATA_DIR, "sessions"));
	// 会话 JSONL 是秘密禁入面（切片共同约束）：text 落盘前统一脱敏（R7），厂商错误
	// 回显 Key、用户误粘贴的令牌都不进流水。draft 等结构化字段不走文本脱敏。
	const safe = typeof entry?.text === "string" ? { ...entry, text: redact(entry.text) } : entry;
	appendFileSync(sessionFile(botId), JSON.stringify({ ts: new Date().toISOString(), ...safe }) + "\n", "utf8");
}

export function readSession(botId) {
	const file = sessionFile(botId);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}

// ---------- routines ----------

export function listRoutines() {
	return readJson(ROUTINES_FILE, { routines: [] }).routines;
}

export function updateRoutine(id, patch) {
	const routines = listRoutines();
	const idx = routines.findIndex((r) => r.id === id);
	if (idx < 0) return null;
	routines[idx] = { ...routines[idx], ...patch };
	writeJson(ROUTINES_FILE, { routines });
	return routines[idx];
}

// ---------- artifacts ----------

export function saveArtifact({ botId, kind, title, body }) {
	ensureDir(join(DATA_DIR, "artifacts"));
	const ts = new Date();
	const id = `${ts.toISOString().slice(0, 10)}-${kind}-${ts.getTime().toString(36)}`;
	// 产物正文拼外部数据（GitHub 响应、错误原文等），落盘前统一脱敏（R7）。
	const meta = { id, botId, kind, title: redact(String(title ?? "")), createdAt: ts.toISOString() };
	writeFileSync(join(DATA_DIR, "artifacts", `${id}.md`), `<!-- piper-artifact ${JSON.stringify(meta)} -->\n${redact(String(body ?? ""))}`, "utf8");
	return meta;
}

export function listArtifacts() {
	const dir = join(DATA_DIR, "artifacts");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => {
			const raw = readFileSync(join(dir, f), "utf8");
			const m = raw.match(/^<!-- piper-artifact (.*) -->/);
			if (m) {
				try {
					return JSON.parse(m[1]);
				} catch {
					/* fall through */
				}
			}
			return { id: f.replace(/\.md$/, ""), botId: null, kind: "file", title: f, createdAt: null };
		})
		.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function readArtifact(id) {
	if (!/^[\w.-]+$/.test(id)) return null;
	const file = join(DATA_DIR, "artifacts", `${id}.md`);
	if (!existsSync(file)) return null;
	const raw = readFileSync(file, "utf8");
	const meta = listArtifacts().find((a) => a.id === id) ?? { id };
	return { ...meta, body: raw.replace(/^<!-- piper-artifact .* -->\n/, "") };
}

// ---------- memory ----------

export function readBotMemory(botId) {
	const file = join(botWorkspace(botId), "memory.md");
	return existsSync(file) ? readFileSync(file, "utf8") : "";
}
