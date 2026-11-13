// 工具权限策略（P2-2）：循环的 beforeToolCall 钩子按本引擎裁决。
// 默认规则是锁定的：读在界内 allow、界外 deny；写 ask、界外 deny；
// deny 永远优先——本引擎返回 deny 时没有任何钩子能再把它改成 allow。
// 界内与否在 decide 时先问 WorkspaceGuard；即便 decide 放行，工具
// execute() 仍会再过一次 Guard（策略与执行双闸，见 workspace-tools.ts）。
import { getBot } from "./store.ts";
import { WorkspaceGuard } from "./workspace-guard.ts";

export type PolicyDecision = "allow" | "deny" | "ask";

export interface PolicyRequest {
	botId: string;
	toolName: string;
	args?: Record<string, unknown> | null;
}

const WORKSPACE_READ_TOOLS = new Set(["workspace_list", "workspace_read"]);
const WORKSPACE_WRITE_TOOLS = new Set(["workspace_write", "workspace_edit"]);

export class PolicyEngine {
	static decide(request: PolicyRequest): PolicyDecision {
		const { botId, toolName } = request;
		const args = request.args ?? {};
		if (WORKSPACE_READ_TOOLS.has(toolName) || WORKSPACE_WRITE_TOOLS.has(toolName)) {
			// workspace_list 的 path 可缺省（缺省 "."）；其余文件工具 path 必填，
			// 缺失或非字符串意味着无法证明在界内，按 deny 处理。
			const rawPath = toolName === "workspace_list" && args.path === undefined ? "." : args.path;
			if (typeof rawPath !== "string" || rawPath.length === 0) return "deny";
			if (!WorkspaceGuard.resolve(botId, rawPath).ok) return "deny";
			return WORKSPACE_READ_TOOLS.has(toolName) ? "allow" : "ask";
		}
		switch (toolName) {
			case "web_fetch":
			case "web_search":
				return "allow";
			case "github.read":
				// 只读 GitHub 能力（尚未物化成工具，规则先行，P2-3 起用）
				return "allow";
			case "github_comment": {
				// 写评论必须人批（P2-3 起挂上循环，绑定校验在此补齐）：
				// 参数形状不全、种类不对、编号非正整数、正文为空 → deny；
				// 仓库不在该 bot 的 repos 绑定内 → deny，不进收件箱；
				// 其余 ask。bot 不存在同样 deny（无从证明绑定）。
				const repo = args.repo;
				const kind = args.kind;
				const number = args.number;
				const body = args.body;
				if (typeof repo !== "string" || repo.length === 0) return "deny";
				if (kind !== "pr_comment" && kind !== "issue_comment") return "deny";
				if (!Number.isInteger(number) || (number as number) <= 0) return "deny";
				if (typeof body !== "string" || body.trim().length === 0) return "deny";
				const bot = getBot(botId);
				if (!bot || !(bot.repos ?? []).includes(repo)) return "deny";
				return "ask";
			}
			default:
				// 未知工具一律 deny：不得默认放行，尤其是写类工具。
				return "deny";
		}
	}
}
