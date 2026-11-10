// 待批收件箱（P1-5）：待批项不是另一份存储——它就是带 writeIntent 的 Finding 的审批视图。
// Finding 是唯一事实源（lib/findings.mjs），本模块只做读模型整形、过期清理与批准/驳回的
// 状态迁移。P1-5 阶段批准只改状态（approved），不执行任何对外写操作；真正的网关执行
// 在 P1-6 接入 approveApproval 的后半段，界面文案不得提前声称已执行。
// 待批列表含两种状态：open（待拍板）与 approved（已批准、待网关执行 / 执行失败可重试）。
import { getFinding, listFindings, updateFinding } from "./findings.mjs";

function conflict(message) {
	return Object.assign(new Error(message), { status: 409 });
}

function badRequest(message) {
	return Object.assign(new Error(message), { status: 400 });
}

// 过期清理：open 且 expiresAt 已过的 Finding 自动转 expired（惰性清理，读列表时顺带做，
// 不另起定时器）。approved 的过期由网关执行前复检处理（P1-6），不在这里悄悄改状态。
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

// 批准：open → approved（P1-5 只改状态）；已 approved 视为重复批准，回当前状态不报错。
// 已关闭（rejected / expired / executed）再批准 → 409。执行写入在 P1-6 接入。
export function approveApproval(id) {
	const f = requireApprovable(id);
	if (!f) return null;
	if (f.status === "approved") return toApproval(f);
	if (f.status !== "open") throw conflict(`该待批项已关闭（当前状态 ${f.status}），不能再批准`);
	return toApproval(updateFinding(id, { status: "approved" }));
}

// 驳回：open / approved → rejected，不产生任何对外写操作。
export function rejectApproval(id) {
	const f = requireApprovable(id);
	if (!f) return null;
	if (f.status !== "open" && f.status !== "approved") throw conflict(`该待批项已关闭（当前状态 ${f.status}），不能再驳回`);
	return toApproval(updateFinding(id, { status: "rejected" }));
}
