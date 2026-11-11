// Piper 数据层：文件优先存储。
// 布局（apps/piper/data/，运行时生成，已被 .gitignore 排除）：
//   bots.json                 bot 元数据（规格四：SQLite 只存元数据——雏形先用 JSON 文件，接口不变）
//   about-me.md               账号级「关于我」：全 bot 可读、仅主 bot 可写（写入在服务端按 canManageBots 校验）
//   workspaces/<botId>/       每 bot 隔离工作区；memory.md 为该 bot 的记忆（雏形只读展示）
//   sessions/<botId>.jsonl    每 bot 独立会话流水（一行一条）
//   artifacts/<id>.md         产物（Markdown），文件头注释里带结构化元数据
//   routines.json             routine 定义 + 上次运行结果
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import type { WriteFileOptions } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redact } from "./redact.js";

// ---------- 共享数据形状（落盘 JSON 的属主口径，其他模块一律引用这里） ----------

export interface Bot {
	id: string;
	name: string;
	systemPrompt: string;
	tools: string[];
	memoryScope: string;
	repos: string[];
	routines: string[];
	isMain: boolean;
	canManageBots: boolean;
	createdAt: string;
}

// 建 bot 入参：来自请求体（wire 输入），字段在 createBot 内逐个收窄，
// 这里只钉住「可能出现哪些键」。
export interface BotInput {
	id?: string;
	name?: unknown;
	systemPrompt?: unknown;
	tools?: unknown;
	memoryScope?: unknown;
	repos?: unknown;
	routines?: unknown;
	canManageBots?: unknown;
}

export interface BotPatch {
	name?: string;
	systemPrompt?: string;
	tools?: string[];
	memoryScope?: string;
	repos?: string[];
	routines?: string[];
	canManageBots?: boolean;
}

export interface Routine {
	id: string;
	botId: string;
	name: string;
	description: string;
	schedule: string;
	scheduleText: string;
	lastRunAt: string | null;
	lastArtifactId: string | null;
	lastStatus: string | null;
	[key: string]: unknown;
}

// 会话流水条目：一行一条 JSON。已知字段逐个钉住，其余（system 条目的
// 结构化载荷等）经索引签名保留，与 appendSession 的透传语义一致。
export interface SessionEntry {
	role: string;
	text?: string;
	kind?: string;
	code?: string;
	sessionId?: string;
	draft?: unknown;
	toolCallId?: string;
	name?: string;
	args?: unknown;
	result?: unknown;
	status?: string;
	seq?: number;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	level?: string;
	truncated?: boolean;
	ts?: string;
	[key: string]: unknown;
}

export interface ArtifactMeta {
	id: string;
	botId: string | null;
	kind: string;
	title: string;
	createdAt: string | null;
}

export interface ArtifactDetail {
	id: string;
	body: string;
	botId?: string | null;
	kind?: string;
	title?: string;
	createdAt?: string | null;
}

// 应用根目录（apps/piper）：本文件在源码布局下位于 lib/、构建后位于 dist/lib/，
// 两处到应用根的层数不同，固定层数推导必然有一处错位——改为从本文件目录向上
// 逐级找 package.json 所在目录（apps/piper/package.json 先于仓库根命中）。
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
// 数据目录：缺省 apps/piper/data；可用 PIPER_DATA_DIR 覆盖（相对路径按进程 cwd 解析）。
// R4 起所有测试/回归脚本都经它指向临时目录，与用户真实 data/ 完全隔离。
export const DATA_DIR = process.env.PIPER_DATA_DIR ? resolve(process.env.PIPER_DATA_DIR) : join(APP_DIR, "data");
const BOTS_FILE = join(DATA_DIR, "bots.json");
const ROUTINES_FILE = join(DATA_DIR, "routines.json");
const ABOUT_ME_FILE = join(DATA_DIR, "about-me.md");

