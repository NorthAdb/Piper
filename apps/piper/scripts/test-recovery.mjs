// F1 集成测试（第二轮返工）：真崩溃后 executing 的 Finding 必须有出口。
// 场景：替身 GitHub 在评论 POST 落库后延迟响应（30 秒），期间对 server 进程 kill -9，
// 再重启——重启后 Finding 必须是 approved（启动恢复 + 审计 failed/interrupted），
// 再次批准靠幂等标记查重，评论总数仍 1、状态转 executed。
// 用法（在 apps/piper 下）：node scripts/test-recovery.mjs（或 npm run test:recovery）
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4421;
const TOKEN = "recovery-test-token";
const FINDING_ID = "f-recovery-1";
const tmp = mkdtempSync(join(tmpdir(), "piper-recovery-"));
const DATA_DIR = join(tmp, "data");

const results = [];
let seq = 0;
function check(name, ok, detail = "") {
	seq += 1;
	results.push({ seq, name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${String(seq).padStart(2, "0")} ${name}${ok ? "" : ` — ${detail}`}`);
}

// ---- 本地替身 GitHub：评论 POST 落库后延迟 30 秒才回响应（模拟「已发出、进程被杀」窗口） ----
const stubState = { comments: [], postCount: 0 };
const stub = createServer((req, res) => {
	const u = new URL(req.url, "http://stub");
	const send = (status, obj) => {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(obj));
	};
	const commentsMatch = u.pathname.match(/^\/repos\/(.+)\/issues\/(\d+)\/comments$/);
	if (commentsMatch && req.method === "POST") {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const body = JSON.parse(raw || "{}");
			stubState.postCount += 1;
			const comment = { body: body.body, html_url: `https://github.com/${commentsMatch[1]}/pull/${commentsMatch[2]}#issuecomment-9001` };
			stubState.comments.push(comment);
			const timer = setTimeout(() => {
				if (!res.destroyed) send(201, comment);
			}, 30 * 1000);
			timer.unref();
		});
		return;
	}
	if (commentsMatch && req.method === "GET") {
		const perPage = Number(u.searchParams.get("per_page") ?? 30);
		const page = Number(u.searchParams.get("page") ?? 1);
		return send(200, stubState.comments.slice((page - 1) * perPage, page * perPage));
	}
	if (/\/pulls\/\d+\/reviews$/.test(u.pathname)) return send(200, []);
	if (/\/pulls\/\d+$/.test(u.pathname)) return send(200, { state: "open", draft: false, head: { sha: "head-sha-1" } });
	if (/\/actions\/runs$/.test(u.pathname)) return send(200, { workflow_runs: [] });
	if (/\/pulls$/.test(u.pathname) || /\/commits$/.test(u.pathname) || /\/issues$/.test(u.pathname)) return send(200, []);
	if (/^\/repos\/[^/]+\/[^/]+$/.test(u.pathname)) return send(200, { default_branch: "main" });
	return send(404, { message: "stub: not found" });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = stub.address().port;

