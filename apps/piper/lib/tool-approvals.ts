// 对话工具待批记录（P2-3，切片 §1.1 锁定形状）：循环闸把 ask 的工具调用先
// 落盘到这里再等待——批准跨进程重启仍可放行/驳回。独立于 Finding 存储
// （Finding.type 仍只有三个扫描规则值，不得把工具待批硬塞进去）。
// 存储：PIPER_DATA_DIR/tool-approvals.json（JSON 数组，文件优先；路径可用
// 环境变量 PIPER_TOOL_APPROVALS_FILE 覆盖，仅供测试隔离）。
// 状态机：pending → approved / rejected / cancelled；approved → executed /
// failed / rejected。executed / rejected / cancelled / failed 为终态。
// 网关执行失败（目标已关、无令牌等暂时性原因）不进 failed：记录保持
// approved 并把原因写进 error，用户可再次批准重试（与 Finding 的
// approved 可重试口径一致）；failed 只给网关校验级拒绝（快照不符、
// 正文含秘密、不支持的意图这类重试也不会变的情况）。
// 落盘纪律（P2-4，#35 审计留项）：整表写入走 store 的原子落盘（临时文件 +
// rename），写一半崩溃不留截断文件；读到损坏内容（JSON 解析失败或不是
// 数组）时把原文件改名隔离（.corrupt-<时间戳>）并记日志，绝不把损坏当成
// 空表后在下一次写入时静默覆盖掉原记录。
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, ensureData, writeFileAtomicSync } from "./store.ts";
import { containsSecret } from "./redact.ts";
import type { IntentSnapshot } from "./gateway.ts";

export type ToolApprovalStatus = "pending" | "approved" | "rejected" | "executed" | "cancelled" | "failed";

export interface ToolApproval {
	id: string; // 形如 "ta-…"
	kind: "tool_call";
	botId: string;
	sessionId: string;
	toolCallId: string;
	toolName: string;
	argsSnapshot: unknown; // 批准比对用；仅 body 可在 pending 时经 updateToolApprovalBody 改（P2-4），其余字段锁定
	status: ToolApprovalStatus;
	createdAt: string;
	updatedAt: string;
	error?: string | null;
}

export const TOOL_APPROVAL_TRANSITIONS: Record<ToolApprovalStatus, ToolApprovalStatus[]> = {
	pending: ["approved", "rejected", "cancelled"],
	approved: ["executed", "failed", "rejected"],
	rejected: [],
	executed: [],
	cancelled: [],
	failed: [],
};

function toolApprovalsFile(): string {
	return process.env.PIPER_TOOL_APPROVALS_FILE || join(DATA_DIR, "tool-approvals.json");
}

function readAll(): ToolApproval[] {
	const file = toolApprovalsFile();
	if (!existsSync(file)) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		parsed = undefined;
	}
	if (Array.isArray(parsed)) return parsed as ToolApproval[];
	// 损坏隔离：原文件改名保留证据，后续写入从空表开始——而不是把解析失败
	// 当成空数组、再在下一次 writeAll 时无声覆盖原文件（#35 审计留项）。
	try {
		renameSync(file, `${file}.corrupt-${Date.now()}`);
		console.error(`[piper] tool-approvals.json 内容损坏，已隔离原文件并从空表继续：${file}`);
	} catch {
		console.error(`[piper] tool-approvals.json 内容损坏且隔离失败，按空表继续：${file}`);
	}
	return [];
}

function writeAll(records: ToolApproval[]): void {
	ensureData();
	writeFileAtomicSync(toolApprovalsFile(), JSON.stringify(records, null, 2) + "\n", "utf8");
}

