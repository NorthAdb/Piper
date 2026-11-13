// 任务运行时测试（P2-7）：JobRuntime 的 job 记录、幂等、恢复与 trigger
// 校验。用法（在 apps/piper 下）：node dist/scripts/test-jobs.js（或 npm run test:jobs）
// A 段进程内（假时钟 + 扫描替身）：手动 job 落盘可查、cron 时槽幂等键
// （同窗不重复建/跑）、结果映射（ok/failed/skipped/抛错）、启动恢复
// （running → interrupted → 按幂等键对账重跑，已 succeeded 的同键不
// 重跑）、channel 明确拒绝、jobs.json 损坏隔离。
// B 段真实 server + GitHub 替身：POST 手动扫描走 JobRuntime 并回 jobId、
// 按 id 查到 manual/succeeded 的 job、channel 经 HTTP 得 400、未知 id
// 404、未登录 401、列表按 botId 隔离。
// 数据目录与 jobs 文件都指向临时目录，不访问真实网络（替身为本地 HTTP）。
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_DIR } from "./app-dir.ts";

const results: { seq: number; name: string; ok: boolean }[] = [];
let seq = 0;
function check(name: string, ok: boolean, detail = "") {
	seq += 1;
	results.push({ seq, name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${String(seq).padStart(2, "0")} ${name}${ok ? "" : ` — ${detail}`}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ================= A 段：进程内 =================
const tmpA = mkdtempSync(join(tmpdir(), "piper-jobs-a-"));
process.env.PIPER_DATA_DIR = join(tmpA, "data");
delete process.env.PIPER_JOBS_FILE;

const { createJobRuntime, listJobs, getJob } = await import("../lib/job-runtime.ts");

const TZ = "Asia/Hong_Kong";
const TIME = { hour: 8, minute: 0 };
const T_0800 = new Date("2026-11-10T00:00:00.000Z"); // 08:00 HKT
const T_0900 = new Date("2026-11-10T01:00:00.000Z");

function makeRuntime(runScan: () => Promise<{ result: "ok" | "failed" | "skipped"; error?: string | null }>, botId: string, state: { lastRunAt: string | null; lastStatus: string | null }) {
	return createJobRuntime({
		runScan,
		botIdFn: () => botId,
		getRoutineState: () => state,
		timezoneFn: () => TZ,
		timeFn: () => TIME,
	});
}

// ---- A1 手动 job：落盘、终态 succeeded、按 id 可查、按 bot 隔离 ----
{
	const state = { lastRunAt: null as string | null, lastStatus: null as string | null };
	const rt = makeRuntime(async () => ({ result: "ok" }), "repo-keeper", state);
	const { job, outcome } = await rt.runManual();
	const onDisk = JSON.parse(readFileSync(join(process.env.PIPER_DATA_DIR as string, "jobs.json"), "utf8")) as { id: string }[];
	check(
		"A1 手动 job：trigger manual、type morning-scan、终态 succeeded，jobs.json 落盘且按 id 可查",
		job.trigger === "manual" &&
			job.type === "morning-scan" &&
			job.status === "succeeded" &&
			outcome.result === "ok" &&
			onDisk.some((j) => j.id === job.id) &&
			getJob(job.id)?.status === "succeeded" &&
			listJobs({ botId: "repo-keeper" }).some((j) => j.id === job.id) &&
			!listJobs({ botId: "piper-main" }).some((j) => j.id === job.id),
		JSON.stringify(job),
	);
}

// ---- A2 cron 幂等：到点建一条 cron job 并跑完；同窗再 tick 不新建；enqueue 同键复用 ----
{
	const state = { lastRunAt: null as string | null, lastStatus: null as string | null };
	let calls = 0;
	const rt = makeRuntime(async () => {
		calls += 1;
		state.lastRunAt = new Date().toISOString();
		state.lastStatus = "ok";
		return { result: "ok" };
	}, "cron-bot", state);
	const r1 = await rt.tick(T_0800);
	const r2 = await rt.tick(T_0900);
	const cronJobs = listJobs({ botId: "cron-bot" }).filter((j) => j.trigger === "cron");
	const e1 = rt.enqueue({ trigger: "cron", idempotencyKey: "k-dedup" });
	const e2 = rt.enqueue({ trigger: "cron", idempotencyKey: "k-dedup" });
	check(
		"A2 cron 幂等：时槽键 morning-scan:<bot>:<日期>:08:00 只建一条且 succeeded，同窗 tick 不重跑，enqueue 同键 queued 复用",
		r1.action === "ran" &&
			r2.action === "idle" &&
			calls === 1 &&
			cronJobs.length === 1 &&
			cronJobs[0].idempotencyKey === "morning-scan:cron-bot:2026-11-10:08:00" &&
			cronJobs[0].status === "succeeded" &&
			e1.id === e2.id &&
			listJobs().filter((j) => j.idempotencyKey === "k-dedup").length === 1,
		`calls=${calls} cronJobs=${JSON.stringify(cronJobs)}`,
	);
}

// ---- A3 结果映射：failed 带 error、skipped 如实记、runScan 抛错按 failed ----
{
	const state = { lastRunAt: null as string | null, lastStatus: null as string | null };
	const rtFail = makeRuntime(async () => ({ result: "failed", error: "boom" }), "map-bot", state);
	const f = await rtFail.runManual();
	const rtSkip = makeRuntime(async () => ({ result: "skipped" }), "map-bot", state);
	const s = await rtSkip.runManual();
	const rtThrow = makeRuntime(async () => {
		throw new Error("kaboom");
	}, "map-bot", state);
	const t = await rtThrow.runManual();
	check(
		"A3 结果映射：failed→failed 且 error 落盘；skipped→skipped；runScan 抛错→failed 带消息",
		f.job.status === "failed" && f.job.error === "boom" && s.job.status === "skipped" && t.job.status === "failed" && t.job.error === "kaboom",
		JSON.stringify([f.job.status, f.job.error, s.job.status, t.job.status, t.job.error]),
	);
}

// ---- A4 channel 拒绝：enqueue 与 runManual 都明确抛 400/TRIGGER_NOT_IMPLEMENTED ----
{
	const state = { lastRunAt: null as string | null, lastStatus: null as string | null };
	const rt = makeRuntime(async () => ({ result: "ok" }), "chan-bot", state);
	let enqueueErr: { code?: string; status?: number } | null = null;
	try {
		rt.enqueue({ trigger: "channel", idempotencyKey: "k-chan" });
	} catch (err) {
		enqueueErr = err as { code?: string; status?: number };
	}
	let manualErr: { code?: string; status?: number } | null = null;
	try {
		await rt.runManual({ trigger: "channel" });
	} catch (err) {
		manualErr = err as { code?: string; status?: number };
	}
	const src = readFileSync(join(APP_DIR, "lib", "job-runtime.ts"), "utf8");
	check(
		"A4 channel 拒绝：enqueue/runManual 均抛 TRIGGER_NOT_IMPLEMENTED(400)，且未建任何 channel job；源码钉 IMPLEMENTED_TRIGGERS 不含 channel",
		enqueueErr?.code === "TRIGGER_NOT_IMPLEMENTED" &&
			enqueueErr?.status === 400 &&
			manualErr?.code === "TRIGGER_NOT_IMPLEMENTED" &&
			!listJobs().some((j) => j.trigger === "channel") &&
			/IMPLEMENTED_TRIGGERS[^=]*= \["cron", "manual", "approval"\]/.test(src),
		`enqueue=${JSON.stringify(enqueueErr)} manual=${JSON.stringify(manualErr)}`,
	);
}

// ---- A5 启动恢复：running → interrupted → 对账重跑；同键已 succeeded 的不重跑；遗留 queued 排空 ----
{
	const dataDir = process.env.PIPER_DATA_DIR as string;
	const nowIso = new Date().toISOString();
	const seedJob = (id: string, status: string, key: string, trigger: string) => ({
		id,
		botId: "rec-bot",
		type: "morning-scan",
		trigger,
		idempotencyKey: key,
		checkpoint: null,
		status,
		createdAt: nowIso,
		updatedAt: nowIso,
		error: null,
	});
	writeFileSync(
		join(dataDir, "jobs.json"),
		JSON.stringify(
			[
				seedJob("job-seed-run", "running", "morning-scan:rec-bot:2026-11-10:08:00", "cron"),
				seedJob("job-seed-queued", "queued", "manual:seed-queued", "manual"),
				seedJob("job-seed-dup", "running", "morning-scan:rec-bot:2026-11-09:08:00", "cron"),
				seedJob("job-seed-done", "succeeded", "morning-scan:rec-bot:2026-11-09:08:00", "cron"),
			],
			null,
			2,
		) + "\n",
		"utf8",
	);
	const state = { lastRunAt: null as string | null, lastStatus: null as string | null };
	let calls = 0;
	const rt = makeRuntime(async () => {
		calls += 1;
		return { result: "ok" };
	}, "rec-bot", state);
	const recovered = await rt.start();
	const jRun = getJob("job-seed-run");
	const jQueued = getJob("job-seed-queued");
	const jDup = getJob("job-seed-dup");
	check(
		"A5 启动恢复：2 条 running 标 interrupted、1 条对账重排队（同键已 succeeded 的不重跑），重跑与遗留 queued 各执行一次且终态 succeeded、checkpoint 留痕",
		recovered.interrupted === 2 &&
			recovered.requeued === 1 &&
			calls === 2 &&
			jRun?.status === "succeeded" &&
			(jRun?.checkpoint as { fromStatus?: string } | null)?.fromStatus === "running" &&
			jQueued?.status === "succeeded" &&
			jDup?.status === "interrupted",
		`recovered=${JSON.stringify(recovered)} calls=${calls} run=${jRun?.status} dup=${jDup?.status}`,
	);
}

// ---- A6 jobs.json 损坏隔离：解析失败改名 .corrupt-* 并从空表继续 ----
{
	const badFile = join(tmpA, "jobs-bad.json");
	writeFileSync(badFile, "{ not json", "utf8");
	process.env.PIPER_JOBS_FILE = badFile;
	const listed = listJobs();
	const siblings = readdirSync(tmpA).filter((f) => f.startsWith("jobs-bad.json.corrupt-"));
	delete process.env.PIPER_JOBS_FILE;
	check("A6 损坏隔离：损坏的 jobs.json 被改名隔离、按空表继续不抛", listed.length === 0 && siblings.length === 1, `listed=${listed.length} siblings=${JSON.stringify(siblings)}`);
}

rmSync(tmpA, { recursive: true, force: true });

// ================= B 段：真实 server + GitHub 替身 =================
const ghStub: Server = createServer((reqHttp, resHttp) => {
	const url = reqHttp.url ?? "";
	const send = (body: unknown) => {
		resHttp.writeHead(200, { "Content-Type": "application/json" });
		resHttp.end(JSON.stringify(body));
	};
	if (/^\/repos\/[^/]+\/[^/]+$/.test(url.split("?")[0])) return send({ stargazers_count: 3, forks_count: 1, default_branch: "main", pushed_at: "2026-11-10T00:00:00Z" });
	if (url.includes("/actions/runs")) return send({ total_count: 0, workflow_runs: [] });
	return send([]);
});
await new Promise<void>((r) => ghStub.listen(0, "127.0.0.1", () => r()));
const GH_BASE = `http://127.0.0.1:${(ghStub.address() as { port: number }).port}`;

const tmpB = mkdtempSync(join(tmpdir(), "piper-jobs-b-"));
const DATA_B = join(tmpB, "data");
const PORT = Number(process.env.JOBS_PORT || 4504);
const BASE = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess | null = null;
let serverLog = "";
let cookie = "";

function startServer(): ChildProcess {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PORT: String(PORT),
		PIPER_DATA_DIR: DATA_B,
		PIPER_GITHUB_API_BASE: GH_BASE,
		GITHUB_TOKEN: ["gh", "stub", "token"].join("-"),
		PIPER_TEST_MODE: "1",
	};
	delete env.PIPER_TOKEN;
	delete env.PIPER_HOST;
	for (const k of ["PIPER_MODEL_API_KEY", "OPENAI_API_KEY", "PIPER_MODEL_BASE_URL", "PIPER_MODEL_ID", "PIPER_TOOL_APPROVALS_FILE", "PIPER_AUDIT_FILE", "PIPER_JOBS_FILE", "PIPER_FINDINGS_FILE"]) delete env[k];
	const child = spawn("node", ["dist/server.js"], { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
	child.stdout?.on("data", (d) => (serverLog += d));
	child.stderr?.on("data", (d) => (serverLog += d));
	return child;
}
async function waitReady(): Promise<boolean> {
	for (let i = 0; i < 60; i++) {
		if (!proc || proc.exitCode !== null) return false;
		try {
			const res = await fetch(`${BASE}/api/bots`);
			if (res.status === 401) return true;
		} catch {
			/* 还没起来 */
		}
		await sleep(250);
	}
	return false;
}
async function login(): Promise<boolean> {
	const res = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "piper-dev" }) });
	cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
	return res.status === 200 && Boolean(cookie);
}
async function req(path: string, init: RequestInit = {}): Promise<{ status: number; json: any }> {
	const res = await fetch(BASE + path, { ...init, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(init.headers || {}) } });
	const text = await res.text();
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		/* 非 JSON */
	}
	return { status: res.status, json };
}

