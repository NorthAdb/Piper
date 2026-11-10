// 「已批准」判定（审计返工 R5，口径已锁定，扫描与网关共用同一实现，不要在别处另写一份）：
// 输入是 GitHub reviews 数组（接口按提交时间正序返回）与 PR 当前 head SHA。
//   1. 按每位审查人取其最新一条审查（数组后出现的覆盖先出现的）；
//   2. 任一审查人最新为 CHANGES_REQUESTED → 仍待审（changes_requested）；
//   3. 至少一人最新为 APPROVED、且无人最新为 CHANGES_REQUESTED → 当前已批准；
//      COMMENTED 不改变判定；DISMISSED 等其他状态顶掉该审查人先前的表态（最新一条说了算）。
//   4. 陈旧批准：最新一条 APPROVED 所针对的 commit（commit_id）与当前 head SHA 不一致
//      → 批准后又推了新提交，视为陈旧批准、仍待审（stale_approval）。
//      head SHA 或 commit_id 缺失时不判陈旧（取证不足不误报，按其余规则判定）。
// 返回 { approved, reason }：approved=true 仅当 reason==="approved"。
export function evaluateReviews(reviews, headSha) {
	const list = Array.isArray(reviews) ? reviews : [];
	const latestByUser = new Map();
	for (const r of list) {
		if (!r || typeof r !== "object") continue;
		latestByUser.set(r.user?.login ?? "?", r);
	}
	const latest = [...latestByUser.values()];
	if (latest.some((r) => r.state === "CHANGES_REQUESTED")) return { approved: false, reason: "changes_requested" };
	if (!latest.some((r) => r.state === "APPROVED")) return { approved: false, reason: "no_approval" };
	const approvals = list.filter((r) => r?.state === "APPROVED");
	const lastApproval = approvals[approvals.length - 1];
	if (headSha && lastApproval?.commit_id && lastApproval.commit_id !== headSha) {
		return { approved: false, reason: "stale_approval" };
	}
	return { approved: true, reason: "approved" };
}

// PR 是否仍待审（扫描的 pr_needs_review 规则与网关执行前复检共用）。
export function prNeedsReview(reviews, headSha) {
	return !evaluateReviews(reviews, headSha).approved;
}
