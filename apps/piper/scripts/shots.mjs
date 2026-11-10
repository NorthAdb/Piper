// R9 截图证据：用本机现成的 Chromium（Playwright 缓存的 headless shell）经 CDP
// 驱动已构建的前端，对一个隔离的种子实例逐页截图，落 apps/piper/docs/screens/。
// 用法（在 apps/piper 下）：node scripts/shots.mjs（或 npm run shots）
// 前提：本机有 Chromium 二进制（CHROMIUM_BIN 或 ~/.cache/ms-playwright 下的
// chromium / chrome-headless-shell）；没有则明确报错退出，不下载、不冒充。
// 种子数据全是假数据：模型 Key 为 sk-r9-fake-…wxyz（界面只应出现末四位掩码），
// GitHub 走本地桩，数据目录为临时目录——截图里不会出现任何真实秘密，
// 截完请逐张目检（脚本只保证流程跑通，不替代目检）。
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCREENS_DIR = join(APP_DIR, "docs", "screens");
const PORT = Number(process.env.SHOTS_PORT || 4399);
const BASE = `http://127.0.0.1:${PORT}`;
const CDP_PORT = Number(process.env.SHOTS_CDP_PORT || 9339);
const FAKE_KEY = "sk-r9-fake-key-00000000wxyz";
const FAKE_SEARCH_KEY = "sk-shots-fake-search-0000wxyz";
const FIXTURE_FEATURE = "夹具特征句：紫水晶海豹在屋顶上读报纸。";

function findChrome() {
	// headless shell 优先于全量 chrome（后者在无显示环境要额外 --headless=new 才起得来）。
	const shellCandidates = [];
	const fullCandidates = [];
	if (process.env.CHROMIUM_BIN) (process.env.CHROMIUM_BIN.includes("headless") ? shellCandidates : fullCandidates).push(process.env.CHROMIUM_BIN);
	const cache = join(homedir(), ".cache", "ms-playwright");
	if (existsSync(cache)) {
		for (const dir of readdirSync(cache)) {
			shellCandidates.push(join(cache, dir, "chrome-headless-shell-linux64", "chrome-headless-shell"));
			fullCandidates.push(join(cache, dir, "chrome-linux64", "chrome"));
		}
	}
	fullCandidates.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome");
	return [...shellCandidates, ...fullCandidates].find((p) => existsSync(p)) ?? null;
}

const chromeBin = findChrome();
if (!chromeBin) {
	console.error("未找到可用的 Chromium 二进制（查过 CHROMIUM_BIN、~/.cache/ms-playwright、/usr/bin），截图未执行。");
	process.exit(2);
}
console.log(`使用 Chromium：${chromeBin}`);

// ---- 构建前端（public/ 是构建产物，截图必须对着最新构建） ----
execFileSync("npm", ["run", "build:web"], { cwd: APP_DIR, stdio: "inherit" });

// ---- 隔离目录与种子 ----
const TMP_ROOT = mkdtempSync(join(tmpdir(), "piper-shots-"));
const TMP_DATA = join(TMP_ROOT, "data");

function runSeed(code) {
	const seedFile = join(TMP_ROOT, `seed-${Math.random().toString(36).slice(2, 8)}.mjs`);
	writeFileSync(seedFile, code, "utf8");
	execFileSync("node", [seedFile], {
		cwd: APP_DIR,
		env: { ...process.env, PIPER_DATA_DIR: TMP_DATA },
		stdio: "inherit",
	});
}

// ---- L0-6 截图用：夹具网页 + 本地模型 stub（让工具卡截图走真实工具链路） ----
const fixtureServer = createServer((reqHttp, resHttp) => {
	if ((reqHttp.url ?? "").startsWith("/page")) {
		resHttp.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		resHttp.end(`<html><body><h1>示例文档</h1><p>${FIXTURE_FEATURE}</p></body></html>`);
	} else {
		resHttp.statusCode = 404;
		resHttp.end("not found");
	}
});
await new Promise((r) => fixtureServer.listen(0, "127.0.0.1", r));
const FIXTURE_PORT = fixtureServer.address().port;

