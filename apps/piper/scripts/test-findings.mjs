// Finding 存储层单元测试（P1-1）：写入 / 读取 / 过滤 / 非法值拒绝 / 跨进程文件读回。
// 用法（在 apps/piper 下）：node scripts/test-findings.mjs（或 npm run test:findings）
// 行为：用临时目录里的 findings.jsonl（经 PIPER_FINDINGS_FILE 隔离，绝不碰真实 data/），
// 逐项断言后退出。退出码 0 = 全部通过；1 = 有失败。不访问网络。
// 子模式：--read 时只把当前存储内容以 JSON 打到 stdout（供跨进程读回断言内部使用）。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const APP_DIR = join(dirname(SCRIPT), "..");

if (process.argv.includes("--read")) {
	const { listFindings } = await import("../lib/findings.mjs");
	console.log(JSON.stringify(listFindings()));
	process.exit(0);
}

const results = [];
let seq = 0;
function check(name, ok, detail = "") {
	seq += 1;
	results.push({ seq, name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${String(seq).padStart(2, "0")} ${name}${ok ? "" : ` — ${detail}`}`);
}

function throws(fn, pattern) {
	try {
		fn();
		return false;
	} catch (err) {
		return pattern.test(String(err.message ?? err));
	}
}

const tmp = mkdtempSync(join(tmpdir(), "piper-findings-"));
const file = join(tmp, "findings.jsonl");
process.env.PIPER_FINDINGS_FILE = file;

try {
	const F = await import("../lib/findings.mjs");

	const base = {
		repo: "NorthAdb/LinkForge",
		type: "ci_failed",
		subject: "9001",
		title: "CI 失败：CI（NorthAdb/LinkForge）",
		summary: "默认分支 main 最近一次已结束的 workflow run 结论为 failure。",
		evidenceUrl: "https://github.com/NorthAdb/LinkForge/actions/runs/9001",
		suggestedAction: "请查看该 run 的失败日志。",
		botId: "repo-keeper",
	};

	const f1 = F.createFinding(base);
	check(
		"createFinding 合法输入落盘并补齐 id/status/时间戳",
		Boolean(f1.id) && f1.status === "open" && f1.writeIntent === null && f1.createdAt === f1.updatedAt,
		JSON.stringify(f1),
	);

	const f2 = F.createFinding({
		...base,
		type: "pr_needs_review",
		subject: 42,
		title: "PR 待审查：#42 修复登录",
		evidenceUrl: "https://github.com/NorthAdb/LinkForge/pull/42",
		writeIntent: { kind: "pr_comment", prNumber: "42", body: "请补充测试。" },
	});
	check(
		"createFinding 带 pr_comment writeIntent 时 prNumber 归一为数字、subject 归一为字符串",
		f2.subject === "42" && f2.writeIntent?.prNumber === 42 && f2.writeIntent?.body === "请补充测试。",
		JSON.stringify(f2.writeIntent),
	);

	check("缺 evidenceUrl 被拒绝", throws(() => F.createFinding({ ...base, evidenceUrl: "" }), /evidenceUrl/));
	check("evidenceUrl 非法 URL 被拒绝", throws(() => F.createFinding({ ...base, evidenceUrl: "not a url" }), /evidenceUrl/));
	check("非法 status 被拒绝", throws(() => F.createFinding({ ...base, status: "pending" }), /status/));
	check("非法 type 被拒绝", throws(() => F.createFinding({ ...base, type: "issue_escalated" }), /type/));
	check(
		"非法 writeIntent.kind 被拒绝",
		throws(() => F.createFinding({ ...base, writeIntent: { kind: "add_label", prNumber: 1, body: "x" } }), /writeIntent/),
	);
	check(
		"pr_comment 缺 prNumber 被拒绝",
		throws(() => F.createFinding({ ...base, writeIntent: { kind: "pr_comment", body: "x" } }), /prNumber/),
	);

	const f3 = F.createFinding({ ...base, repo: "NorthAdb/Loom", subject: "9002", evidenceUrl: "https://github.com/NorthAdb/Loom/actions/runs/9002", botId: "other-bot" });
	check(
		"listFindings 按 repo / botId / status 过滤",
		F.listFindings({ repo: "NorthAdb/LinkForge" }).length === 2 &&
			F.listFindings({ botId: "other-bot" }).length === 1 &&
			F.listFindings({ status: "open" }).length === 3 &&
			F.listFindings({ repo: "NorthAdb/LinkForge", botId: "other-bot" }).length === 0,
		`linkforge=${F.listFindings({ repo: "NorthAdb/LinkForge" }).length}`,
	);
	check("listFindings 非法 status 过滤被拒绝", throws(() => F.listFindings({ status: "pending" }), /status/));

	check("getFinding 按 id 读回，不存在返回 null", F.getFinding(f1.id)?.id === f1.id && F.getFinding("f-nope") === null);

	check(
		"findOpenFinding 命中 open 的同 repo/type/subject",
		F.findOpenFinding("NorthAdb/LinkForge", "ci_failed", "9001")?.id === f1.id &&
			F.findOpenFinding("NorthAdb/LinkForge", "ci_failed", "9999") === null,
	);

	// R1 起状态迁移由显式迁移表强制：走到 executed 必须经 open→approved→executing→executed。
	const attempt = (fn) => {
		try {
			return fn();
		} catch {
			return null;
		}
	};
	const updated = attempt(() =>
		F.updateFinding(F.updateFinding(F.updateFinding(f1.id, { status: "approved" }).id, { status: "executing" }).id, { status: "executed" }),
	);
	check(
		"updateFinding 沿合法迁移链改 status 生效且取证字段不可改",
		updated?.status === "executed" && updated?.evidenceUrl === base.evidenceUrl && updated?.updatedAt >= updated?.createdAt,
		JSON.stringify(updated),
	);
	check(
		"updateFinding 非法 status 被拒绝且原值不变",
		throws(() => F.updateFinding(f2.id, { status: "pending" }), /status/) && F.getFinding(f2.id)?.status === "open",
	);
	check("findOpenFinding 在 Finding 关闭后不再命中", F.findOpenFinding("NorthAdb/LinkForge", "ci_failed", "9001") === null);
	check("updateFinding 不存在返回 null", F.updateFinding("f-nope", { status: "open" }) === null);

	// R1：writeIntent 已从可改字段移除——批准后内容以批准记录快照为准，存储层不许再改。
	F.updateFinding(f2.id, { writeIntent: { kind: "pr_comment", prNumber: 99, body: "被篡改的正文" } });
	check(
		"updateFinding 不能改 writeIntent（批准内容不可篡改）",
		F.getFinding(f2.id)?.writeIntent?.prNumber === 42 && F.getFinding(f2.id)?.writeIntent?.body === "请补充测试。",
		JSON.stringify(F.getFinding(f2.id)?.writeIntent),
	);

	// R1：状态迁移表——非法迁移全部被拒，合法链完整可走。
	{
		const mk = (subject) => F.createFinding({ ...base, subject });
		const g1 = mk("9101");
		check("非法迁移 open→executed 被拒", throws(() => F.updateFinding(g1.id, { status: "executed" }), /迁移/));
		check("非法迁移 open→executing 被拒", throws(() => F.updateFinding(g1.id, { status: "executing" }), /迁移/));
		const g2 = mk("9102");
		F.updateFinding(g2.id, { status: "rejected" });
		check("非法迁移 rejected→approved 被拒", throws(() => F.updateFinding(g2.id, { status: "approved" }), /迁移/));
		check("非法迁移 executed→open 被拒", throws(() => F.updateFinding(f1.id, { status: "open" }), /迁移/));
		const g3 = mk("9103");
		F.updateFinding(g3.id, { status: "approved" });
		check("非法迁移 approved→open 被拒", throws(() => F.updateFinding(g3.id, { status: "open" }), /迁移/));
		check("非法迁移 approved→executed 被拒（须经 executing）", throws(() => F.updateFinding(g3.id, { status: "executed" }), /迁移/));
		const g4 = mk("9104");
		F.updateFinding(g4.id, { status: "expired" });
		check("非法迁移 expired→open 被拒", throws(() => F.updateFinding(g4.id, { status: "open" }), /迁移/));
		const g5 = mk("9105");
		F.updateFinding(g5.id, { status: "approved" });
		attempt(() => F.updateFinding(g5.id, { status: "executing" }));
		const back = attempt(() => F.updateFinding(g5.id, { status: "approved" }));
		check(
			"合法迁移 executing→approved（失败退回）与 executing 状态可落盘",
			back?.status === "approved" && F.FINDING_STATUSES.includes("executing"),
			`status=${back?.status}`,
		);
	}

	// 跨进程读回：另起一个 node 进程指向同一文件，能读到 f2/f3，证明落盘持久（等价进程重启后还在）。
	const child = spawnSync("node", [SCRIPT, "--read"], {
		cwd: APP_DIR,
		env: { ...process.env, PIPER_FINDINGS_FILE: file },
		encoding: "utf8",
	});
	let fromChild = [];
	try {
		fromChild = JSON.parse(child.stdout);
	} catch {
		/* 解析失败则断言失败 */
	}
	check(
		"新进程从文件读回已落盘的 Finding（重启不丢）",
		child.status === 0 && fromChild.some((f) => f.id === f2.id) && fromChild.some((f) => f.id === f3.id),
		`child.status=${child.status} 条数=${fromChild.length}`,
	);

	check(
		"deleteFinding 删除后读不到，重复删返回 false",
		F.deleteFinding(f3.id) === true && F.getFinding(f3.id) === null && F.deleteFinding(f3.id) === false,
	);
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