export function createToolApproval(input: {
	botId: string;
	sessionId: string;
	toolCallId: string;
	toolName: string;
	argsSnapshot: unknown;
}): ToolApproval {
	// 同一 (sessionId, toolCallId) 只许一条未终结记录：循环重入或宿主重复
	// 落盘时复用已存在的那条，避免收件箱出现双份。
	const existing = findToolApprovalByToolCall(input.sessionId, input.toolCallId);
	if (existing && existing.status !== "executed" && existing.status !== "rejected" && existing.status !== "cancelled" && existing.status !== "failed") {
		return existing;
	}
	const now = new Date().toISOString();
	const record: ToolApproval = {
		id: `ta-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		kind: "tool_call",
		botId: input.botId,
		sessionId: input.sessionId,
		toolCallId: input.toolCallId,
		toolName: input.toolName,
		argsSnapshot: input.argsSnapshot ?? null,
		status: "pending",
		createdAt: now,
		updatedAt: now,
		error: null,
	};
	const all = readAll();
	all.push(record);
	writeAll(all);
	return record;
}

export function getToolApproval(id: string): ToolApproval | null {
	return readAll().find((r) => r.id === id) ?? null;
}

export function listToolApprovals(filter: { botId?: string; status?: ToolApprovalStatus } = {}): ToolApproval[] {
	return readAll().filter(
		(r) => (filter.botId === undefined || r.botId === filter.botId) && (filter.status === undefined || r.status === filter.status),
	);
}

export function findToolApprovalByToolCall(sessionId: string, toolCallId: string): ToolApproval | null {
	const matches = readAll().filter((r) => r.sessionId === sessionId && r.toolCallId === toolCallId);
	return matches.length ? matches[matches.length - 1] : null;
}

export function updateToolApproval(id: string, patch: { status: ToolApprovalStatus; error?: string | null }): ToolApproval {
	const all = readAll();
	const idx = all.findIndex((r) => r.id === id);
	if (idx < 0) throw Object.assign(new Error(`工具待批不存在: ${id}`), { status: 404 });
	const current = all[idx];
	if (patch.status !== current.status) {
		const allowed = TOOL_APPROVAL_TRANSITIONS[current.status] ?? [];
		if (!allowed.includes(patch.status)) {
			throw Object.assign(new Error(`工具待批状态不可从 ${current.status} 变为 ${patch.status}`), { status: 409 });
		}
	}
	const next: ToolApproval = {
		...current,
		status: patch.status,
		error: patch.error !== undefined ? patch.error : current.error ?? null,
		updatedAt: new Date().toISOString(),
	};
	all[idx] = next;
	writeAll(all);
	return next;
}

// 改正文（P2-4）：只许改 argsSnapshot.body，其余字段（repo / kind /
// number）是锁定字段——路由层先对请求里带的锁定字段做不一致校验（400），
// 这里只负责正文本身与状态。仅 pending 可改：已批准的记录正文即冻结快照，
// 要改先驳回让 bot 重新提出（ToolApproval 状态机没有 approved → pending
// 这条边，不为改正文新开状态迁移）。正文校验与 Finding 改文同口径
// （非空、长度上限、疑似含秘密拒绝），上限与 approvals.ts 的
// COMMENT_BODY_MAX_CHARS 对齐。
export const TOOL_COMMENT_BODY_MAX_CHARS = 10000;

export function updateToolApprovalBody(id: string, rawBody: unknown): ToolApproval {
	const all = readAll();
	const idx = all.findIndex((r) => r.id === id);
	if (idx < 0) throw Object.assign(new Error(`工具待批不存在: ${id}`), { status: 404 });
	const current = all[idx];
	if (current.status !== "pending") {
		throw Object.assign(new Error(`该工具待批已不在待批准状态（当前状态 ${current.status}），不能改正文`), { status: 409 });
	}
	if (typeof rawBody !== "string" || !rawBody.trim()) throw Object.assign(new Error("评论正文不能为空"), { status: 400 });
	if (rawBody.length > TOOL_COMMENT_BODY_MAX_CHARS) {
		throw Object.assign(new Error(`评论正文过长（上限 ${TOOL_COMMENT_BODY_MAX_CHARS} 字）`), { status: 400 });
	}
	if (containsSecret(rawBody)) {
		throw Object.assign(new Error("评论正文疑似包含令牌或密钥，已拒绝保存（凭据请勿写进评论）"), { status: 400 });
	}
	const snap = current.argsSnapshot;
	if (!snap || typeof snap !== "object" || Array.isArray(snap) || typeof (snap as { body?: unknown }).body !== "string") {
		throw Object.assign(new Error("该工具待批的参数快照不支持正文编辑"), { status: 409 });
	}
	const next: ToolApproval = {
		...current,
		argsSnapshot: { ...(snap as Record<string, unknown>), body: rawBody },
		updatedAt: new Date().toISOString(),
	};
	all[idx] = next;
	writeAll(all);
	return next;
}

// 网关执行用的意图快照：从落盘参数快照整形（github_comment 的参数形状
// {repo, kind, number, body} → 网关的 IntentSnapshot）。形状不对返回 null，
// 网关据此 denied——落盘后参数被改坏的记录发不出去。
export function toolIntentSnapshotOf(record: ToolApproval | null | undefined): IntentSnapshot | null {
	const args = record?.argsSnapshot as { repo?: unknown; kind?: unknown; number?: unknown; body?: unknown } | null | undefined;
	if (!args || typeof args !== "object") return null;
	if (typeof args.repo !== "string" || typeof args.body !== "string") return null;
	if (args.kind !== "pr_comment" && args.kind !== "issue_comment") return null;
	if (!Number.isInteger(args.number)) return null;
	const number = args.number as number;
	return {
		kind: args.kind,
		repo: args.repo,
		prNumber: args.kind === "pr_comment" ? number : null,
		issueNumber: args.kind === "issue_comment" ? number : null,
		body: args.body,
	};
}

// 快照冲突判定（P2-5，#33 MAJOR-2 宿主契约 / #35 审计项）：批准与恢复
// 两条路径放行时都必须把落盘的 argsSnapshot 经 resolveToolCall 的
// arguments 回传，快照才是被批准的那份参数。恢复路径的 transcript 是从
// 会话 JSONL 重建的，条目里存的是模型原始参数：它与快照在 body 之外
// 任一字段不一致，说明落盘记录与会话流水已经对不上（被篡改或写坏），
// 此时由本层判定冲突、调用方拒绝放行，绝不拿对不上的参数执行。
// body 是唯一豁免字段：它是 pending 时可经 updateToolApprovalBody 合法
// 改写的字段，快照里的正文比流水里的原始正文新，分歧以快照为准、
// 不算冲突。快照本身不是对象（异常记录）时不判冲突——返回 null 的
// 路径由各工具 execute / 网关的形状校验兜底。
function deepEqualJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((v, i) => deepEqualJson(v, b[i]));
	}
	const ao = a as Record<string, unknown>;
	const bo = b as Record<string, unknown>;
	const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
	for (const k of keys) {
		if (!deepEqualJson(ao[k], bo[k])) return false;
	}
	return true;
}

export function snapshotConflictReason(record: ToolApproval, candidateArgs: unknown): string | null {
	const snap = record.argsSnapshot;
	if (!snap || typeof snap !== "object" || Array.isArray(snap)) return null;
	if (!candidateArgs || typeof candidateArgs !== "object" || Array.isArray(candidateArgs)) {
		return "会话流水里的调用参数不是对象，与落盘快照形状不一致";
	}
	const snapObj = snap as Record<string, unknown>;
	const candObj = candidateArgs as Record<string, unknown>;
	const keys = new Set([...Object.keys(snapObj), ...Object.keys(candObj)]);
	for (const key of keys) {
		if (key === "body") continue;
		if (!deepEqualJson(snapObj[key], candObj[key])) return `参数 ${key} 与批准快照不一致`;
	}
	return null;
}

// 收件箱联合视图里的工具待批项（§1.1：每一项必须带 kind）。
export interface ToolApprovalView extends ToolApproval {
	kind: "tool_call";
}

export function toToolApprovalView(record: ToolApproval): ToolApprovalView {
	return { ...record, kind: "tool_call" };
}

export function listToolApprovalViews({ closed = false }: { closed?: boolean } = {}): ToolApprovalView[] {
	const active: ToolApprovalStatus[] = ["pending", "approved"];
	const terminal: ToolApprovalStatus[] = ["rejected", "executed", "cancelled", "failed"];
	return readAll()
		.filter((r) => (closed ? terminal : active).includes(r.status))
		.map(toToolApprovalView);
}
