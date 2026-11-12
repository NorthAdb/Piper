// GitHub 令牌自检（拍板切片三）：P1-7 试用里用户对着一个 403 盲排了近十分钟——
// 设置里只存令牌、从不验证它到底是谁、够不够得着绑定的仓库、有没有写权限。
// 本模块提供一次只读自检：GET /user 验令牌与身份，逐个绑定仓库 GET /repos/:repo
// 对账可达性与有效写权限（仓库响应里的 permissions.push 是 GitHub 按当前凭据
// 算出的有效权限）。全部只读，不写任何接口；结果只含登录名与布尔结论，
// 绝不回显令牌本身。API 基址与扫描/网关同一环境变量口径（R4 桩可测）。
import { githubToken } from "./settings.ts";
import { redact } from "./redact.ts";

export type TokenKind = "fine-grained" | "classic" | "oauth" | "installation" | "unknown";

// 令牌种类只按前缀粗分（用于给用户对的权限指引：fine-grained 在仓库级授权，
// classic 在 scope 级）。前缀之外不猜——种类未知就只报事实、不给错指引。
export function tokenKindOf(token: string): TokenKind {
	if (token.startsWith("github_pat_")) return "fine-grained";
	if (token.startsWith("ghp_")) return "classic";
	if (token.startsWith("gho_")) return "oauth";
	if (token.startsWith("ghs_") || token.startsWith("ghu_")) return "installation";
	return "unknown";
}

export interface RepoAccess {
	repo: string;
	reachable: boolean;
	status: number | null;
	canPush: boolean | null;
}

export interface GithubSelfCheck {
	configured: boolean;
	login: string | null;
	tokenKind: TokenKind | null;
	repos: RepoAccess[];
	error: string | null;
}

function ghBase(): string {
	return (process.env.PIPER_GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, "");
}

// 自检专用的只读 GET：失败不抛、回 { status }，由调用方逐项判读——自检的职责
// 是把每一项的真实结果摆出来，一处失败不该遮住其余项。
async function ghGet(path: string, token: string): Promise<{ status: number; json: any }> {
	const res = await fetch(`${ghBase()}${path}`, {
		headers: { Accept: "application/vnd.github+json", "User-Agent": "piper-token-check", Authorization: `Bearer ${token}` },
	});
	let json: any = null;
	try {
		json = await res.json();
	} catch {
		json = null;
	}
	return { status: res.status, json };
}

export async function checkGithubToken(repos: string[]): Promise<GithubSelfCheck> {
	const token = githubToken();
	if (!token) return { configured: false, login: null, tokenKind: null, repos: [], error: null };
	const tokenKind = tokenKindOf(token);
	try {
		const me = await ghGet("/user", token);
		if (me.status === 401) {
			return { configured: true, login: null, tokenKind, repos: [], error: "令牌无效（GitHub 回 401）：可能已过期、被吊销或粘贴有误，请重新申请后在设置里覆盖保存。" };
		}
		if (me.status < 200 || me.status >= 300) {
			return { configured: true, login: null, tokenKind, repos: [], error: `GitHub 身份查询失败（${me.status}），暂时无法完成自检。` };
		}
		const login = typeof me.json?.login === "string" ? me.json.login : null;
		const access: RepoAccess[] = [];
		for (const repo of repos) {
			try {
				const r = await ghGet(`/repos/${repo}`, token);
				if (r.status >= 200 && r.status < 300) {
					const push = r.json?.permissions?.push;
					access.push({ repo, reachable: true, status: r.status, canPush: typeof push === "boolean" ? push : null });
				} else {
					access.push({ repo, reachable: false, status: r.status, canPush: null });
				}
			} catch {
				access.push({ repo, reachable: false, status: null, canPush: null });
			}
		}
		return { configured: true, login, tokenKind, repos: access, error: null };
	} catch (err) {
		return { configured: true, login: null, tokenKind, repos: [], error: redact(`自检请求失败：${err instanceof Error ? err.message : String(err)}`) };
	}
}
