// 冻结夹具评测（P1-3）：把晨间扫描的两条拍板规则钉在入库夹具上回归。
// 用法（在 apps/piper 下）：npm run eval:scan（或 node scripts/eval-scan.mjs）
// 夹具在 test/fixtures/github/*.json，一文件一用例，格式：
//   { name, description, scans（默认 1）,
//     repos: { "Owner/Repo": { info, commits, issues, runs, pulls, reviews } 或 { "error": 500 } },
//     expect: { failures, findings: [{ repo, type, subject, evidenceUrl }], reportIncludes?: [..] } }
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
		else if (rest.startsWith("/pulls")) payload = entry.pulls ?? [];
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

const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json")).sort();
const caseResults = [];

try {
	const { runMorningScan } = await import("../lib/scan.mjs");
	const { listFindings } = await import("../lib/findings.mjs");

	for (const file of files) {
		const fx = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"));
		const scans = fx.scans ?? 1;
		process.env.PIPER_FINDINGS_FILE = join(tmp, `${fx.name}.jsonl`);
		installStub(fx.repos);
		const problems = [];
		let last = null;
		let createdTotal = 0;
		for (let i = 0; i < scans; i += 1) {
			last = await runMorningScan({ repos: Object.keys(fx.repos), botId: "repo-keeper", saveArtifact: saveArtifactStub });
			createdTotal += last.findings.length;
		}
		if (last.failures !== fx.expect.failures) problems.push(`failures 期望 ${fx.expect.failures} 实际 ${last.failures}`);
		const expected = sortFindings(fx.expect.findings);
		const opened = sortFindings(listFindings({ status: "open" }));
		if (JSON.stringify(opened) !== JSON.stringify(expected)) {
			problems.push(`open Finding 不一致：期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(opened)}`);
		}
		if (createdTotal !== fx.expect.findings.length) {
			problems.push(`累计新开 ${createdTotal} 条，期望 ${fx.expect.findings.length} 条（去重失效或重复开）`);
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
