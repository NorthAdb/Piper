// 晨间仓库扫描 routine：只读拉 GitHub 公开 REST API，生成 Markdown 日报存为产物。
// 数据源：api.github.com/repos/<owner>/<repo> 的 repo / commits / pulls / issues / actions runs。
// 令牌经 lib/settings.mjs 的 githubToken() 统一读取（L0-4：设置文件优先、环境变量兜底），
// 本文件不再直读环境变量；无令牌走公开限额。单仓失败不中断整体，失败原因写进日报。
import { githubToken } from "./settings.mjs";

async function gh(path) {
	const headers = { Accept: "application/vnd.github+json", "User-Agent": "piper-morning-scan" };
	const token = githubToken();
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(`https://api.github.com${path}`, { headers });
	if (!res.ok) throw new Error(`GitHub API ${res.status} ${path}`);
	return res.json();
}

function fmtDate(iso) {
	return iso ? String(iso).slice(0, 10) : "-";
}

async function scanRepo(repo) {
	const [info, commits, pulls, issues, runs] = await Promise.all([
		gh(`/repos/${repo}`),
		gh(`/repos/${repo}/commits?per_page=5`),
		gh(`/repos/${repo}/pulls?state=open&per_page=10`),
		gh(`/repos/${repo}/issues?state=open&per_page=10`),
		gh(`/repos/${repo}/actions/runs?per_page=5`).catch(() => ({ workflow_runs: [] })),
	]);
	const realIssues = (issues ?? []).filter((i) => !i.pull_request);
	const lines = [];
	lines.push(`## ${repo}`);
	lines.push("");
	lines.push(
		`- 概况：⭐ ${info.stargazers_count} · Fork ${info.forks_count} · 默认分支 ${info.default_branch} · 最近推送 ${fmtDate(info.pushed_at)}`,
	);
	lines.push(`- 待处理：PR ${pulls.length} 个 · Issue ${realIssues.length} 个`);
	lines.push("");
	lines.push("最近提交：");
	for (const c of commits.slice(0, 5)) {
		lines.push(`- ${fmtDate(c.commit?.author?.date)} ${String(c.commit?.message ?? "").split("\n")[0]}（${c.author?.login ?? c.commit?.author?.name ?? "?"}）`);
	}
	if (pulls.length) {
		lines.push("");
		lines.push("待处理 PR：");
		for (const p of pulls.slice(0, 5)) lines.push(`- #${p.number} ${p.title}（${p.user?.login ?? "?"}，${fmtDate(p.created_at)}）`);
	}
	if (realIssues.length) {
		lines.push("");
		lines.push("待处理 Issue：");
		for (const i of realIssues.slice(0, 5)) lines.push(`- #${i.number} ${i.title}（${i.user?.login ?? "?"}，${fmtDate(i.created_at)}）`);
	}
	const runList = runs.workflow_runs ?? [];
	if (runList.length) {
		lines.push("");
		lines.push("最近 CI：");
		for (const r of runList.slice(0, 5)) {
			lines.push(`- ${fmtDate(r.created_at)} ${r.name ?? r.display_title}：${r.status}${r.conclusion ? ` / ${r.conclusion}` : ""}`);
		}
	}
	lines.push("");
	return lines.join("\n");
}

// 返回 { artifact, report, failures, total }：report 为日报正文，artifact 为产物元数据；
// failures 是取证失败的仓库数（单仓失败不中断整体、原因写进日报），total 为仓库总数。
// 调用方据此判定整轮成败：全部仓库都失败时不应报成功（L0-5 起用于例程状态与失败通知）。
export async function runMorningScan({ repos, botId, saveArtifact }) {
	const now = new Date();
	const parts = [`# 晨间仓库日报 ${now.toISOString().slice(0, 10)}`, "", `扫描时间：${now.toISOString()} · 仓库数：${repos.length}`, ""];
	let failures = 0;
	for (const repo of repos) {
		try {
			parts.push(await scanRepo(repo));
		} catch (err) {
			failures += 1;
			parts.push(`## ${repo}\n\n- 扫描失败：${err.message}\n`);
		}
	}
	const body = parts.join("\n");
	const artifact = saveArtifact({ botId, kind: "morning-scan", title: `晨间仓库日报 ${now.toISOString().slice(0, 10)}`, body });
	return { artifact, report: body, failures, total: repos.length };
}
