// Finding 存储（P1-1）：分诊的核心对象——「需要人拍板的事项」的结构化记录。
// 文件优先：data/findings.jsonl 一行一条，每次读写都现读落盘，进程重启不丢。
// 校验在写入边界完成：没有 evidenceUrl 的对象不准存成有效 Finding；type / status /
// writeIntent 只接受本批已定的枚举，非法值抛带 status 的 Error（路由层转 4xx）。
// 文件路径可用环境变量 PIPER_FINDINGS_FILE 覆盖（仅供单元测试 / 评测隔离数据，缺省走 data/）。
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, ensureData, writeFileAtomicSync } from "./store.js";

export const FINDING_TYPES = ["ci_failed", "pr_needs_review"] as const;
export type FindingType = (typeof FINDING_TYPES)[number];
export const FINDING_STATUSES = ["open", "approved", "rejected", "expired", "executed", "executing"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];
// 显式状态迁移表（R1）：updateFinding 强制执行，表外迁移一律抛错。
// executing 是批准执行在途态（网关领取后、落终态前）；executing→approved 是执行失败退回。
export const FINDING_TRANSITIONS: Record<FindingStatus, FindingStatus[]> = {
	open: ["approved", "rejected", "expired"],
	approved: ["executing", "rejected", "expired"],
	executing: ["executed", "approved"],
	rejected: [],
	expired: [],
	executed: [],
};
// 本批只允许一种写意图（P1-6 网关放行）：给指定 PR 发表一条评论。
export const FINDING_WRITE_INTENT_KINDS = ["pr_comment"] as const;

export interface WriteIntent {
	kind: string;
	prNumber: number;
	body: string;
}

export interface Finding {
	id: string;
	repo: string;
	type: FindingType;
	subject: string;
	title: string;
	summary: string;
	evidenceUrl: string;
	suggestedAction: string;
	writeIntent: WriteIntent | null;
	expiresAt: string | null;
	status: FindingStatus;
	botId: string;
	headSha: string | null;
	workflow: string | null;
	createdAt: string;
	updatedAt: string;
}

// 写入边界的入参形状：字段在 buildFinding 内逐个校验收窄，这里只钉住键名。
export interface FindingInput {
	repo?: unknown;
	type?: unknown;
	subject?: unknown;
	title?: unknown;
	summary?: unknown;
	evidenceUrl?: unknown;
	suggestedAction?: unknown;
	writeIntent?: unknown;
	expiresAt?: unknown;
	status?: unknown;
	botId?: unknown;
	headSha?: unknown;
	workflow?: unknown;
}

export type FindingDraft = Omit<Finding, "id" | "createdAt" | "updatedAt">;

function findingsFile(): string {
	return process.env.PIPER_FINDINGS_FILE || join(DATA_DIR, "findings.jsonl");
}

function badRequest(message: string): Error & { status: number } {
	return Object.assign(new Error(message), { status: 400 });
}

function readAll(): Finding[] {
	const file = findingsFile();
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
		.filter((f): f is Finding => Boolean(f));
}

// 整表重写走临时文件 + rename（R10）：状态迁移写一半崩溃不会把 findings.jsonl
// 截成半截文件，下次启动读到的要么是旧全表、要么是新全表。
function rewriteAll(all: Finding[]): void {
	ensureData();
	writeFileAtomicSync(findingsFile(), all.map((f) => JSON.stringify(f)).join("\n") + (all.length ? "\n" : ""), "utf8");
}

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw badRequest(`Finding.${field} 必填且须为非空字符串`);
	return value;
}

