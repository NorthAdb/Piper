// 薄网关（P1-6）：apps/piper 层所有对外写副作用的唯一入口。默认拒绝，本批只放行
// 一种写意图 pr_comment（给指定 PR 发表一条评论）。通用形状：网关只认「意图 + 关联
// Finding」，不认调用方是谁——扫描与对话层没有任何直达 GitHub 写接口的路径（绕过断言
// 在 scripts/test-gateway.mjs 里以源码检索钉死）。
// 放行条件（逐条复检，任一不满足即拒绝并写审计 denied，绝不调用写 API）：
//   1. Finding 存在且存有 writeIntent；
//   2. 请求的动作恰好等于 Finding.writeIntent（kind / prNumber / body 逐字一致，未被改过）；
//   3. 意图种类是 pr_comment；
//   4. 目标仓库在该 Finding 所属 bot 的绑定仓内；
//   5. Finding 已被批准（status=approved）——未经批准的直调一律拒绝；
//   6. Finding 未过期（过期则顺手转 expired）；
//   7. 评论正文不含当前 GitHub 令牌（发送前防秘密外泄）。
// 执行前复检（失败写审计 failed，Finding 保持 approved、错误可见、可重试）：
//   - 无令牌 → failed/no_token，明确失败不假成功；
//   - 目标 PR 必须仍为 open（现查 GitHub），否则 failed/pr_not_open；查询本身失败同理。
// 成功：写审计 executed（带评论 URL）、Finding 转 executed，并返回评论链接。
// 凭证只经 lib/settings.mjs 的 githubToken() 读取，本文件不直读环境变量与设置文件。
import { githubToken } from "./settings.mjs";
import { getBot } from "./store.mjs";
import { getFinding, updateFinding } from "./findings.mjs";
import { appendAudit } from "./audit.mjs";

const GH_API = "https://api.github.com";

async function ghJson(path, { method = "GET", token, body } = {}) {
	const headers = { Accept: "application/vnd.github+json", "User-Agent": "piper-gateway" };
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(`${GH_API}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`GitHub API ${res.status} ${method} ${path}`);
	return res.json();
}

function sameIntent(a, b) {
	return a && b && a.kind === b.kind && Number(a.prNumber) === Number(b.prNumber) && a.body === b.body;
}

export async function gatewayExecuteWrite({ findingId, intent } = {}) {
	const finding = findingId ? getFinding(findingId) : null;
	const auditIntent = { ...(intent ?? finding?.writeIntent ?? {}), repo: finding?.repo ?? intent?.repo ?? null };
	const base = { botId: finding?.botId ?? null, findingId: findingId ?? null, approvalId: findingId ?? null, intent: auditIntent };
	const denied = (reason) => {
		appendAudit({ ...base, result: "denied", reason });
		return { ok: false, result: "denied", reason };
	};
	const failed = (reason) => {
		appendAudit({ ...base, result: "failed", reason });
		return { ok: false, result: "failed", reason };
	};

	if (!finding) return denied("finding_not_found");
	const stored = finding.writeIntent;
	if (!stored) return denied("no_write_intent");
	if (!sameIntent(intent ?? stored, stored)) return denied("intent_mismatch");
	if (stored.kind !== "pr_comment") return denied("unsupported_intent");

	const bot = getBot(finding.botId);
	if (!bot) return denied("bot_not_found");
	if (!(bot.repos ?? []).includes(finding.repo)) return denied("repo_not_bound");

	if (finding.status !== "approved") return denied("not_approved");
	if (finding.expiresAt && Date.parse(finding.expiresAt) <= Date.now()) {
		updateFinding(finding.id, { status: "expired" });
		return denied("expired");
	}

	const token = githubToken();
	if (token && typeof stored.body === "string" && stored.body.includes(token)) return denied("secret_in_body");
	if (!token) return failed("no_token");

	let pr;
	try {
		pr = await ghJson(`/repos/${finding.repo}/pulls/${stored.prNumber}`, { token });
	} catch (err) {
		return failed(`pr_check_failed: ${err.message}`);
	}
	if (pr.state !== "open") return failed("pr_not_open");

	let comment;
	try {
		comment = await ghJson(`/repos/${finding.repo}/issues/${stored.prNumber}/comments`, { method: "POST", token, body: { body: stored.body } });
	} catch (err) {
		return failed(`comment_failed: ${err.message}`);
	}

	appendAudit({ ...base, result: "executed", commentUrl: comment.html_url ?? null });
	const updated = updateFinding(finding.id, { status: "executed" });
	return { ok: true, result: "executed", commentUrl: comment.html_url ?? null, finding: updated };
}
