// 定时调度的时间助手（P1-4）：计划时刻解析、时区换算、下一次运行与启动
// 补跑判定、补跑节奏常量。调度状态机本体（到点一次 / 失败有限补跑 / 启动
// 补跑 / 并发防护 / 异常不杀进程）P2-7 起迁入 lib/job-runtime.ts，本文件
// 只留纯函数与常量，不再有第二份 tick（见 job-runtime.ts 文件头）。
// 计划：每天固定时刻（routines.json 的 schedule 字段，机器可解析的 "HH:MM"），时区读
// L0-3 基础资料（readProfileSettings().timezone，缺省 Asia/Hong_Kong），每次决策现读，
// 设置页改时区后下一周期即生效。
import { readProfileSettings } from "./settings.ts";

export const DEFAULT_SCHEDULE_TIME = "08:00";
// 补跑策略：到点失败后 15 分钟窗口内最多补跑 3 次，每次间隔 5 分钟。
export const RETRY_DELAYS_MS = [5 * 60 * 1000, 5 * 60 * 1000, 5 * 60 * 1000];

export interface ScheduleTime {
	hour: number;
	minute: number;
}

// 某时刻在指定时区下的墙钟分量（Intl 在给定选项下必产出这六个分量）。
export interface ZonedParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

// schedule 字段解析：只接受 "HH:MM"，其余（旧版中文描述等）返回 null，调用方回退缺省。
export function parseScheduleTime(schedule: unknown): ScheduleTime | null {
	const m = /^(\d{2}):(\d{2})$/.exec(String(schedule ?? ""));
	if (!m) return null;
	const hour = Number(m[1]);
	const minute = Number(m[2]);
	if (hour > 23 || minute > 59) return null;
	return { hour, minute };
}

export function formatScheduleText(time: ScheduleTime, timezone: string): string {
	return `每日 ${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}（${timezone}，进程内定时）`;
}

// 把旧版纯文本 schedule（如「每日 08:00（雏形阶段仅手动触发）」）迁移成机器可解析字段。
// 已是 "HH:MM" 则原样返回 null（无需迁移）；文本里能抠出 HH:MM 就用它，否则用缺省 08:00。
export function migrateScheduleFields(
	routine: { schedule?: unknown } | null | undefined,
	timezone: string,
): { schedule: string; scheduleText: string } | null {
	if (parseScheduleTime(routine?.schedule)) return null;
	const m = /(\d{1,2}):(\d{2})/.exec(String(routine?.schedule ?? ""));
	// 缺省 "08:00" 恒可解析，parseScheduleTime 不会返回 null，兜底字面量仅为类型完备。
	const time: ScheduleTime = m ? { hour: Number(m[1]) % 24, minute: Number(m[2]) % 60 } : (parseScheduleTime(DEFAULT_SCHEDULE_TIME) ?? { hour: 8, minute: 0 });
	const schedule = `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
	return { schedule, scheduleText: formatScheduleText(time, timezone) };
}

// 某时刻在指定时区下的墙钟分量。
export function zonedParts(date: Date, timeZone: string): ZonedParts {
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
	const bag: Record<string, number> = {};
	for (const p of fmt.formatToParts(date)) {
		if (p.type !== "literal") bag[p.type] = Number(p.value);
	}
	return bag as unknown as ZonedParts;
}

// 某时刻在指定时区下的日期键（YYYY-MM-DD），用于「今日是否已成功」判定。
export function zonedDateKey(date: Date, timeZone: string): string {
	const p = zonedParts(date, timeZone);
	return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

// 把「时区下的墙钟时刻」换算成 UTC 瞬间：先按 UTC 猜一次，再用 zonedParts 反推偏移迭代修正。
function zonedTimeToUtc({ year, month, day, hour, minute }: { year: number; month: number; day: number; hour: number; minute: number }, timeZone: string): Date {
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
export function nextRunAfter(now: Date, timeZone: string, time: ScheduleTime): Date {
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
function todaySlot(now: Date, timeZone: string, time: ScheduleTime): Date {
	const p = zonedParts(now, timeZone);
	return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: time.hour, minute: time.minute }, timeZone);
}

// 启动补跑判定：今日计划已过 且 今日尚未成功跑过（lastStatus=ok 且 lastRunAt 落在今日）。
export function shouldCatchUp({
	now,
	timeZone,
	time,
	lastRunAt,
	lastStatus,
}: {
	now: Date;
	timeZone: string;
	time: ScheduleTime;
	lastRunAt?: string | null;
	lastStatus?: string | null;
}): boolean {
	if (now.getTime() < todaySlot(now, timeZone, time).getTime()) return false;
	if (lastStatus === "ok" && lastRunAt && zonedDateKey(new Date(lastRunAt), timeZone) === zonedDateKey(now, timeZone)) return false;
	return true;
}

// 服务端装配用：时区直接读基础资料（缺省 Asia/Hong_Kong 在 readProfileSettings 内兜底）。
export function profileTimezone(): string {
	return readProfileSettings().timezone;
}
