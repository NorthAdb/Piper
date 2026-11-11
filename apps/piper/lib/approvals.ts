// 待批收件箱（P1-5 读模型 + P1-6 批准执行 + R1 返工）：待批项不是另一份存储——它就是带
// writeIntent 的 Finding 的审批视图。Finding 是唯一事实源（lib/findings.ts），本模块
// 负责读模型整形、批准/驳回的状态迁移；过期清理由显式步骤触发（见 sweepExpiredFindings）；
// 批准后经 lib/gateway.ts 执行写入
//（本模块不直接调用任何 GitHub 写接口）。审计（lib/audit.ts）记录 approved /
// rejected / 以及网关的 denied / executing / executed / failed，收件箱据审计展示最近失败原因。
// 执行失败时 Finding 保持 approved：错误经 lastError 展示，再次点批准即重试。
// R1：批准动作先落一条 append-only 批准记录（data/approvals.jsonl）——批准时刻的意图
// 快照 + SHA-256 哈希。GET 下发 intentHash，POST 批准必须带回，哈希对不上当前内容回
// 409「内容已变，请重新查看」；网关只执行快照，批准的是「看到的那段内容」而不是某个 id。
// 文件路径可用环境变量 PIPER_APPROVALS_FILE 覆盖（仅供单元测试隔离，缺省走 data/）。
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getFinding, listFindings, updateFinding } from "./findings.js";
import { appendAudit, executedCommentUrl, latestFailureReason } from "./audit.js";
import { gatewayExecuteWrite } from "./gateway.js";
import { addNotification } from "./notify.js";
import { DATA_DIR, ensureData, saveArtifact } from "./store.js";

function conflict(message) {
	return Object.assign(new Error(message), { status: 409 });
}

// ---- 批准记录（append-only）：批准时刻的意图快照与哈希 ----
function approvalsFile() {
	return process.env.PIPER_APPROVALS_FILE || join(DATA_DIR, "approvals.jsonl");
}

// 意图快照：网关执行的唯一内容来源。repo 取 Finding.repo（取证事实，不可改）。
export function intentSnapshotOf(finding) {
	if (!finding?.writeIntent) return null;
	return {
		kind: finding.writeIntent.kind,
		repo: finding.repo,
		prNumber: finding.writeIntent.prNumber,
		body: finding.writeIntent.body,
	};
}

export function intentHashOf(snapshot) {
	if (!snapshot) return null;
	return createHash("sha256")
		.update(JSON.stringify({ kind: snapshot.kind, repo: snapshot.repo, prNumber: snapshot.prNumber, body: snapshot.body }))
		.digest("hex");
}

