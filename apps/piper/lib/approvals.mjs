// 待批收件箱（P1-5 读模型 + P1-6 批准执行）：待批项不是另一份存储——它就是带
// writeIntent 的 Finding 的审批视图。Finding 是唯一事实源（lib/findings.mjs），本模块
// 负责读模型整形、过期清理、批准/驳回的状态迁移；批准后经 lib/gateway.mjs 执行写入
//（本模块不直接调用任何 GitHub 写接口）。审计（lib/audit.mjs）记录 approved /
// rejected / 以及网关的 denied / executed / failed，收件箱据审计展示最近失败原因。
// 执行失败时 Finding 保持 approved：错误经 lastError 展示，再次点批准即重试。
import { getFinding, listFindings, updateFinding } from "./findings.mjs";
import { appendAudit, executedCommentUrl, latestFailureReason } from "./audit.mjs";
import { gatewayExecuteWrite } from "./gateway.mjs";
import { addNotification } from "./notify.mjs";
import { saveArtifact } from "./store.mjs";

function conflict(message) {
	return Object.assign(new Error(message), { status: 409 });
}

function badRequest(message) {
	return Object.assign(new Error(message), { status: 400 });
}

// 过期清理：open 且 expiresAt 已过的 Finding 自动转 expired（惰性清理，读列表时顺带做，
// 不另起定时器）。approved 的过期由网关执行前复检处理，不在这里悄悄改状态。
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
		// 来自审计：最近一次执行失败/被拒原因（approved 待重试时展示）与已执行评论链接。
		lastError: f.status === "approved" ? latestFailureReason(f.id) : null,
		commentUrl: executedCommentUrl(f.id),
	};
}

// 待批列表：带 writeIntent 且状态为 open / approved 的 Finding，新在前。
export function listApprovals() {
	sweepExpiredFindings();
	return listFindings()
		.filter((f) => f.writeIntent && (f.status === "open" || f.status === "approved"))
		.map(toApproval);
}

export function getApproval(id) {
	sweepExpiredFindings();
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

// 批准 → 先落 approved 状态与审计，再经网关执行（执行前网关会逐条复检）。
// 返回 { approval, execution }：execution.ok 时 approval.status 已是 executed 并带
// commentUrl；失败时 status 保持 approved、lastError 写明原因，可再次批准重试。
// 已关闭（rejected / expired / executed）再批准 → 409；不存在 → null（路由转 404）。
// saveArtifactFn 可注入（测试用替身，避免在真实产物目录留下替身执行记录）。
export async function approveApproval(id, { saveArtifactFn = saveArtifact } = {}) {
	const f = requireApprovable(id);
	if (!f) return null;
	if (f.status === "rejected" || f.status === "expired" || f.status === "executed") {
		throw conflict(`该待批项已关闭（当前状态 ${f.status}），不能再批准`);
	}
	if (f.status === "open") {
		updateFinding(id, { status: "approved" });
		appendAudit({ botId: f.botId, intent: { ...f.writeIntent, repo: f.repo }, result: "approved", findingId: id, approvalId: id });
	}
	const execution = await gatewayExecuteWrite({ findingId: id, intent: f.writeIntent });
	const fresh = getFinding(id);
	if (execution.ok) {
		const artifact = saveArtifactFn({
			botId: f.botId,
			kind: "gateway-execution",
			title: `网关执行记录：${f.repo} PR #${f.writeIntent.prNumber} 评论`,
			body: [
				`# 网关执行记录`,
				``,
				`- 时间：${new Date().toISOString()}`,
				`- Finding：${f.id}（${f.title}）`,
				`- 写入： 在 ${f.repo} 的 PR #${f.writeIntent.prNumber} 下发表评论`,
				`- 评论链接：${execution.commentUrl ?? "（GitHub 未返回链接）"}`,
				`- 证据：${f.evidenceUrl}`,
				``,
				`评论正文：`,
				``,
				f.writeIntent.body,
			].join("\n"),
		});
		addNotification({
			type: "approval.executed",
			title: "待批写操作已执行",
			body: `已在 ${f.repo} 的 PR #${f.writeIntent.prNumber} 发表评论：${execution.commentUrl ?? ""}`,
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
	if (f.status !== "open" && f.status !== "approved") throw conflict(`该待批项已关闭（当前状态 ${f.status}），不能再驳回`);
	const next = updateFinding(id, { status: "rejected" });
	appendAudit({
		botId: f.botId,
		intent: { ...f.writeIntent, repo: f.repo },
		result: "rejected",
		reason: "rejected_by_user",
		findingId: id,
		approvalId: id,
	});
	return toApproval(next);
}
