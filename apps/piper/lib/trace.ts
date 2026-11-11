// 轨迹归一化（PR-D）：把会话 JSONL 条目整理成按轮分组的轨迹，供轨迹视图
// （PR-E）消费。纯函数：只读入参、不回写任何文件，老会话文件读完字节不变。
//
// 分组口径：一条 user 条目开启一轮，直到下一条 user 条目之前；首条 user
// 之前的条目（bot 创建确认、扫描播报等）自成一组（无 user 事件）。
//
// 时间口径（输出统一 epoch 毫秒数）：
//   - 条目自带 ts 是 appendSession 的落盘戳（ISO 字符串；落盘戳引入前的极
//     老文件可能没有）——解析得出的是真实记录时刻，不是编造。
//   - startedAt/endedAt/durationMs 是 PR-D 起新落盘的事件时刻（epoch 毫秒
//     数，见 server.ts handleChat 的落盘字段）。
//   - 事件时刻 ts：tool 取 startedAt、thinking 取段首 startedAt（事件真正
//     发生的时刻，比回合末尾的落盘戳更适合画时间线），缺失回落条目 ts；
//     其余种类取条目 ts。无任何证据（字段缺失或解析不出）一律 null，不拿
//     文件 mtime 之类旁证冒充。
//   - 轮 startedAt 取 user 事件的 ts（无 user 的组取首个有时刻的事件），
//     endedAt 取本轮事件时刻的最大值，durationMs 两者可算且非负才给。
//
// 出参脱敏：正文预览过 redact() 后截断（落盘时已脱敏，这里是接口层兜底，
// 老文件里的未脱敏文本不出接口）；tool 的 args/result 沿用落盘的已脱敏
// 版本，再过一遍 redactDeep 兜底，不在接口层产生任何新明文。
import { redact, redactDeep } from "./redact.js";
import type { SessionEntry } from "./store.js";

const PREVIEW_MAX_CHARS = 200;

export interface TraceEvent {
	kind: string;
	subKind: string | null;
	ts: number | null;
	durationMs: number | null;
	seq: number | null;
	textChars: number | null;
	textPreview: string | null;
	level?: string | null;
	truncated?: boolean;
	name?: string | null;
	status?: string | null;
	toolCallId?: string | null;
	startedAt?: number | null;
	endedAt?: number | null;
	args?: unknown;
	result?: unknown;
}

export interface TraceTurn {
	index: number;
	startedAt: number | null;
	endedAt: number | null;
	durationMs: number | null;
	events: TraceEvent[];
}

// 毫秒数原样、ISO 字符串解析、其余（缺失/坏值）回 null。
function toMs(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const ms = Date.parse(value);
		return Number.isNaN(ms) ? null : ms;
	}
	return null;
}

function numOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function traceEvent(entry: SessionEntry): TraceEvent {
	const kind = typeof entry?.role === "string" && entry.role ? entry.role : "unknown";
	// tool/thinking 的事件时刻优先用事件字段 startedAt（毫秒数）
	const eventStartedAt = kind === "tool" || kind === "thinking" ? numOrNull(entry?.startedAt) : null;
	const ev: TraceEvent = {
		kind,
		subKind: typeof entry?.kind === "string" ? entry.kind : null,
		ts: eventStartedAt ?? toMs(entry?.ts),
		durationMs: numOrNull(entry?.durationMs),
		seq: numOrNull(entry?.seq),
		textChars: null,
		textPreview: null,
	};
	if (typeof entry?.text === "string") {
		ev.textChars = entry.text.length;
		ev.textPreview = redact(entry.text).slice(0, PREVIEW_MAX_CHARS);
	} else {
		ev.textChars = null;
		ev.textPreview = null;
	}
	if (kind === "thinking") {
		ev.level = typeof entry?.level === "string" ? entry.level : null;
		ev.truncated = entry?.truncated === true;
	}
	if (kind === "tool") {
		ev.name = typeof entry?.name === "string" ? entry.name : null;
		ev.status = typeof entry?.status === "string" ? entry.status : null;
		ev.toolCallId = typeof entry?.toolCallId === "string" ? entry.toolCallId : null;
		ev.startedAt = eventStartedAt;
		ev.endedAt = numOrNull(entry?.endedAt);
		ev.args = entry?.args === undefined ? null : redactDeep(entry.args);
		ev.result = entry?.result === undefined ? null : redactDeep(entry.result);
	}
	return ev;
}

// 会话条目数组 -> { turns: [{ index, startedAt, endedAt, durationMs, events }] }
export function buildTrace(entries: unknown): { turns: TraceTurn[] } {
	const turns: TraceTurn[] = [];
	let current: TraceTurn | null = null;
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (!entry || typeof entry !== "object") continue;
		let cur: TraceTurn | null = current;
		if (entry.role === "user" || !cur) {
			cur = { index: turns.length, startedAt: null, endedAt: null, durationMs: null, events: [] };
			current = cur;
			turns.push(cur);
		}
		cur.events.push(traceEvent(entry));
	}
	for (const turn of turns) {
		const userEv = turn.events.find((e) => e.kind === "user");
		const stamps = turn.events.map((e) => e.ts).filter((v): v is number => v !== null);
		turn.startedAt = userEv ? userEv.ts : stamps.length ? stamps[0] : null;
		turn.endedAt = stamps.length ? Math.max(...stamps) : null;
		turn.durationMs = turn.startedAt !== null && turn.endedAt !== null && turn.endedAt >= turn.startedAt ? turn.endedAt - turn.startedAt : null;
	}
	return { turns };
}
