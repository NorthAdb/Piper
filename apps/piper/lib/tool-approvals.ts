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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, ensureData } from "./store.ts";
import type { IntentSnapshot } from "./gateway.ts";

export type ToolApprovalStatus = "pending" | "approved" | "rejected" | "executed" | "cancelled" | "failed";

export interface ToolApproval {
	id: string; // 形如 "ta-…"
	kind: "tool_call";
	botId: string;
	sessionId: string;
	toolCallId: string;
	toolName: string;
	argsSnapshot: unknown; // 批准比对用，落盘后视为不可变（本件不支持批准时改参，P2-4 再议）
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
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function writeAll(records: ToolApproval[]): void {
	ensureData();
	writeFileSync(toolApprovalsFile(), JSON.stringify(records, null, 2) + "\n", "utf8");
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
