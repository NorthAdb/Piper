// 任务运行时（P2-7）：把晨间扫描的调度收成循环外的任务运行时——
// 唤醒与执行分离：定时器只负责到点入队（queued）并叫醒 runner，
// runner 再执行扫描；每一次执行都是一条可查的 Job 记录。副作用仍走
// 既有路径（runMorningScan → 网关闸），本模块不直接碰 GitHub 写 API。
//
// 调度状态机（到点一次、失败有限补跑、启动补跑、并发防护、异常不杀
// 进程）原样迁自 lib/schedule.ts 的 createScheduler（P1-4），P2-7 起
// 只在这里有一份；schedule.ts 只留纯时间助手与 RETRY_DELAYS_MS 常量
// （补跑间隔仍是 [5 分钟 ×3]，未迁移、未改值，本模块直接引用）。
//
// Job 存储：PIPER_DATA_DIR/jobs.json（JSON 数组，文件优先；路径可用
// 环境变量 PIPER_JOBS_FILE 覆盖，仅供测试隔离）。落盘纪律与
// tool-approvals 同口径：整表原子落盘（临时文件 + rename）；读到损坏
// 内容时把原文件改名隔离（.corrupt-<时间戳>），绝不把损坏当成空表
// 后在下一次写入时静默覆盖。保留上限 500 条：超出时先丢最旧的终态
// 记录，queued / running 永不丢。
//
// 幂等：cron job 的幂等键 = morning-scan:<botId>:<时区日期>:<HH:MM>
// （时槽键）。同键已有 queued / running 的 job 时不重复建；已有
// succeeded 时本时槽视为已完成、不重跑；终态为 failed / skipped /
// interrupted 的同键 job 不挡新尝试（失败补跑即新尝试，沿用调度机
// 的 RETRY_DELAYS_MS 节奏）。手动 job 每请求一条、键唯一。
//
// 启动恢复（对齐 recoverInterruptedExecutions 的「至少一次 + 对账」
// 精神，不假装恰好一次）：start() 把残留 running 标 interrupted 并
// 在 checkpoint 留痕；同键没有 succeeded 的 interrupted job 重新
// 入队，随后连同遗留 queued 一并排空执行。扫描本身的去重（Finding
// 对账、评论幂等标记）保证重跑不产生重复副作用。
//
// trigger 的 "channel" 只在类型里预留：任何创建 job 的入口收到它
// 都明确拒绝（TRIGGER_NOT_IMPLEMENTED / 400），不得悄悄当成 manual。
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, ensureData, writeFileAtomicSync } from "./store.ts";
import { RETRY_DELAYS_MS, nextRunAfter, shouldCatchUp, zonedDateKey } from "./schedule.ts";
import type { ScheduleTime } from "./schedule.ts";

export type JobTrigger = "cron" | "manual" | "approval" | "channel"; // channel 仅预留，不可被产品代码设置为已实现

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "skipped" | "interrupted";

export interface Job {
	id: string; // 形如 "job-…"
	botId: string;
	type: "morning-scan"; // 本件只实现这一种
	trigger: JobTrigger;
	idempotencyKey: string;
	checkpoint: unknown | null;
	status: JobStatus;
	createdAt: string;
	updatedAt: string;
	error?: string | null;
}

const MAX_JOBS_KEPT = 500;
const TERMINAL_STATUSES: readonly JobStatus[] = ["succeeded", "failed", "skipped", "interrupted"];

function jobsFile(): string {
	return process.env.PIPER_JOBS_FILE || join(DATA_DIR, "jobs.json");
}

function readAllJobs(): Job[] {
	const file = jobsFile();
	if (!existsSync(file)) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		parsed = undefined;
	}
	if (Array.isArray(parsed)) return parsed as Job[];
	// 损坏隔离（与 tool-approvals 同口径）：保留原文件为证据，后续写入
	// 从空表开始，而不是把解析失败当成空数组无声覆盖。
	try {
		renameSync(file, `${file}.corrupt-${Date.now()}`);
		console.error(`[piper] jobs.json 内容损坏，已隔离原文件并从空表继续：${file}`);
	} catch {
		console.error(`[piper] jobs.json 内容损坏且隔离失败，按空表继续：${file}`);
	}
	return [];
}

