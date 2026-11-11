// 网关审计日志（P1-6）：data/audit.jsonl 一行一条，只追加，进程重启不丢。
// 正负两类都要留痕：被网关拒绝的写请求（denied，含原因）与批准 / 执行 / 失败都在这里。
// 字段钉死：ts 时间、botId、intent 摘要（kind / repo / prNumber / bodyLength /
// bodyPreview——只存摘要与预览，绝不存任何秘密）、result、reason、findingId、
// approvalId（本批与 findingId 同值，收件箱即按 Finding 审批）、commentUrl（执行成功时）。
// 文件路径可用环境变量 PIPER_AUDIT_FILE 覆盖（仅供单元测试隔离，缺省走 data/）。
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, ensureData } from "./store.js";
import { redact } from "./redact.js";

// executing（R1）：网关领取执行、真正发出评论之前先落一条，进程崩溃后能看到「发到一半」。
// expired（R5）：扫描前对账把失效的 open/approved Finding 自动退役时落一条，
// reason 形如 reconciled:<原因>（pr_merged / pr_closed / pr_draft / pr_approved / ci_green / ci_superseded）。
export const AUDIT_RESULTS = ["denied", "approved", "executing", "executed", "failed", "rejected", "expired"];

function auditFile() {
	return process.env.PIPER_AUDIT_FILE || join(DATA_DIR, "audit.jsonl");
}

// 意图摘要：正文只留长度与前 120 字符预览（收件箱里有全文，审计是追责用的摘要）。
// 脱敏是硬要求：预览先经统一 redact（lib/redact.ts，覆盖当前/历史令牌、模型 Key 与
// 前缀模式）再落盘——审计文件本身绝不能成为秘密的第二个落点。R7 前这里只替换当前
// GitHub 令牌，旧令牌与模型 Key 都漏（审计 M4）。
export function summarizeIntent(intent) {
	if (!intent || typeof intent !== "object") return null;
	const rawBody = typeof intent.body === "string" ? intent.body : "";
	return {
		kind: intent.kind ?? null,
		repo: intent.repo ?? null,
		prNumber: intent.prNumber ?? null,
		bodyLength: rawBody.length,
		bodyPreview: redact(rawBody).slice(0, 120),
	};
}

export function appendAudit({ botId = null, intent = null, result, reason = null, findingId = null, approvalId = null, commentUrl = null }) {
	if (!AUDIT_RESULTS.includes(result)) throw new Error(`未知审计结果: ${result}`);
	const entry = {
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

function readAll() {
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
		.filter(Boolean);
}

// 按 findingId 追溯（收件箱错误展示与验收追审计都走这里），时间正序（先发生先排）。
export function listAudit({ findingId } = {}) {
	return readAll()
		.filter((r) => findingId === undefined || r.findingId === findingId)
		.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

// 某 Finding 最近一次执行失败的原因（供收件箱展示「为什么没发出去、可重试」）。
export function latestFailureReason(findingId) {
	const failed = listAudit({ findingId }).filter((r) => r.result === "failed" || r.result === "denied");
	return failed.length ? failed[failed.length - 1].reason : null;
}

export function executedCommentUrl(findingId) {
	const done = listAudit({ findingId }).filter((r) => r.result === "executed");
	return done.length ? done[done.length - 1].commentUrl : null;
}
