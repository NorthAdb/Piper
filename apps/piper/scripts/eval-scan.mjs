// 冻结夹具评测（P1-3）：把晨间扫描的两条拍板规则钉在入库夹具上回归。
// 用法（在 apps/piper 下）：npm run eval:scan（或 node scripts/eval-scan.mjs）
// 夹具在 test/fixtures/github/*.json，一文件一用例，格式：
//   { name, description, scans（默认 1）, comment（可选，说明本用例覆盖边界，不参与断言）,
//     repos: { "Owner/Repo": { info, commits, issues, runs, pulls, reviews, pullDetails? } 或 { "error": 500 } },
//     expect: { failures, findings: [{ repo, type, subject, evidenceUrl }], reportIncludes?: [..] } }
// R5 起可加的字段（全部可选、只增不减）：
//   phases: [repos, repos, ...]——第 i 轮扫描用 phases[i]（超出取最后一个），模拟多轮之间
//     GitHub 状态变化（如 CI 转绿、PR 换了 head）；给了 phases 就忽略 repos。
//   seedFindings: [{ repo, type, subject, status, headSha?, workflow?, updatedAtDaysAgo?,
//     createdAtDaysAgo?, writeIntent? }]——扫描前预置的 Finding（如已 rejected / executed 的
//     历史项），时间按「几天前」相对评测运行时刻换算，evidenceUrl 按 type 从 repo+subject 推导。
//   pullDetails: { "<PR号>": {…PR 对象…} }——不在 open 列表里的 PR 的单查结果（已合并/关闭等），
//     供扫描前对账的 GET /pulls/:n 取用；open 列表里有的 PR 单查直接取列表项。
//   expect.created: 全部轮次累计新开条数（缺省 = expect.findings 条数，旧口径）。
//   expect.createdPerScan: [n, n, ...]——逐轮新开条数（冷却类用例靠它区分「哪一轮开的」）。
//   expect.expired: [{ repo, type, subject }]——结束时应恰好处于 expired 的 Finding 集合（对账退役）。
//   expect.statusFindings: [{ repo, type, subject, status }]——结束时应存在对应状态的 Finding（子集断言）。
// 每个用例用独立的临时 findings 文件跑（PIPER_FINDINGS_FILE），PIPER_DATA_DIR 一并
// 指向临时目录（R4：ensureData 种子不落真实 data/），fetch 全域替换为夹具替身：
// 夹具未映射的 URL 会被记录并以 599 失败，结尾断言为空——评测永不访问真实 api.github.com。
// 新增用例：往 test/fixtures/github/ 放一个符合上面格式的 JSON 即可，无需改本脚本。
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "github");
const realFetch = globalThis.fetch;
const tmp = mkdtempSync(join(tmpdir(), "piper-eval-"));
process.env.PIPER_DATA_DIR = join(tmp, "data");

let unmapped = [];
function installStub(repos) {
	unmapped = [];
	globalThis.fetch = async (url) => {
		const u = new URL(String(url));
		if (u.hostname !== "api.github.com") {
			unmapped.push(String(url));
			return { ok: false, status: 599, json: async () => ({}) };
		}
		const m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
		const entry = m ? repos[m[1]] : undefined;
		if (!entry) {
			unmapped.push(u.pathname);
			return { ok: false, status: 599, json: async () => ({}) };
		}
		if (entry.error) return { ok: false, status: entry.error, json: async () => ({}) };
		const rest = m[2] ?? "";
		let payload;
		if (rest === "") payload = entry.info;
		else if (rest.startsWith("/commits")) payload = entry.commits ?? [];
		else if (rest.match(/^\/pulls\/\d+\/reviews/)) payload = entry.reviews?.[rest.match(/^\/pulls\/(\d+)\/reviews/)[1]] ?? [];
		else if (rest.match(/^\/pulls\/\d+$/)) {
			// 单个 PR 查询（对账用）：先查 open 列表，再查 pullDetails，都没有回 404。
			const num = rest.match(/^\/pulls\/(\d+)$/)[1];
			const one = (entry.pulls ?? []).find((p) => String(p.number) === num) ?? entry.pullDetails?.[num];
			if (!one) return { ok: false, status: 404, json: async () => ({}) };
			payload = one;
		} else if (rest.startsWith("/pulls")) payload = entry.pulls ?? [];
		else if (rest.startsWith("/issues")) payload = entry.issues ?? [];
		else if (rest.startsWith("/actions/runs")) payload = { workflow_runs: entry.runs ?? [] };
		else {
			unmapped.push(u.pathname);
			return { ok: false, status: 599, json: async () => ({}) };
		}
		return { ok: true, status: 200, json: async () => payload };
	};
}

const saveArtifactStub = ({ title }) => ({ id: "eval-artifact", title });
const keyOf = (f) => `${f.repo}|${f.type}|${f.subject}`;
const sortFindings = (list) =>
	list.map((f) => ({ repo: f.repo, type: f.type, subject: f.subject, evidenceUrl: f.evidenceUrl })).sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
const sortKeys = (list) => list.map((f) => ({ repo: f.repo, type: f.type, subject: f.subject })).sort((a, b) => keyOf(a).localeCompare(keyOf(b)));