function validateEvidenceUrl(value: unknown): string {
	const v = requireNonEmptyString(value, "evidenceUrl");
	let url: URL;
	try {
		url = new URL(v);
	} catch {
		throw badRequest(`Finding.evidenceUrl 不是合法 URL: ${v}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw badRequest(`Finding.evidenceUrl 只允许 http/https: ${v}`);
	}
	return v;
}

function validateWriteIntent(value: unknown): WriteIntent | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) throw badRequest("Finding.writeIntent 须为对象或 null");
	const v = value as { kind?: unknown; body?: unknown; prNumber?: unknown };
	if (!(FINDING_WRITE_INTENT_KINDS as readonly unknown[]).includes(v.kind)) {
		throw badRequest(`Finding.writeIntent.kind 非法: ${v.kind}（本批只允许 ${FINDING_WRITE_INTENT_KINDS.join("/")}）`);
	}
	// pr_comment：仓库沿用 Finding.repo，正文与 PR 号必须齐全（PR 号即 subject，但意图里再存一份供网关独立校验）。
	const body = requireNonEmptyString(v.body, "writeIntent.body");
	const prNumber = Number(v.prNumber);
	if (!Number.isInteger(prNumber) || prNumber <= 0) throw badRequest("Finding.writeIntent.prNumber 须为正整数");
	return { kind: v.kind as string, prNumber, body };
}

function validateExpiresAt(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
		throw badRequest(`Finding.expiresAt 不是合法时间: ${value}`);
	}
	return value;
}

// 校验并组装一条 Finding（不落盘）。createFinding 与 updateFinding 共用字段校验口径。
function buildFinding(input: FindingInput): FindingDraft {
	if (!input || typeof input !== "object") throw badRequest("Finding 输入须为对象");
	const repo = requireNonEmptyString(input.repo, "repo");
	if (!repo.includes("/")) throw badRequest(`Finding.repo 须为 owner/name 形状: ${repo}`);
	if (!(FINDING_TYPES as readonly unknown[]).includes(input.type)) {
		throw badRequest(`Finding.type 非法: ${input.type}（本批只允许 ${FINDING_TYPES.join("/")}）`);
	}
	if (input.subject === undefined || input.subject === null || String(input.subject) === "") {
		throw badRequest("Finding.subject 必填（PR 号或 workflow run id 等可去重键）");
	}
	const status = input.status ?? "open";
	if (!(FINDING_STATUSES as readonly unknown[]).includes(status)) {
		throw badRequest(`Finding.status 非法: ${status}（只允许 ${FINDING_STATUSES.join("/")}）`);
	}
	return {
		repo,
		type: input.type as FindingType,
		subject: String(input.subject),
		title: requireNonEmptyString(input.title, "title"),
		summary: typeof input.summary === "string" ? input.summary : "",
		evidenceUrl: validateEvidenceUrl(input.evidenceUrl),
		suggestedAction: typeof input.suggestedAction === "string" ? input.suggestedAction : "",
		writeIntent: validateWriteIntent(input.writeIntent),
		expiresAt: validateExpiresAt(input.expiresAt),
		status: status as FindingStatus,
		botId: requireNonEmptyString(input.botId, "botId"),
		// 头部提交（R5，去重冷却的比较基准，开单时刻的取证事实、不可改）：
		// pr_needs_review 取 PR 的 head.sha，ci_failed 取 run 的 head_sha；缺失为 null。
		headSha: typeof input.headSha === "string" && input.headSha ? input.headSha : null,
		// ci_failed 所属工作流名（R5 对账按工作流退役用）；其他类型为 null。
		workflow: typeof input.workflow === "string" && input.workflow ? input.workflow : null,
	};
}

export function createFinding(input: FindingInput): Finding {
	const now = new Date().toISOString();
	const entry: Finding = {
		id: `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		...buildFinding(input),
		createdAt: now,
		updatedAt: now,
	};
	ensureData();
	appendFileSync(findingsFile(), JSON.stringify(entry) + "\n", "utf8");
	return entry;
}

// 按 status / repo / botId 过滤（都给才叠加），新在前。
export function listFindings({ status, repo, botId }: { status?: string; repo?: string; botId?: string } = {}): Finding[] {
	if (status !== undefined && !(FINDING_STATUSES as readonly string[]).includes(status)) {
		throw badRequest(`Finding.status 非法: ${status}（只允许 ${FINDING_STATUSES.join("/")}）`);
	}
	return readAll()
		.filter((f) => status === undefined || f.status === status)
		.filter((f) => repo === undefined || f.repo === repo)
		.filter((f) => botId === undefined || f.botId === botId)
		.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function getFinding(id: string): Finding | null {
	return readAll().find((f) => f.id === id) ?? null;
}

// 同一仓库、同一类型、同一 subject 是否已有 open 的 Finding（P1-2 扫描去重用）。
export function findOpenFinding(repo: string, type: string, subject: string | number): Finding | null {
	return readAll().find((f) => f.repo === repo && f.type === type && f.subject === String(subject) && f.status === "open") ?? null;
}

// 去重冷却（R5，口径已锁定）：去重键 repo+type+subject。返回「挡住新开」的既有 Finding，
// 没有则 null。规则：
//   open / approved / executing：未关闭，不得另开一条；
//   rejected：头部提交未变且距上次状态变更（updatedAt，近似驳回时刻）未满 14 天 → 挡住；
//     头部变化或满 14 天 → 不挡（可重开）；
//   executed：头部提交未变 → 挡住（已留过言，不以满 14 天自动再催）；头部变化 → 不挡；
//   expired：从不挡住。
// 头部比较：任一侧 headSha 缺失时按「未变」处理（取证不足不重开、不再催，保守口径）。
export const REJECTED_COOLDOWN_MS = 14 * 24 * 3600 * 1000;

export function findBlockingFinding(
	repo: string,
	type: string,
	subject: string | number,
	{ headSha = null, now = new Date() }: { headSha?: string | null; now?: Date } = {},
): Finding | null {
	const same = readAll().filter((f) => f.repo === repo && f.type === type && f.subject === String(subject));
	const active = same.find((f) => f.status === "open" || f.status === "approved" || f.status === "executing");
	if (active) return active;
	const headSame = (f: Finding) => !headSha || !f.headSha || f.headSha === headSha;
	for (const f of same) {
		if (f.status === "executed" && headSame(f)) return f;
		if (f.status === "rejected" && headSame(f) && now.getTime() - Date.parse(f.updatedAt) < REJECTED_COOLDOWN_MS) return f;
	}
	return null;
}

// 可改字段：status / title / summary / suggestedAction / expiresAt。
// 其余字段（repo/type/subject/evidenceUrl/botId/headSha/workflow）是取证事实，立住后不许改；writeIntent 自
// R1 起同样不可改——批准的是用户看到的那份内容，批准后以批准记录的意图快照为准执行。
const PATCHABLE = ["status", "title", "summary", "suggestedAction", "expiresAt"];

export function updateFinding(id: string, patch: Record<string, unknown>): Finding | null {
	const all = readAll();
	const idx = all.findIndex((f) => f.id === id);
	if (idx < 0) return null;
	// 状态迁移强制（R1）：status 真正变化且目标是合法枚举时必须落在迁移表内，否则抛 409；
	// 枚举外的 status 仍由 buildFinding 按非法值拒绝（报错口径不变）。
	const targetStatus = patch?.status;
	if (
		patch &&
		targetStatus !== undefined &&
		targetStatus !== all[idx].status &&
		(FINDING_STATUSES as readonly unknown[]).includes(targetStatus)
	) {
		const allowed = FINDING_TRANSITIONS[all[idx].status] ?? [];
		if (!allowed.includes(targetStatus as FindingStatus)) {
			throw Object.assign(new Error(`Finding 状态迁移非法：${all[idx].status} → ${targetStatus}`), { status: 409 });
		}
	}
	const merged: Finding = { ...all[idx] };
	// PATCHABLE 是白名单（仅 status/title/summary/suggestedAction/expiresAt），
	// 按键名写回属主对象是已定不变量，类型系统表达不了，故经 unknown 中转。
	const mergedRecord = merged as unknown as Record<string, unknown>;
	for (const key of PATCHABLE) {
		if (patch && patch[key] !== undefined) mergedRecord[key] = patch[key];
	}
	// 借 buildFinding 复检合并结果（status/writeIntent/expiresAt 的合法性都在里面）
	const checked = buildFinding(merged);
	const next = { ...all[idx], ...checked, id: all[idx].id, createdAt: all[idx].createdAt, updatedAt: new Date().toISOString() };
	all[idx] = next;
	rewriteAll(all);
	return next;
}

// 注意（R1 核查）：deleteFinding 没有生产路径调用——server / scan / approvals / gateway
// 均不删 Finding（关闭走状态迁移），仅存储层单测使用。不要在生产路径里接它。
export function deleteFinding(id: string): boolean {
	const all = readAll();
	const next = all.filter((f) => f.id !== id);
	if (next.length === all.length) return false;
	rewriteAll(next);
	return true;
}
