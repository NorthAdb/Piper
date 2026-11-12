// 晨间扫描规则测试（P1-2）：用进程内 fetch 替身喂假 GitHub 响应，断言拍板清单两条规则、
// 去重与单仓失败不拖垮整轮。用法（在 apps/piper 下）：node dist/scripts/test-scan.js（或 npm run test:scan）
// 拍板切片二新增场景 G/G2/H：拍板详情取证与降级、即席开单（判定与扫描同口径、去重回既有项）。
// Finding 落盘用临时文件隔离（PIPER_FINDINGS_FILE），PIPER_DATA_DIR 一并指向临时目录
// （R4：ensureData 的种子文件也不落真实 data/），不访问网络。
// P1-3 的冻结夹具评测（scripts/eval-scan.ts）在这套断言口径上扩成入库夹具。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results: { seq: number; name: string; ok: boolean }[] = [];
let seq = 0;
function check(name: string, ok: boolean, detail = "") {
	seq += 1;
	results.push({ seq, name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${String(seq).padStart(2, "0")} ${name}${ok ? "" : ` — ${detail}`}`);
}

const tmp = mkdtempSync(join(tmpdir(), "piper-scan-"));
process.env.PIPER_DATA_DIR = join(tmp, "data");
const realFetch = globalThis.fetch;
const requested: string[] = [];

function infoFor(name: string) {
	return { stargazers_count: 3, forks_count: 1, default_branch: "main", pushed_at: "2026-11-10T00:00:00Z" };
}

// scenario: { "Owner/Repo": { runs, pulls, reviews, commits?, issues? } | { error } }
// 场景数据是 GitHub 响应的本地替身（外部数据形状）：只声明替身真正读的字段，其余透传。
interface ScenarioRepo {
	error?: number;
	commits?: unknown[];
	issues?: unknown[];
	runs?: unknown[];
	runsError?: number;
	pulls?: { number?: number | string; [k: string]: unknown }[];
	reviews?: Record<string, { error?: number } | unknown[]>;
	pullDetails?: Record<string, unknown>;
	prFiles?: Record<string, { error?: number } | unknown[]>;
}
function installStub(scenario: Record<string, ScenarioRepo>) {
	requested.length = 0;
	// 替身只实现扫描实际用到的 ok/status/json 三个面，不是完整 Response，故 cast 到 typeof fetch。
	globalThis.fetch = (async (url: unknown) => {
		const u = new URL(String(url));
		requested.push(u.pathname);
		const m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
		const entry = m ? scenario[m[1]] : undefined;
		if (!m || !entry) return { ok: false, status: 599, json: async () => ({}) };
		if (entry.error) return { ok: false, status: entry.error, json: async () => ({}) };
		const rest = m[2] ?? "";
		// 分页（R6）：按请求的 page/per_page 切片，与真实 GitHub 及 eval 替身一致。
		const page = Number(u.searchParams.get("page") ?? 1);
		const perPage = Number(u.searchParams.get("per_page") ?? 30);
		const pageOf = (arr: unknown[] | undefined) => (arr ?? []).slice((page - 1) * perPage, page * perPage);
		let payload: unknown;
		if (rest === "") payload = infoFor(m[1]);
		else if (rest.startsWith("/commits")) payload = pageOf(entry.commits);
		else if (rest.match(/^\/pulls\/\d+\/reviews/)) {
			const rv = entry.reviews?.[rest.match(/^\/pulls\/(\d+)\/reviews/)?.[1] ?? ""] ?? [];
			if (!Array.isArray(rv) && rv?.error) return { ok: false, status: rv.error, json: async () => ({}) };
			payload = pageOf(Array.isArray(rv) ? rv : []);
		} else if (rest.match(/^\/pulls\/\d+$/)) {
			const num = rest.match(/^\/pulls\/(\d+)$/)?.[1] ?? "";
			const one = (entry.pulls ?? []).find((p) => String(p.number) === num) ?? entry.pullDetails?.[num];
			if (!one) return { ok: false, status: 404, json: async () => ({}) };
			payload = one;
		} else if (rest.match(/^\/pulls\/\d+\/files/)) {
			const num = rest.match(/^\/pulls\/(\d+)\/files/)?.[1] ?? "";
			const fl = entry.prFiles?.[num] ?? [];
			if (!Array.isArray(fl) && fl?.error) return { ok: false, status: fl.error, json: async () => ({}) };
			payload = pageOf(Array.isArray(fl) ? fl : []);
		} else if (rest.startsWith("/pulls")) payload = pageOf(entry.pulls);
		else if (rest.startsWith("/issues")) payload = pageOf(entry.issues);
		else if (rest.startsWith("/actions/runs")) {
			if (entry.runsError) return { ok: false, status: entry.runsError, json: async () => ({}) };
			payload = { workflow_runs: pageOf(entry.runs) };
		}
		else return { ok: false, status: 599, json: async () => ({}) };
		return { ok: true, status: 200, json: async () => payload };
	}) as typeof fetch;
}

// 返回形状对齐 lib 的 ArtifactMeta（扫描只透传，本测试不断言其内容）。
const saveArtifactStub = ({ title }: { title?: unknown }) => ({
	id: "stub-artifact",
	botId: "repo-keeper",
	kind: "morning-scan",
	title: String(title ?? ""),
	createdAt: null,
});

try {
	const { createAdHocReviewFinding, runMorningScan } = await import("../lib/scan.ts");
	const findingsMod = await import("../lib/findings.ts");

	// ---- 场景 A：失败 CI（中间夹一条进行中与一条别分支失败）+ 待审 PR + draft PR ----
	process.env.PIPER_FINDINGS_FILE = join(tmp, "a.jsonl");
	installStub({
		"Acme/Widgets": {
			runs: [
				{ id: 9003, name: "CI", status: "in_progress", conclusion: null, head_branch: "main", html_url: "https://github.com/Acme/Widgets/actions/runs/9003", created_at: "2026-11-10T01:00:00Z" },
				{ id: 9001, name: "CI", status: "completed", conclusion: "failure", head_branch: "main", html_url: "https://github.com/Acme/Widgets/actions/runs/9001", created_at: "2026-11-09T23:00:00Z" },
				{ id: 9000, name: "CI", status: "completed", conclusion: "success", head_branch: "main", html_url: "https://github.com/Acme/Widgets/actions/runs/9000", created_at: "2026-11-09T20:00:00Z" },
				{ id: 8999, name: "CI", status: "completed", conclusion: "failure", head_branch: "feature-x", html_url: "https://github.com/Acme/Widgets/actions/runs/8999", created_at: "2026-11-09T19:00:00Z" },
			],
			pulls: [
				{ number: 7, title: "Fix login", draft: false, html_url: "https://github.com/Acme/Widgets/pull/7", user: { login: "alice" }, created_at: "2026-11-09T00:00:00Z" },
				{ number: 8, title: "WIP refactor", draft: true, html_url: "https://github.com/Acme/Widgets/pull/8", user: { login: "bob" }, created_at: "2026-11-09T00:00:00Z" },
			],
			reviews: { "7": [{ state: "COMMENTED" }] },
			commits: [{ commit: { message: "fix: x", author: { date: "2026-11-10T00:00:00Z", name: "dev" } }, author: { login: "dev" } }],
			issues: [],
		},
	});
	const runA1 = await runMorningScan({ repos: ["Acme/Widgets"], botId: "repo-keeper", saveArtifact: saveArtifactStub });
	const ci = runA1.findings.find((f) => f.type === "ci_failed");
	const pr = runA1.findings.find((f) => f.type === "pr_needs_review");
	check(
		"场景A：最近已结束 run 为 failure 时开 ci_failed，subject/evidenceUrl 指向该 run（跳过进行中与别分支）",
		ci !== undefined && ci.subject === "9001" && ci.evidenceUrl === "https://github.com/Acme/Widgets/actions/runs/9001" && ci.status === "open",
		JSON.stringify(runA1.findings.map((f) => `${f.type}:${f.subject}`)),
	);
	check(
		"场景A：open 非 draft 且无 APPROVED 审查的 PR 开 pr_needs_review，draft PR 不开且不查其审查",
		pr !== undefined && pr.subject === "7" && pr.evidenceUrl === "https://github.com/Acme/Widgets/pull/7" && !requested.some((p) => p.includes("/pulls/8/reviews")),
		JSON.stringify(runA1.findings.map((f) => `${f.type}:${f.subject}`)),
	);
	check(
		"场景A：日报先拍板清单（含两条证据链接）后其余观察（含 star 统计），顺序正确",
		runA1.report.includes("## 拍板清单") &&
			runA1.report.includes("## 其余观察") &&
			runA1.report.indexOf("## 拍板清单") < runA1.report.indexOf("## 其余观察") &&
			runA1.report.includes("https://github.com/Acme/Widgets/actions/runs/9001") &&
			runA1.report.includes("⭐ 3"),
		"",
	);
	const runA2 = await runMorningScan({ repos: ["Acme/Widgets"], botId: "repo-keeper", saveArtifact: saveArtifactStub });
	const openAfter = findingsMod.listFindings({ status: "open" });
	check(
		"场景A：连续扫两次不重复开 open Finding（本轮新开 0 条，open 总数仍 2）",
		runA2.findings.length === 0 && openAfter.length === 2,
		`第二轮新开=${runA2.findings.length} open=${openAfter.length}`,
	);

	// ---- 场景 B：一仓 API 500 + 一仓安静（成功 CI、已批准 PR） ----
	process.env.PIPER_FINDINGS_FILE = join(tmp, "b.jsonl");
	installStub({
		"Acme/Broken": { error: 500 },
		"Acme/Quiet": {
			runs: [{ id: 7001, name: "CI", status: "completed", conclusion: "success", head_branch: "main", html_url: "https://github.com/Acme/Quiet/actions/runs/7001", created_at: "2026-11-09T23:00:00Z" }],
			pulls: [{ number: 9, title: "Docs", draft: false, html_url: "https://github.com/Acme/Quiet/pull/9", user: { login: "carol" }, created_at: "2026-11-09T00:00:00Z" }],
			reviews: { "9": [{ state: "APPROVED" }] },
			commits: [],
			issues: [],
		},
	});
	const runB = await runMorningScan({ repos: ["Acme/Broken", "Acme/Quiet"], botId: "repo-keeper", saveArtifact: saveArtifactStub });
	check(
		"场景B：单仓 API 失败计 failures=1 并写进日报，其他仓继续；安静仓（成功 CI + 已批准 PR）不开 Finding",
		runB.failures === 1 && runB.total === 2 && runB.findings.length === 0 && runB.report.includes("扫描失败") && runB.report.includes("Acme/Quiet") && runB.report.includes("本轮没有需要拍板的事项。"),
		`failures=${runB.failures} findings=${runB.findings.length}`,
	);

	// ---- 场景 C（R5，审计探针 P5 的镜像）：驳回后冷却——头部未变连扫不再重开，
	//      头部变化才重开。旧实现每轮新开 1 条（累计多条、待批列表堆积）。 ----
	process.env.PIPER_FINDINGS_FILE = join(tmp, "c.jsonl");
	const scenarioC = (headSha: string) => ({
		"Acme/Probe": {
			runs: [{ id: 6001, name: "CI", status: "completed", conclusion: "success", head_branch: "main", head_sha: headSha, html_url: "https://github.com/Acme/Probe/actions/runs/6001", created_at: "2026-11-10T01:00:00Z" }],
			pulls: [
				{ number: 42, title: "Probe PR", draft: false, head: { sha: headSha }, html_url: "https://github.com/Acme/Probe/pull/42", user: { login: "alice" }, created_at: "2026-11-09T00:00:00Z" },
			],
			reviews: { "42": [] },
			commits: [],
			issues: [],
		},
	});
	installStub(scenarioC("aaa111"));
	const runC1 = await runMorningScan({ repos: ["Acme/Probe"], botId: "repo-keeper", saveArtifact: saveArtifactStub });
	const firstC = runC1.findings.find((f) => f.type === "pr_needs_review");
	if (firstC) findingsMod.updateFinding(firstC.id, { status: "rejected" });
	let reopened = 0;
	for (let i = 0; i < 3; i += 1) {
		const r = await runMorningScan({ repos: ["Acme/Probe"], botId: "repo-keeper", saveArtifact: saveArtifactStub });
		reopened += r.findings.length;
	}
	const allC = findingsMod.listFindings({ repo: "Acme/Probe" });
	check(
		"场景C：驳回后头部未变，连扫三轮每轮新开 0 条（P5 旧现象为每轮 +1），该 subject 总共只有 1 条且为 rejected",
		Boolean(firstC) && reopened === 0 && allC.length === 1 && allC[0].status === "rejected",
		`首轮=${runC1.findings.length} 后三轮累计新开=${reopened} 总条数=${allC.length}`,
	);
	installStub(scenarioC("bbb222"));
	const runC5 = await runMorningScan({ repos: ["Acme/Probe"], botId: "repo-keeper", saveArtifact: saveArtifactStub });
	check(
		"场景C：头部提交变化后可重开一条新的 open Finding（冷却按 head 解除）",
		runC5.findings.length === 1 && runC5.findings[0].status === "open" && findingsMod.listFindings({ repo: "Acme/Probe", status: "open" }).length === 1,
		`新开=${runC5.findings.length}`,
	);

	// ---- 场景 D（R6）：按工作流分别取最新——test 最新成功不遮蔽 lint 最新失败；
	//      e2e 最新为 cancelled 不报、也不回溯它更早的 failure。 ----
	process.env.PIPER_FINDINGS_FILE = join(tmp, "d.jsonl");
	const mkRun = (id: number, name: string, conclusion: string, ts: string) => ({
		id, name, status: "completed", conclusion, head_branch: "main",
		html_url: `https://github.com/Acme/Multi/actions/runs/${id}`, created_at: ts,
	});
	installStub({
		"Acme/Multi": {
			runs: [
				mkRun(5005, "test", "success", "2026-11-10T03:00:00Z"),
				mkRun(5004, "lint", "failure", "2026-11-10T02:00:00Z"),
				mkRun(5003, "e2e", "cancelled", "2026-11-10T01:30:00Z"),
				mkRun(5002, "e2e", "failure", "2026-11-10T01:00:00Z"),
				mkRun(5001, "lint", "success", "2026-11-09T23:00:00Z"),
			],
			pulls: [],
			reviews: {},
			commits: [],
			issues: [],
		},
	});
	const runD = await runMorningScan({ repos: ["Acme/Multi"], botId: "repo-keeper", saveArtifact: saveArtifactStub });
	check(
		"场景D：多工作流分别判定——只开 lint 的 ci_failed（test 成功不遮蔽、e2e 取消不报不回溯）",
		runD.findings.length === 1 && runD.findings[0].type === "ci_failed" && runD.findings[0].subject === "5004" && runD.findings[0].workflow === "lint",
		JSON.stringify(runD.findings.map((f) => `${f.type}:${f.subject}`)),
	);

	// ---- 场景 E（R6）：半成品不落盘——CI 已取到 failure，但 reviews 接口 500，
	//      整仓失败且一条 Finding 都不得落盘（旧实现会先落 ci_failed）。 ----
	process.env.PIPER_FINDINGS_FILE = join(tmp, "e.jsonl");
	installStub({
		"Acme/Half": {
			runs: [mkRun(6001, "CI", "failure", "2026-11-10T01:00:00Z")],
			pulls: [{ number: 42, title: "Risky", draft: false, head: { sha: "abc123" }, html_url: "https://github.com/Acme/Half/pull/42", user: { login: "alice" }, created_at: "2026-11-09T00:00:00Z" }],
			reviews: { "42": { error: 500 } },
			commits: [],
			issues: [],
		},
	});
	const runE = await runMorningScan({ repos: ["Acme/Half"], botId: "repo-keeper", saveArtifact: saveArtifactStub });
	check(
		"场景E：取证中途失败整仓不落盘（failures=1，存储里 0 条 Finding）",
		runE.failures === 1 && runE.findings.length === 0 && findingsMod.listFindings({ repo: "Acme/Half" }).length === 0,
		`failures=${runE.failures} 落盘=${findingsMod.listFindings({ repo: "Acme/Half" }).length}`,
	);

	// ---- 场景 F（R6）：分页上限——205 条待审 PR 只检查前 200 条，日报写明截断。 ----
	process.env.PIPER_FINDINGS_FILE = join(tmp, "f.jsonl");
	const manyPulls = Array.from({ length: 205 }, (_, i) => ({
		number: i + 1, title: `PR ${i + 1}`, draft: false, head: { sha: `sha${i}` },
		html_url: `https://github.com/Acme/Many/pull/${i + 1}`, user: { login: "alice" }, created_at: "2026-11-09T00:00:00Z",
	}));
	installStub({
		"Acme/Many": {
			runs: [mkRun(7001, "CI", "success", "2026-11-10T01:00:00Z")],
			pulls: manyPulls,
			reviews: {},
			commits: [],
			issues: [],
		},
	});
	const runF = await runMorningScan({ repos: ["Acme/Many"], botId: "repo-keeper", saveArtifact: saveArtifactStub });
	check(
		"场景F：PR 超过检查上限时翻页取到 200 条并在日报写明「仅检查前 200 条」",
		runF.findings.length === 200 && runF.report.includes("仅检查前 200 条"),
		`新开=${runF.findings.length} 日报含提示=${runF.report.includes("仅检查前 200 条")}`,
	);

	// ---- 场景 G（拍板切片二）：新开 pr_needs_review 带拍板详情——描述摘录、分支、
	//      改动规模、文件清单、每位审查人最新表态（含陈旧批准标记）。 ----
	process.env.PIPER_FINDINGS_FILE = join(tmp, "g.jsonl");
	installStub({
		"Acme/Detail": {
			runs: [],
			pulls: [
				{
					number: 5, title: "Rework exporter", draft: false, state: "open",
					head: { sha: "h123", ref: "feat-export" }, base: { ref: "main" },
					body: "导出器重写：换流式写出，附回滚开关。", changed_files: 3, additions: 120, deletions: 30,
					html_url: "https://github.com/Acme/Detail/pull/5", user: { login: "alice" }, created_at: "2026-11-09T00:00:00Z",
				},
			],
			reviews: {
				"5": [
					{ state: "APPROVED", user: { login: "amy" }, commit_id: "old999" },
					{ state: "CHANGES_REQUESTED", user: { login: "bob" }, commit_id: "h123" },
				],
			},
			prFiles: {
				"5": [
					{ filename: "src/export.ts", additions: 100, deletions: 10 },
					{ filename: "src/export.test.ts", additions: 20, deletions: 20 },
				],
			},
			commits: [],
			issues: [],
		},
	});
	const runG = await runMorningScan({ repos: ["Acme/Detail"], botId: "repo-keeper", saveArtifact: saveArtifactStub });
	const g = runG.findings.find((f) => f.type === "pr_needs_review");
	check(
		"场景G：拍板详情齐全（描述/分支/改动规模/文件清单）",
		g?.detail != null &&
			g.detail.bodyExcerpt.includes("导出器重写") &&
			g.detail.headRef === "feat-export" &&
			g.detail.baseRef === "main" &&
			g.detail.changedFiles === 3 &&
			g.detail.additions === 120 &&
			g.detail.deletions === 30 &&
			g.detail.files.length === 2 &&
			g.detail.files[0].filename === "src/export.ts",
		JSON.stringify(g?.detail ?? null),
	);
	check(
		"场景G：审查态势按每人最新表态（amy 的批准对旧提交标 stale、bob 要求修改）",
		g?.detail != null &&
			g.detail.reviewers.length === 2 &&
			g.detail.reviewers.find((r) => r.login === "amy")?.state === "APPROVED" &&
			g.detail.reviewers.find((r) => r.login === "amy")?.stale === true &&
			g.detail.reviewers.find((r) => r.login === "bob")?.state === "CHANGES_REQUESTED",
		JSON.stringify(g?.detail?.reviewers ?? null),
	);

	// ---- 场景 G2：详情取证失败（files 接口 500）不连坐开单——事项照常开、
	//      detail 为 null、日报注明详情缺失。 ----
	process.env.PIPER_FINDINGS_FILE = join(tmp, "g2.jsonl");
	installStub({
		"Acme/NoDetail": {
			runs: [],
			pulls: [
				{ number: 6, title: "Plain", draft: false, state: "open", head: { sha: "h6", ref: "f6" }, base: { ref: "main" }, html_url: "https://github.com/Acme/NoDetail/pull/6", user: { login: "alice" }, created_at: "2026-11-09T00:00:00Z" },
			],
			reviews: { "6": [] },
			prFiles: { "6": { error: 500 } },
			commits: [],
			issues: [],
		},
	});
	const runG2 = await runMorningScan({ repos: ["Acme/NoDetail"], botId: "repo-keeper", saveArtifact: saveArtifactStub });
	const g2 = runG2.findings.find((f) => f.type === "pr_needs_review");
	check(
		"场景G2：详情取证失败时事项照常开出、detail 为 null、日报注明「拍板详情取证失败」",
		g2 !== undefined && g2.detail === null && runG2.failures === 0 && runG2.report.includes("拍板详情取证失败"),
		`detail=${JSON.stringify(g2?.detail)} failures=${runG2.failures}`,
	);

	// ---- 场景 H（拍板切片二）：即席开单——指定 PR 即时开单（带详情与即席模板）、
	//      重复指定返回既有项、已批准/已合并回 refusal。 ----
	process.env.PIPER_FINDINGS_FILE = join(tmp, "h.jsonl");
	installStub({
		"Acme/Adhoc": {
			runs: [],
			pulls: [
				{ number: 11, title: "Ad hoc PR", draft: false, state: "open", head: { sha: "hh1", ref: "f11" }, base: { ref: "main" }, body: "即席说明", changed_files: 1, additions: 5, deletions: 1, html_url: "https://github.com/Acme/Adhoc/pull/11", user: { login: "alice" }, created_at: "2026-11-09T00:00:00Z" },
				{ number: 12, title: "Approved PR", draft: false, state: "open", head: { sha: "hh2", ref: "f12" }, base: { ref: "main" }, html_url: "https://github.com/Acme/Adhoc/pull/12", user: { login: "alice" }, created_at: "2026-11-09T00:00:00Z" },
				{ number: 13, title: "Merged PR", draft: false, state: "closed", merged_at: "2026-11-10T00:00:00Z", head: { sha: "hh3", ref: "f13" }, base: { ref: "main" }, html_url: "https://github.com/Acme/Adhoc/pull/13", user: { login: "alice" }, created_at: "2026-11-09T00:00:00Z" },
			],
			reviews: { "11": [], "12": [{ state: "APPROVED", user: { login: "amy" }, commit_id: "hh2" }], "13": [] },
			prFiles: { "11": [{ filename: "a.ts", additions: 5, deletions: 1 }] },
			commits: [],
			issues: [],
		},
	});
	const h1 = await createAdHocReviewFinding({ repo: "Acme/Adhoc", prNumber: 11, botId: "repo-keeper" });
	check(
		"场景H：即席开单成功——带详情、写意图正文为即席模板",
		h1.created !== null &&
			h1.created.detail?.changedFiles === 1 &&
			(h1.created.writeIntent?.body ?? "").includes("即席请求") &&
			h1.created.status === "open",
		JSON.stringify(h1.created?.id ?? h1),
	);
	const h2 = await createAdHocReviewFinding({ repo: "Acme/Adhoc", prNumber: 11, botId: "repo-keeper" });
	check(
		"场景H：重复指定同一 PR 返回既有事项、不另开一条",
		h2.created === null && h2.existing?.id === h1.created?.id && findingsMod.listFindings({ repo: "Acme/Adhoc" }).length === 1,
		`existing=${h2.existing?.id}`,
	);
	const h3 = await createAdHocReviewFinding({ repo: "Acme/Adhoc", prNumber: 12, botId: "repo-keeper" });
	const h4 = await createAdHocReviewFinding({ repo: "Acme/Adhoc", prNumber: 13, botId: "repo-keeper" });
	check(
		"场景H：已批准 PR 回 refusal=pr_approved、已合并 PR 回 refusal=pr_merged，均不开单",
		h3.created === null && h3.refusal === "pr_approved" && h4.created === null && h4.refusal === "pr_merged",
		`h3=${h3.refusal} h4=${h4.refusal}`,
	);
} finally {
	globalThis.fetch = realFetch;
	delete process.env.PIPER_FINDINGS_FILE;
	rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
