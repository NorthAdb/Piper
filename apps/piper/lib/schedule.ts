// 定时调度（P1-4）：在 server.ts 长驻进程内调度晨间扫描，不另起服务、不加外部依赖。
// 计划：每天固定时刻（routines.json 的 schedule 字段，机器可解析的 "HH:MM"），时区读
// L0-3 基础资料（readProfileSettings().timezone，缺省 Asia/Hong_Kong），每次决策现读，
// 设置页改时区后下一周期即生效。
// 语义（本模块状态机钉死，测试以假时钟驱动，不依赖真实时间流逝）：
//   - 到点只触发一次；成功后同一周期不再跑；失败（整轮失败或抛错）后按 RETRY_DELAYS_MS
//     有限补跑（15 分钟窗口内最多 3 次），超过则保持失败状态等下一周期；
//   - 同一例程不并行：tick 时已有运行在途则跳过（busy），运行函数自身再做一层重入防护；
//   - 启动补跑：进程启动时若今日计划时刻已过、且今日尚未成功跑过（按存储中的例程状态
//     lastRunAt/lastStatus 判断），补跑一次，避免「服务 7:50 才启动、今天就空了」——
//     这不是随时乱扫：只在启动后的第一次规划时判定，且今日已成功则绝不补。
import { readProfileSettings } from "./settings.js";

export const DEFAULT_SCHEDULE_TIME = "08:00";
// 补跑策略：到点失败后 15 分钟窗口内最多补跑 3 次，每次间隔 5 分钟。
export const RETRY_DELAYS_MS = [5 * 60 * 1000, 5 * 60 * 1000, 5 * 60 * 1000];

// schedule 字段解析：只接受 "HH:MM"，其余（旧版中文描述等）返回 null，调用方回退缺省。
export function parseScheduleTime(schedule) {
	const m = /^(\d{2}):(\d{2})$/.exec(String(schedule ?? ""));
	if (!m) return null;
	const hour = Number(m[1]);
	const minute = Number(m[2]);
	if (hour > 23 || minute > 59) return null;
	return { hour, minute };
}

export function formatScheduleText(time, timezone) {
	return `每日 ${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}（${timezone}，进程内定时）`;
}

