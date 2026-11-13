// 对话写工具 github_comment（P2-3）：参数形状按切片 §1.1 锁定
// { repo, kind: pr_comment | issue_comment, number, body }。
// 注册面：只有 bot 的 tools 能力声明里含 "github_comment" 才注册（种子里
// 只有 repo-keeper 带，主 bot 默认不带，验收 7）。策略恒为 ask（PolicyEngine）：
// 循环先落盘 ToolApproval 并等人批，execute() 只会在 resolve allow 之后
// 被调用；它不自己请求 GitHub——写入只经 lib/gateway.ts 的
// gatewayExecuteWrite（toolApprovalId 入参），复检、幂等与审计都在网关里。
// 注意：本文件不得出现 GitHub 评论写端点的路径字面量——「除网关外无人
// 构造该端点」由 scripts/test-gateway.ts 的源码检索断言钉死。
import { gatewayExecuteWrite } from "./gateway.ts";
import { findToolApprovalByToolCall, toolIntentSnapshotOf } from "./tool-approvals.ts";
import type { Bot } from "./store.ts";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

export const GITHUB_COMMENT_TOOL_NAME = "github_comment";

function textResult(text: string, details: unknown): AgentToolResult<any> {
	return { content: [{ type: "text", text }], details };
}
function errorResult(text: string): AgentToolResult<any> {
	return { content: [{ type: "text", text }], details: { isError: true }, isError: true };
}

export function githubCommentToolsForBot(bot: Bot | null | undefined, sessionId: string): AgentTool<any>[] {
	if (!bot || !(bot.tools ?? []).includes(GITHUB_COMMENT_TOOL_NAME)) return [];
	const tool: AgentTool<any> = {
		name: GITHUB_COMMENT_TOOL_NAME,
		label: "发表 GitHub 评论（需用户批准）",
		description:
			"给绑定仓库的某个 PR 或 Issue 发表一条评论。这是写操作：调用后先进入待批，用户批准后才会真正发出；被驳回则不会发出。仓库必须是本 bot 已绑定的仓库。",
		parameters: {
			type: "object",
			properties: {
				repo: { type: "string", description: "owner/repo" },
				kind: { type: "string", enum: ["pr_comment", "issue_comment"], description: "评论目标类型" },
				number: { type: "integer", description: "PR 或 Issue 编号" },
				body: { type: "string", description: "评论文本" },
			},
			required: ["repo", "kind", "number", "body"],
		},
		execute: async (toolCallId, params) => {
			// 执行到这里说明循环已 resolve allow；待批记录就是批准的凭据与
			// 快照来源。找不到记录或记录不是已批准态，说明闸的顺序被绕过，
			// 直接失败，绝不凭模型参数自行拼装写入。
			const record = findToolApprovalByToolCall(sessionId, toolCallId);
			if (!record) return errorResult("未找到对应的工具待批记录，已取消发送。");
			if (record.status !== "approved") return errorResult(`工具待批状态为 ${record.status}，未获批准，已取消发送。`);
			const snapshot = toolIntentSnapshotOf(record);
			if (!snapshot) return errorResult("工具待批的参数快照不合法，已取消发送。");
			// 模型此刻给的参数若与批准快照不一致，以快照为准执行（网关还会
			// 再逐字比对一次，不一致 denied/intent_changed，见 gateway.ts）。
			void params;
			const out = await gatewayExecuteWrite({ toolApprovalId: record.id, snapshot });
			if (out.ok) {
				return textResult(
					out.reused ? `该评论此前已发送过（幂等复用），链接：${out.commentUrl ?? "（无）"}` : `评论已发表：${out.commentUrl ?? "（GitHub 未返回链接）"}`,
					{ commentUrl: out.commentUrl ?? null, reused: Boolean(out.reused), toolApprovalId: record.id },
				);
			}
			return errorResult(`评论未能发出（${out.result}${out.reason ? `: ${out.reason}` : ""}）。待批记录保持可重试状态，可请用户在收件箱再次批准。`);
		},
	};
	return [tool];
}
