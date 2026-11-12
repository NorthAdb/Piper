// Piper 活网回归（非门禁）：唯一允许打真实 GitHub 的套件。
// 用法（在 apps/piper 下）：npm run regression:live
// 与硬门禁 scripts/regression.ts 的分工（R4）：门禁全离线、走本地 GitHub 桩、
// 结果必须确定；本套件不设 PIPER_GITHUB_API_BASE，对 repo-keeper 绑定的真实仓库
// 跑一轮真实晨间扫描，只验证「真实世界里链路通」这一件门禁验不了的事。
// 口径：
//   - 数据目录仍经 PIPER_DATA_DIR 隔离到临时目录，不碰用户真实 data/。
//   - 环境性失败一律 SKIP（输出单列、不计通过）且退出码 0：GitHub 403（无令牌
//     公开限额/二次限流——错误文本只有状态码，故见 report 里的「GitHub API 403」
//     即按限流类处理）、429、网络错误（fetch failed 等）。红只留给真实异常
//     （如 404/500、服务端 5xx、结构断言不符）：那才是要人看的失败。
//   - SIGINT/SIGTERM 同门禁口径：杀子进程、清临时目录再退出。
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_DIR } from "./app-dir.ts";

const PORT = Number(process.env.REGRESSION_LIVE_PORT || 4399);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "piper-dev";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "piper-regression-live-"));
const TMP_DATA = join(TMP_ROOT, "data");
process.env.PIPER_DATA_DIR = TMP_DATA;
delete process.env.PIPER_GITHUB_API_BASE; // 本套件的定义就是走真实 api.github.com

const results: { seq: number; name: string; status: string }[] = [];
let seq = 0;
function record(name: string, status: string, detail = "") {
	seq += 1;
	results.push({ seq, name, status });
	const label = status === "pass" ? "PASS" : status === "skip" ? "SKIP" : "FAIL";
	console.log(`${label} ${String(seq).padStart(2, "0")} ${name}${status === "pass" ? "" : ` — ${detail}`}`);
}
const check = (name: string, ok: boolean, detail = "") => record(name, ok ? "pass" : "fail", detail);
const skip = (name: string, reason: string) => record(name, "skip", reason);

let cookie = "";
// json 是 HTTP 响应边界（外部数据，逐字段取用），与产品侧 readBody 同口径用 any。
async function req(path: string, init: RequestInit = {}): Promise<{ status: number; json: any; text: string }> {
	const res = await fetch(BASE + path, {
		...init,
		headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(init.headers || {}) },
	});
	const text = await res.text();
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		/* 非 JSON */
	}
	return { status: res.status, json, text };
}

async function waitReady(proc: ChildProcess) {
	for (let i = 0; i < 60; i++) {
		if (proc.exitCode !== null) throw new Error(`server 提前退出，exitCode=${proc.exitCode}`);
		try {
			const res = await fetch(`${BASE}/api/bots`);
			if (res.status === 401) return;
		} catch {
			/* 还没起来 */
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error("server 启动超时");
}

let serverProc: ChildProcess | null = null;
let cleanedUp = false;
function cleanup() {
	if (cleanedUp) return;
	cleanedUp = true;
	try {
		serverProc?.kill("SIGTERM");
	} catch {
		/* 已退出 */
	}
	rmSync(TMP_ROOT, { recursive: true, force: true });
}
for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		cleanup();
		process.exit(sig === "SIGINT" ? 130 : 143);
	});
}

// 环境性失败判定：整轮失败或报告含失败行时，从报告文本里找环境原因。
function envFailureReason(report: unknown) {
	const text = String(report ?? "");
	if (/GitHub API 403/.test(text)) return "GitHub 403（公开限额/二次限流）";
	if (/GitHub API 429/.test(text)) return "GitHub 429（限流）";
	if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/.test(text)) return "网络不可达";
	return null;
}

