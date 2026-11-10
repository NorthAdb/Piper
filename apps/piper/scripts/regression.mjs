// Piper API 回归脚本：把历次实测的断言固化成可重复运行的检查。
// 用法（在 apps/piper 下）：
//   node scripts/regression.mjs        （或 npm run regression）
// 行为：以「无模型 Key」的默认环境在本机测试端口启动一份 server.mjs，逐项断言后退出。
// 退出码 0 = 全部通过；1 = 有失败。晨间扫描一项会真实调用 GitHub 公开 API（与产品行为一致），
// 其余断言不依赖外网。运行会写 apps/piper/data/（测试 bot 会清理，扫描产物会留下一份日报）。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.REGRESSION_PORT || 4398);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "piper-dev";

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
		process.exit(2);
	}
	const env = { ...process.env, PORT: String(PORT), PIPER_TOKEN: TOKEN };
	// 默认环境必须是「无模型 Key」：显式剔除可能从外层继承的模型与 GitHub 令牌变量
	for (const k of ["PIPER_MODEL_API_KEY", "OPENAI_API_KEY", "PIPER_MODEL_BASE_URL", "PIPER_MODEL_ID", "GITHUB_TOKEN"]) delete env[k];
	const proc = spawn("node", ["server.mjs"], { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
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

		// ---- 晨间扫描与产物（20-22，真实调用 GitHub 公开 API）----
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
		check("新产物可按 id 读全文且含日报标题", art.status === 200 && String(art.json?.artifact?.body ?? "").includes("晨间仓库日报"), `实际 ${art.status}`);

		// ---- 收件箱与记忆（23-25）----
		const approvals = await req("/api/approvals");
		check('GET /api/approvals 返回 {"approvals":[]}', approvals.status === 200 && Array.isArray(approvals.json?.approvals) && approvals.json.approvals.length === 0, `实际 ${approvals.status}`);

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
	} finally {
		proc.kill("SIGTERM");
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
// 保护：若 data/settings-model.json 在运行前就存在（用户真实配置），整组跳过，绝不覆盖或清除。
async function runExtraChecks({ req, chatEvents, check }) {
	const { existsSync, rmSync } = await import("node:fs");
	const settingsFile = join(APP_DIR, "data", "settings-model.json");
	if (existsSync(settingsFile)) {
		console.log("SKIP 27-30 已存在 data/settings-model.json（视为用户真实配置），跳过设置组断言以免覆盖");
		return;
	}
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
		check(
			"POST /api/settings/model/test 坏端点返回 ok:false 且进程存活",
			test.status === 200 && test.json?.ok === false && typeof test.json?.error === "string" && alive.status === 200,
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
// 超限拒绝不写坏原文件。运行前快照原 profile 与 about-me，结束时还原，不污染用户真实数据。
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
// 保护：若 data/settings-github.json 运行前已存在（用户真实令牌），整组跳过，绝不覆盖或清除。
// 本组在脚本进程内临时剔除 GITHUB_TOKEN，使 githubToken() 的断言不受外层环境影响（结束恢复）。
async function runConnectorChecks({ req, check }) {
	const { existsSync, rmSync, readFileSync } = await import("node:fs");
	const githubFile = join(APP_DIR, "data", "settings-github.json");
	if (existsSync(githubFile)) {
		console.log("SKIP 36-39 已存在 data/settings-github.json（视为用户真实令牌），跳过连接器组断言以免覆盖");
		return;
	}
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
// 注意 data/notifications.jsonl 跨运行累积，断言一律按本轮 artifactId / 新增条目定位，不假设列表为空。
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

main().catch((err) => {
	console.error(`回归脚本异常：${err.message}`);
	process.exit(1);
});
