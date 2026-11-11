// 「已批准」判定单测（lib/pr-review.mjs，扫描与网关共用的同一实现）：
// 用法（在 apps/piper 下）：npm run test:pr-review（或 node scripts/test-pr-review.mjs）
// 覆盖口径（R5 锁定 + 第二轮返工 F4/F5）：
//   F4：取每位审查人「最新一条」时忽略 COMMENTED 与 PENDING——批准后 COMMENTED 仍算
//   已批准，要求修改后 COMMENTED 仍待审；DISMISSED 顶掉该人先前表态（清掉先前批准
//   或先前要求修改）；只有 COMMENTED 的人不构成任何表态。
//   F5①：跨审查人——A 批准、B 最新为 CHANGES_REQUESTED → 仍待审（changes_requested）。
//   陈旧批准不变：最新一条 APPROVED 的 commit_id 与当前 head 不一致 → stale_approval；
//   head 缺失（null/undefined）时不判陈旧、按未变处理（F5 末段，审计已同意保留）。
import { evaluateReviews } from "../lib/pr-review.mjs";

const results = [];
let seq = 0;
function check(name, actual, expected) {
	seq += 1;
	const ok = actual.approved === expected.approved && actual.reason === expected.reason;
	results.push({ seq, name, ok });
	console.log(
		`${ok ? "PASS" : "FAIL"} ${String(seq).padStart(2, "0")} ${name}${ok ? "" : ` — 期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(actual)}`}`,
	);
}
const R = (login, state, commit_id = "aaa111") => ({ user: { login }, state, commit_id });

// 基线
check("无审查 → 待审（no_approval）", evaluateReviews([], "aaa111"), { approved: false, reason: "no_approval" });
check("单人 APPROVED 且 commit 与 head 一致 → 已批准", evaluateReviews([R("a", "APPROVED")], "aaa111"), { approved: true, reason: "approved" });

// F4：COMMENTED / PENDING 不改变判定
check(
	"F4 批准后同人 COMMENTED（head 未变）→ 仍已批准",
	evaluateReviews([R("a", "APPROVED"), R("a", "COMMENTED")], "aaa111"),
	{ approved: true, reason: "approved" },
);
check(
	"F4 要求修改后同人 COMMENTED → 仍待审（changes_requested）",
	evaluateReviews([R("a", "CHANGES_REQUESTED"), R("a", "COMMENTED")], "aaa111"),
	{ approved: false, reason: "changes_requested" },
);
check("F4 只有 COMMENTED → 无表态（no_approval）", evaluateReviews([R("a", "COMMENTED")], "aaa111"), { approved: false, reason: "no_approval" });
check("F4 批准后同人 PENDING → 仍已批准（PENDING 忽略）", evaluateReviews([R("a", "APPROVED"), R("a", "PENDING")], "aaa111"), {
	approved: true,
	reason: "approved",
});
check(
	"F4 他人仅 COMMENTED 不影响批准 → 已批准",
	evaluateReviews([R("a", "APPROVED"), R("b", "COMMENTED")], "aaa111"),
	{ approved: true, reason: "approved" },
);

// F4：DISMISSED 清掉先前表态
check("F4 批准后 DISMISSED → 表态清掉（no_approval）", evaluateReviews([R("a", "APPROVED"), R("a", "DISMISSED")], "aaa111"), {
	approved: false,
	reason: "no_approval",
});
check(
	"F4 要求修改后 DISMISSED → 不再算要求修改（no_approval）",
	evaluateReviews([R("a", "CHANGES_REQUESTED"), R("a", "DISMISSED")], "aaa111"),
	{ approved: false, reason: "no_approval" },
);
check(
	"F4 DISMISSED 后再 COMMENTED → 仍无表态（no_approval）",
	evaluateReviews([R("a", "APPROVED"), R("a", "DISMISSED"), R("a", "COMMENTED")], "aaa111"),
	{ approved: false, reason: "no_approval" },
);

// F5①：跨审查人——任一人最新为 CHANGES_REQUESTED 即待审
check(
	"F5 A 批准、B 要求修改 → 仍待审（changes_requested）",
	evaluateReviews([R("alice", "APPROVED"), R("bob", "CHANGES_REQUESTED")], "aaa111"),
	{ approved: false, reason: "changes_requested" },
);
check(
	"F5 B 要求修改、A 批准（顺序相反）→ 仍待审（changes_requested）",
	evaluateReviews([R("bob", "CHANGES_REQUESTED"), R("alice", "APPROVED")], "aaa111"),
	{ approved: false, reason: "changes_requested" },
);

// 陈旧批准与 head 缺失（判定口径不变，F5 末段）
check("陈旧批准：APPROVED 针对旧 commit、head 已变 → stale_approval", evaluateReviews([R("a", "APPROVED", "old999")], "aaa111"), {
	approved: false,
	reason: "stale_approval",
});
check(
	"陈旧判定不被 COMMENTED 干扰：批准旧 commit 后 COMMENTED、head 为新 commit → stale_approval",
	evaluateReviews([R("a", "APPROVED", "old999"), R("a", "COMMENTED", "aaa111")], "aaa111"),
	{ approved: false, reason: "stale_approval" },
);
check("head 缺失（null）→ 不判陈旧，按未变处理 → 已批准", evaluateReviews([R("a", "APPROVED", "old999")], null), {
	approved: true,
	reason: "approved",
});
check("head 缺失（undefined）→ 不判陈旧，按未变处理 → 已批准", evaluateReviews([R("a", "APPROVED", "old999")], undefined), {
	approved: true,
	reason: "approved",
});

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过，${failed.length} 失败`);
if (failed.length) process.exit(1);