// 把旧版纯文本 schedule（如「每日 08:00（雏形阶段仅手动触发）」）迁移成机器可解析字段。
// 已是 "HH:MM" 则原样返回 null（无需迁移）；文本里能抠出 HH:MM 就用它，否则用缺省 08:00。
export function migrateScheduleFields(routine, timezone) {
	if (parseScheduleTime(routine?.schedule)) return null;
	const m = /(\d{1,2}):(\d{2})/.exec(String(routine?.schedule ?? ""));
	const time = m ? { hour: Number(m[1]) % 24, minute: Number(m[2]) % 60 } : parseScheduleTime(DEFAULT_SCHEDULE_TIME);
	const schedule = `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
	return { schedule, scheduleText: formatScheduleText(time, timezone) };
}

// 某时刻在指定时区下的墙钟分量。
export function zonedParts(date, timeZone) {
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	});
	const out = {};
	for (const p of fmt.formatToParts(date)) {
		if (p.type !== "literal") out[p.type] = Number(p.value);
	}
	return out;
}

// 某时刻在指定时区下的日期键（YYYY-MM-DD），用于「今日是否已成功」判定。
export function zonedDateKey(date, timeZone) {
	const p = zonedParts(date, timeZone);
	return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

// 把「时区下的墙钟时刻」换算成 UTC 瞬间：先按 UTC 猜一次，再用 zonedParts 反推偏移迭代修正。
function zonedTimeToUtc({ year, month, day, hour, minute }, timeZone) {
	const target = Date.UTC(year, month - 1, day, hour, minute, 0);
	let utc = target;
	for (let i = 0; i < 3; i += 1) {
		const p = zonedParts(new Date(utc), timeZone);
		const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
		const next = utc + (target - asUtc);
		if (next === utc) break;
		utc = next;
	}
	return new Date(utc);
}

// 严格晚于 now 的下一次计划瞬间（时区下的每日 HH:MM）。
export function nextRunAfter(now, timeZone, time) {
	const p = zonedParts(now, timeZone);
	let candidate = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: time.hour, minute: time.minute }, timeZone);
	if (candidate.getTime() <= now.getTime()) {
		const tomorrow = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
		candidate = zonedTimeToUtc(
			{ year: tomorrow.getUTCFullYear(), month: tomorrow.getUTCMonth() + 1, day: tomorrow.getUTCDate(), hour: time.hour, minute: time.minute },
			timeZone,
		);
	}
	return candidate;
}

// now 所在时区日期当天的计划瞬间（可能已过）。
function todaySlot(now, timeZone, time) {
	const p = zonedParts(now, timeZone);
	return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: time.hour, minute: time.minute }, timeZone);
}

// 启动补跑判定：今日计划已过 且 今日尚未成功跑过（lastStatus=ok 且 lastRunAt 落在今日）。
export function shouldCatchUp({ now, timeZone, time, lastRunAt, lastStatus }) {
	if (now.getTime() < todaySlot(now, timeZone, time).getTime()) return false;
	if (lastStatus === "ok" && lastRunAt && zonedDateKey(new Date(lastRunAt), timeZone) === zonedDateKey(now, timeZone)) return false;
	return true;
}

// 调度状态机。run() 返回 "ok" | "failed" | "skipped"（skipped = 运行函数侧重入防护命中，
// 不计成败、不推进计划，等下一次 tick）；抛错按 "failed" 处理。
// getRoutineState() 返回存储中的例程状态（{ lastRunAt, lastStatus }），供启动补跑与状态端点。
// timezoneFn / timeFn 每次规划时现读，使设置变更无需重启即生效。
// 防崩（审计 B3）：tick 整体包一层 try/catch——规划阶段（时区换算等）或状态推进抛错时
// 不把异常抛给调用方（server 用 void tick(...) 驱动，抛出去就是 unhandledRejection 杀
// 进程），改为复位 running、经 onError 钩子通知（server 侧落 routine.failed 通知）并
// 返回 { action: "error" }，调度器保持可用。
export function createScheduler({ run, getRoutineState, timezoneFn, timeFn, retryDelaysMs = RETRY_DELAYS_MS, onError = null }) {
	let running = false;
	let attempts = 0;
	let nextDueAt = null;
	let nextRetryAt = null;

	function plan(now) {
		const timeZone = timezoneFn();
		const time = timeFn();
		const state = getRoutineState() ?? {};
		if (shouldCatchUp({ now, timeZone, time, lastRunAt: state.lastRunAt ?? null, lastStatus: state.lastStatus ?? null })) {
			nextDueAt = now;
		} else {
			nextDueAt = nextRunAfter(now, timeZone, time);
		}
	}

	async function tick(now = new Date()) {
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
			return { action: "error", error: String(err?.message ?? err) };
		}
	}

	async function tickInner(now) {
		if (running) return { action: "busy" };
		if (!nextDueAt) plan(now);
		const dueAt = nextRetryAt ?? nextDueAt;
		if (now.getTime() < dueAt.getTime()) return { action: "idle", nextRunAt: dueAt };
		running = true;
		let outcome;
		try {
			outcome = await run();
		} catch {
			outcome = "failed";
		} finally {
			running = false;
		}
		if (outcome === "skipped") return { action: "skipped", nextRunAt: nextDueAt };
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

	function status(now = new Date()) {
		if (!nextDueAt) plan(now);
		const state = getRoutineState() ?? {};
		return {
			timezone: timezoneFn(),
			nextRunAt: (nextRetryAt ?? nextDueAt).toISOString(),
			nextRetryAt: nextRetryAt ? nextRetryAt.toISOString() : null,
			running,
			attempts,
			lastRunAt: state.lastRunAt ?? null,
			lastStatus: state.lastStatus ?? null,
		};
	}

	return { tick, status };
}

// 服务端装配用：时区直接读基础资料（缺省 Asia/Hong_Kong 在 readProfileSettings 内兜底）。
export function profileTimezone() {
	return readProfileSettings().timezone;
}