function startPiper() {
	const env = { ...process.env, PORT: String(PORT), PIPER_DATA_DIR: DATA_DIR, PIPER_GITHUB_API_BASE: `http://127.0.0.1:${stubPort}`, PIPER_TOKEN: TOKEN, GITHUB_TOKEN: "stub-gh-token" };
	delete env.PIPER_HOST;
	const proc = spawn("node", ["server.mjs"], { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	proc.stdout.on("data", (d) => (out += d));
	proc.stderr.on("data", (d) => (out += d));
	return { proc, output: () => out };
}

async function waitReady(proc, timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) return false;
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/api/bots`);
			if (res.status === 401) return true;
		} catch {
			/* 还没起来 */
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}

async function waitExit(proc, timeoutMs = 10000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) return proc.exitCode;
		await new Promise((r) => setTimeout(r, 100));
	}
	return null;
}

async function api(path, { method = "GET", body } = {}) {
	const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
		method,
		headers: { Authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	return { status: res.status, json: await res.json().catch(() => null) };
}

let server = null;
try {
	server = startPiper();
	check("替身环境下 server 首次启动成功", await waitReady(server.proc), server.output().slice(0, 300));

	// 直接落盘种一条 open 的待批 Finding（文件优先存储，server 每次请求现读）。
	const now = new Date().toISOString();
	const finding = {
		id: FINDING_ID,
		repo: "NorthAdb/LinkForge",
		type: "pr_needs_review",
		subject: "42",
		title: "PR 待审查：#42（恢复集成测试）",
		summary: "stub",
		evidenceUrl: "https://github.com/NorthAdb/LinkForge/pull/42",
		suggestedAction: "请审查该 PR。",
		writeIntent: { kind: "pr_comment", prNumber: 42, body: "晨间分诊提醒：请维护者审查这个 PR。" },
		expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
		status: "open",
		botId: "repo-keeper",
		headSha: "head-sha-1",
		workflow: null,
		createdAt: now,
		updatedAt: now,
	};
	writeFileSync(join(DATA_DIR, "findings.jsonl"), JSON.stringify(finding) + "\n", "utf8");

	const list = await api("/api/approvals");
	const view = (list.json?.approvals ?? []).find((a) => a.findingId === FINDING_ID);
	check("种子 Finding 出现在待批收件箱且带 intentHash", Boolean(view?.intentHash), JSON.stringify(list.json).slice(0, 200));

	// 发起批准：网关 POST 评论到替身后替身延迟响应，批准请求会一直挂起——不 await。
	const approvePromise = api(`/api/approvals/${FINDING_ID}/approve`, { method: "POST", body: { intentHash: view.intentHash } }).then(
		(v) => ({ settled: true, v }),
		(e) => ({ settled: true, e: String(e) }),
	);
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline && stubState.comments.length < 1) await new Promise((r) => setTimeout(r, 100));
	check("替身已收到评论（落库 1 条），响应仍在延迟中", stubState.comments.length === 1 && stubState.postCount === 1, `comments=${stubState.comments.length} posts=${stubState.postCount}`);

	// 真崩溃：kill -9，然后重启同一数据目录。
	server.proc.kill("SIGKILL");
	await waitExit(server.proc);
	await approvePromise; // 批准请求随进程死亡断开，结果不关心
	server = startPiper();
	const restarted = await waitReady(server.proc);
	check("kill -9 后 server 能重启（数据锁为死 pid 陈旧锁）", restarted, server.output().slice(0, 300));

	const after = await api(`/api/findings/${FINDING_ID}`);
	check(
		"重启后 Finding 已恢复为 approved（不是 executing），审计有 failed/interrupted",
		after.json?.finding?.status === "approved",
		`status=${after.json?.finding?.status}`,
	);
	const audit = await api(`/api/audit?findingId=${FINDING_ID}`);
	check(
		"审计可查到 failed/interrupted 记录",
		(audit.json?.records ?? []).some((r) => r.result === "failed" && r.reason === "interrupted"),
		`records=${(audit.json?.records ?? []).map((r) => `${r.result}/${r.reason}`).join(",")}`,
	);

	// 再批准：网关先查评论标记，复用已发出的评论记 executed，不再 POST。
	const list2 = await api("/api/approvals");
	const view2 = (list2.json?.approvals ?? []).find((a) => a.findingId === FINDING_ID);
	const retry = await api(`/api/approvals/${FINDING_ID}/approve`, { method: "POST", body: { intentHash: view2?.intentHash } });
	const final = await api(`/api/findings/${FINDING_ID}`);
	check(
		"再批准复用已发评论：execution 成功、状态 executed、评论 POST 总数仍 1",
		retry.status === 200 && retry.json?.execution?.ok === true && final.json?.finding?.status === "executed" && stubState.postCount === 1 && stubState.comments.length === 1,
		`retry=${retry.status} ${JSON.stringify(retry.json?.execution)} status=${final.json?.finding?.status} posts=${stubState.postCount}`,
	);
} finally {
	if (server) server.proc.kill("SIGTERM");
	stub.closeAllConnections?.();
	stub.close();
	rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过，${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);