const shotsModelStub = createServer((reqHttp, resHttp) => {
	if (!reqHttp.url?.startsWith("/v1/chat/completions")) {
		resHttp.statusCode = 404;
		resHttp.end(JSON.stringify({ error: { message: "not found" } }));
		return;
	}
	let raw = "";
	reqHttp.on("data", (c) => (raw += c));
	reqHttp.on("end", () => {
		let body = {};
		try {
			body = JSON.parse(raw || "{}");
		} catch {
			/* 忽略 */
		}
		const model = body.model || "stub-model";
		if (!body.stream) {
			resHttp.writeHead(200, { "Content-Type": "application/json" });
			resHttp.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1762732800, model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
			return;
		}
		const toolNames = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
		const messages = body.messages ?? [];
		const last = messages[messages.length - 1] ?? {};
		const lastUser = [...messages].reverse().find((m) => m.role === "user");
		const userText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
		resHttp.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
		const chunk = (delta, finishReason = null) =>
			`data: ${JSON.stringify({ id: "chatcmpl-shots", object: "chat.completion.chunk", created: 1762732800, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
		resHttp.write(chunk({ role: "assistant" }));
		if (last.role === "tool") {
			const toolText = typeof last.content === "string" ? last.content : JSON.stringify(last.content ?? "");
			resHttp.write(chunk({ content: `页面要点：${toolText.slice(0, 220)}` }));
			resHttp.write(chunk({}, "stop"));
		} else if (toolNames.includes("web.fetch") && /https?:\/\//.test(userText)) {
			const url = /https?:\/\/[^\s"']+/.exec(userText)[0];
			resHttp.write(chunk({ tool_calls: [{ index: 0, id: "call_shots", type: "function", function: { name: "web.fetch", arguments: "" } }] }));
			resHttp.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ url }) } }] }));
			resHttp.write(chunk({}, "tool_calls"));
		} else {
			resHttp.write(chunk({ content: "好的。" }));
			resHttp.write(chunk({}, "stop"));
		}
		resHttp.end("data: [DONE]\n\n");
	});
});
await new Promise((r) => shotsModelStub.listen(0, "127.0.0.1", r));
const SHOTS_MODEL_BASE = `http://127.0.0.1:${shotsModelStub.address().port}/v1`;

const libUrl = (name) => `file://${join(APP_DIR, "lib", name)}`;
runSeed(`
import { ensureData, saveArtifact, updateRoutine } from "${libUrl("store.mjs")}";
import { saveModelSettingsFile, saveWebSettingsFile } from "${libUrl("settings.mjs")}";
import { addNotification } from "${libUrl("notify.mjs")}";
ensureData();
saveModelSettingsFile({ baseUrl: "${SHOTS_MODEL_BASE}", modelId: "gpt-4o-mini", apiKey: "${FAKE_KEY}" });
saveWebSettingsFile({ fetchEnabled: true, searchEndpoint: "https://search.example.com/query", searchApiKey: "${FAKE_SEARCH_KEY}" });
const artifact = saveArtifact({
	botId: "repo-keeper",
	kind: "morning-report",
	title: "晨间仓库日报（2026-11-11）",
	body: "# 晨间仓库日报\\n\\n## 拍板清单\\n\\n- PR 待审查：NorthAdb/LinkForge #42\\n\\n## 其余观察\\n\\n- CI 全绿，star 无变化。\\n",
});
updateRoutine("morning-scan", { lastRunAt: new Date().toISOString(), lastStatus: "ok", lastArtifactId: artifact.id });
addNotification({
	type: "routine.completed",
	title: "晨间仓库扫描已完成",
	body: "日报：晨间仓库日报（2026-11-11）（本轮新开 1 条待拍板事项，见日报开头的拍板清单）",
	routineId: "morning-scan",
	artifactId: artifact.id,
});
console.log("种子（模型/产物/通知）已写入");
`);

// ---- 本地 GitHub 桩：调度启动补跑就算触发也只打桩、不打活网 ----
const ghStub = createServer((reqHttp, resHttp) => {
	const u = new URL(reqHttp.url ?? "/", "http://stub.invalid");
	resHttp.setHeader("Content-Type", "application/json");
	let payload;
	if (u.pathname.includes("/actions/runs")) payload = { workflow_runs: [] };
	else if (/\/(commits|pulls|issues)$/.test(u.pathname) || u.pathname.includes("/reviews")) payload = [];
	else if (/^\/repos\/[^/]+\/[^/]+$/.test(u.pathname))
		payload = { stargazers_count: 7, forks_count: 2, default_branch: "main", pushed_at: "2026-11-10T00:00:00Z" };
	else {
		resHttp.statusCode = 404;
		payload = { message: "Not Found" };
	}
	resHttp.end(JSON.stringify(payload));
});
await new Promise((r) => ghStub.listen(0, "127.0.0.1", r));
const GH_BASE = `http://127.0.0.1:${ghStub.address().port}`;

// ---- 起被截实例 ----
const env = { ...process.env, PORT: String(PORT), PIPER_DATA_DIR: TMP_DATA, PIPER_GITHUB_API_BASE: GH_BASE, PIPER_WEB_FETCH_TEST_ALLOW: `127.0.0.1:${FIXTURE_PORT}` };
delete env.PIPER_TOKEN;
delete env.PIPER_HOST;
const serverProc = spawn("node", ["server.mjs"], { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
serverProc.stdout.on("data", (d) => (serverLog += d));
serverProc.stderr.on("data", (d) => (serverLog += d));

async function waitReady() {
	for (let i = 0; i < 60; i++) {
		if (serverProc.exitCode !== null) throw new Error(`server 提前退出：${serverLog.slice(-400)}`);
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

// ---- 起 Chromium 并接 CDP ----
const chromeProc = spawn(
	chromeBin,
	[
		...(chromeBin.includes("headless") ? [] : ["--headless=new"]),
		"--no-sandbox",
		"--disable-gpu",
		`--window-size=1440,1000`,
		`--user-data-dir=${join(TMP_ROOT, "profile")}`,
		"--remote-debugging-address=127.0.0.1",
		`--remote-debugging-port=${CDP_PORT}`,
		"about:blank",
	],
	{ stdio: ["ignore", "pipe", "pipe"] },
);

let ws;
let msgId = 0;
const pending = new Map();
function cdp(method, params = {}, sessionId) {
	return new Promise((resolvePromise, rejectPromise) => {
		const id = ++msgId;
		pending.set(id, { resolvePromise, rejectPromise });
		ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
	});
}

async function connectCdp() {
	let version = null;
	for (let i = 0; i < 60; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
			version = await res.json();
			break;
		} catch {
			await new Promise((r) => setTimeout(r, 250));
		}
	}
	if (!version?.webSocketDebuggerUrl) throw new Error("CDP 端点未就绪");
	ws = new WebSocket(version.webSocketDebuggerUrl);
	await new Promise((resolvePromise, rejectPromise) => {
		ws.addEventListener("open", resolvePromise, { once: true });
		ws.addEventListener("error", rejectPromise, { once: true });
	});
	ws.addEventListener("message", (event) => {
		const msg = JSON.parse(String(event.data));
		if (msg.id && pending.has(msg.id)) {
			const { resolvePromise, rejectPromise } = pending.get(msg.id);
			pending.delete(msg.id);
			if (msg.error) rejectPromise(new Error(`${msg.error.message}`));
			else resolvePromise(msg.result);
		}
	});
	const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
	const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
	return sessionId;
}

let sessionId = null;
async function evaluate(expression) {
	const res = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
	if (res.exceptionDetails) throw new Error(`页面求值失败：${res.exceptionDetails.text ?? ""} ${res.exceptionDetails.exception?.description ?? ""}`);
	return res.result?.value;
}

async function waitFor(expression, description, timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if (await evaluate(`Boolean(${expression})`)) return;
		} catch {
			/* 页面切换中 */
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	throw new Error(`等待超时：${description}`);
}

const bodyHas = (text) => `document.body && document.body.innerText.includes(${JSON.stringify(text)})`;

async function clickText(text, { maxX = Infinity, minX = 0 } = {}) {
	const point = await evaluate(`(() => {
		// bot 行是 div onClick、页签是 button：都纳入候选，按面积取最小并限高，避免误中布局大容器。
		const els = [...document.querySelectorAll('button, a, [role="tab"], [role="button"], div, span, li')];
		const hits = els
			.map((el) => ({ el, rect: el.getBoundingClientRect(), label: (el.innerText || el.textContent || "").trim() }))
			.filter((h) => h.rect.width > 0 && h.rect.height > 0 && h.rect.height <= 80 && h.label.includes(${JSON.stringify(text)}))
			.filter((h) => h.rect.x + h.rect.width / 2 >= ${minX} && h.rect.x + h.rect.width / 2 <= ${maxX})
			.sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);
		if (!hits.length) return null;
		const r = hits[0].rect;
		return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
	})()`);
	if (!point) throw new Error(`找不到可点击元素：${text}`);
	await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 }, sessionId);
	await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 }, sessionId);
	await new Promise((r) => setTimeout(r, 700));
}

const shots = [];
async function shot(fileName) {
	const { data } = await cdp("Page.captureScreenshot", { format: "png" }, sessionId);
	mkdirSync(SCREENS_DIR, { recursive: true });
	writeFileSync(join(SCREENS_DIR, fileName), Buffer.from(data, "base64"));
	shots.push(fileName);
	console.log(`已截图：docs/screens/${fileName}`);
}

try {
	await waitReady();
	sessionId = await connectCdp();
	await cdp("Page.enable", {}, sessionId);
	await cdp("Runtime.enable", {}, sessionId);
	await cdp("Page.navigate", { url: `${BASE}/` }, sessionId);
	await waitFor(`document.querySelector('#login-token') !== null`, "登录页出现");

	// 登录（口令走真实输入事件，React 受控输入才认）
	await evaluate(`document.querySelector('#login-token').focus()`);
	await cdp("Input.insertText", { text: "piper-dev" }, sessionId);
	await evaluate(`document.querySelector('form').requestSubmit()`);
	await waitFor(bodyHas("待批收件箱"), "登录后主界面出现");
	await new Promise((r) => setTimeout(r, 800));

	await shot("01-main-piper-desktop.png"); // 主界面：选中 Piper，其右栏无仓库管家的例程（隔离）

	await clickText("仓库管家", { maxX: 264 });
	await waitFor(bodyHas("晨间仓库扫描"), "仓库管家右栏出现晨间扫描例程");
	await shot("02-main-repo-keeper-desktop.png"); // 选中仓库管家：右栏有晨间扫描例程
	await clickText("产物", { minX: 1080 });
	await waitFor(bodyHas("晨间仓库日报"), "仓库管家产物列表出现日报");
	await shot("03-main-repo-keeper-artifacts.png");

	// 设置四组
	await clickText("设置", { maxX: 264 });
	await waitFor(bodyHas("只接一个 OpenAI 兼容端点"), "设置-模型组出现");
	await shot("04-settings-model-configured.png"); // 模型已配置态：Key 只显示末四位掩码
	await clickText("基础资料");
	await waitFor(bodyHas("关于我"), "设置-基础资料组出现");
	await shot("05-settings-profile.png");
	await clickText("连接器");
	await waitFor(bodyHas("GitHub"), "设置-连接器组出现");
	await shot("06-settings-connectors.png");
	// L0-6：网页查询已启用态——把网页查询卡滚到视口中央再截（卡上应有已启用与搜索掩码）
	await evaluate(`(() => { const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && (e.textContent || '').trim() === '网页查询'); el?.scrollIntoView({ block: 'center' }); return Boolean(el); })()`);
	await waitFor(bodyHas("网页抓取：已启用"), "网页查询卡已启用态出现");
	await shot("10-settings-connectors-web-enabled.png");
	await clickText("通知");
	await waitFor(bodyHas("晨间仓库扫描已完成"), "设置-通知组出现完成条");
	await shot("07-settings-notifications.png");

	// 收件箱：先空态（Finding 尚未播种），再播种一条待批看详情
	await clickText("返回");
	await waitFor(bodyHas("待批收件箱"), "回到主界面");
	await clickText("待批收件箱", { maxX: 264 });
	await waitFor(bodyHas("现在没有需要你批准的写操作。"), "收件箱空态出现");
	await shot("08-inbox-empty.png");

	runSeed(`
import { createFinding } from "${libUrl("findings.mjs")}";
createFinding({
	repo: "NorthAdb/LinkForge",
	type: "pr_needs_review",
	subject: "42",
	title: "PR 待审查：NorthAdb/LinkForge #42 长时间无人审查",
	summary: "该 PR 已开放 3 天，尚无任何审查结论。种子数据，仅用于截图。",
	evidenceUrl: "https://github.com/NorthAdb/LinkForge/pull/42",
	suggestedAction: "在 PR 下发表一条模板评论，提醒作者补充自测说明。",
	writeIntent: { kind: "pr_comment", prNumber: 42, body: "提醒：这个 PR 还没有审查结论，方便补充一下自测说明吗？（种子评论正文）" },
	expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
	botId: "repo-keeper",
	headSha: null,
});
console.log("种子（待批 Finding）已写入");
`);
	await clickText("返回");
	await waitFor(bodyHas("待批收件箱"), "回到主界面（播种后）");
	await clickText("待批收件箱", { maxX: 264 });
	await waitFor(bodyHas("批准后将执行的写操作"), "待批详情出现写操作参数");
	await shot("09-inbox-detail.png");

	// L0-6：一次 web.fetch 工具卡——刷新回主界面（默认选中主 bot）、让它打开夹具页
	await cdp("Page.navigate", { url: `${BASE}/` }, sessionId);
	await waitFor(bodyHas("待批收件箱"), "刷新后主界面出现");
	await waitFor(`document.querySelector('textarea') !== null`, "主 bot 对话输入框出现");
	await evaluate(`document.querySelector('textarea').focus()`);
	await cdp("Input.insertText", { text: `打开 http://127.0.0.1:${FIXTURE_PORT}/page 看看里面写了什么` }, sessionId);
	await clickText("发送");
	await waitFor(bodyHas("web.fetch"), "对话里出现 web.fetch 工具卡", 30000);
	await waitFor(bodyHas("紫水晶海豹"), "助手回答引用到夹具特征句", 30000);
	await new Promise((r) => setTimeout(r, 800));
	await shot("11-chat-web-fetch-tool.png");

	console.log(`\n截图完成：${shots.length} 张，目录 ${SCREENS_DIR}`);
	console.log("注意：脚本不做内容断言，请逐张目检 Key 区为掩码、无真实秘密。");
} finally {
	try {
		ws?.close();
	} catch {
		/* 已关 */
	}
	chromeProc.kill("SIGTERM");
	serverProc.kill("SIGTERM");
	ghStub.close();
	fixtureServer.close();
	shotsModelStub.close();
	rmSync(TMP_ROOT, { recursive: true, force: true });
}
