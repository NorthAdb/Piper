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
	// 模型名单拉取（改版截图 12 用）：设置页会用已保存 Key 向端点 GET /models，
	// stub 回两个假模型名，证明拉取链路能把名单填进下拉。
	if (reqHttp.url?.startsWith("/v1/models")) {
		resHttp.writeHead(200, { "Content-Type": "application/json" });
		resHttp.end(JSON.stringify({ object: "list", data: [{ id: "stub-alpha" }, { id: "stub-beta" }] }));
		return;
	}
	if (!reqHttp.url?.startsWith("/v1/chat/completions")) {
		resHttp.statusCode = 404;
		resHttp.end(JSON.stringify({ error: { message: "not found" } }));
		return;
	}
	let raw = "";
	reqHttp.on("data", (c) => (raw += c));
	reqHttp.on("end", async () => {
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
			// 思考分段截图（15）：带「先想一想」的话先回第二段 reasoning 再回正文，
			// 与工具调用前的第一段构成同轮两段思考。11 号图的工具结果不带这句，不受影响。
			if (typeof body.reasoning_effort === "string" && body.reasoning_effort && userText.includes("先想一想")) {
				resHttp.write(chunk({ reasoning_content: "再结合页面想一想：" }));
				resHttp.write(chunk({ reasoning_content: "页面要点已经清楚，可以作答。" }));
				// 停顿一下再回正文，让第二段的 durationMs 是真实秒数（摘要行不至于是 0 秒）
				await new Promise((r) => setTimeout(r, 1200));
			}
			resHttp.write(chunk({ content: `页面要点：${toolText.slice(0, 220)}` }));
			resHttp.write(chunk({}, "stop"));
		} else if (
			typeof body.reasoning_effort === "string" &&
			body.reasoning_effort &&
			toolNames.includes("web_fetch") &&
			/https?:\/\//.test(userText) &&
			userText.includes("先想一想")
		) {
			// 思考分段截图（15）第一段：先回一段 reasoning，再发 web_fetch 工具调用，
			// 让工具调用把思考段打断。
			const url = /https?:\/\/[^\s"']+/.exec(userText)[0];
			resHttp.write(chunk({ reasoning_content: "先拆解问题：" }));
			resHttp.write(chunk({ reasoning_content: "要先打开页面确认内容，再组织回答。" }));
			// 停顿一下再发工具调用，让第一段的 durationMs 是真实秒数（摘要行不至于是 0 秒）
			await new Promise((r) => setTimeout(r, 1200));
			resHttp.write(chunk({ tool_calls: [{ index: 0, id: "call_shots_seg", type: "function", function: { name: "web_fetch", arguments: "" } }] }));
			resHttp.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ url }) } }] }));
			resHttp.write(chunk({}, "tool_calls"));
		} else if (toolNames.includes("web_fetch") && /https?:\/\//.test(userText)) {
			const url = /https?:\/\/[^\s"']+/.exec(userText)[0];
			resHttp.write(chunk({ tool_calls: [{ index: 0, id: "call_shots", type: "function", function: { name: "web_fetch", arguments: "" } }] }));
			resHttp.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ url }) } }] }));
			resHttp.write(chunk({}, "tool_calls"));
		} else if (typeof body.reasoning_effort === "string" && body.reasoning_effort) {
			// 兜底 reasoning 分支：请求带 reasoning_effort 且不命中上面的工具/分段
			// 分支时，先回两段 reasoning_content 增量、再回正文。必须放在 web_fetch
			// 分支之后：11 号图的抓取首请求也带着挡位参数（种子已存 high），要先命中工具分支。
			resHttp.write(chunk({ reasoning_content: "先拆解问题：" }));
			resHttp.write(chunk({ reasoning_content: "1 加 1 是最基础的加法，结果为 2。" }));
			resHttp.write(chunk({ content: "1 加 1 等于 2。" }));
			resHttp.write(chunk({}, "stop"));
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
import { saveModelSettingsFile } from "${libUrl("settings.mjs")}";
import { addNotification } from "${libUrl("notify.mjs")}";
ensureData();
saveModelSettingsFile({ baseUrl: "${SHOTS_MODEL_BASE}", modelId: "gpt-4o-mini", apiKey: "${FAKE_KEY}" });
// 网页查询不在种子里预启（第二轮 F13）：06 要截「未启用」默认态，与 10 的已启用态
// 区分；启用动作在截 06 之后经页面同源调用真实设置接口完成（见下方流程）。
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
const env = { ...process.env, PORT: String(PORT), PIPER_DATA_DIR: TMP_DATA, PIPER_GITHUB_API_BASE: GH_BASE, PIPER_WEB_FETCH_TEST_ALLOW: `127.0.0.1:${FIXTURE_PORT}`, PIPER_TEST_MODE: "1" };
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

// 按表达式求出的坐标点做一次真实鼠标点击（Radix Select 的 trigger/option 靠
// 指针事件开关，合成 .click() 不可靠，须走 CDP Input）。
async function clickPoint(expression, description) {
	const point = await evaluate(expression);
	if (!point) throw new Error(`找不到可点击元素：${description}`);
	await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 }, sessionId);
	await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 }, sessionId);
	await new Promise((r) => setTimeout(r, 500));
}