const SEED_BOTS: Bot[] = [
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

const SEED_ROUTINES: Routine[] = [
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

function ensureDir(p: string): void {
	mkdirSync(p, { recursive: true });
}

function readJson<T>(file: string, fallback: T): T {
	if (!existsSync(file)) return fallback;
	try {
		// 落盘 JSON 是本进程自己写的属主数据，形状由调用方给出的 T 断言。
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function writeJson(file: string, data: unknown): void {
	writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// 整表重写走临时文件 + rename（R10）：写一半进程崩溃不会留下截断的文件，读者要么
// 看到旧内容、要么看到新内容（rename 在同一文件系统内是原子替换）。tmp 名带 pid，
// 避免并发写者踩同一个临时文件。设置文件与 findings.jsonl 的整表重写都经这里。
export function writeFileAtomicSync(file: string, content: string, options?: WriteFileOptions): void {
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, content, options);
	renameSync(tmp, file);
}

// ---------- 数据目录进程锁（R10） ----------
// 同一数据目录只允许一个 Piper 服务进程：两个进程同时整表重写 findings /
// notifications 等文件会互相踩踏（后写者覆盖先写者的更新）。锁文件 data/piper.lock
// 只存持有者 pid；启动时若已有存活进程持有则拒绝启动，pid 不存在则视为陈旧锁接管。
const LOCK_FILE = join(DATA_DIR, "piper.lock");

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException | undefined)?.code === "EPERM";
	}
}

// 抢锁成功返回释放函数（只删自己持有的锁）；已有存活进程时抛错，调用方拒绝启动。
export function acquireDataLock(): () => void {
	ensureDir(DATA_DIR);
	const writeOwn = () => writeFileSync(LOCK_FILE, `${process.pid}\n`, { flag: "wx" });
	try {
		writeOwn();
	} catch (err) {
		if ((err as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw err;
		let holder = NaN;
		try {
			holder = Number(readFileSync(LOCK_FILE, "utf8").trim());
		} catch {
			/* 锁文件读不出内容，按陈旧处理 */
		}
		if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && pidAlive(holder)) {
			throw new Error(`数据目录 ${DATA_DIR} 已被另一个 Piper 进程占用（pid ${holder}），拒绝启动；请先停掉已有进程，或换 PIPER_DATA_DIR。`);
		}
		// 陈旧锁：持有进程已退出或内容无效——删掉重抢（单机单用户，竞态窗口可接受）。
		rmSync(LOCK_FILE, { force: true });
		writeOwn();
	}
	let released = false;
	return function releaseDataLock() {
		if (released) return;
		released = true;
		try {
			if (Number(readFileSync(LOCK_FILE, "utf8").trim()) === process.pid) rmSync(LOCK_FILE, { force: true });
		} catch {
			/* 锁已被接管或删除，无需处理 */
		}
	};
}

export function botWorkspace(botId: string): string {
	return join(DATA_DIR, "workspaces", botId);
}

export function ensureData(): void {
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

export function listBots(): Bot[] {
	const { bots } = readJson<{ bots: Bot[] }>(BOTS_FILE, { bots: [] });
	// 主 bot 置顶，其余按创建时间
	return [...bots].sort((a, b) => Number(b.isMain) - Number(a.isMain) || String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function getBot(id: string): Bot | null {
	return listBots().find((b) => b.id === id) ?? null;
}

export function createBot(input: BotInput): Bot {
	const bots = listBots();
	const id = input.id || `bot-${Date.now().toString(36)}`;
	if (bots.some((b) => b.id === id)) throw Object.assign(new Error(`bot id 已存在: ${id}`), { status: 409 });
	const bot: Bot = {
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

export function updateBot(id: string, patch: BotPatch): Bot | null {
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

export function deleteBot(id: string): boolean {
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

export function readAboutMe(): string {
	return existsSync(ABOUT_ME_FILE) ? readFileSync(ABOUT_ME_FILE, "utf8") : "";
}

// 写入唯一的 about-me.md（设置页、右栏记忆、对话注入三处同源，只此一份）。
// 超限在落盘前拒绝，原文件不动；落盘走临时文件 + rename，避免写一半损坏。
export function writeAboutMe(markdown: unknown): string {
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

function sessionFile(botId: string): string {
	return join(DATA_DIR, "sessions", `${botId}.jsonl`);
}

export function appendSession(botId: string, entry: SessionEntry): void {
	ensureDir(join(DATA_DIR, "sessions"));
	// 会话 JSONL 是秘密禁入面（切片共同约束）：text 落盘前统一脱敏（R7），厂商错误
	// 回显 Key、用户误粘贴的令牌都不进流水。draft 等结构化字段不走文本脱敏。
	const safe = typeof entry?.text === "string" ? { ...entry, text: redact(entry.text) } : entry;
	appendFileSync(sessionFile(botId), JSON.stringify({ ts: new Date().toISOString(), ...safe }) + "\n", "utf8");
}

export function readSession(botId: string): SessionEntry[] {
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
		.filter((e): e is SessionEntry => Boolean(e));
}

// ---------- routines ----------

export function listRoutines(): Routine[] {
	return readJson<{ routines: Routine[] }>(ROUTINES_FILE, { routines: [] }).routines;
}

export function updateRoutine(id: string, patch: Partial<Routine>): Routine | null {
	const routines = listRoutines();
	const idx = routines.findIndex((r) => r.id === id);
	if (idx < 0) return null;
	routines[idx] = { ...routines[idx], ...patch };
	writeJson(ROUTINES_FILE, { routines });
	return routines[idx];
}

// ---------- artifacts ----------

export function saveArtifact({ botId, kind, title, body }: { botId: string; kind: string; title?: unknown; body?: unknown }): ArtifactMeta {
	ensureDir(join(DATA_DIR, "artifacts"));
	const ts = new Date();
	// id 的时间戳部分只有毫秒精度：同 kind 在同一毫秒连写会同 id 互相覆盖（第二轮
	// F11；实测紧循环连写 300 条只剩 21 条）。尾部加 6 位十六进制随机后缀保唯一，
	// 日期与 kind 前缀不变，按 id 读取/引用的既有路径不受影响。
	const id = `${ts.toISOString().slice(0, 10)}-${kind}-${ts.getTime().toString(36)}-${randomBytes(3).toString("hex")}`;
	// 产物正文拼外部数据（GitHub 响应、错误原文等），落盘前统一脱敏（R7）。
	const meta: ArtifactMeta = { id, botId, kind, title: redact(String(title ?? "")), createdAt: ts.toISOString() };
	writeFileSync(join(DATA_DIR, "artifacts", `${id}.md`), `<!-- piper-artifact ${JSON.stringify(meta)} -->\n${redact(String(body ?? ""))}`, "utf8");
	return meta;
}

export function listArtifacts(): ArtifactMeta[] {
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

export function readArtifact(id: string): ArtifactDetail | null {
	if (!/^[\w.-]+$/.test(id)) return null;
	const file = join(DATA_DIR, "artifacts", `${id}.md`);
	if (!existsSync(file)) return null;
	const raw = readFileSync(file, "utf8");
	const meta = listArtifacts().find((a) => a.id === id) ?? { id };
	return { ...meta, body: raw.replace(/^<!-- piper-artifact .* -->\n/, "") };
}

// ---------- memory ----------

export function readBotMemory(botId: string): string {
	const file = join(botWorkspace(botId), "memory.md");
	return existsSync(file) ? readFileSync(file, "utf8") : "";
}
