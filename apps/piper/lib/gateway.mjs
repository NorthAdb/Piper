// 薄网关（P1-6 + R1 返工）：apps/piper 层所有对外写副作用的唯一入口。默认拒绝，本批只放行
// 一种写意图 pr_comment（给指定 PR 发表一条评论）。通用形状：网关只认「批准记录 + 关联
// Finding」，不认调用方是谁——扫描与对话层没有任何直达 GitHub 写接口的路径（绕过断言
// 在 scripts/test-gateway.mjs 里以源码检索钉死）。
// R1 起网关只执行批准时刻的意图快照（approvals 的批准记录），不执行 Finding 里现存的
// writeIntent 本身：执行前拿快照与当前 writeIntent 逐字比对，不一致 denied/intent_changed，
// 批准之后被改过的内容发不出去。
// 放行条件（领取执行前的同步复检，任一不满足即拒绝并写审计，绝不调用写 API）：
//   1. Finding 存在，且带批准记录 id 与意图快照；
//   2. 快照恰好等于 Finding 当前 writeIntent（kind / repo / prNumber / body 逐字一致）；
//   3. 意图种类是 pr_comment；
//   4. 目标仓库在该 Finding 所属 bot 的绑定仓内；
//   5. Finding 已被批准（status=approved）——未经批准的直调一律拒绝；已在 executing
//      说明有另一路正在执行，拒绝防并发双发；
//   6. Finding 未过期（过期则顺手转 expired）；
//   7. 评论正文不含当前 GitHub 令牌（发送前防秘密外泄）；
//   8. 有令牌（无令牌 failed/no_token，明确失败不假成功）。
// 领取与执行（领取 = approved→executing 的同步段，单进程内即互斥）：
//   - 领取后先写一条审计 executing，再做网络调用——进程崩溃后能看到「发到一半」；
//   - 执行前现查目标 PR 仍为 open，否则 failed/pr_not_open，退回 approved 可重试；
//   - 发评论前先查该 PR 已有评论里是否带本批准的幂等标记
//     <!-- piper:approval=<approvalId> -->，有则复用该评论记 executed，不再 POST；
//   - POST 的正文 = 快照正文 + 幂等标记；成功写审计 executed（带评论 URL）、Finding 转 executed；
//   - 任一网络步失败：Finding 从 executing 退回 approved、写审计 failed，错误可见可重试。
// 凭证只经 lib/settings.mjs 的 githubToken() 读取，本文件不直读环境变量与设置文件。
import { githubToken } from "./settings.mjs";
import { getBot } from "./store.mjs";
import { getFinding, updateFinding } from "./findings.mjs";
import { appendAudit } from "./audit.mjs";

// GitHub API 基址：缺省官方；可用 PIPER_GITHUB_API_BASE 覆盖（R4：回归/测试指向本地桩）。
function ghBase() {
	return (process.env.PIPER_GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, "");
}

async function ghJson(path, { method = "GET", token, body } = {}) {
	const headers = { Accept: "application/vnd.github+json", "User-Agent": "piper-gateway" };
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(`${ghBase()}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`GitHub API ${res.status} ${method} ${path}`);
	return res.json();
}

function sameIntent(snapshot, finding) {
	const current = finding?.writeIntent;
	if (!snapshot || !current) return false;
	return (
		snapshot.kind === current.kind &&
		snapshot.repo === finding.repo &&
		Number(snapshot.prNumber) === Number(current.prNumber) &&
		snapshot.body === current.body
	);
}

export async function gatewayExecuteWrite({ findingId, approvalId = null, snapshot = null } = {}) {
	const finding = findingId ? getFinding(findingId) : null;
	const auditIntent = { ...(snapshot ?? finding?.writeIntent ?? {}), repo: snapshot?.repo ?? finding?.repo ?? null };
	const base = { botId: finding?.botId ?? null, findingId: findingId ?? null, approvalId, intent: auditIntent };
	const denied = (reason) => {
		appendAudit({ ...base, result: "denied", reason });
		return { ok: false, result: "denied", reason };
	};
	const failed = (reason) => {
		appendAudit({ ...base, result: "failed", reason });
		return { ok: false, result: "failed", reason };
	};
	// 执行在途的失败退回：executing→approved（迁移表内的合法退回），保持可重试。
	const rollback = () => {
		const cur = getFinding(findingId);
		if (cur?.status === "executing") updateFinding(findingId, { status: "approved" });
	};

	if (!finding) return denied("finding_not_found");
	if (!approvalId) return denied("missing_approval");
	if (!snapshot) return denied("missing_snapshot");
	if (!finding.writeIntent) return denied("no_write_intent");
	if (!sameIntent(snapshot, finding)) return denied("intent_changed");
	if (snapshot.kind !== "pr_comment") return denied("unsupported_intent");

	const bot = getBot(finding.botId);
	if (!bot) return denied("bot_not_found");
	if (!(bot.repos ?? []).includes(finding.repo)) return denied("repo_not_bound");

	if (finding.status === "executing") return denied("already_executing");
	if (finding.status !== "approved") return denied("not_approved");
	if (finding.expiresAt && Date.parse(finding.expiresAt) <= Date.now()) {
		updateFinding(finding.id, { status: "expired" });
		return denied("expired");
	}

	const token = githubToken();
	if (token && typeof snapshot.body === "string" && snapshot.body.includes(token)) return denied("secret_in_body");
	if (!token) return failed("no_token");

	// 领取执行：读—判—写在本同步段内完成（上面的 getFinding 与这里的 updateFinding
	// 之间没有 await），单进程内第二个并发执行到此必然看到 executing 而被上面的检查拒绝。
	updateFinding(finding.id, { status: "executing" });
	appendAudit({ ...base, result: "executing" });

	let pr;
	try {
		pr = await ghJson(`/repos/${finding.repo}/pulls/${snapshot.prNumber}`, { token });
	} catch (err) {
		rollback();
		return failed(`pr_check_failed: ${err.message}`);
	}
	if (pr.state !== "open") {
		rollback();
		return failed("pr_not_open");
	}

	// 幂等查重：同一批准若已留过评论（例如上次 POST 成功后进程崩溃），直接复用，不再发第二条。
	const marker = `<!-- piper:approval=${approvalId} -->`;
	let existing = null;
	try {
		const comments = await ghJson(`/repos/${finding.repo}/issues/${snapshot.prNumber}/comments`, { token });
		existing = (Array.isArray(comments) ? comments : []).find((c) => typeof c?.body === "string" && c.body.includes(marker)) ?? null;
	} catch (err) {
		rollback();
		return failed(`comments_check_failed: ${err.message}`);
	}
	if (existing) {
		appendAudit({ ...base, result: "executed", commentUrl: existing.html_url ?? null });
		const updated = updateFinding(finding.id, { status: "executed" });
		return { ok: true, result: "executed", commentUrl: existing.html_url ?? null, reused: true, finding: updated };
	}

	let comment;
	try {
		comment = await ghJson(`/repos/${finding.repo}/issues/${snapshot.prNumber}/comments`, {
			method: "POST",
			token,
			body: { body: `${snapshot.body}\n\n${marker}` },
		});
	} catch (err) {
		rollback();
		return failed(`comment_failed: ${err.message}`);
	}

	appendAudit({ ...base, result: "executed", commentUrl: comment.html_url ?? null });
	const updated = updateFinding(finding.id, { status: "executed" });
	return { ok: true, result: "executed", commentUrl: comment.html_url ?? null, finding: updated };
}