try {
	proc = startServer();
	const ready = await waitReady();
	const loggedIn = ready && (await login());
	check("B0 真实 server 启动并登录", Boolean(ready && loggedIn), serverLog.slice(-400));

	// 启动补跑可能先跑一轮 cron 扫描：等调度空闲再手动触发，避免 409。
	for (let i = 0; i < 80; i++) {
		const s = await req("/api/schedule/status");
		if (s.json?.routines?.[0]?.running === false) break;
		await sleep(250);
	}

	const run = await req("/api/routines/morning-scan/run", { method: "POST", body: JSON.stringify({}) });
	const jobId = run.json?.jobId as string | undefined;
	check(
		"B1 手动扫描走 JobRuntime：POST 回 200 且带 jobId",
		run.status === 200 && typeof jobId === "string" && jobId.startsWith("job-"),
		`status=${run.status} body=${JSON.stringify(run.json)?.slice(0, 200)} log=${serverLog.slice(-300)}`,
	);

	const got = jobId ? await req(`/api/jobs/${jobId}`) : { status: 0, json: null };
	check(
		"B2 按 id 查 job：trigger manual / type morning-scan / botId repo-keeper / 终态 succeeded",
		got.status === 200 && got.json?.job?.trigger === "manual" && got.json?.job?.type === "morning-scan" && got.json?.job?.botId === "repo-keeper" && got.json?.job?.status === "succeeded",
		`status=${got.status} job=${JSON.stringify(got.json?.job)}`,
	);

	const chan = await req("/api/routines/morning-scan/run", { method: "POST", body: JSON.stringify({ trigger: "channel" }) });
	check("B3 channel 经 HTTP 明确拒绝（400），不悄悄当 manual", chan.status === 400, `status=${chan.status} body=${JSON.stringify(chan.json)?.slice(0, 200)}`);

	const missing = await req("/api/jobs/job-nope");
	const listKeeper = await req("/api/jobs?botId=repo-keeper");
	const listMain = await req("/api/jobs?botId=piper-main");
	check(
		"B4 查询面：未知 id 404；列表按 botId 隔离（管家有该 job、主 bot 列表里没有）",
		missing.status === 404 &&
			(listKeeper.json?.jobs ?? []).some((j: { id: string }) => j.id === jobId) &&
			!(listMain.json?.jobs ?? []).some((j: { id: string }) => j.id === jobId),
		`missing=${missing.status} keeper=${(listKeeper.json?.jobs ?? []).length} main=${(listMain.json?.jobs ?? []).length}`,
	);

	const savedCookie = cookie;
	cookie = "";
	const unauth = await req(`/api/jobs/${jobId ?? "job-x"}`);
	cookie = savedCookie;
	check("B5 未登录查 job 得 401", unauth.status === 401, `status=${unauth.status}`);

	check("B6 jobs.json 落在数据目录且含 manual 记录", existsSync(join(DATA_B, "jobs.json")) && (JSON.parse(readFileSync(join(DATA_B, "jobs.json"), "utf8")) as { trigger: string }[]).some((j) => j.trigger === "manual"), "");
} finally {
	if (proc) proc.kill("SIGKILL");
	ghStub.close();
	rmSync(tmpB, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
