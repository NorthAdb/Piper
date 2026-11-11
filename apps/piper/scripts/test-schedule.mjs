// 定时调度测试（P1-4）：假时钟驱动 lib/schedule.mjs 的状态机，禁止依赖真实时间流逝。
// 用法（在 apps/piper 下）：node scripts/test-schedule.mjs（或 npm run test:schedule）
// 覆盖：下一次运行计算（时区换算）、到点只触发一次、失败有限补跑、成功后同周期不再跑、
// 启动补跑判定（已过点未成功补一次 / 已成功不补 / 未到点不补）、并发重入防护、
// schedule 字段解析与旧文本迁移。时区固定 Asia/Hong_Kong（UTC+8，无夏令时）。
// R4：schedule 经 settings 间接引用数据目录，PIPER_DATA_DIR 先指向临时目录再 import，
// 与其他脚本统一隔离口径（本脚本用注入的 timezoneFn，不实际读写数据文件）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "piper-schedule-"));
process.env.PIPER_DATA_DIR = join(tmp, "data");

const { createScheduler, migrateScheduleFields, nextRunAfter, parseScheduleTime, shouldCatchUp } = await import("../lib/schedule.mjs");

const results = [];
let seq = 0;
function check(name, ok, detail = "") {
	seq += 1;
	results.push({ seq, name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${String(seq).padStart(2, "0")} ${name}${ok ? "" : ` — ${detail}`}`);
}

const TZ = "Asia/Hong_Kong";
const TIME = { hour: 8, minute: 0 };
// HKT 2026-11-10 07:00 = UTC 2026-11-09 23:00；08:00 HKT = 00:00 UTC。
const T_0700 = new Date("2026-11-09T23:00:00.000Z");
const T_0800 = new Date("2026-11-10T00:00:00.000Z");
const T_0900 = new Date("2026-11-10T01:00:00.000Z");
const T_NEXT_0800 = new Date("2026-11-11T00:00:00.000Z");

// ---- 纯函数：nextRunAfter / parseScheduleTime / migrateScheduleFields ----
check(
	"nextRunAfter：08:00 前返回今日 08:00（HKT）",
	nextRunAfter(T_0700, TZ, TIME).toISOString() === "2026-11-10T00:00:00.000Z",
	nextRunAfter(T_0700, TZ, TIME).toISOString(),
);
check(
	"nextRunAfter：08:00 后返回次日 08:00（HKT）；恰在 08:00 也算已过（严格晚于）",
	nextRunAfter(T_0900, TZ, TIME).toISOString() === "2026-11-11T00:00:00.000Z" &&
		nextRunAfter(T_0800, TZ, TIME).toISOString() === "2026-11-11T00:00:00.000Z",
	nextRunAfter(T_0900, TZ, TIME).toISOString(),
);
check(
	"parseScheduleTime：接受 HH:MM，拒绝中文描述与越界值",
	parseScheduleTime("08:00")?.hour === 8 && parseScheduleTime("每日 08:00") === null && parseScheduleTime("24:00") === null && parseScheduleTime("") === null,
	"",
);
check(
	"migrateScheduleFields：旧文本抠出 08:00 并生成可读文案；已是 HH:MM 返回 null",
	(() => {
		const m = migrateScheduleFields({ schedule: "每日 08:00（雏形阶段仅手动触发）" }, TZ);
		return m?.schedule === "08:00" && m.scheduleText.includes("每日 08:00") && migrateScheduleFields({ schedule: "08:00" }, TZ) === null;
	})(),
	"",
);

// ---- 启动补跑判定 ----
check(
	"shouldCatchUp：已过点且今日未跑 → true；今日已成功 → false；未到点 → false；今日失败过 → true",
	shouldCatchUp({ now: T_0900, timeZone: TZ, time: TIME, lastRunAt: null, lastStatus: null }) === true &&
		shouldCatchUp({ now: T_0900, timeZone: TZ, time: TIME, lastRunAt: "2026-11-10T00:01:00.000Z", lastStatus: "ok" }) === false &&
		shouldCatchUp({ now: T_0700, timeZone: TZ, time: TIME, lastRunAt: null, lastStatus: null }) === false &&
		shouldCatchUp({ now: T_0900, timeZone: TZ, time: TIME, lastRunAt: "2026-11-10T00:01:00.000Z", lastStatus: "failed" }) === true,
	"",
);

// ---- 状态机：到点只跑一次，成功后同周期不再跑，次日再跑 ----
{
	let calls = 0;
	const state = { lastRunAt: null, lastStatus: null };
	const sched = createScheduler({
		run: async () => {
			calls += 1;
			state.lastRunAt = new Date().toISOString();
			state.lastStatus = "ok";
			return "ok";
		},
		getRoutineState: () => state,
		timezoneFn: () => TZ,
		timeFn: () => TIME,
	});
	const before = await sched.tick(T_0700);
	const atSlot = await sched.tick(T_0800);
	const after = await sched.tick(T_0900);
	const nextDay = await sched.tick(T_NEXT_0800);
	check(
		"到点触发：08:00 前 idle、到点跑一次、成功后同日不再跑、次日到点再跑",
		before.action === "idle" && atSlot.action === "ran" && atSlot.result === "ok" && after.action === "idle" && nextDay.action === "ran" && calls === 2,
		`calls=${calls} ${JSON.stringify([before.action, atSlot.action, after.action, nextDay.action])}`,
	);
}

// ---- 状态机：失败有限补跑（3 次、每次 +5 分钟），给满后等下一周期 ----
{
	let calls = 0;
	const state = { lastRunAt: null, lastStatus: null };
	const sched = createScheduler({
		run: async () => {
			calls += 1;
			state.lastRunAt = new Date().toISOString();
			state.lastStatus = "failed";
			return "failed";
		},
		getRoutineState: () => state,
		timezoneFn: () => TZ,
		timeFn: () => TIME,
	});
	await sched.tick(T_0700); // idle，顺带规划（未到点且 lastStatus 非 ok 但未过点，不补跑）
	const r1 = await sched.tick(T_0800); // 第 1 跑失败
	const early = await sched.tick(new Date(T_0800.getTime() + 4 * 60 * 1000)); // 补跑时刻未到
	const r2 = await sched.tick(new Date(T_0800.getTime() + 5 * 60 * 1000)); // 补跑 1
	const r3 = await sched.tick(new Date(T_0800.getTime() + 10 * 60 * 1000)); // 补跑 2
	const r4 = await sched.tick(new Date(T_0800.getTime() + 15 * 60 * 1000)); // 补跑 3 → 放弃
	const later = await sched.tick(T_0900); // 同日不再跑
	const nextDay = await sched.tick(T_NEXT_0800); // 次日周期重新触发
	check(
		"失败补跑：到点失败后 +5/+10/+15 分钟各补一次（共 4 跑），放弃后同日 idle、次日再触发",
		r1.result === "failed" &&
			early.action === "idle" &&
			r2.action === "ran" &&
			r3.action === "ran" &&
			r4.gaveUp === true &&
			later.action === "idle" &&
			nextDay.action === "ran" &&
			calls === 5,
		`calls=${calls}`,
	);
}

// ---- 状态机：失败一次后补跑成功，attempts 清零、不再补跑 ----
{
	let calls = 0;
	const state = { lastRunAt: null, lastStatus: null };
	const sched = createScheduler({
		run: async () => {
			calls += 1;
			const ok = calls >= 2;
			state.lastStatus = ok ? "ok" : "failed";
			return ok ? "ok" : "failed";
		},
		getRoutineState: () => state,
		timezoneFn: () => TZ,
		timeFn: () => TIME,
	});
	await sched.tick(T_0800);
	const retry = await sched.tick(new Date(T_0800.getTime() + 5 * 60 * 1000));
	const after = await sched.tick(new Date(T_0800.getTime() + 10 * 60 * 1000));
	check(
		"补跑成功即停：第二次成功后 attempts 清零，同日不再触发",
		retry.action === "ran" && retry.result === "ok" && after.action === "idle" && calls === 2 && sched.status(T_0900).attempts === 0,
		`calls=${calls}`,
	);
}

// ---- 状态机：启动补跑（已过点、今日未成功 → 首个 tick 立即跑；已成功 → 不跑） ----
{
	let callsA = 0;
	const stateA = { lastRunAt: "2026-11-09T00:05:00.000Z", lastStatus: "ok" }; // 昨日成功
	const schedA = createScheduler({
		run: async () => {
			callsA += 1;
			return "ok";
		},
		getRoutineState: () => stateA,
		timezoneFn: () => TZ,
		timeFn: () => TIME,
	});
	const tickA = await schedA.tick(T_0900);
	let callsB = 0;
	const stateB = { lastRunAt: "2026-11-10T00:01:00.000Z", lastStatus: "ok" }; // 今日已成功
	const schedB = createScheduler({
		run: async () => {
			callsB += 1;
			return "ok";
		},
		getRoutineState: () => stateB,
		timezoneFn: () => TZ,
		timeFn: () => TIME,
	});
	const tickB = await schedB.tick(T_0900);
	check(
		"启动补跑：已过点且今日未成功 → 立即补跑一次；今日已成功 → 不补跑",
		tickA.action === "ran" && callsA === 1 && tickB.action === "idle" && callsB === 0,
		`A calls=${callsA} B calls=${callsB}`,
	);
}

// ---- 状态机：并发重入防护（运行在途时 tick 返回 busy，不重复跑） ----
{
	let calls = 0;
	let release;
	const gate = new Promise((r) => (release = r));
	const state = { lastRunAt: null, lastStatus: null };
	const sched = createScheduler({
		run: async () => {
			calls += 1;
			await gate;
			return "ok";
		},
		getRoutineState: () => state,
		timezoneFn: () => TZ,
		timeFn: () => TIME,
	});
	const first = sched.tick(T_0800);
	const second = await sched.tick(T_0800);
	release();
	const firstResult = await first;
	check(
		"并发防护：运行在途时第二个 tick 返回 busy 且 run 只被调用一次",
		second.action === "busy" && firstResult.action === "ran" && calls === 1,
		`calls=${calls} second=${second.action}`,
	);
}

// ---- 状态机：run 返回 skipped（执行层重入防护命中）不计成败、不推进 ----
{
	let calls = 0;
	const state = { lastRunAt: null, lastStatus: null };
	const sched = createScheduler({
		run: async () => {
			calls += 1;
			return calls === 1 ? "skipped" : "ok";
		},
		getRoutineState: () => state,
		timezoneFn: () => TZ,
		timeFn: () => TIME,
	});
	const s1 = await sched.tick(T_0800);
	const s2 = await sched.tick(T_0800);
	check(
		"skipped 不推进计划：同一时刻下一次 tick 仍会真正执行",
		s1.action === "skipped" && s2.action === "ran" && s2.result === "ok" && calls === 2,
		`calls=${calls}`,
	);
}

// ---- R3：timezoneFn 抛错时 tick 不抛（外层 try/catch + onError 失败通知钩子） ----
{
	let broken = true;
	let calls = 0;
	const errors = [];
	const state = { lastRunAt: null, lastStatus: null };
	const sched = createScheduler({
		run: async () => {
			calls += 1;
			return "ok";
		},
		getRoutineState: () => state,
		timezoneFn: () => {
			if (broken) throw new Error("Invalid time zone specified: Foo/Bar");
			return TZ;
		},
		timeFn: () => TIME,
		onError: (err) => errors.push(err),
	});
	let threw = false;
	let res = null;
	try {
		res = await sched.tick(T_0800);
	} catch {
		threw = true;
	}
	// 不带 onError 的调度器同样不得把异常抛给调用方（server 是 void tick(...)）。
	const schedBare = createScheduler({
		run: async () => "ok",
		getRoutineState: () => state,
		timezoneFn: () => {
			throw new Error("Invalid time zone specified: Foo/Bar");
		},
		timeFn: () => TIME,
	});
	let threwBare = false;
	try {
		await schedBare.tick(T_0800);
	} catch {
		threwBare = true;
	}
	check(
		"R3 timezoneFn 抛错：tick 不抛、返回 error 结果、onError 收到一次通知（无 onError 亦不抛）",
		!threw && res?.action === "error" && errors.length === 1 && !threwBare && calls === 0,
		`threw=${threw} res=${JSON.stringify(res)} errors=${errors.length} threwBare=${threwBare} calls=${calls}`,
	);

	broken = false;
	const after = await sched.tick(T_0800);
	check(
		"R3 timezoneFn 恢复后调度器未楔死：running 已复位，到点能真正执行",
		after.action === "ran" && after.result === "ok" && calls === 1 && errors.length === 1,
		`after=${JSON.stringify(after)} calls=${calls}`,
	);
}

// ---- 状态端点形状 ----
{
	const state = { lastRunAt: "2026-11-10T00:01:00.000Z", lastStatus: "ok" };
	const sched = createScheduler({
		run: async () => "ok",
		getRoutineState: () => state,
		timezoneFn: () => TZ,
		timeFn: () => TIME,
	});
	const st = sched.status(T_0700);
	check(
		"status()：含 timezone / nextRunAt / lastRunAt / lastStatus / running / attempts",
		st.timezone === TZ &&
			st.nextRunAt === "2026-11-10T00:00:00.000Z" &&
			st.lastRunAt === state.lastRunAt &&
			st.lastStatus === "ok" &&
			st.running === false &&
			st.attempts === 0,
		JSON.stringify(st),
	);
}

rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