const centerOf = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;

async function selectRadixOption(triggerSelector, optionText) {
	await clickPoint(centerOf(triggerSelector), `下拉触发器 ${triggerSelector}`);
	await waitFor(`[...document.querySelectorAll('[role="option"]')].some((el) => (el.textContent || '').includes(${JSON.stringify(optionText)}))`, `下拉选项出现：${optionText}`);
	await clickPoint(
		`(() => { const el = [...document.querySelectorAll('[role="option"]')].find((e) => (e.textContent || '').includes(${JSON.stringify(optionText)})); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
		`下拉选项：${optionText}`,
	);
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
	await waitFor(bodyHas("先选服务商，再填该服务商的 API Key 接入"), "设置-模型组出现");
	await shot("04-settings-model-configured.png"); // 模型已配置态：Key 只显示末四位掩码
	// 服务商 + 拉取模型截图（改版口径）：把已保存配置直接写成 provider=deepseek、
	// 但 baseUrl 指向本地模型 stub——截图里的端点是本地替身、不是真 DeepSeek，
	// Key 也是种子假 Key。重载后表单读回 DeepSeek 归属，且已保存 Key 在场会
	// 自动向 stub 拉一次 /models；等「已从端点拉取 2 个模型」出现后打开模型
	// 下拉，名单里应是 stub 回的 stub-alpha / stub-beta。
	runSeed(`
import { saveModelSettingsFile } from "${libUrl("settings.mjs")}";
saveModelSettingsFile({ provider: "deepseek", baseUrl: "${SHOTS_MODEL_BASE}", modelId: "stub-alpha", apiKey: "${FAKE_KEY}" });
console.log("截图 12 用配置已写入（provider=deepseek，端点=本地 stub）");
`);
	await cdp("Page.navigate", { url: `${BASE}/` }, sessionId);
	await waitFor(bodyHas("待批收件箱"), "重载后主界面出现");
	await clickText("设置", { maxX: 264 });
	await waitFor(bodyHas("先选服务商，再填该服务商的 API Key 接入"), "重载后设置-模型组出现");
	await waitFor(bodyHas("已从端点拉取 2 个模型"), "自动拉取 stub 模型名单成功");
	await clickPoint(centerOf("#model-id-select"), "打开模型下拉");
	await waitFor(
		`[...document.querySelectorAll('[role="option"]')].some((el) => (el.textContent || '').includes('stub-beta'))`,
		"模型下拉出现 stub-beta",
	);
	await shot("12-settings-model-deepseek.png");
	// 收起模型下拉再继续：Radix 下拉开着时点别处只会先关下拉、吞掉那次点击。
	await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
	await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
	const dropdownClosed = await evaluate(`document.querySelectorAll('[role="option"]').length === 0`).catch(() => false);
	if (!dropdownClosed) {
		await clickPoint(centerOf("#model-id-select"), "再次点击模型触发器收起下拉");
		await waitFor(`document.querySelectorAll('[role="option"]').length === 0`, "模型下拉已收起");
	}
	// 思考挡位截图（14）：把已保存配置换成目录模型 deepseek-flash + 挡位 high
	// （端点仍是本地 stub、Key 仍是种子假 Key），重载后在模型组打开思考挡位
	// 下拉——选项应恰为 pi-ai 给该模型的支持集 off / low / high / max。
	runSeed(`
import { saveModelSettingsFile } from "${libUrl("settings.mjs")}";
saveModelSettingsFile({ provider: "deepseek", baseUrl: "${SHOTS_MODEL_BASE}", modelId: "deepseek-flash", apiKey: "${FAKE_KEY}", thinkingLevel: "high" });
console.log("截图 14 用配置已写入（deepseek-flash + thinkingLevel=high）");
`);
	await cdp("Page.navigate", { url: `${BASE}/` }, sessionId);
	await waitFor(bodyHas("待批收件箱"), "重载后主界面出现（思考挡位截图）");
	await clickText("设置", { maxX: 264 });
	await waitFor(bodyHas("思考挡位"), "设置-模型组出现思考挡位");
	await evaluate(`document.querySelector('#model-thinking-level')?.scrollIntoView({ block: 'center' })`);
	await clickPoint(centerOf("#model-thinking-level"), "打开思考挡位下拉");
	await waitFor(
		`(() => { const opts = [...document.querySelectorAll('[role="option"]')].map((el) => (el.textContent || '').trim()); return ['off', 'low', 'high', 'max'].every((l) => opts.includes(l)); })()`,
		"思考挡位下拉出现 off/low/high/max",
	);
	await shot("14-settings-thinking-levels.png");
	await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
	await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
	await waitFor(`document.querySelectorAll('[role="option"]').length === 0`, "思考挡位下拉已收起");
	await clickText("基础资料");
	await waitFor(bodyHas("关于我"), "设置-基础资料组出现");
	await shot("05-settings-profile.png");
	await clickText("连接器");
	await waitFor(bodyHas("GitHub"), "设置-连接器组出现");
	// F13：06 截网页查询「未启用」默认态（种子未预启）——把网页查询卡滚到视口中央，
	// 卡上应显示「网页抓取：未启用」；与下方 10 的已启用态是同一页的两种状态，不再重复。
	await evaluate(`(() => { const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && (e.textContent || '').trim() === '网页查询'); el?.scrollIntoView({ block: 'center' }); return Boolean(el); })()`);
	await waitFor(bodyHas("网页抓取：未启用"), "网页查询卡未启用态出现");
	await shot("06-settings-connectors.png");
	// 经页面同源调用真实设置接口启用网页抓取并配置搜索，再整页刷新回到连接器组截 10。
	const putStatus = await evaluate(
		`fetch('/api/settings/connectors/web', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fetchEnabled: true, searchEndpoint: 'https://search.example.com/query', searchApiKey: '${FAKE_SEARCH_KEY}' }) }).then((r) => r.status)`,
	);
	if (putStatus !== 200) throw new Error(`启用网页查询失败：PUT /api/settings/connectors/web 回 ${putStatus}`);
	await cdp("Page.navigate", { url: `${BASE}/` }, sessionId);
	await waitFor(bodyHas("待批收件箱"), "启用后刷新主界面出现");
	await clickText("设置", { maxX: 264 });
	await waitFor(bodyHas("先选服务商，再填该服务商的 API Key 接入"), "启用后设置-模型组出现");
	await clickText("连接器");
	await waitFor(bodyHas("GitHub"), "启用后设置-连接器组出现");
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

	// L0-6：一次 web_fetch 工具卡——刷新回主界面（默认选中主 bot）、让它打开夹具页
	await cdp("Page.navigate", { url: `${BASE}/` }, sessionId);
	await waitFor(bodyHas("待批收件箱"), "刷新后主界面出现");
	await waitFor(`document.querySelector('textarea') !== null`, "主 bot 对话输入框出现");
	await evaluate(`document.querySelector('textarea').focus()`);
	await cdp("Input.insertText", { text: `打开 http://127.0.0.1:${FIXTURE_PORT}/page 看看里面写了什么` }, sessionId);
	await clickText("发送");
	await waitFor(bodyHas("web_fetch"), "对话里出现 web_fetch 工具卡", 30000);
	await waitFor(bodyHas("紫水晶海豹"), "助手回答引用到夹具特征句", 30000);
	// 三合一：一轮调用在页面上只能有一张工具卡（标题 span 恰好一个），且已是 Completed 终态；
	// 展开卡片能看到结果摘要行「HTTP 200」。
	await waitFor(
		`[...document.querySelectorAll('span.font-medium')].filter((el) => el.textContent === 'web_fetch').length === 1 && document.body.innerText.includes('Completed')`,
		"工具卡合并为一张且状态 Completed",
		30000,
	);
	await clickText("web_fetch");
	await waitFor(bodyHas("HTTP 200"), "展开工具卡看到结果摘要 HTTP 200", 30000);
	await new Promise((r) => setTimeout(r, 800));
	await shot("11-chat-web-fetch-tool.png");

	// 持久化：刷新页面后工具卡从会话历史还原（仍是一张、仍可展开看摘要）
	await cdp("Page.navigate", { url: `${BASE}/` }, sessionId);
	await waitFor(bodyHas("待批收件箱"), "刷新后主界面出现");
	await waitFor(
		`[...document.querySelectorAll('span.font-medium')].filter((el) => el.textContent === 'web_fetch').length === 1 && document.body.innerText.includes('Completed')`,
		"刷新后工具卡从历史还原为一张 Completed 卡",
		30000,
	);
	await clickText("web_fetch");
	await waitFor(bodyHas("HTTP 200"), "刷新后展开工具卡仍看到结果摘要 HTTP 200", 30000);
	await new Promise((r) => setTimeout(r, 800));
	await shot("13-chat-tool-card-after-reload.png");

	// 思考链（15）：当前已保存配置是 deepseek-flash + thinkingLevel=high（截图 14
	// 的种子），向主 bot 发一个会触发 stub 分段分支的问题——同轮两段思考：第一段
	// 被 web_fetch 工具调用打断、第二段在工具结果后、正文之前。回合结束两段都应
	// 自动折叠为摘要行「已思考 Ns · 约 M 字」；点开第二段摘要，能看到左侧弱化
	// 竖条内的推理全文。
	await waitFor(`document.querySelector('textarea') !== null`, "主 bot 对话输入框出现（思考截图）");
	await evaluate(`document.querySelector('textarea').focus()`);
	await cdp("Input.insertText", { text: `先想一想：打开 http://127.0.0.1:${FIXTURE_PORT}/page 看看里面写了什么` }, sessionId);
	await clickText("发送");
	await waitFor(bodyHas("紫水晶海豹"), "分段回合的正文出现（引用夹具特征句）", 30000);
	await waitFor(
		`(document.body.innerText.match(/已思考/g) ?? []).length >= 2`,
		"两段思考都已折叠为摘要行「已思考 Ns · 约 M 字」",
		30000,
	);
	await evaluate(
		`(() => { const btns = [...document.querySelectorAll('button')].filter((b) => b.textContent.includes('已思考')); const b = btns[btns.length - 1]; b?.scrollIntoView({ block: "center" }); b?.click(); return btns.length; })()`,
	);
	await waitFor(bodyHas("再结合页面想一想"), "点开第二段摘要看到弱化竖条内的推理全文", 30000);
	await new Promise((r) => setTimeout(r, 800));
	await shot("15-chat-thinking.png");

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
