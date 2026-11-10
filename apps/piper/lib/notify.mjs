// 应用内通知（L0-5）：文件优先持久化，data/notifications.jsonl 一行一条，进程重启不丢。
// 已落地类型：routine.completed / routine.failed（晨间扫描成功 / 失败时由服务端写入）。
// approval.pending 仅在类型枚举里预留，第一件（P1-6）接入时才真正写入，本切片不造假数据。
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, ensureData } from "./store.mjs";

const NOTIFICATIONS_FILE = join(DATA_DIR, "notifications.jsonl");

export const NOTIFICATION_TYPES = ["routine.completed", "routine.failed", "approval.pending"];

function readAll() {
	if (!existsSync(NOTIFICATIONS_FILE)) return [];
	return readFileSync(NOTIFICATIONS_FILE, "utf8")
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

export function addNotification({ type, title, body = "", routineId = null, artifactId = null }) {
	if (!NOTIFICATION_TYPES.includes(type)) throw new Error(`未知通知类型: ${type}`);
	const entry = {
		id: `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		type,
		title: String(title ?? ""),
		body: String(body ?? ""),
		routineId,
		artifactId,
		read: false,
		createdAt: new Date().toISOString(),
	};
	ensureData();
	appendFileSync(NOTIFICATIONS_FILE, JSON.stringify(entry) + "\n", "utf8");
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
		writeFileSync(NOTIFICATIONS_FILE, all.map((n) => JSON.stringify(n)).join("\n") + (all.length ? "\n" : ""), "utf8");
	}
	return changed;
}
