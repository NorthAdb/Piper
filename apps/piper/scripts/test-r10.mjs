// R10 MINOR 批量专项测试：文案口径、产物服务端过滤、GET /api/approvals 无写副作用、
// 设置与 findings 原子写、双进程锁。用临时数据目录隔离（PIPER_DATA_DIR），模块级断言
// 为主，产物过滤与进程锁另起真实 server 子进程核对。全程不打活网（GitHub 基址指向
// 本机黑洞，启动补跑扫描只会快速失败、不影响断言）。
// 用法（在 apps/piper 下）：node scripts/test-r10.mjs（或 npm run test:r10）
// 退出码 0 = 全部通过；1 = 有失败。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const APP_DIR = join(dirname(SCRIPT), "..");
const TMP_ROOT = mkdtempSync(join(tmpdir(), "piper-r10-"));
const TMP_DATA = join(TMP_ROOT, "data");
process.env.PIPER_DATA_DIR = TMP_DATA;

const results = [];
let seq = 0;
function check(name, ok, detail = "") {
	seq += 1;
	results.push({ seq, name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${String(seq).padStart(2, "0")} ${name}${ok ? "" : ` — ${detail}`}`);
}

const { createFinding, updateFinding, getFinding } = await import("../dist/lib/findings.js");
const { listApprovals, getApproval, sweepExpiredFindings } = await import("../dist/lib/approvals.js");
const { listConnectors, saveProfileSettings } = await import("../dist/lib/settings.js");
const { saveArtifact, listArtifacts, readArtifact } = await import("../dist/lib/store.js");

const findingsFile = join(TMP_DATA, "findings.jsonl");
const noTmpResidue = (dir) => readdirSync(dir).every((f) => !f.includes(".tmp-"));

// ---------- 1. 原子写：findings 整表重写走 rename（inode 必变、无临时文件残留） ----------
const f1 = createFinding({
	repo: "NorthAdb/LinkForge",
	type: "pr_needs_review",
	subject: "42",
	title: "PR 待审查：#42（测试）",
	evidenceUrl: "https://github.com/NorthAdb/LinkForge/pull/42",
	botId: "repo-keeper",
});
const inoBefore = statSync(findingsFile).ino;
updateFinding(f1.id, { status: "rejected" });
const inoAfter = statSync(findingsFile).ino;
check("findings 整表重写后 inode 变化（临时文件 + rename 生效）", inoBefore !== inoAfter, `ino ${inoBefore} -> ${inoAfter}`);
check("findings 重写后内容可读且状态已更新、无临时文件残留", getFinding(f1.id)?.status === "rejected" && noTmpResidue(TMP_DATA));

// ---------- 2. 原子写：设置文件同样走 rename，权限仍为 0600 ----------
saveProfileSettings({ displayName: "R10 测试" });
const profileFile = join(TMP_DATA, "settings-profile.json");
const pInoBefore = statSync(profileFile).ino;
saveProfileSettings({ displayName: "R10 测试二" });
const pInoAfter = statSync(profileFile).ino;
check("设置文件重写后 inode 变化（临时文件 + rename 生效）", pInoBefore !== pInoAfter, `ino ${pInoBefore} -> ${pInoAfter}`);
check("设置文件权限仍为 0600 且无临时文件残留", (statSync(profileFile).mode & 0o777) === 0o600 && noTmpResidue(TMP_DATA), `mode=${(statSync(profileFile).mode & 0o777).toString(8)}`);

// ---------- 3. GET 读路径无写副作用：已过期的 open Finding 读后仍为 open，显式清理才转 expired ----------
const f2 = createFinding({
	repo: "NorthAdb/LinkForge",
	type: "pr_needs_review",
	subject: "43",
	title: "PR 待审查：#43（已过期）",
	evidenceUrl: "https://github.com/NorthAdb/LinkForge/pull/43",
	writeIntent: { kind: "pr_comment", prNumber: 43, body: "测试评论" },
	expiresAt: new Date(Date.now() - 60_000).toISOString(),
	botId: "repo-keeper",
});
const listed = listApprovals();
getApproval(f2.id);
check("读列表/详情后已过期 Finding 仍为 open（GET 无写副作用）", getFinding(f2.id)?.status === "open", `status=${getFinding(f2.id)?.status}`);
check("读列表仍能看到该待批项（清理不在读路径做，列表不假装它已消失）", listed.some((a) => a.id === f2.id));
const swept = sweepExpiredFindings();
check("显式 sweepExpiredFindings 后转 expired", swept >= 1 && getFinding(f2.id)?.status === "expired", `swept=${swept} status=${getFinding(f2.id)?.status}`);

// ---------- 4. 文案口径：连接器与通知页无切片号/开发口吻，GitHub access 同步新口径 ----------
const connectors = listConnectors();
const github = connectors.find((c) => c.id === "github");
const web = connectors.find((c) => c.id === "web");
const devTone = /P1-\d|L0-\d|本批|切片/;
check("GitHub 连接器 access 为「读 + 经收件箱批准的评论」口径", github?.access === "read-approved-comment", `access=${github?.access}`);
check(
	"连接器卡文案无切片号与开发口吻",
	!devTone.test(github?.purpose ?? "") && !devTone.test(github?.statusNote ?? "") && !devTone.test(web?.statusNote ?? ""),
);
const connectorsTsx = readFileSync(join(APP_DIR, "web/src/SettingsConnectors.tsx"), "utf8");
const notificationsTsx = readFileSync(join(APP_DIR, "web/src/SettingsNotifications.tsx"), "utf8");
check("前端 ACCESS_LABEL 含新 access 的产品文案", connectorsTsx.includes('"read-approved-comment": "读 + 经收件箱批准的评论"'));
check("连接器/通知页源码无「本批」与切片号残留", !devTone.test(connectorsTsx) && !devTone.test(notificationsTsx));

// ---------- 5/6. 真实 server 子进程：产物服务端过滤 + 双进程锁 ----------
const TOKEN = "r10-test-token";
function startServer(port) {
	const env = {
		...process.env,
		PORT: String(port),
		PIPER_TOKEN: TOKEN,
		PIPER_DATA_DIR: TMP_DATA,
		PIPER_GITHUB_API_BASE: "http://127.0.0.1:9",
	};
	delete env.PIPER_HOST;
	const proc = spawn("node", ["dist/server.js"], { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	proc.stdout.on("data", (d) => (out += d));
	proc.stderr.on("data", (d) => (out += d));
	return { proc, output: () => out };
}

async function waitReady(proc, port, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) return false;
		try {
			const res = await fetch(`http://127.0.0.1:${port}/api/bots`);
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
		if (proc.exitCode !== null) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return false;
}

// ---------- F11（第二轮）：产物 id 随机后缀，同 kind 同毫秒连写不覆盖 ----------
// id 的时间戳部分只有毫秒精度，紧循环连写必然大量同毫秒同 kind：旧实现同 id 覆盖
// （实测连写 300 条只剩 21 条落盘）。随机后缀后 300 条 id 必须全唯一、一条不丢、
// 按 id 读回正文不串。
const f11Metas = [];
for (let i = 0; i < 300; i++) f11Metas.push(saveArtifact({ botId: "bot-f11", kind: "note", title: `F11 连写 ${i}`, body: `f11-body-${i}-end` }));
const f11Ids = f11Metas.map((m) => m.id);
check("同 kind 紧循环连写 300 条产物 id 全唯一", new Set(f11Ids).size === 300, `unique=${new Set(f11Ids).size}/300`);
check(
	"300 条产物全部落盘（按 bot 数得全）",
	listArtifacts().filter((a) => a.botId === "bot-f11").length === 300,
	`listed=${listArtifacts().filter((a) => a.botId === "bot-f11").length}/300`,
);
check(
	"按 id 读回首尾两条正文不串",
	(readArtifact(f11Ids[0])?.body ?? "").includes("f11-body-0-end") && (readArtifact(f11Ids[299])?.body ?? "").includes("f11-body-299-end"),
);

// F11 之前两条种子靠不同 kind 避开同毫秒覆盖；F11 后 id 已带随机后缀，这里仍用
// 不同 kind，只为让下面过滤断言的标题互不干扰。
saveArtifact({ botId: "bot-a", kind: "note", title: "A 的产物", body: "a" });
saveArtifact({ botId: "bot-b", kind: "report", title: "B 的产物", body: "b" });

const s1 = startServer(4471);
try {
	check("server 子进程启动成功", await waitReady(s1.proc, 4471), s1.output().slice(-300));
	const headers = { Authorization: `Bearer ${TOKEN}` };
	const all = await (await fetch("http://127.0.0.1:4471/api/artifacts", { headers })).json();
	const onlyA = await (await fetch("http://127.0.0.1:4471/api/artifacts?botId=bot-a", { headers })).json();
	check(
		"?botId=bot-a 只返回该 bot 的产物",
		(onlyA.artifacts ?? []).length >= 1 && onlyA.artifacts.every((a) => a.botId === "bot-a") && onlyA.artifacts.some((a) => a.title === "A 的产物"),
		`got=${JSON.stringify((onlyA.artifacts ?? []).map((a) => a.botId))}`,
	);
	check(
		"不带参数仍返回全量（含 bot-a 与 bot-b）",
		(all.artifacts ?? []).some((a) => a.botId === "bot-a") && (all.artifacts ?? []).some((a) => a.botId === "bot-b"),
	);

	const s2 = startServer(4472);
	const exited = await waitExit(s2.proc);
	check("同一数据目录第二个进程被拒绝启动（退出码非 0）", exited && s2.proc.exitCode !== 0, `exitCode=${s2.proc.exitCode} out=${s2.output().slice(-200)}`);
	check("拒绝原因写明数据目录已被占用", /已被另一个 Piper 进程占用/.test(s2.output()), s2.output().slice(-200));
} finally {
	s1.proc.kill("SIGTERM");
	await waitExit(s1.proc);
}

// 持有者退出后锁释放（SIGTERM 处理器删锁），同目录可再次启动。
const s3 = startServer(4473);
try {
	check("持有者退出后同目录可再次启动（锁已释放）", await waitReady(s3.proc, 4473), s3.output().slice(-300));
} finally {
	s3.proc.kill("SIGTERM");
	await waitExit(s3.proc);
}

// 陈旧锁接管：锁里是已不存在的 pid 时不挡启动。
writeFileSync(join(TMP_DATA, "piper.lock"), "999999\n", "utf8");
const s4 = startServer(4474);
try {
	check("陈旧锁（pid 不存在）不挡启动、自动接管", await waitReady(s4.proc, 4474), s4.output().slice(-300));
} finally {
	s4.proc.kill("SIGTERM");
	await waitExit(s4.proc);
}

check("全部子进程退出后数据目录无锁文件与临时文件残留", !existsSync(join(TMP_DATA, "piper.lock")) && noTmpResidue(TMP_DATA));

rmSync(TMP_ROOT, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
	console.log("失败项：");
	for (const f of failed) console.log(`  ${String(f.seq).padStart(2, "0")} ${f.name}`);
	process.exit(1);
}
