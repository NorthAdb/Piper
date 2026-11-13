// 每 bot 文件工具（P2-2）：workspace_list / workspace_read / workspace_write /
// workspace_edit，参数形状按切片锁定。每个 execute() 开头先过
// WorkspaceGuard：越界返回 reason:"escape" 的错误结果，且不读、不写任何
// 字节；普通 IO 失败是 reason:"io"，参数形状不对是 reason:"args"，三者可区分。
// 本模块只提供工具实现，不负责挂载：产品对话何时能用上这四个工具由
// P2-5（工具注册表）决定；repo-keeper 默认不开放。
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { WorkspaceGuard } from "./workspace-guard.ts";

export const WORKSPACE_LIST_TOOL_NAME = "workspace_list";
export const WORKSPACE_READ_TOOL_NAME = "workspace_read";
export const WORKSPACE_WRITE_TOOL_NAME = "workspace_write";
export const WORKSPACE_EDIT_TOOL_NAME = "workspace_edit";

// read 的回喂上限 64 KiB（落点）：避免一个大文件把整轮上下文吃满。
const READ_MAX_BYTES = 64 * 1024;

function textResult(text: string, details: Record<string, unknown>): AgentToolResult<any> {
	return { content: [{ type: "text", text }], details };
}

function errorResult(reason: "escape" | "io" | "args", text: string): AgentToolResult<any> {
	return { content: [{ type: "text", text }], details: { isError: true, reason }, isError: true };
}

function escapeResult(): AgentToolResult<any> {
	return errorResult("escape", "路径越界：该路径不在本 bot 的工作区（或其额外允许根）内，已拒绝。");
}

function ioErrorResult(err: unknown): AgentToolResult<any> {
	return errorResult("io", `文件操作失败：${String((err as { message?: unknown } | null | undefined)?.message ?? err)}`);
}

export function workspaceToolsForBot(botId: string): AgentTool<any>[] {
	return [
		{
			name: WORKSPACE_LIST_TOOL_NAME,
			label: "列出工作区文件",
			description:
				"列出你自己工作区内某个目录的文件与子目录（相对路径，缺省为工作区根 \".\"）。只能看本 bot 的工作区，看不到其他 bot 的文件。",
			parameters: {
				type: "object",
				properties: { path: { type: "string", description: "相对工作区的目录路径，缺省 \".\"" } },
			},
			execute: async (_toolCallId, params) => {
				const resolved = WorkspaceGuard.resolve(botId, typeof params?.path === "string" ? params.path : ".");
				if (!resolved.ok) return escapeResult();
				try {
					const entries = readdirSync(resolved.path, { withFileTypes: true })
						.sort((a, b) => a.name.localeCompare(b.name))
						.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
					return textResult(entries.length ? entries.join("\n") : "（空目录）", { count: entries.length });
				} catch (err) {
					return ioErrorResult(err);
				}
			},
		},
		{
			name: WORKSPACE_READ_TOOL_NAME,
			label: "读取工作区文件",
			description:
				"读取你自己工作区内的一个文本文件（相对路径）。内容过长会截断。工作区外的路径会被拒绝。",
			parameters: {
				type: "object",
				properties: { path: { type: "string", description: "相对工作区的文件路径" } },
				required: ["path"],
			},
			execute: async (_toolCallId, params) => {
				if (typeof params?.path !== "string") return errorResult("args", "参数 path 必须是字符串。");
				const resolved = WorkspaceGuard.resolve(botId, params.path);
				if (!resolved.ok) return escapeResult();
				try {
					const buf = readFileSync(resolved.path);
					const truncated = buf.length > READ_MAX_BYTES;
					const text = buf.subarray(0, READ_MAX_BYTES).toString("utf8");
					return textResult(truncated ? `${text}\n\n[内容已截断：文件共 ${buf.length} 字节]` : text, {
						bytes: buf.length,
						truncated,
					});
				} catch (err) {
					return ioErrorResult(err);
				}
			},
		},
		{
			name: WORKSPACE_WRITE_TOOL_NAME,
			label: "写入工作区文件",
			description:
				"把文本内容写入你自己工作区内的文件（相对路径，父目录不存在时自动创建，已有文件整体覆盖）。工作区外的路径会被拒绝。写入需要人批准。",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "相对工作区的文件路径" },
					content: { type: "string", description: "要写入的完整文本内容" },
				},
				required: ["path", "content"],
			},
			execute: async (_toolCallId, params) => {
				if (typeof params?.path !== "string" || typeof params?.content !== "string") {
					return errorResult("args", "参数 path 与 content 都必须是字符串。");
				}
				const resolved = WorkspaceGuard.resolve(botId, params.path);
				if (!resolved.ok) return escapeResult();
				try {
					mkdirSync(dirname(resolved.path), { recursive: true });
					writeFileSync(resolved.path, params.content, "utf8");
					const bytes = Buffer.byteLength(params.content, "utf8");
					return textResult(`已写入 ${params.path}（${bytes} 字节）`, { bytes });
				} catch (err) {
					return ioErrorResult(err);
				}
			},
		},
		{
			name: WORKSPACE_EDIT_TOOL_NAME,
			label: "编辑工作区文件",
			description:
				"把你自己工作区内文件中唯一出现的一段文本替换为新文本（相对路径）。原文片段不存在或出现多次都会失败、不改文件。编辑需要人批准。",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "相对工作区的文件路径" },
					oldText: { type: "string", description: "要被替换的原文片段（必须在文件中恰好出现一次）" },
					newText: { type: "string", description: "替换后的新文本" },
				},
				required: ["path", "oldText", "newText"],
			},
			execute: async (_toolCallId, params) => {
				if (typeof params?.path !== "string" || typeof params?.oldText !== "string" || typeof params?.newText !== "string") {
					return errorResult("args", "参数 path、oldText、newText 都必须是字符串。");
				}
				const resolved = WorkspaceGuard.resolve(botId, params.path);
				if (!resolved.ok) return escapeResult();
				try {
					const original = readFileSync(resolved.path, "utf8");
					const first = original.indexOf(params.oldText);
					if (first < 0) return errorResult("io", "编辑失败：文件中未找到 oldText，文件未改动。");
					if (original.indexOf(params.oldText, first + 1) >= 0) {
						return errorResult("io", "编辑失败：oldText 在文件中出现多次，文件未改动。");
					}
					const next = original.slice(0, first) + params.newText + original.slice(first + params.oldText.length);
					writeFileSync(resolved.path, next, "utf8");
					return textResult(`已编辑 ${params.path}`, { bytes: Buffer.byteLength(next, "utf8") });
				} catch (err) {
					return ioErrorResult(err);
				}
			},
		},
	];
}