async function main() {
	if (!existsSync(join(APP_DIR, "public", "index.html"))) {
		console.error("缺少 public/index.html：先在 apps/piper 下执行 npm run build:web 再跑。");
		cleanup();
		process.exit(2);
	}
	const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(PORT), PIPER_TOKEN: TOKEN, PIPER_DATA_DIR: TMP_DATA };
	for (const k of ["PIPER_MODEL_API_KEY", "OPENAI_API_KEY", "PIPER_MODEL_BASE_URL", "PIPER_MODEL_ID", "GITHUB_TOKEN", "PIPER_GITHUB_API_BASE"]) delete env[k];
	const proc = spawn("node", ["dist/server.js"], { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
	serverProc = proc;
	let serverLog = "";
	proc.stdout.on("data", (d) => (serverLog += d));
	proc.stderr.on("data", (d) => (serverLog += d));
	try {
		await waitReady(proc);

		const unauth = await req("/api/bots");
		check("未登录 GET /api/bots 返回 401", unauth.status === 401, `实际 ${unauth.status}`);

		const login = await fetch(`${BASE}/api/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: TOKEN }),
		});
		const loginJson = (await login.json().catch(() => ({}))) as { ok?: unknown };
		cookie = (login.headers.get("set-cookie") || "").split(";")[0];
		check("POST /api/login 正确口令返回 {ok:true}", login.status === 200 && loginJson.ok === true && Boolean(cookie), `实际 ${login.status}`);

		// 等调度空闲（启动补跑同样是真实扫描，先让它跑完，避免与手动扫描计数竞态）。
		for (let i = 0; i < 160; i++) {
			const st = await req("/api/schedule/status");
			if (st.json?.routines?.[0]?.running === false) break;
			await new Promise((r) => setTimeout(r, 500));
		}

		const before = await req("/api/artifacts");
		const beforeCount = before.json?.artifacts?.length ?? 0;
		const run = await req("/api/routines/morning-scan/run", { method: "POST", body: "{}" });
		const routines = await req("/api/routines");
		const morning = (routines.json?.routines ?? []).find((r: { id?: string; lastStatus?: string }) => r.id === "morning-scan");

		const envReason = run.json?.failed === true || String(run.json?.report ?? "").includes("扫描失败") ? envFailureReason(run.json?.report) : null;
		if (run.status !== 200) {
			check("POST /api/routines/morning-scan/run（真实 GitHub）返回 200", false, `实际 ${run.status} ${serverLog.slice(-300)}`);
		} else if (envReason) {
			skip("真实晨间扫描（真实 GitHub）", `${envReason}，环境性失败，非门禁套件跳过本轮真实断言`);
			skip("真实扫描 lastStatus=ok 且失败仓 0", envReason);
			skip("真实扫描产物 +1 且日报结构完整", envReason);
		} else if (run.json?.failed === true) {
			check("真实晨间扫描整轮成功（无 failed 标记）", false, `report 节选：${String(run.json?.report ?? "").slice(0, 300)}`);
			skip("真实扫描 lastStatus=ok 且失败仓 0", "整轮失败原因非环境性，已在上一项记 FAIL");
			skip("真实扫描产物 +1 且日报结构完整", "整轮失败，已在上面记 FAIL");
		} else {
			check("POST /api/routines/morning-scan/run（真实 GitHub）返回 200 且未整轮失败", true);
			check(
				"真实扫描 lastStatus=ok",
				morning?.lastStatus === "ok",
				`lastStatus=${morning?.lastStatus}`,
			);
			const after = await req("/api/artifacts");
			const artId = run.json?.artifact?.id;
			const art = artId ? await req(`/api/artifacts/${artId}`) : { status: 0, json: null };
			const body = String(art.json?.artifact?.body ?? "");
			check(
				"真实扫描产物 +1 且日报含拍板清单/其余观察两节（顺序正确）",
				(after.json?.artifacts?.length ?? 0) === beforeCount + 1 &&
					body.includes("## 拍板清单") &&
					body.includes("## 其余观察") &&
					body.indexOf("## 拍板清单") < body.indexOf("## 其余观察"),
				`before=${beforeCount} after=${after.json?.artifacts?.length} artStatus=${art.status}`,
			);
		}
	} finally {
		proc.kill("SIGTERM");
		cleanup();
	}
	const passed = results.filter((r) => r.status === "pass").length;
	const skipped = results.filter((r) => r.status === "skip").length;
	const failed = results.filter((r) => r.status === "fail");
	console.log(`\n结果：${passed}/${results.length} 通过，${skipped} 跳过（单列，不计通过），${failed.length} 失败`);
	if (failed.length) process.exit(1);
}

main().catch((err) => {
	console.error(`活网回归脚本异常：${err.message}`);
	cleanup();
	process.exit(1);
});
