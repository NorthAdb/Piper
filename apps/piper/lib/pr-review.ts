// 「已批准」判定（审计返工 R5，口径已锁定，扫描与网关共用同一实现，不要在别处另写一份）：
// 输入是 GitHub reviews 数组（接口按提交时间正序返回）与 PR 当前 head SHA。
//   1. 按每位审查人取其「最新一条表态」：只有 APPROVED、CHANGES_REQUESTED、DISMISSED
//      改变该人的状态（数组后出现的覆盖先出现的）；COMMENTED 与 PENDING 忽略——
//      回复行内评论就会产生 COMMENTED，它不得撤销已有批准、也不得顶掉要求修改
//      （第二轮返工 F4）；DISMISSED 顶掉该人先前的表态（清掉先前批准或要求修改）。
//   2. 任一审查人最新表态为 CHANGES_REQUESTED → 仍待审（changes_requested）；
//   3. 至少一人最新表态为 APPROVED、且无人最新表态为 CHANGES_REQUESTED → 当前已批准。
//   4. 陈旧批准：最新一条 APPROVED 所针对的 commit（commit_id）与当前 head SHA 不一致
//      → 批准后又推了新提交，视为陈旧批准、仍待审（stale_approval）。
//      head SHA 或 commit_id 缺失时不判陈旧（取证不足不误报，按其余规则判定）。
// 返回 { approved, reason }：approved=true 仅当 reason==="approved"。
// GitHub reviews 接口条目的相关字段（外部 API 响应，只取判定用到的三个）。
export interface GithubReview {
	state?: string;
	user?: { login?: string } | null;
	commit_id?: string;
}

export type ReviewReason = "approved" | "changes_requested" | "no_approval" | "stale_approval";
export interface ReviewVerdict {
	approved: boolean;
	reason: ReviewReason;
}

const STANCE_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);
export function evaluateReviews(reviews: unknown, headSha?: string | null): ReviewVerdict {
	const list: GithubReview[] = Array.isArray(reviews) ? reviews : [];
	const latestByUser = new Map<string, GithubReview>();
	for (const r of list) {
		if (!r || typeof r !== "object") continue;
		if (typeof r.state !== "string" || !STANCE_STATES.has(r.state)) continue;
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
export function prNeedsReview(reviews: unknown, headSha?: string | null): boolean {
	return !evaluateReviews(reviews, headSha).approved;
}

// 每位审查人的最新表态（拍板详情展示用，与 evaluateReviews 同一迭代口径：只有
// APPROVED / CHANGES_REQUESTED 算表态，DISMISSED 顶掉先前表态后该人不再列出，
// COMMENTED / PENDING 不算）。stale 表示该人的 APPROVED 针对的 commit 不是当前
// head（批准后又推了新提交）；head 或 commit_id 缺失时不判陈旧（与判定口径一致）。
export interface ReviewStance {
	login: string;
	state: "APPROVED" | "CHANGES_REQUESTED";
	stale: boolean;
}

export function latestReviewStances(reviews: unknown, headSha?: string | null): ReviewStance[] {
	const list: GithubReview[] = Array.isArray(reviews) ? reviews : [];
	const latestByUser = new Map<string, GithubReview>();
	for (const r of list) {
		if (!r || typeof r !== "object") continue;
		if (typeof r.state !== "string" || !STANCE_STATES.has(r.state)) continue;
		latestByUser.set(r.user?.login ?? "?", r);
	}
	const stances: ReviewStance[] = [];
	for (const [login, r] of latestByUser) {
		if (r.state !== "APPROVED" && r.state !== "CHANGES_REQUESTED") continue;
		stances.push({
			login,
			state: r.state,
			stale: r.state === "APPROVED" && Boolean(headSha) && Boolean(r.commit_id) && r.commit_id !== headSha,
		});
	}
	return stances;
}
