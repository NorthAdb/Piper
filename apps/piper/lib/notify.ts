// 应用内通知（L0-5）：文件优先持久化，data/notifications.jsonl 一行一条，进程重启不丢。
// 类型：routine.completed / routine.failed（例程完成 / 整轮失败）、approval.pending
//（出现新的待批写操作，P1-6）、approval.executed / approval.failed（网关执行结果，P1-6）。
// 文件路径可用环境变量 PIPER_NOTIFICATIONS_FILE 覆盖（仅供单元测试隔离，缺省走 data/）。
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, ensureData } from "./store.js";
import { redact } from "./redact.js";

export const NOTIFICATION_TYPES = ["routine.completed", "routine.failed", "approval.pending", "approval.executed", "approval.failed"];

function notificationsFile() {
	return process.env.PIPER_NOTIFICATIONS_FILE || join(DATA_DIR, "notifications.jsonl");
}

function readAll() {
	const file = notificationsFile();
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}

export function addNotification({ type, title, body = "", routineId = null, artifactId = null, findingId = null }) {
	if (!NOTIFICATION_TYPES.includes(type)) throw new Error(`未知通知类型: ${type}`);
	const entry = {
		id: `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		type,
		// 通知正文常拼外部错误原文，落盘前统一脱敏（R7，出口在 lib/redact.ts）。
		title: redact(String(title ?? "")),
		body: redact(String(body ?? "")),
		routineId,
		artifactId,
		findingId,
		read: false,
		createdAt: new Date().toISOString(),
	};
	ensureData();
	appendFileSync(notificationsFile(), JSON.stringify(entry) + "\n", "utf8");
	return entry;
}

// 新在前
export function listNotifications() {
	return readAll().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function countUnread() {
	return readAll().filter((n) => !n.read).length;
}

// ids 给数组则只标记这些；不给（undefined）则全部标记已读。整表重写落盘，已读状态持久。
export function markNotificationsRead(ids) {
	const all = readAll();
	const wanted = Array.isArray(ids) ? new Set(ids.map(String)) : null;
	let changed = 0;
	for (const n of all) {
		if (!n.read && (!wanted || wanted.has(n.id))) {
			n.read = true;
			changed += 1;
		}
	}
	if (changed) {
		ensureData();
		writeFileSync(notificationsFile(), all.map((n) => JSON.stringify(n)).join("\n") + (all.length ? "\n" : ""), "utf8");
	}
	return changed;
}
