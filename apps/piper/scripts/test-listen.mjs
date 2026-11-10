// R2 监听面测试：另起真实 server 进程核对监听地址与启动拒绝。
// 用法（在 apps/piper 下）：node scripts/test-listen.mjs（或 npm run test:listen）
// 覆盖：
//   A 默认（不设 PIPER_HOST）：只监听 127.0.0.1（ss 实查），回环可达（未登录 401）。
//   B PIPER_HOST=0.0.0.0 且未设 PIPER_TOKEN（默认口令）：进程拒绝启动，退出码非 0
//     且输出写明原因。
//   C PIPER_HOST=0.0.0.0 且显式设置 PIPER_TOKEN：正常启动，监听 0.0.0.0。
//   D（F1→F3，第二轮返工）PIPER_TOKEN 显式设为默认值 piper-dev + PIPER_HOST=0.0.0.0：
//     「是否默认口令」按值比较而不是看变量有没有设——照样拒绝启动。
//   E PIPER_TOKEN=piper-dev + 回环监听：正常启动（默认值本身只禁非回环）。
// R4 起子进程一律带 PIPER_DATA_DIR 指向临时目录：调度启动 tick 的补跑产物只落
// 隔离目录，不再写用户真实 data/；本脚本只断言监听面，不碰业务数据。
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP_DATA = join(mkdtempSync(join(tmpdir(), "piper-listen-")), "data");

const results = [];
let seq = 0;
function check(name, ok, detail = "") {
	seq += 1;
	results.push({ seq, name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${String(seq).padStart(2, "0")} ${name}${ok ? "" : ` — ${detail}`}`);
}

function baseEnv(port) {
	const env = { ...process.env, PORT: String(port), PIPER_DATA_DIR: TMP_DATA };
	delete env.PIPER_HOST;
	delete env.PIPER_TOKEN;
	for (const k of ["PIPER_MODEL_API_KEY", "OPENAI_API_KEY", "PIPER_MODEL_BASE_URL", "PIPER_MODEL_ID", "GITHUB_TOKEN"]) delete env[k];
	return env;
}

function startServer(env) {
	const proc = spawn("node", ["server.mjs"], { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
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

async function waitExit(proc, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) return proc.exitCode;
		await new Promise((r) => setTimeout(r, 100));
	}
	return null;
}

function listenLocalAddr(port) {
	const out = execFileSync("ss", ["-ltn"], { encoding: "utf8" });
	for (const line of out.split("\n")) {
		const fields = line.trim().split(/\s+/);
		const local = fields[3] || "";
		if (local.endsWith(`:${port}`)) return local.slice(0, local.length - String(port).length - 1);
	}
	return null;
}

async function caseDefaultLoopback() {
	const port = 4411;
	const { proc } = startServer({ ...baseEnv(port), PIPER_TOKEN: "listen-test-token" });
	try {
		const ready = await waitReady(proc, port);
		check("默认启动成功且回环可达（未登录 401）", ready, `exitCode=${proc.exitCode}`);
		const addr = ready ? listenLocalAddr(port) : null;
		check("默认只监听 127.0.0.1（ss 实查）", addr === "127.0.0.1", `实际 ${addr}`);
	} finally {
		proc.kill("SIGTERM");
	}
}

async function caseRefuseNonLoopbackDefaultToken() {
	const port = 4412;
	const { proc, output } = startServer({ ...baseEnv(port), PIPER_HOST: "0.0.0.0" });
	try {
		const code = await waitExit(proc);
		check(
			"PIPER_HOST=0.0.0.0 且未设 PIPER_TOKEN 时进程拒绝启动（退出码非 0）",
			code !== null && code !== 0,
			code === null ? "进程未退出（仍在运行）" : `exitCode=${code}`,
		);
		check(
			"拒绝启动时输出写明原因（提到 PIPER_TOKEN / 默认口令）",
			/PIPER_TOKEN|默认口令/.test(output()),
			`输出节选：${output().slice(0, 200)}`,
		);
	} finally {
		proc.kill("SIGTERM");
	}
}

async function caseNonLoopbackWithToken() {
	const port = 4413;
	const { proc } = startServer({ ...baseEnv(port), PIPER_HOST: "0.0.0.0", PIPER_TOKEN: "listen-test-token" });
	try {
		const ready = await waitReady(proc, port);
		check("PIPER_HOST=0.0.0.0 且已设 PIPER_TOKEN 时正常启动", ready, `exitCode=${proc.exitCode}`);
		const addr = ready ? listenLocalAddr(port) : null;
		check("显式放开后监听 0.0.0.0（ss 实查）", addr === "0.0.0.0", `实际 ${addr}`);
	} finally {
		proc.kill("SIGTERM");
	}
}

async function caseExplicitDefaultTokenNonLoopback() {
	const port = 4414;
	const { proc, output } = startServer({ ...baseEnv(port), PIPER_HOST: "0.0.0.0", PIPER_TOKEN: "piper-dev" });
	try {
		const code = await waitExit(proc);
		check(
			"显式 PIPER_TOKEN=piper-dev + 0.0.0.0 时进程拒绝启动（按值判定默认口令，退出码非 0）",
			code !== null && code !== 0,
			code === null ? "进程未退出（仍在运行）" : `exitCode=${code}`,
		);
		check(
			"显式默认口令被拒时输出写明原因（提到 PIPER_TOKEN / 默认口令）",
			/PIPER_TOKEN|默认口令/.test(output()),
			`输出节选：${output().slice(0, 200)}`,
		);
	} finally {
		proc.kill("SIGTERM");
	}
}

async function caseExplicitDefaultTokenLoopback() {
	const port = 4415;
	const { proc } = startServer({ ...baseEnv(port), PIPER_TOKEN: "piper-dev" });
	try {
		const ready = await waitReady(proc, port);
		check("显式 PIPER_TOKEN=piper-dev + 回环监听时正常启动", ready, `exitCode=${proc.exitCode}`);
	} finally {
		proc.kill("SIGTERM");
	}
}

await caseDefaultLoopback();
await caseRefuseNonLoopbackDefaultToken();
await caseNonLoopbackWithToken();
await caseExplicitDefaultTokenNonLoopback();
await caseExplicitDefaultTokenLoopback();

rmSync(join(TMP_DATA, ".."), { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
