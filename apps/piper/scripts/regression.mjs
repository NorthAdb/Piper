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

		await runExtraChecks({ req, chatEvents, check });
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

// 切片扩展断言的挂载点：后续切片在此追加（默认无操作）。
async function runExtraChecks() {}

main().catch((err) => {
	console.error(`回归脚本异常：${err.message}`);
	process.exit(1);
});