function writeAllJobs(jobs: Job[]): void {
	let kept = jobs;
	if (kept.length > MAX_JOBS_KEPT) {
		// 先丢最旧的终态记录（数组按创建时间升序）；非终态一条不丢，
		// 因此极端情况下总数可短暂超过上限——宁可多留，不丢在途 job。
		const dropCount = kept.length - MAX_JOBS_KEPT;
		let dropped = 0;
		kept = kept.filter((job) => {
			if (dropped < dropCount && TERMINAL_STATUSES.includes(job.status)) {
				dropped += 1;
				return false;
			}
			return true;
		});
	}
	ensureData();
	writeFileAtomicSync(jobsFile(), JSON.stringify(kept, null, 2) + "\n", "utf8");
}

export function listJobs(filter?: { botId?: string; status?: JobStatus }): Job[] {
	return readAllJobs().filter((job) => (!filter?.botId || job.botId === filter.botId) && (!filter?.status || job.status === filter.status));
}

export function getJob(id: string): Job | null {
	return readAllJobs().find((job) => job.id === id) ?? null;
}

function insertJob(input: { botId: string; trigger: JobTrigger; idempotencyKey: string }): Job {
	const now = new Date().toISOString();
	const job: Job = {
		id: `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		botId: input.botId,
		type: "morning-scan",
		trigger: input.trigger,
		idempotencyKey: input.idempotencyKey,
		checkpoint: null,
		status: "queued",
		createdAt: now,
		updatedAt: now,
		error: null,
	};
	const all = readAllJobs();
	all.push(job);
	writeAllJobs(all);
	return job;
}

function updateJobRecord(id: string, patch: Partial<Job>): Job | null {
	const all = readAllJobs();
	const job = all.find((j) => j.id === id);
	if (!job) return null;
	Object.assign(job, patch, { updatedAt: new Date().toISOString() });
	writeAllJobs(all);
	return job;
}

// 已实现的 trigger 集合；"channel" 在类型里但不在这里——入口校验据此拒绝。
const IMPLEMENTED_TRIGGERS: readonly JobTrigger[] = ["cron", "manual", "approval"];

export function assertTriggerImplemented(trigger: unknown): asserts trigger is JobTrigger {
	if (trigger === "channel") {
		throw Object.assign(new Error('trigger "channel" 仅为类型预留、尚未实现，拒绝创建 job'), { code: "TRIGGER_NOT_IMPLEMENTED", status: 400 });
	}
	if (!IMPLEMENTED_TRIGGERS.includes(trigger as JobTrigger)) {
		throw Object.assign(new Error(`未知 trigger：${String(trigger)}`), { code: "TRIGGER_UNKNOWN", status: 400 });
	}
}

export interface ScanRunOutcome {
	result: "ok" | "failed" | "skipped";
	error?: string | null;
	payload?: unknown;
}

export interface RoutineStateLike {
	lastRunAt?: string | null;
	lastStatus?: string | null;
}

export interface JobRuntimeOptions {
	runScan: () => Promise<ScanRunOutcome>;
	botIdFn: () => string;
	getRoutineState: () => RoutineStateLike | null | undefined;
	timezoneFn: () => string;
	timeFn: () => ScheduleTime;
	retryDelaysMs?: number[];
	onError?: ((err: unknown) => void) | null;
}

export interface TickResult {
	action: string;
	nextRunAt?: Date;
	result?: string;
	attempts?: number;
	gaveUp?: boolean;
	error?: string;
}

export interface JobRuntimeStatus {
	timezone: string;
	nextRunAt: string;
	nextRetryAt: string | null;
	running: boolean;
	attempts: number;
	lastRunAt: string | null;
	lastStatus: string | null;
}

export interface JobRuntime {
	tick: (now?: Date) => Promise<TickResult>;
	status: (now?: Date) => JobRuntimeStatus;
	start: () => Promise<{ interrupted: number; requeued: number }>;
	enqueue: (input: { trigger: JobTrigger; idempotencyKey: string }) => Job;
	runManual: (input?: { trigger?: unknown }) => Promise<{ job: Job; outcome: ScanRunOutcome }>;
	getJob: (id: string) => Job | null;
	listJobs: (filter?: { botId?: string; status?: JobStatus }) => Job[];
}

export function createJobRuntime({ runScan, botIdFn, getRoutineState, timezoneFn, timeFn, retryDelaysMs = RETRY_DELAYS_MS, onError = null }: JobRuntimeOptions): JobRuntime {
	let running = false;
	let attempts = 0;
	let nextDueAt: Date | null = null;
	let nextRetryAt: Date | null = null;

	function plan(now: Date): void {
		const timeZone = timezoneFn();
		const time = timeFn();
		const state = getRoutineState() ?? {};
		if (shouldCatchUp({ now, timeZone, time, lastRunAt: state.lastRunAt ?? null, lastStatus: state.lastStatus ?? null })) {
			nextDueAt = now;
		} else {
			nextDueAt = nextRunAfter(now, timeZone, time);
		}
	}

	// 时槽幂等键：bot + 时区日期 + 计划时刻。补跑发生在同一时区日期内
	// 时键不变（新尝试另建 job）；跨日自然换键。
	function slotIdempotencyKey(now: Date): string {
		const time = timeFn();
		const hh = String(time.hour).padStart(2, "0");
		const mm = String(time.minute).padStart(2, "0");
		return `morning-scan:${botIdFn()}:${zonedDateKey(now, timezoneFn())}:${hh}:${mm}`;
	}

	// 执行一条 job：queued → running → 终态。runScan 自身抛错按 failed
	// 记（错误文本进 job.error）；runScan 的 skipped 是执行层重入防护
	// 命中（如手动与定时重叠），如实记 skipped、不算失败。
	async function executeJob(job: Job): Promise<ScanRunOutcome> {
		updateJobRecord(job.id, { status: "running" });
		let outcome: ScanRunOutcome;
		try {
			outcome = await runScan();
		} catch (err) {
			outcome = { result: "failed", error: String((err as { message?: unknown } | null | undefined)?.message ?? err) };
		}
		updateJobRecord(job.id, {
			status: outcome.result === "ok" ? "succeeded" : outcome.result,
			error: outcome.error ?? null,
		});
		return outcome;
	}

	// cron 到点入队：同键已有 queued/running → 在途，不重复建；
	// 已有 succeeded → 本时槽已完成；其余（无记录或终态非 succeeded）
	// 建新尝试。
	function enqueueCronAttempt(now: Date): { kind: "created" | "active" | "done"; job: Job } {
		const key = slotIdempotencyKey(now);
		const same = listJobs().filter((j) => j.idempotencyKey === key);
		const active = same.find((j) => j.status === "queued" || j.status === "running");
		if (active) return { kind: "active", job: active };
		const done = same.find((j) => j.status === "succeeded");
		if (done) return { kind: "done", job: done };
		return { kind: "created", job: insertJob({ botId: botIdFn(), trigger: "cron", idempotencyKey: key }) };
	}

	async function tick(now: Date = new Date()): Promise<TickResult> {
		try {
			return await tickInner(now);
		} catch (err) {
			running = false;
			if (onError) {
				try {
					onError(err);
				} catch {
					/* 通知钩子自身失败不得再拖垮调度 */
				}
			}
			return { action: "error", error: String((err as { message?: unknown } | null | undefined)?.message ?? err) };
		}
	}

	async function tickInner(now: Date): Promise<TickResult> {
		if (running) return { action: "busy" };
		if (!nextDueAt) plan(now);
		// plan() 两条分支都给 nextDueAt 赋值，到此必非空。
		const dueAt = (nextRetryAt ?? nextDueAt) as Date;
		if (now.getTime() < dueAt.getTime()) return { action: "idle", nextRunAt: dueAt };
		running = true;
		let outcome: string;
		try {
			const enq = enqueueCronAttempt(now);
			if (enq.kind === "active") {
				// 同槽已有 job 在途（恢复排队或崩溃后残留）：本 tick 不
				// 重复执行，按 skipped 语义不计成败、不推进计划。
				outcome = "skipped";
			} else if (enq.kind === "done") {
				// 同槽已成功（例如进程在成功落盘后、计划推进前崩溃）：
				// 按成功推进计划，但不重跑扫描。
				outcome = "ok";
			} else {
				outcome = (await executeJob(enq.job)).result;
			}
		} catch {
			outcome = "failed";
		} finally {
			running = false;
		}
		if (outcome === "skipped") return { action: "skipped", nextRunAt: nextDueAt as Date };
		if (outcome === "ok") {
			attempts = 0;
			nextRetryAt = null;
			nextDueAt = nextRunAfter(now, timezoneFn(), timeFn());
			return { action: "ran", result: "ok", nextRunAt: nextDueAt };
		}
		attempts += 1;
		if (attempts <= retryDelaysMs.length) {
			nextRetryAt = new Date(now.getTime() + retryDelaysMs[attempts - 1]);
			return { action: "ran", result: "failed", attempts, nextRunAt: nextRetryAt };
		}
		attempts = 0;
		nextRetryAt = null;
		nextDueAt = nextRunAfter(now, timezoneFn(), timeFn());
		return { action: "ran", result: "failed", gaveUp: true, nextRunAt: nextDueAt };
	}

	function status(now: Date = new Date()): JobRuntimeStatus {
		if (!nextDueAt) plan(now);
		const state = getRoutineState() ?? {};
		return {
			timezone: timezoneFn(),
			nextRunAt: ((nextRetryAt ?? nextDueAt) as Date).toISOString(),
			nextRetryAt: nextRetryAt ? nextRetryAt.toISOString() : null,
			running,
			attempts,
			lastRunAt: state.lastRunAt ?? null,
			lastStatus: state.lastStatus ?? null,
		};
	}

	// 通用入队（cron 内部路径与未来 approval 入口共用）：同键已有
	// queued/running 时复用那条，不重复建；trigger 先过实现校验。
	function enqueue(input: { trigger: JobTrigger; idempotencyKey: string }): Job {
		assertTriggerImplemented(input.trigger);
		const active = listJobs().find((j) => j.idempotencyKey === input.idempotencyKey && (j.status === "queued" || j.status === "running"));
		if (active) return active;
		return insertJob({ botId: botIdFn(), trigger: input.trigger, idempotencyKey: input.idempotencyKey });
	}

	// 手动入口：只接受 manual（缺省即 manual）；channel 在此明确
	// 拒绝（400），绝不悄悄当成 manual。建 job 后立即执行并等它跑完，
	// 调用方（HTTP 路由）据 job 终态与 outcome.payload 回应。
	async function runManual(input: { trigger?: unknown } = {}): Promise<{ job: Job; outcome: ScanRunOutcome }> {
		const trigger = input.trigger ?? "manual";
		assertTriggerImplemented(trigger);
		if (trigger !== "manual") {
			throw Object.assign(new Error(`手动入口只接受 trigger "manual"，收到 "${String(trigger)}"`), { code: "TRIGGER_NOT_MANUAL", status: 400 });
		}
		const job = insertJob({ botId: botIdFn(), trigger: "manual", idempotencyKey: `manual:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` });
		const outcome = await executeJob(job);
		return { job: getJob(job.id) ?? job, outcome };
	}

	// 启动恢复：残留 running → interrupted（checkpoint 留痕）；同键无
	// succeeded 的 interrupted 重新入队；随后把全部 queued（含崩溃前
	// 遗留的）按创建顺序排空执行。重跑的安全边界在扫描层（Finding
	// 对账 + 评论幂等），本层只保证至少一次。
	async function start(): Promise<{ interrupted: number; requeued: number }> {
		let interrupted = 0;
		for (const job of listJobs({ status: "running" })) {
			updateJobRecord(job.id, {
				status: "interrupted",
				checkpoint: { recoveredAt: new Date().toISOString(), fromStatus: "running" },
			});
			interrupted += 1;
		}
		let requeued = 0;
		const all = readAllJobs();
		for (const job of all) {
			if (job.status !== "interrupted") continue;
			if (all.some((j) => j.idempotencyKey === job.idempotencyKey && j.status === "succeeded")) continue;
			updateJobRecord(job.id, { status: "queued" });
			requeued += 1;
		}
		for (const job of listJobs({ status: "queued" })) {
			await executeJob(job);
		}
		return { interrupted, requeued };
	}

	return { tick, status, start, enqueue, runManual, getJob, listJobs };
}