// 种子 Finding（R5）：模拟扫描开始前就存在的历史项（已驳回/已执行/已批准等）。
// 直接写 JSONL 行（绕过 createFinding 的「时间恒为现在」），字段形状与存储层一致。
function seedLines(fx) {
	const now = Date.now();
	return (fx.seedFindings ?? []).map((s, i) => {
		const updated = new Date(now - (s.updatedAtDaysAgo ?? 0) * 24 * 3600 * 1000).toISOString();
		const created = new Date(now - (s.createdAtDaysAgo ?? s.updatedAtDaysAgo ?? 0) * 24 * 3600 * 1000).toISOString();
		return JSON.stringify({
			id: `seed-${fx.name}-${i}`,
			repo: s.repo,
			type: s.type,
			subject: String(s.subject),
			title: `种子 Finding：${s.type} ${s.repo}#${s.subject}`,
			summary: "",
			evidenceUrl:
				s.type === "pr_needs_review" ? `https://github.com/${s.repo}/pull/${s.subject}` : `https://github.com/${s.repo}/actions/runs/${s.subject}`,
			suggestedAction: "",
			writeIntent: s.writeIntent ?? null,
			expiresAt: new Date(now + 30 * 24 * 3600 * 1000).toISOString(),
			status: s.status,
			botId: "repo-keeper",
			headSha: s.headSha ?? null,
			workflow: s.workflow ?? null,
			createdAt: created,
			updatedAt: updated,
		});
	});
}

const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json")).sort();
const caseResults = [];

try {
	const { runMorningScan } = await import("../lib/scan.mjs");
	const { listFindings } = await import("../lib/findings.mjs");
	const { writeFileSync } = await import("node:fs");

	for (const file of files) {
		const fx = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));
		const scans = fx.phases ? fx.phases.length : (fx.scans ?? 1);
		process.env.PIPER_FINDINGS_FILE = join(tmp, `${fx.name}.jsonl`);
		const seeds = seedLines(fx);
		if (seeds.length) writeFileSync(process.env.PIPER_FINDINGS_FILE, seeds.join("\n") + "\n", "utf8");
		const problems = [];
		let last = null;
		let createdTotal = 0;
		const createdPerScan = [];
		for (let i = 0; i < scans; i += 1) {
			const repos = fx.phases ? fx.phases[Math.min(i, fx.phases.length - 1)] : fx.repos;
			installStub(repos);
			last = await runMorningScan({ repos: Object.keys(repos), botId: "repo-keeper", saveArtifact: saveArtifactStub });
			createdTotal += last.findings.length;
			createdPerScan.push(last.findings.length);
		}
		if (fx.expect.createdPerScan && JSON.stringify(createdPerScan) !== JSON.stringify(fx.expect.createdPerScan)) {
			problems.push(`逐轮新开 ${JSON.stringify(createdPerScan)}，期望 ${JSON.stringify(fx.expect.createdPerScan)}（冷却在哪一轮生效对不上）`);
		}
		if (last.failures !== fx.expect.failures) problems.push(`failures 期望 ${fx.expect.failures} 实际 ${last.failures}`);
		const expected = sortFindings(fx.expect.findings);
		const opened = sortFindings(listFindings({ status: "open" }));
		if (JSON.stringify(opened) !== JSON.stringify(expected)) {
			problems.push(`open Finding 不一致：期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(opened)}`);
		}
		const expectedCreated = fx.expect.created ?? fx.expect.findings.length;
		if (createdTotal !== expectedCreated) {
			problems.push(`累计新开 ${createdTotal} 条，期望 ${expectedCreated} 条（去重失效或重复开）`);
		}
		if (fx.expect.expired) {
			const expired = sortKeys(listFindings({ status: "expired" }));
			if (JSON.stringify(expired) !== JSON.stringify(sortKeys(fx.expect.expired))) {
				problems.push(`expired Finding 不一致：期望 ${JSON.stringify(sortKeys(fx.expect.expired))} 实际 ${JSON.stringify(expired)}`);
			}
		}
		for (const s of fx.expect.statusFindings ?? []) {
			const hit = listFindings({ status: s.status }).some((f) => f.repo === s.repo && f.type === s.type && f.subject === String(s.subject));
			if (!hit) problems.push(`期望存在 ${s.status} 状态的 Finding ${s.repo}|${s.type}|${s.subject}，实际没有`);
		}
		for (const s of fx.expect.reportIncludes ?? []) {
			if (!last.report.includes(s)) problems.push(`日报未包含期望片段：${s}`);
		}
		if (unmapped.length) problems.push(`出现夹具未映射请求（疑似打活网或路径漂移）：${unmapped.join(", ")}`);
		caseResults.push({ name: fx.name, ok: problems.length === 0, problems });
		console.log(`${problems.length === 0 ? "PASS" : "FAIL"} ${fx.name}${problems.length ? ` — ${problems.join("；")}` : ""}`);
	}
} finally {
	globalThis.fetch = realFetch;
	delete process.env.PIPER_FINDINGS_FILE;
	delete process.env.PIPER_DATA_DIR;
	rmSync(tmp, { recursive: true, force: true });
}

const passed = caseResults.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${caseResults.length} 用例通过`);
if (passed !== caseResults.length) process.exit(1);
