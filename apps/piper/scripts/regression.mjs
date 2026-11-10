// Piper API 回归脚本（硬门禁）：把历次实测的断言固化成可重复运行的检查。
// 用法（在 apps/piper 下）：
//   node scripts/regression.mjs        （或 npm run regression）
// 行为：以「无模型 Key」的默认环境在本机测试端口启动一份 server.mjs，逐项断言后退出。
// 退出码 0 = 全部通过；1 = 有失败。
// R4 测试隔离（本脚本的立身之本，改动前先想清楚）：
//   - 数据目录经 PIPER_DATA_DIR 指向临时目录：子进程 server 与本进程内 import 的 lib
//     共用同一隔离目录，用户真实 data/ 一个字节都不碰、也不读——机器上有没有真实
//     配置，本套件结果都一样（R4 前「文件存在就 SKIP」的保护逻辑已删除，原被跳过的
//     27-30、36-39 在隔离目录里恒为真断言）。
//   - GitHub 经 PIPER_GITHUB_API_BASE 指向脚本内起的本地桩（下方 STUB_REPOS），
//     全程离线、结果确定；打真实 GitHub 的几项已拆到 scripts/regression-live.mjs
//     （npm run regression:live，非门禁）。
//   - 收到 SIGINT/SIGTERM 时先杀子进程、关桩、删临时目录再退出，不留孤儿与残留。
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.REGRESSION_PORT || 4398);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "piper-dev";

// ---- 隔离目录：必须在任何 lib import 与子进程启动之前建好并写入环境 ----
const TMP_ROOT = mkdtempSync(join(tmpdir(), "piper-regression-"));
const TMP_DATA = join(TMP_ROOT, "data");
process.env.PIPER_DATA_DIR = TMP_DATA;

// ---- 本地 GitHub 桩：路径映射与 test-scan 替身同口径；未映射仓库回 404 ----
// 通知组「绑不存在的仓库整轮失败」就靠这个 404。桩数据保持安静：最新已结束 run
// 为 success、无 open PR（不开 Finding），日报结构（两节标题）仍可断言。
function stubRepo(ownerRepo) {
	return {
		info: { stargazers_count: 7, forks_count: 2, default_branch: "main", pushed_at: "2026-11-10T00:00:00Z" },
		commits: [
			{ commit: { message: "chore: stub commit", author: { date: "2026-11-10T00:00:00Z", name: "stub" } }, author: { login: "stub" } },
		],
		pulls: [],
		issues: [],
		runs: [
			{
				id: 1001,
				name: "CI",
				status: "completed",
				conclusion: "success",
				head_branch: "main",
				html_url: `https://github.com/${ownerRepo}/actions/runs/1001`,
				created_at: "2026-11-10T00:00:00Z",
			},
		],
		reviews: {},
	};
}
const STUB_REPOS = { "NorthAdb/LinkForge": stubRepo("NorthAdb/LinkForge"), "NorthAdb/Loom": stubRepo("NorthAdb/Loom") };
const ghStub = createServer((reqHttp, resHttp) => {
	const u = new URL(reqHttp.url ?? "/", "http://stub.invalid");
	const m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
	const entry = m ? STUB_REPOS[m[1]] : undefined;
	resHttp.setHeader("Content-Type", "application/json");
	if (!entry) {
		resHttp.statusCode = 404;
		resHttp.end(JSON.stringify({ message: "Not Found" }));
		return;
	}
	const rest = m[2] ?? "";
	let payload;
	if (rest === "") payload = entry.info;
	else if (rest.startsWith("/commits")) payload = entry.commits;
	else if (rest.match(/^\/pulls\/\d+\/reviews/)) payload = entry.reviews[rest.match(/^\/pulls\/(\d+)\/reviews/)[1]] ?? [];
	else if (rest.startsWith("/pulls")) payload = entry.pulls;
	else if (rest.startsWith("/issues")) payload = entry.issues;
	else if (rest.startsWith("/actions/runs")) payload = { workflow_runs: entry.runs };
	else {
		resHttp.statusCode = 404;
		resHttp.end(JSON.stringify({ message: "Not Found" }));
		return;
	}
	resHttp.end(JSON.stringify(payload));
});
await new Promise((resolveListen) => ghStub.listen(0, "127.0.0.1", resolveListen));
const GH_BASE = `http://127.0.0.1:${ghStub.address().port}`;
process.env.PIPER_GITHUB_API_BASE = GH_BASE;

// ---- 信号处理：杀子进程、关桩、清临时目录，不留孤儿 server 与残留 ----
let serverProc = null;
let cleanedUp = false;
function cleanup() {
	if (cleanedUp) return;
	cleanedUp = true;
	try {
		serverProc?.kill("SIGTERM");
	} catch {
		/* 已退出 */
	}
	try {
		ghStub.close();
	} catch {
		/* 已关闭 */
	}
	rmSync(TMP_ROOT, { recursive: true, force: true });
}
for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		cleanup();
		process.exit(sig === "SIGINT" ? 130 : 143);
	});
}

const results = [];
let seq = 0;
function check(name, ok, detail = "") {
	seq += 1;
	results.push({ seq, name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${String(seq).padStart(2, "0")} ${name}${ok ? "" : ` — ${detail}`}`);
}

let cookie = "";
async function req(path, init = {}) {
	const res = await fetch(BASE + path, {
		...init,
		headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(init.headers || {}) },
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		/* 非 JSON（如首页 HTML） */
	}
	return { status: res.status, json, text, headers: res.headers };
}

async function chatEvents(botId, message) {
	const res = await fetch(`${BASE}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Cookie: cookie },
		body: JSON.stringify({ botId, message }),
	});
	const raw = await res.text();
	const events = [];
	for (const block of raw.split("\n\n")) {
		const ev = /event: (.*)/.exec(block)?.[1];
		const data = /data: (.*)/s.exec(block)?.[1];
		if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
	}
	return events;
}