function readApprovalRecords() {
	const file = approvalsFile();
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

export function listApprovalRecords(findingId) {
	return readApprovalRecords().filter((r) => findingId === undefined || r.findingId === findingId);
}

export function latestApprovalRecord(findingId) {
	const recs = listApprovalRecords(findingId);
	return recs.length ? recs[recs.length - 1] : null;
}

function createApprovalRecord(finding) {
	const intentSnapshot = intentSnapshotOf(finding);
	const record = {
		approvalId: `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		findingId: finding.id,
		intentSnapshot,
		intentHash: intentHashOf(intentSnapshot),
		approvedAt: new Date().toISOString(),
	};
	ensureData();
	appendFileSync(approvalsFile(), JSON.stringify(record) + "\n", "utf8");
	return record;
}

function badRequest(message) {
	return Object.assign(new Error(message), { status: 400 });
}

// executing 崩溃恢复（F1，第二轮返工）：网关领取执行后若进程在落终态前死亡
// （kill -9、断电），Finding 会永久卡在 executing——批准 409、驳回 409，无出口。
// 恢复把超时的 executing 退回 approved 并写审计 failed/interrupted，不自动重发；
// 之后用户再点批准，网关会先查幂等标记：评论已发出的直接记 executed，不会双发。
// 阈值 5 分钟：正常执行的网络调用在秒级完成，5 分钟足够覆盖慢网络，又不让真
// 卡死的事项久等。server 启动时以 olderThanMs=0 调用（本进程刚起，数据锁保证没有
// 第二个活进程，任何 executing 必然是上一进程的残留）；调度周期 tick 用缺省阈值。
export const EXECUTING_RECOVERY_MS = 5 * 60 * 1000;

export function recoverInterruptedExecutions({ now = new Date(), olderThanMs = EXECUTING_RECOVERY_MS } = {}) {
	let recovered = 0;
	for (const f of listFindings({ status: "executing" })) {
		if (now.getTime() - Date.parse(f.updatedAt) < olderThanMs) continue;
		updateFinding(f.id, { status: "approved" });
		appendAudit({
			botId: f.botId,
			intent: f.writeIntent ? { ...f.writeIntent, repo: f.repo } : null,
			result: "failed",
			reason: "interrupted",
			findingId: f.id,
			approvalId: latestApprovalRecord(f.id)?.approvalId ?? null,
		});
		recovered += 1;
	}
	return recovered;
}

// 过期清理：open 且 expiresAt 已过的 Finding 转 expired。R10 起 GET 读路径不再顺带
// 做这件事（读接口无写副作用）——只由显式步骤调用：晨间扫描开始前、调度周期 tick
// （server.ts 每 30 秒）、以及批准/驳回的写路径（requireApprovable）。approved 的
// 过期由网关执行前复检处理，不在这里悄悄改状态。
export function sweepExpiredFindings(now = new Date()) {
	let swept = 0;
	for (const f of listFindings({ status: "open" })) {
		if (f.expiresAt && Date.parse(f.expiresAt) <= now.getTime()) {
			updateFinding(f.id, { status: "expired" });
			swept += 1;
		}
	}
	return swept;
}

export function toApproval(f) {
	const record = latestApprovalRecord(f.id);
	return {
		id: f.id,
		findingId: f.id,
		botId: f.botId,
		repo: f.repo,
		type: f.type,
		title: f.title,
		summary: f.summary,
		evidenceUrl: f.evidenceUrl,
		suggestedAction: f.suggestedAction,
		writeIntent: f.writeIntent,
		status: f.status,
		expiresAt: f.expiresAt,
		createdAt: f.createdAt,
		updatedAt: f.updatedAt,
		// R1：批准记录 id 与意图哈希——前端批准时必须把 intentHash 带回，内容变了就回 409。
		// 尚无批准记录（open）时下发当前内容的哈希；已有记录时下发记录里的哈希（批准快照）。
		approvalId: record?.approvalId ?? null,
		intentHash: record?.intentHash ?? intentHashOf(intentSnapshotOf(f)),
		// 来自审计：最近一次执行失败/被拒原因（approved 待重试时展示）与已执行评论链接。
		lastError: f.status === "approved" ? latestFailureReason(f.id) : null,
		commentUrl: executedCommentUrl(f.id),
	};
}

// 待批列表：带 writeIntent 且状态为 open / approved / executing 的 Finding，新在前。
// 纯读：不做过期清理（R10）——清理的显式触发点见 sweepExpiredFindings 的注释。
export function listApprovals() {
	return listFindings()
		.filter((f) => f.writeIntent && (f.status === "open" || f.status === "approved" || f.status === "executing"))
		.map(toApproval);
}

export function getApproval(id) {
	const f = getFinding(id);
	return f && f.writeIntent ? toApproval(f) : null;
}

function requireApprovable(id) {
	sweepExpiredFindings();
	const f = getFinding(id);
	if (!f) return null;
	if (!f.writeIntent) throw badRequest("该事项没有待批写操作（writeIntent 为空）");
	return f;
}

// 批准 → 先校验 intentHash 并落批准记录与 approved 状态/审计，再经网关执行快照。
// 返回 { approval, execution }：execution.ok 时 approval.status 已是 executed 并带
// commentUrl；失败时 status 保持 approved、lastError 写明原因，可再次批准重试。
// 已关闭（rejected / expired / executed）再批准 → 409；正在 executing → 409「正在执行」
//（在途互斥：本函数的校验、落记录、改状态与网关的领取都在同步段内完成，单进程里
// 第二个并发批准必然看到 executing）；不存在 → null（路由转 404）。
// saveArtifactFn 可注入（测试用替身，避免在真实产物目录留下替身执行记录）。
export async function approveApproval(id, { intentHash, saveArtifactFn = saveArtifact } = {}) {
	const f = requireApprovable(id);
	if (!f) return null;
	if (f.status === "rejected" || f.status === "expired" || f.status === "executed") {
		throw conflict(`该待批项已关闭（当前状态 ${f.status}），不能再批准`);
	}
	if (f.status === "executing") {
		throw conflict("该待批项正在执行，请稍候");
	}
	let record = latestApprovalRecord(id);
	if (f.status === "open") {
		// 批准的是「看到的那段内容」：带来的哈希必须与当前内容一致，否则先重新查看。
		if (!intentHash || intentHash !== intentHashOf(intentSnapshotOf(f))) {
			throw conflict("内容已变，请重新查看");
		}
		record = createApprovalRecord(f);
		updateFinding(id, { status: "approved" });
		appendAudit({ botId: f.botId, intent: { ...f.writeIntent, repo: f.repo }, result: "approved", findingId: id, approvalId: record.approvalId });
	} else {
		// approved 重试：沿用原批准记录（快照与 approvalId 不变，评论幂等标记才对得上）；
		// 历史数据没有记录时按当前内容补一条。带回的哈希若与记录不符同样回 409。
		if (!record) record = createApprovalRecord(f);
		else if (intentHash && intentHash !== record.intentHash) throw conflict("内容已变，请重新查看");
	}
	const execution = await gatewayExecuteWrite({ findingId: id, approvalId: record.approvalId, snapshot: record.intentSnapshot });
	const fresh = getFinding(id);
	if (execution.ok) {
		const artifact = saveArtifactFn({
			botId: f.botId,
			kind: "gateway-execution",
			title: `网关执行记录：${f.repo} PR #${record.intentSnapshot.prNumber} 评论`,
			body: [
				`# 网关执行记录`,
				``,
				`- 时间：${new Date().toISOString()}`,
				`- Finding：${f.id}（${f.title}）`,
				`- 批准记录：${record.approvalId}`,
				`- 写入： 在 ${f.repo} 的 PR #${record.intentSnapshot.prNumber} 下发表评论`,
				`- 评论链接：${execution.commentUrl ?? "（GitHub 未返回链接）"}`,
				`- 证据：${f.evidenceUrl}`,
				``,
				`评论正文（批准快照）：`,
				``,
				record.intentSnapshot.body,
			].join("\n"),
		});
		addNotification({
			type: "approval.executed",
			title: "待批写操作已执行",
			body: `已在 ${f.repo} 的 PR #${record.intentSnapshot.prNumber} 发表评论：${execution.commentUrl ?? ""}`,
			findingId: id,
			artifactId: artifact.id,
		});
		return { approval: toApproval(fresh), execution: { ...execution, artifactId: artifact.id } };
	}
	addNotification({
		type: "approval.failed",
		title: "待批写操作执行失败",
		body: `${f.title}：${execution.reason ?? execution.result}（保持已批准状态，可在收件箱重试）`,
		findingId: id,
	});
	return { approval: toApproval(fresh), execution };
}

// 驳回：open / approved → rejected，写审计，不调用任何写 API。
export function rejectApproval(id) {
	const f = requireApprovable(id);
	if (!f) return null;
	if (f.status === "executing") throw conflict("该待批项正在执行，不能驳回");
	if (f.status !== "open" && f.status !== "approved") throw conflict(`该待批项已关闭（当前状态 ${f.status}），不能再驳回`);
	const next = updateFinding(id, { status: "rejected" });
	appendAudit({
		botId: f.botId,
		intent: { ...f.writeIntent, repo: f.repo },
		result: "rejected",
		reason: "rejected_by_user",
		findingId: id,
		approvalId: latestApprovalRecord(id)?.approvalId ?? null,
	});
	return toApproval(next);
}
