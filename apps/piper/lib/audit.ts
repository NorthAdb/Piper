// 网关审计日志（P1-6）：data/audit.jsonl 一行一条，只追加，进程重启不丢。
// 正负两类都要留痕：被网关拒绝的写请求（denied，含原因）与批准 / 执行 / 失败都在这里。
// 字段钉死：ts 时间、botId、intent 摘要（kind / repo / prNumber / bodyLength /
// bodyPreview——只存摘要与预览，绝不存任何秘密）、result、reason、findingId、
// approvalId（本批与 findingId 同值，收件箱即按 Finding 审批）、commentUrl（执行成功时）。
// 文件路径可用环境变量 PIPER_AUDIT_FILE 覆盖（仅供单元测试隔离，缺省走 data/）。
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, ensureData } from "./store.ts";
import { redact } from "./redact.ts";

// executing（R1）：网关领取执行、真正发出评论之前先落一条，进程崩溃后能看到「发到一半」。
// expired（R5）：扫描前对账把失效的 open/approved Finding 自动退役时落一条，
// reason 形如 reconciled:<原因>（pr_merged / pr_closed / pr_draft / pr_approved / ci_green / ci_superseded）。
// edited（拍板切片二）：批准前用户改了评论正文时落一条，intent 摘要即新正文；
// 已批准状态下改文同时作废原批准（reason=approval_invalidated），审计里可追到
// 「批的是哪一版、哪一版被改掉」。
export const AUDIT_RESULTS = ["denied", "approved", "executing", "executed", "failed", "rejected", "expired", "edited"] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

export interface IntentSummary {
	kind: unknown;
	repo: unknown;
	prNumber: unknown;
	bodyLength: number;
	bodyPreview: string;
}

export interface AuditEntry {
	id: string;
	ts: string;
	botId: string | null;
	intent: IntentSummary | null;
	result: string;
	reason: string | null;
	findingId: string | null;
	approvalId: string | null;
	commentUrl: string | null;
}

function auditFile(): string {
	return process.env.PIPER_AUDIT_FILE || join(DATA_DIR, "audit.jsonl");
}

// 意图摘要：正文只留长度与前 120 字符预览（收件箱里有全文，审计是追责用的摘要）。
// 脱敏是硬要求：预览先经统一 redact（lib/redact.ts，覆盖当前/历史令牌、模型 Key 与
// 前缀模式）再落盘——审计文件本身绝不能成为秘密的第二个落点。R7 前这里只替换当前
// GitHub 令牌，旧令牌与模型 Key 都漏（审计 M4）。
export function summarizeIntent(intent: unknown): IntentSummary | null {
	if (!intent || typeof intent !== "object") return null;
	const o = intent as { body?: unknown; kind?: unknown; repo?: unknown; prNumber?: unknown };
	const rawBody = typeof o.body === "string" ? o.body : "";
	return {
		kind: o.kind ?? null,
		repo: o.repo ?? null,
		prNumber: o.prNumber ?? null,
		bodyLength: rawBody.length,
		bodyPreview: redact(rawBody).slice(0, 120),
	};
}

export function appendAudit({
	botId = null,
	intent = null,
	result,
	reason = null,
	findingId = null,
	approvalId = null,
	commentUrl = null,
}: {
	botId?: string | null;
	intent?: unknown;
	result: string;
	reason?: string | null;
	findingId?: string | null;
	approvalId?: string | null;
	commentUrl?: string | null;
}): AuditEntry {
	if (!(AUDIT_RESULTS as readonly string[]).includes(result)) throw new Error(`未知审计结果: ${result}`);
	const entry: AuditEntry = {
		id: `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		ts: new Date().toISOString(),
		botId,
		intent: summarizeIntent(intent),
		result,
		// reason 常含外部错误原文（如 GitHub/模型厂商回显），落盘前统一脱敏（R7）。
		reason: typeof reason === "string" ? redact(reason) : reason,
		findingId,
		approvalId,
		commentUrl,
	};
	ensureData();
	appendFileSync(auditFile(), JSON.stringify(entry) + "\n", "utf8");
	return entry;
}

function readAll(): AuditEntry[] {
	const file = auditFile();
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
		.filter((r): r is AuditEntry => Boolean(r));
}

// 按 findingId 追溯（收件箱错误展示与验收追审计都走这里），时间正序（先发生先排）。
export function listAudit({ findingId }: { findingId?: string } = {}): AuditEntry[] {
	return readAll()
		.filter((r) => findingId === undefined || r.findingId === findingId)
		.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

// 某 Finding 最近一次执行失败的原因（供收件箱展示「为什么没发出去、可重试」）。
export function latestFailureReason(findingId: string): string | null {
	const failed = listAudit({ findingId }).filter((r) => r.result === "failed" || r.result === "denied");
	return failed.length ? failed[failed.length - 1].reason : null;
}

export function executedCommentUrl(findingId: string): string | null {
	const done = listAudit({ findingId }).filter((r) => r.result === "executed");
	return done.length ? done[done.length - 1].commentUrl : null;
}

// 终态审计（已关闭视图用）：某 Finding 最近一条终态记录（rejected / expired /
// executed），给收件箱说明「它为什么没了、何时关闭的」。TTL 到期清理（sweep）不写
// 审计，此类 expired 返回 null，界面按状态本身说明，不编造原因。
export function latestTerminalAudit(findingId: string): AuditEntry | null {
	const terminal = listAudit({ findingId }).filter((r) => r.result === "rejected" || r.result === "expired" || r.result === "executed");
	return terminal.length ? terminal[terminal.length - 1] : null;
}