async function waitReady(proc) {
	for (let i = 0; i < 60; i++) {
		if (proc.exitCode !== null) throw new Error(`server 提前退出，exitCode=${proc.exitCode}`);
		try {
			const res = await fetch(`${BASE}/api/bots`);
			if (res.status === 401) return;
		} catch {
			/* 还没起来 */
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error("server 启动超时");
}

async function main() {
	if (!existsSync(join(APP_DIR, "public", "index.html"))) {
		console.error("缺少 public/index.html：先在 apps/piper 下执行 npm run build:web 再跑回归。");
		cleanup();
		process.exit(2);
	}
	const env = { ...process.env, PORT: String(PORT), PIPER_TOKEN: TOKEN, PIPER_DATA_DIR: TMP_DATA, PIPER_GITHUB_API_BASE: GH_BASE };
	// 默认环境必须是「无模型 Key」：显式剔除可能从外层继承的模型与 GitHub 令牌变量
	for (const k of ["PIPER_MODEL_API_KEY", "OPENAI_API_KEY", "PIPER_MODEL_BASE_URL", "PIPER_MODEL_ID", "GITHUB_TOKEN"]) delete env[k];
	const proc = spawn("node", ["server.mjs"], { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
	serverProc = proc;
	let serverLog = "";
	proc.stdout.on("data", (d) => (serverLog += d));
	proc.stderr.on("data", (d) => (serverLog += d));
	try {
		await waitReady(proc);

		// ---- 基础与会话（1-5）----
		const unauth = await req("/api/bots");
		check("未登录 GET /api/bots 返回 401", unauth.status === 401, `实际 ${unauth.status}`);

		const login = await fetch(`${BASE}/api/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: TOKEN }),
		});
		const loginJson = await login.json().catch(() => ({}));
		cookie = (login.headers.get("set-cookie") || "").split(";")[0];
		check("POST /api/login 正确口令返回 {ok:true}", login.status === 200 && loginJson.ok === true && Boolean(cookie), `实际 ${login.status}`);

		const session = await req("/api/session");
		check("GET /api/session 的 modelConfigured 为 false（无 Key 默认环境）", session.json?.modelConfigured === false, JSON.stringify(session.json));

		const botsRes = await req("/api/bots");
		const bots = botsRes.json?.bots ?? [];
		check("GET /api/bots 返回两个预置 bot", bots.length === 2, `实际 ${bots.length}`);
		check("bot 列表第一个是主 bot（isMain 置顶）", bots[0]?.isMain === true, `实际 ${bots[0]?.id}`);

		// ---- bot CRUD（6-9）----
		const created = await req("/api/bots", {
			method: "POST",
			body: JSON.stringify({ name: "回归测试 Bot", systemPrompt: "回归用", tools: [], memoryScope: "self", repos: [] }),
		});
		check("POST /api/bots 新建返回 201", created.status === 201 && Boolean(created.json?.bot?.id), `实际 ${created.status}`);
		const testBotId = created.json?.bot?.id;

		const renamed = await req(`/api/bots/${testBotId}`, {
			method: "PUT",
			body: JSON.stringify({ name: "回归测试 Bot（改名）", systemPrompt: "回归用", tools: [], memoryScope: "self", repos: [] }),
		});
		check("PUT /api/bots/:id 改名生效", renamed.status === 200 && renamed.json?.bot?.name === "回归测试 Bot（改名）", `实际 ${renamed.status}`);

		const del = await req(`/api/bots/${testBotId}`, { method: "DELETE" });
		check("DELETE 普通 bot 返回 ok", del.status === 200 && del.json?.ok === true, `实际 ${del.status}`);

		const delMain = await req("/api/bots/piper-main", { method: "DELETE" });
		check("DELETE 主 bot 返回 400", delMain.status === 400, `实际 ${delMain.status}`);

		// ---- chat 无 Key（10-15）----
		const ev1 = await chatEvents("piper-main", "你好");
		check("chat 普通消息 SSE 首个事件为 session", ev1[0]?.event === "session", `实际 ${ev1[0]?.event}`);
		const errEv = ev1.find((e) => e.event === "error");
		check(
			"chat 普通消息 SSE 含 error 且 code=MODEL_NOT_CONFIGURED",
			errEv?.data?.code === "MODEL_NOT_CONFIGURED",
			JSON.stringify(errEv?.data ?? null),
		);
		check("chat 普通消息 SSE 末个事件为 done", ev1[ev1.length - 1]?.event === "done", `实际 ${ev1[ev1.length - 1]?.event}`);

		const ev2 = await chatEvents("piper-main", "创建一个代码审查 bot，负责审查 PR 的代码质量");
		const sysEv = ev2.find((e) => e.event === "system");
		check("chat 建 bot 意图 SSE 含 system 事件（标注规则兜底）", Boolean(sysEv) && String(sysEv.data?.text ?? "").includes("规则兜底"), JSON.stringify(sysEv?.data ?? null));
		const draftEv = ev2.find((e) => e.event === "draft");
		check(
			"chat 建 bot 意图 SSE draft.name=代码审查 且 source=rules",
			draftEv?.data?.draft?.name === "代码审查" && draftEv?.data?.draft?.source === "rules",
			JSON.stringify(draftEv?.data ?? null),
		);
		check("chat 建 bot 意图 SSE 末个事件为 done", ev2[ev2.length - 1]?.event === "done", `实际 ${ev2[ev2.length - 1]?.event}`);

		// ---- 草案落库与清理（16-19）----
		const confirm = await req("/api/bots/draft-confirm", { method: "POST", body: JSON.stringify({ draft: draftEv.data.draft }) });
		check("POST /api/bots/draft-confirm 返回 201", confirm.status === 201 && Boolean(confirm.json?.bot?.id), `实际 ${confirm.status}`);
		const draftBotId = confirm.json?.bot?.id;

		const afterConfirm = await req("/api/bots");
		check(
			"草案确认后 bot 出现在列表中",
			(afterConfirm.json?.bots ?? []).some((b) => b.id === draftBotId),
			`列表 ${(afterConfirm.json?.bots ?? []).map((b) => b.id).join(",")}`,
		);

		const history = await req("/api/bots/piper-main/messages");
		check(
			"主 bot 会话历史含 draft 条目",
			(history.json?.messages ?? []).some((m) => m.kind === "draft"),
			`条目数 ${history.json?.messages?.length}`,
		);

		if (draftBotId) await req(`/api/bots/${draftBotId}`, { method: "DELETE" });
		const restored = await req("/api/bots");
		check("删除草案 bot 后列表恢复为两个预置 bot", (restored.json?.bots ?? []).length === 2, `实际 ${(restored.json?.bots ?? []).length}`);

		// ---- 晨间扫描与产物（20-22，R4 起走本地 GitHub 桩，离线确定性；真实
		// GitHub 公开 API 的同口径检查在 scripts/regression-live.mjs，非门禁）----
		// P1-4：服务端启动时可能触发一次启动补跑（今日已过点且未成功时）。先等调度空闲，
		// 避免补跑与下面手动扫描的产物计数竞态（补跑产物会计入 before，断言仍是手动 +1）。
		for (let i = 0; i < 160; i++) {
			const st = await req("/api/schedule/status");
			if (st.json?.routines?.[0]?.running === false) break;
			await new Promise((r) => setTimeout(r, 500));
		}
		const before = await req("/api/artifacts");
		const beforeCount = before.json?.artifacts?.length ?? 0;
		const run = await req("/api/routines/morning-scan/run", { method: "POST", body: "{}" });
		const routines = await req("/api/routines");
		const morning = (routines.json?.routines ?? []).find((r) => r.id === "morning-scan");
		check("POST /api/routines/morning-scan/run 成功且 routine lastStatus=ok", run.status === 200 && morning?.lastStatus === "ok", `run=${run.status} lastStatus=${morning?.lastStatus}`);

		const after = await req("/api/artifacts");
		check("扫描后产物列表数量 +1", (after.json?.artifacts?.length ?? 0) === beforeCount + 1, `before=${beforeCount} after=${after.json?.artifacts?.length}`);

		const newArtId = run.json?.artifact?.id;
		const art = newArtId ? await req(`/api/artifacts/${newArtId}`) : { status: 0, json: null };
		check(
			"新产物可按 id 读全文且含日报标题与拍板清单/其余观察两节（P1-2 清单结构口径）",
			art.status === 200 &&
				String(art.json?.artifact?.body ?? "").includes("晨间仓库日报") &&
				String(art.json?.artifact?.body ?? "").includes("## 拍板清单") &&
				String(art.json?.artifact?.body ?? "").includes("## 其余观察") &&
				String(art.json?.artifact?.body ?? "").indexOf("## 拍板清单") < String(art.json?.artifact?.body ?? "").indexOf("## 其余观察"),
			`实际 ${art.status}`,
		);

		// ---- 收件箱与记忆（23-25）----
		// P1-5 起 approvals 改读真实存储（带 writeIntent 的 Finding 审批视图），断言改成
		// 「结构合法」口径：是数组，且每条带 findingId / writeIntent / 合法 status，不再要求恒空。
		const approvals = await req("/api/approvals");
		check(
			"GET /api/approvals 来自真实存储且结构合法（数组；每条带 findingId、writeIntent、intentHash 与 open/approved/executing 状态）",
			approvals.status === 200 &&
				Array.isArray(approvals.json?.approvals) &&
				(approvals.json?.approvals ?? []).every(
					(a) =>
						typeof a.findingId === "string" &&
						a.writeIntent?.kind === "pr_comment" &&
						typeof a.intentHash === "string" &&
						a.intentHash.length > 0 &&
						["open", "approved", "executing"].includes(a.status),
				),
			`实际 ${approvals.status} 条数=${approvals.json?.approvals?.length}`,
		);

		const memory = await req("/api/memory/repo-keeper");
		check("GET /api/memory/repo-keeper 返回 markdown 字段", memory.status === 200 && typeof memory.json?.markdown === "string", `实际 ${memory.status}`);
		check("GET /api/memory/repo-keeper 返回 aboutMe 全文（非空）", typeof memory.json?.aboutMe === "string" && memory.json.aboutMe.length > 0, `长度 ${memory.json?.aboutMe?.length}`);

		// ---- 静态首页（26）----
		const home = await fetch(`${BASE}/`);
		const homeHtml = await home.text();
		check('GET / 返回 200 且 html 带 class="dark"', home.status === 200 && homeHtml.includes('class="dark"'), `实际 ${home.status}`);

		const anon = async (path, init = {}) => {
			const res = await fetch(BASE + path, { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
			const text = await res.text();
			let json = null;
			try {
				json = JSON.parse(text);
			} catch {
				/* 非 JSON */
			}
			return { status: res.status, json, text };
		};

		await runExtraChecks({ req, chatEvents, check });
		await runProfileChecks({ req, check, anon });
		await runConnectorChecks({ req, check });
		await runNotificationChecks({ req, check, anon });
		await runFindingChecks({ req, check, anon });
		await runScanFindingChecks({ req, check, run });
		await runScheduleChecks({ req, check, anon });
		await runApprovalChecks({ req, check, anon });
		await runAuditChecks({ req, check, anon });
		await runSecurityChecks({ check, cookie });
		await runTimezoneChecks({ req, check });
		await runSecretsChecks({ req, check });
	} finally {
		proc.kill("SIGTERM");
		cleanup();
	}
	const failed = results.filter((r) => !r.ok);
	console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
	if (failed.length) {
		console.log("失败项：");
		for (const f of failed) console.log(`  ${String(f.seq).padStart(2, "0")} ${f.name} — ${f.detail}`);
		if (serverLog) console.log(`\nserver 输出（节选）：\n${serverLog.slice(-800)}`);
		process.exit(1);
	}
}

// 切片扩展断言的挂载点：后续切片在此追加。
// L0-2（27-30）：模型设置存储——无 Key 默认值、保存不回显全文、测试连接失败不崩溃、清除恢复未配置。
// R4 前这里有「真实 settings-model.json 存在就整组 SKIP」的保护；隔离后操作的是
// 临时目录里的文件，恒真跑，不再跳过。
async function runExtraChecks({ req, chatEvents, check }) {
	const { existsSync, rmSync } = await import("node:fs");
	const settingsFile = join(TMP_DATA, "settings-model.json");
	const FAKE_KEY = "sk-regression-1234567890abcd";
	try {
		const before = await req("/api/settings/model");
		check(
			"GET /api/settings/model 无 Key 时 configured=false 且 apiKeyHint 为空",
			before.status === 200 && before.json?.configured === false && before.json?.apiKeyHint === "",
			`实际 ${before.status} ${JSON.stringify(before.json)}`,
		);

		await req("/api/settings/model", {
			method: "PUT",
			body: JSON.stringify({ baseUrl: "https://api.openai.com/v1", modelId: "gpt-4o-mini", apiKey: FAKE_KEY }),
		});
		const after = await req("/api/settings/model");
		check(
			"PUT 保存后 GET 只回末四位掩码且响应不含 Key 全文",
			after.status === 200 &&
				after.json?.configured === true &&
				String(after.json?.apiKeyHint ?? "").endsWith("abcd") &&
				!JSON.stringify(after.json).includes(FAKE_KEY),
			`实际 ${JSON.stringify(after.json)}`,
		);

		const test = await req("/api/settings/model/test", {
			method: "POST",
			body: JSON.stringify({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-bad" }),
		});
		const alive = await req("/api/session");
		// R9：这一项必须能区分两类失败——「端点不通」（本项的死端口）与「基座未构建」
		// （packages dist 缺失时内核报 BASE_NOT_BUILT、error 含「基座未构建」）。旧断言只看
		// ok:false，基座没构建时也会误绿；现加 error 不含「基座未构建」的反向断言钉死分类。
		// 对话链路上的三类失败（MODEL_NOT_CONFIGURED / MODEL_ERROR / 成功流）由
		// scripts/test-model-stub.mjs 以错误 code 逐项区分，不在这里重复。
		check(
			"POST /api/settings/model/test 坏端点返回 ok:false（端点不通类：error 不含「基座未构建」）且进程存活",
			test.status === 200 &&
				test.json?.ok === false &&
				typeof test.json?.error === "string" &&
				test.json.error.length > 0 &&
				!test.json.error.includes("基座未构建") &&
				alive.status === 200,
			`实际 ${test.status} ${JSON.stringify(test.json)}`,
		);

		const clear = await req("/api/settings/model", { method: "PUT", body: JSON.stringify({ apiKey: "" }) });
		const ev = await chatEvents("piper-main", "你好");
		const errEv = ev.find((e) => e.event === "error");
		check(
			"清除 Key 后回到未配置且对话再回 MODEL_NOT_CONFIGURED",
			clear.json?.configured === false && errEv?.data?.code === "MODEL_NOT_CONFIGURED",
			`clear=${JSON.stringify(clear.json)} err=${JSON.stringify(errEv?.data ?? null)}`,
		);
	} finally {
		if (existsSync(settingsFile)) rmSync(settingsFile);
	}
}

// L0-3（31-35）：基础资料与「关于我」——未登录写 401、profile 保存读回、about-me 三处同源、
// 超限拒绝不写坏原文件。全部发生在隔离目录内；组内仍按快照—还原自洽（与真实数据无关）。
async function runProfileChecks({ req, check, anon }) {
	const origProfile = (await req("/api/settings/profile")).json ?? {};
	const origAbout = (await req("/api/about-me")).json?.markdown ?? "";
	const MARK = "回归标记-L0-3-关于我同源";
	try {
		const unauth = await anon("/api/about-me", { method: "PUT", body: JSON.stringify({ markdown: "未登录写入" }) });
		check("未登录 PUT /api/about-me 返回 401", unauth.status === 401, `实际 ${unauth.status}`);

		const savedProfile = await req("/api/settings/profile", {
			method: "PUT",
			body: JSON.stringify({ displayName: "回归称呼", timezone: "Asia/Tokyo" }),
		});
		const readProfile = await req("/api/settings/profile");
		check(
			"PUT /api/settings/profile 保存后 GET 读回称呼与时区一致",
			savedProfile.status === 200 && readProfile.json?.displayName === "回归称呼" && readProfile.json?.timezone === "Asia/Tokyo",
			`实际 ${JSON.stringify(readProfile.json)}`,
		);

		const withMark = `${origAbout}\n\n- ${MARK}\n`;
		const putAbout = await req("/api/about-me", { method: "PUT", body: JSON.stringify({ markdown: withMark }) });
		const getAbout = await req("/api/about-me");
		const memory = await req("/api/memory/repo-keeper");
		check(
			"PUT /api/about-me 后 GET /api/about-me 与记忆接口 aboutMe 均含新标记（同源一份）",
			putAbout.status === 200 &&
				String(getAbout.json?.markdown ?? "").includes(MARK) &&
				String(memory.json?.aboutMe ?? "").includes(MARK),
			`put=${putAbout.status} get含标记=${String(getAbout.json?.markdown ?? "").includes(MARK)} memory含标记=${String(memory.json?.aboutMe ?? "").includes(MARK)}`,
		);

		const tooBig = await req("/api/about-me", { method: "PUT", body: JSON.stringify({ markdown: "x".repeat(20001) }) });
		const afterBig = await req("/api/about-me");
		check(
			"超限（20001 字符）PUT /api/about-me 被拒绝且原文件保持上一步内容",
			(tooBig.status === 413 || tooBig.status === 400) && afterBig.json?.markdown === withMark,
			`实际 status=${tooBig.status} 内容一致=${afterBig.json?.markdown === withMark}`,
		);
	} finally {
		await req("/api/about-me", { method: "PUT", body: JSON.stringify({ markdown: origAbout }) });
		await req("/api/settings/profile", {
			method: "PUT",
			body: JSON.stringify({ displayName: origProfile.displayName ?? "", timezone: origProfile.timezone ?? "" }),
		});
	}
	const restoredAbout = await req("/api/about-me");
	const restoredProfile = await req("/api/settings/profile");
	check(
		"还原后 about-me 与 profile 与运行前一致",
		restoredAbout.json?.markdown === origAbout &&
			restoredProfile.json?.displayName === (origProfile.displayName ?? "") &&
			restoredProfile.json?.timezone === (origProfile.timezone ?? "Asia/Hong_Kong"),
		`about一致=${restoredAbout.json?.markdown === origAbout} profile=${JSON.stringify(restoredProfile.json)}`,
	);
}

// L0-4（36-39）：连接器列表与 GitHub 配置——四卡与状态、保存不回显全文、scan 走唯一令牌入口、清除回到无令牌。
// R4 前这里有「真实 settings-github.json 存在就整组 SKIP」的保护；隔离后恒真跑。
// 本组在脚本进程内临时剔除 GITHUB_TOKEN，使 githubToken() 的断言不受外层环境影响（结束恢复）。
// 本进程内 import 的 lib 与子进程 server 共用同一 PIPER_DATA_DIR：经 API 保存的令牌
// 文件，进程内 githubToken() 读到的正是同一份。
async function runConnectorChecks({ req, check }) {
	const { existsSync, rmSync, readFileSync } = await import("node:fs");
	const githubFile = join(TMP_DATA, "settings-github.json");
	const FAKE_TOKEN = "ghp_regressiontoken1234567890wxyz";
	const savedEnvToken = process.env.GITHUB_TOKEN;
	delete process.env.GITHUB_TOKEN;
	try {
		const list = await req("/api/settings/connectors");
		const byId = Object.fromEntries((list.json?.connectors ?? []).map((c) => [c.id, c]));
		check(
			"GET /api/settings/connectors 返回四张卡且日历/邮件为 placeholder、GitHub 无令牌时 unconfigured",
			list.status === 200 &&
				["github", "web", "calendar", "mail"].every((id) => byId[id]) &&
				byId.calendar?.status === "placeholder" &&
				byId.mail?.status === "placeholder" &&
				byId.github?.status === "unconfigured" &&
				String(byId.mail?.statusNote ?? "").includes("收件箱"),
			`实际 ${JSON.stringify((list.json?.connectors ?? []).map((c) => `${c.id}:${c.status}`))}`,
		);

		const put = await req("/api/settings/connectors/github", { method: "PUT", body: JSON.stringify({ token: FAKE_TOKEN }) });
		const after = await req("/api/settings/connectors");
		const ghAfter = (after.json?.connectors ?? []).find((c) => c.id === "github");
		check(
			"PUT 保存 GitHub 令牌后状态 connected、只回末四位掩码且响应不含令牌全文",
			put.status === 200 &&
				put.json?.connector?.status === "connected" &&
				ghAfter?.status === "connected" &&
				String(ghAfter?.tokenHint ?? "").endsWith("wxyz") &&
				!JSON.stringify(after.json).includes(FAKE_TOKEN),
			`实际 put=${put.status} hint=${ghAfter?.tokenHint}`,
		);

		// scan 的令牌来源只能是 settings.githubToken()：源码断言（无第二套入口）+ 同文件读回断言
		// + 进程内 fetch 替身实际跑一次扫描，断言出站请求带了刚保存的令牌（不打活网、不打印令牌）。
		const { githubToken } = await import("../lib/settings.mjs");
		const scanSrc = readFileSync(join(APP_DIR, "lib", "scan.mjs"), "utf8");
		const { runMorningScan } = await import("../lib/scan.mjs");
		const seenAuth = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = async (url, init = {}) => {
			seenAuth.push(init.headers?.Authorization ?? "");
			const u = String(url);
			const payload = u.includes("/actions/runs")
				? { workflow_runs: [] }
				: u.includes("/commits") || u.includes("/pulls") || u.includes("/issues")
					? []
					: { stargazers_count: 1, forks_count: 0, default_branch: "main", pushed_at: "2026-11-10T00:00:00Z" };
			return { ok: true, status: 200, json: async () => payload };
		};
		try {
			await runMorningScan({ repos: ["NorthAdb/LinkForge"], botId: "repo-keeper", saveArtifact: () => ({ id: "stub-artifact" }) });
		} finally {
			globalThis.fetch = realFetch;
		}
		check(
			"scan.mjs 经 githubToken() 取令牌（无 env 直读）且替身扫描的出站请求带 Bearer 已保存令牌",
			scanSrc.includes("githubToken()") &&
				!scanSrc.includes("process.env.GITHUB_TOKEN") &&
				githubToken() === FAKE_TOKEN &&
				seenAuth.length > 0 &&
				seenAuth.every((a) => a === `Bearer ${FAKE_TOKEN}`),
			`请求数=${seenAuth.length} 全部带对令牌=${seenAuth.every((a) => a === `Bearer ${FAKE_TOKEN}`)}`,
		);

		const cleared = await req("/api/settings/connectors/github", { method: "PUT", body: JSON.stringify({ token: "" }) });
		const afterClear = await req("/api/settings/connectors");
		const ghClear = (afterClear.json?.connectors ?? []).find((c) => c.id === "github");
		check(
			"清除令牌后 GitHub 回到 unconfigured 且 githubToken() 为空",
			cleared.status === 200 && ghClear?.status === "unconfigured" && githubToken() === "",
			`实际 status=${ghClear?.status} token空=${githubToken() === ""}`,
		);
	} finally {
		if (existsSync(githubFile)) rmSync(githubFile);
		if (savedEnvToken !== undefined) process.env.GITHUB_TOKEN = savedEnvToken;
	}
}

// L0-5（40-43）：应用内通知——未登录 401、成功扫描写完成通知、标记已读跨进程持久（文件落盘）、
// 绑定不存在仓库时整轮失败写失败通知且进程不崩溃，恢复后成功扫描再写完成通知。
// R4：扫描走本地桩，「不存在的仓库」由桩回 404 实现整轮失败；通知文件在隔离目录内
// 从空开始累积，断言仍按本轮 artifactId / 新增条目定位，不假设列表为空。
async function runNotificationChecks({ req, check, anon }) {
	const unauth = await anon("/api/notifications");
	check("未登录 GET /api/notifications 返回 401", unauth.status === 401, `实际 ${unauth.status}`);

	const routines = await req("/api/routines");
	const morning = (routines.json?.routines ?? []).find((r) => r.id === "morning-scan");
	const list1 = await req("/api/notifications");
	const completed = (list1.json?.notifications ?? []).find((n) => n.type === "routine.completed" && n.artifactId === morning?.lastArtifactId);
	check(
		"本轮成功扫描已写 routine.completed 通知（artifactId 对上 lastArtifactId）且初始未读",
		Boolean(completed) && completed.read === false && (list1.json?.unread ?? 0) >= 1 && completed.routineId === "morning-scan",
		`找到=${Boolean(completed)} unread=${list1.json?.unread}`,
	);

	// 标记已读后：接口内状态更新，且脚本进程（相当于重启后的新进程）从文件读到的也是已读——证明文件持久。
	const unreadBefore = list1.json?.unread ?? 0;
	const marked = completed ? await req("/api/notifications/read", { method: "POST", body: JSON.stringify({ ids: [completed.id] }) }) : { json: null };
	const inMarked = (marked.json?.notifications ?? []).find((n) => n.id === completed?.id);
	const { listNotifications } = await import("../lib/notify.mjs");
	const fromFile = listNotifications().find((n) => n.id === completed?.id);
	check(
		"POST /api/notifications/read 标记后 unread 减一且文件落盘（新进程读回为已读）",
		Boolean(completed) && inMarked?.read === true && marked.json?.unread === unreadBefore - 1 && fromFile?.read === true,
		`unread ${unreadBefore} -> ${marked.json?.unread} 文件已读=${fromFile?.read}`,
	);

	// 失败路径：把仓库管家临时绑到不存在的仓库，整轮取证失败应记 failed + 失败通知；恢复后再跑成功。
	const botsRes = await req("/api/bots");
	const keeper = (botsRes.json?.bots ?? []).find((b) => b.id === "repo-keeper");
	const keeperBody = { name: keeper.name, systemPrompt: keeper.systemPrompt, tools: keeper.tools, memoryScope: keeper.memoryScope, repos: keeper.repos };
	const countFailed = async () => ((await req("/api/notifications")).json?.notifications ?? []).filter((n) => n.type === "routine.failed").length;
	const failedBefore = await countFailed();
	let failOk = false;
	let restoreOk = false;
	try {
		await req("/api/bots/repo-keeper", { method: "PUT", body: JSON.stringify({ ...keeperBody, repos: ["NorthAdb/piper-no-such-repo-zzz"] }) });
		const run = await req("/api/routines/morning-scan/run", { method: "POST", body: "{}" });
		const afterFail = await req("/api/routines");
		const morningAfterFail = (afterFail.json?.routines ?? []).find((r) => r.id === "morning-scan");
		failOk =
			run.status === 200 && morningAfterFail?.lastStatus === "failed" && (await countFailed()) === failedBefore + 1;
	} finally {
		await req("/api/bots/repo-keeper", { method: "PUT", body: JSON.stringify(keeperBody) });
	}
	const rerun = await req("/api/routines/morning-scan/run", { method: "POST", body: "{}" });
	const afterRestore = await req("/api/routines");
	const morningRestored = (afterRestore.json?.routines ?? []).find((r) => r.id === "morning-scan");
	const listEnd = await req("/api/notifications");
	const restoredCompleted = (listEnd.json?.notifications ?? []).find(
		(n) => n.type === "routine.completed" && n.artifactId === morningRestored?.lastArtifactId,
	);
	restoreOk = rerun.status === 200 && morningRestored?.lastStatus === "ok" && Boolean(restoredCompleted);
	check(
		"绑不存在仓库时整轮失败：lastStatus=failed 且新增 routine.failed 通知；恢复绑定后再跑成功并写完成通知",
		failOk && restoreOk,
		`failOk=${failOk} restoreOk=${restoreOk}`,
	);
}

// P1-1（44-46）：Finding 只读 API——未登录 401、列表结构合法（本切片不改扫描，列表可为空）、
// 不存在的 id 返回 404。存储层校验与持久化由 scripts/test-findings.mjs 覆盖，不在这里重复。
async function runFindingChecks({ req, check, anon }) {
	const unauth = await anon("/api/findings");
	check("未登录 GET /api/findings 返回 401", unauth.status === 401, `实际 ${unauth.status}`);

	const list = await req("/api/findings");
	check(
		"GET /api/findings 返回 findings 数组且每条带 evidenceUrl 与合法 status",
		list.status === 200 &&
			Array.isArray(list.json?.findings) &&
			(list.json?.findings ?? []).every(
				(f) => typeof f.evidenceUrl === "string" && f.evidenceUrl.length > 0 && ["open", "approved", "rejected", "expired", "executed", "executing"].includes(f.status),
			),
		`实际 ${list.status} 条数=${list.json?.findings?.length}`,
	);

	const missing = await req("/api/findings/f-no-such-id");
	check("GET /api/findings/:id 不存在返回 404", missing.status === 404, `实际 ${missing.status}`);
}

// P1-2（47-48）：扫描主产物改为拍板清单——扫描响应带 findings 数组且每条有证据链接；
// findings 与 GET /api/findings 同一存储（按 bot 过滤可读回）。规则本身的精确断言
// （哪条 run、哪个 PR、去重）走 scripts/test-scan.mjs 的替身测试与 P1-3 冻结夹具，
// 不拿活仓当唯一断言（活仓状态会变）。
async function runScanFindingChecks({ req, check, run }) {
	const findings = run.json?.findings;
	check(
		"扫描响应带 findings 数组且每条含 evidenceUrl、repo、type",
		Array.isArray(findings) && findings.every((f) => f.evidenceUrl && f.repo && (f.type === "ci_failed" || f.type === "pr_needs_review")),
		`实际条数=${Array.isArray(findings) ? findings.length : "非数组"}`,
	);
	const list = await req("/api/findings?botId=repo-keeper");
	check(
		"GET /api/findings?botId=repo-keeper 可读回扫描落盘的 Finding（同一存储）",
		list.status === 200 && Array.isArray(list.json?.findings),
		`实际 ${list.status} 条数=${list.json?.findings?.length}`,
	);
}

// P1-4（49-52）：真定时调度——状态端点未登录 401、结构完整（时区/下次运行/上次结果）；
// 例程 schedule 已是机器可解析 HH:MM 且文案不再是「仅手动触发」，并带 nextRunAt；
// 状态机本身（到点/补跑/启动补跑/重入）由 scripts/test-schedule.mjs 假时钟覆盖。
async function runScheduleChecks({ req, check, anon }) {
	const unauth = await anon("/api/schedule/status");
	check("未登录 GET /api/schedule/status 返回 401", unauth.status === 401, `实际 ${unauth.status}`);

	const st = await req("/api/schedule/status");
	const s0 = st.json?.routines?.[0];
	check(
		"GET /api/schedule/status 结构完整：时区为字符串、含 nextRunAt（可解析时间）/lastRunAt/lastStatus/running",
		st.status === 200 &&
			typeof st.json?.timezone === "string" &&
			s0?.id === "morning-scan" &&
			!Number.isNaN(Date.parse(s0?.nextRunAt ?? "")) &&
			"lastRunAt" in (s0 ?? {}) &&
			"lastStatus" in (s0 ?? {}) &&
			s0?.running === false,
		`实际 ${JSON.stringify(st.json)}`,
	);

	const routines = await req("/api/routines");
	const morning = (routines.json?.routines ?? []).find((r) => r.id === "morning-scan");
	check(
		"morning-scan 的 schedule 为 HH:MM、scheduleText 不含「仅手动触发」且带 nextRunAt",
		/^\d{2}:\d{2}$/.test(morning?.schedule ?? "") &&
			typeof morning?.scheduleText === "string" &&
			!morning.scheduleText.includes("仅手动触发") &&
			!Number.isNaN(Date.parse(morning?.nextRunAt ?? "")),
		`实际 ${JSON.stringify({ schedule: morning?.schedule, scheduleText: morning?.scheduleText, nextRunAt: morning?.nextRunAt })}`,
	);

	const next = Date.parse(morning?.nextRunAt ?? "");
	check(
		"nextRunAt 落在未来 25 小时内（调度已规划，不是空文案）",
		next > Date.now() - 60 * 1000 && next < Date.now() + 25 * 3600 * 1000,
		`nextRunAt=${morning?.nextRunAt}`,
	);
}

// P1-5（53-56）：待批收件箱独立视图的服务端契约——未登录读写均 401；对不存在的待批项
// 批准/驳回返回 404（不假成功）；例程与产物都带 botId（桌面按 bot 隔离的数据前提）。
// 批准/驳回的状态迁移与过期清理在 lib/approvals.mjs，由本组的结构断言 + P1-6 网关测试覆盖。
async function runApprovalChecks({ req, check, anon }) {
	const unauthGet = await anon("/api/approvals");
	check("未登录 GET /api/approvals 返回 401", unauthGet.status === 401, `实际 ${unauthGet.status}`);

	const unauthPost = await anon("/api/approvals/f-whatever/approve", { method: "POST", body: "{}" });
	check("未登录 POST /api/approvals/:id/approve 返回 401", unauthPost.status === 401, `实际 ${unauthPost.status}`);

	const approve404 = await req("/api/approvals/f-no-such-item/approve", { method: "POST", body: "{}" });
	const reject404 = await req("/api/approvals/f-no-such-item/reject", { method: "POST", body: "{}" });
	check(
		"对不存在的待批项批准/驳回均返回 404（不假成功）",
		approve404.status === 404 && reject404.status === 404,
		`approve=${approve404.status} reject=${reject404.status}`,
	);

	const routines = await req("/api/routines");
	const artifacts = await req("/api/artifacts");
	check(
		"例程与产物均带 botId 字段（桌面按当前 bot 隔离过滤的数据前提）",
		(routines.json?.routines ?? []).every((r) => typeof r.botId === "string") &&
			(artifacts.json?.artifacts ?? []).every((a) => "botId" in a),
		`routines=${(routines.json?.routines ?? []).length} artifacts=${(artifacts.json?.artifacts ?? []).length}`,
	);
}

// P1-6（57-58）：网关审计的只读追溯端点——未登录 401；登录后结构合法且可按 findingId
// 过滤。网关的拒绝/执行全路径（替身写 API 计数、正负审计）在 scripts/test-gateway.mjs 覆盖，
// 这里不拿活仓库做写断言。
async function runAuditChecks({ req, check, anon }) {
	const unauth = await anon("/api/audit");
	check("未登录 GET /api/audit 返回 401", unauth.status === 401, `实际 ${unauth.status}`);

	const all = await req("/api/audit");
	const filtered = await req("/api/audit?findingId=f-no-such-item");
	check(
		"GET /api/audit 返回 records 数组（元素带 result 与 ts），按 findingId 过滤不报错",
		all.status === 200 &&
			Array.isArray(all.json?.records) &&
			(all.json?.records ?? []).every((r) => typeof r.result === "string" && typeof r.ts === "string") &&
			filtered.status === 200 &&
			Array.isArray(filtered.json?.records) &&
			(filtered.json?.records ?? []).every((r) => r.findingId === "f-no-such-item"),
		`实际 all=${all.status}/${all.json?.records?.length} filtered=${filtered.status}/${filtered.json?.records?.length}`,
	);
}

// R2（59-63）：监听与跨源写入收口的服务端契约——会话 Cookie SameSite=Strict；写请求
// 带跨源 Origin 回 403、Content-Type 非 JSON 回 415、同源 Origin 正常放行；登录限速
// （连续 11 次错口令均 401、第 12 次 429）。监听地址绑定与「非回环 + 默认口令拒绝
// 启动」需要另起进程，在 scripts/test-listen.mjs 覆盖。本组放在最后：限速锁定来源后
// 不应再有依赖登录的断言。
async function runSecurityChecks({ check, cookie }) {
	const login = await fetch(`${BASE}/api/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token: TOKEN }),
	});
	const setCookie = login.headers.get("set-cookie") || "";
	check("登录 Cookie 带 SameSite=Strict", login.status === 200 && setCookie.includes("SameSite=Strict"), `status=${login.status} set-cookie=${setCookie}`);

	const put = (headers, body = "{}") =>
		fetch(`${BASE}/api/settings/profile`, {
			method: "PUT",
			headers: { "Content-Type": "application/json", Cookie: cookie, ...headers },
			body,
		});
	const evil = await put({ Origin: "http://evil.example" }, JSON.stringify({ displayName: "跨源写入不应生效" }));
	check("带跨源 Origin（evil.example）的 PUT 返回 403", evil.status === 403, `实际 ${evil.status}`);

	const plain = await put({ "Content-Type": "text/plain" });
	check("Content-Type 为 text/plain 的 PUT 返回 415", plain.status === 415, `实际 ${plain.status}`);

	const sameOrigin = await put({ Origin: BASE }, JSON.stringify({ displayName: "回归测试" }));
	check("带同源 Origin 的 PUT 正常放行（200）", sameOrigin.status === 200, `实际 ${sameOrigin.status}`);

	const statuses = [];
	for (let i = 0; i < 12; i++) {
		const r = await fetch(`${BASE}/api/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: `wrong-${i}` }),
		});
		statuses.push(r.status);
	}
	check(
		"连续 11 次错口令均 401、第 12 次返回 429（登录限速）",
		statuses.slice(0, 11).every((s) => s === 401) && statuses[11] === 429,
		`实际 ${statuses.join(",")}`,
	);
}

// R3（64-66）：时区保存校验——非法 IANA 时区回 400 且 settings-profile.json 字节不变；
// 合法时区仍可正常保存（校验不误杀）。文件指隔离目录内的那份；运行前快照，结束时还原。
async function runTimezoneChecks({ req, check }) {
	const { existsSync, readFileSync } = await import("node:fs");
	const profileFile = join(TMP_DATA, "settings-profile.json");
	const origProfile = (await req("/api/settings/profile")).json ?? {};
	const origBytes = existsSync(profileFile) ? readFileSync(profileFile, "utf8") : null;
	try {
		const bad = await req("/api/settings/profile", { method: "PUT", body: JSON.stringify({ timezone: "Foo/Bar" }) });
		check("PUT /api/settings/profile 非法时区 Foo/Bar 返回 400", bad.status === 400, `实际 ${bad.status}`);

		const afterBad = await req("/api/settings/profile");
		const afterBytes = existsSync(profileFile) ? readFileSync(profileFile, "utf8") : null;
		check(
			"非法时区被拒后 profile 读回与 settings-profile.json 文件字节均不变",
			afterBad.json?.timezone === (origProfile.timezone ?? "Asia/Hong_Kong") && afterBytes === origBytes,
			`读回=${JSON.stringify(afterBad.json)} 文件一致=${afterBytes === origBytes}`,
		);

		const good = await req("/api/settings/profile", { method: "PUT", body: JSON.stringify({ timezone: "Asia/Singapore" }) });
		const readGood = await req("/api/settings/profile");
		check(
			"合法时区 Asia/Singapore 仍可保存（200）并读回一致",
			good.status === 200 && readGood.json?.timezone === "Asia/Singapore",
			`put=${good.status} 读回=${JSON.stringify(readGood.json)}`,
		);
	} finally {
		await req("/api/settings/profile", {
			method: "PUT",
			body: JSON.stringify({ displayName: origProfile.displayName ?? "", timezone: origProfile.timezone ?? "" }),
		});
	}
}

// R7（67-69）：秘密面——短 Key（≤8 位）读回为固定掩码；模型测试接口只传 baseUrl
// 回 400（不得把已保存 Key 发往请求体给定的地址）；baseUrl 非 http/https 回 400。
// 本组在最后运行（会改动已保存的模型 Key），隔离临时目录随回归结束整体丢弃，无需还原。
async function runSecretsChecks({ req, check }) {
	const put = await req("/api/settings/model", { method: "PUT", body: JSON.stringify({ apiKey: "k1234567" }) });
	const view = await req("/api/settings/model");
	check(
		"短 Key（8 位）保存后 GET /api/settings/model 的 apiKeyHint 为固定掩码（不含真实末位）",
		put.status === 200 && view.json?.apiKeyHint === "••••••••",
		`put=${put.status} hint=${JSON.stringify(view.json?.apiKeyHint)}`,
	);

	const onlyBase = await req("/api/settings/model/test", { method: "POST", body: JSON.stringify({ baseUrl: "http://127.0.0.1:9/v1" }) });
	check("POST /api/settings/model/test 只传 baseUrl 返回 400（不外送已保存 Key）", onlyBase.status === 400, `实际 ${onlyBase.status}`);

	const badProto = await req("/api/settings/model/test", {
		method: "POST",
		body: JSON.stringify({ baseUrl: "ftp://example.invalid/v1", apiKey: "sk-bad-1234567890" }),
	});
	check("POST /api/settings/model/test 非 http/https 的 baseUrl 返回 400", badProto.status === 400, `实际 ${badProto.status}`);
}

main().catch((err) => {
	console.error(`回归脚本异常：${err.message}`);
	process.exit(1);
});
