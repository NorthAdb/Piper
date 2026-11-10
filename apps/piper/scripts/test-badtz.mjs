// R3 坏时区文件重启测试：手把 data/settings-profile.json 的 timezone 改成非法值后
// 启动真实 server 进程，核对进程存活、日志回落提示、调度状态回缺省时区、且能从
// 设置接口把时区修好。用法（在 apps/piper 下）：node scripts/test-badtz.mjs
// 行为：运行前备份 settings-profile.json 字节，结束时原样还原；子进程的启动 tick
// 可能对真实 data/ 写补跑产物，与 test-listen.mjs 的既有行为一致。
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_FILE = join(APP_DIR, "data", "settings-profile.json");
const PORT = 4414;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "badtz-test-token";

const results = [];
let seq = 0;
function check(name, ok, detail = "") {
	seq += 1;
	results.push({ seq, name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${String(seq).padStart(2, "0")} ${name}${ok ? "" : ` — ${detail}`}`);
}

function startServer() {
	const env = { ...process.env, PORT: String(PORT), PIPER_TOKEN: TOKEN };
	delete env.PIPER_HOST;
	for (const k of ["PIPER_MODEL_API_KEY", "OPENAI_API_KEY", "PIPER_MODEL_BASE_URL", "PIPER_MODEL_ID", "GITHUB_TOKEN"]) delete env[k];
	const proc = spawn("node", ["server.mjs"], { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	proc.stdout.on("data", (d) => (out += d));
	proc.stderr.on("data", (d) => (out += d));
	return { proc, output: () => out };
}

async function waitReady(proc, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) return false;
		try {
			const res = await fetch(`${BASE}/api/bots`);
			if (res.status === 401) return true;
		} catch {
			/* 还没起来 */
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}

const origBytes = existsSync(PROFILE_FILE) ? readFileSync(PROFILE_FILE, "utf8") : null;
writeFileSync(PROFILE_FILE, JSON.stringify({ displayName: "坏时区测试", timezone: "Foo/Bar" }, null, 2) + "\n", "utf8");

const { proc, output } = startServer();
try {
	const ready = await waitReady(proc);
	// 坏时区曾在启动 tick 阶段以 unhandledRejection 形式迟到崩溃：就绪后再多等一拍，
	// 确认进程是真的活着而不是 listen 后旋即退出。
	await new Promise((r) => setTimeout(r, 2500));
	check(
		"时区文件为 Foo/Bar 时进程启动后存活且回环可达（未登录 401）",
		ready && proc.exitCode === null,
		`ready=${ready} exitCode=${proc.exitCode} 输出节选：${output().slice(0, 300)}`,
	);
	check(
		"启动日志提示时区非法并回落缺省（提到 Foo/Bar 与 Asia/Hong_Kong）",
		output().includes("Foo/Bar") && output().includes("Asia/Hong_Kong"),
		`输出节选：${output().slice(0, 300)}`,
	);

	let cookie = "";
	if (proc.exitCode === null) {
		const login = await fetch(`${BASE}/api/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: TOKEN }),
		});
		cookie = (login.headers.get("set-cookie") || "").split(";")[0];
	}
	const authed = async (path, init = {}) => {
		const res = await fetch(BASE + path, { ...init, headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers || {}) } });
		return { status: res.status, json: await res.json().catch(() => null) };
	};

	const status = cookie ? await authed("/api/schedule/status") : { status: 0, json: null };
	check(
		"GET /api/schedule/status 回缺省时区 Asia/Hong_Kong（不 500）",
		status.status === 200 && status.json?.timezone === "Asia/Hong_Kong",
		`实际 status=${status.status} body=${JSON.stringify(status.json)}`,
	);

	const fix = cookie ? await authed("/api/settings/profile", { method: "PUT", body: JSON.stringify({ timezone: "Asia/Tokyo" }) }) : { status: 0, json: null };
	const statusAfter = cookie ? await authed("/api/schedule/status") : { status: 0, json: null };
	check(
		"从设置接口可把时区修好：PUT Asia/Tokyo 回 200 且调度状态随之更新",
		fix.status === 200 && statusAfter.json?.timezone === "Asia/Tokyo",
		`put=${fix.status} status=${JSON.stringify(statusAfter.json)}`,
	);
} finally {
	proc.kill("SIGTERM");
	if (origBytes === null) rmSync(PROFILE_FILE, { force: true });
	else writeFileSync(PROFILE_FILE, origBytes, "utf8");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
