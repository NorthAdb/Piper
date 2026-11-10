// L0-6 / R11 网页查询离线测试：web.fetch 的 SSRF 拦截、重定向逐跳复检、DNS 钉住、
// 截断上限，以及经本地 stub 模型的工具链路（主 bot 可用、其他 bot 调不到）。
// 用法（在 apps/piper 下）：node scripts/test-webfetch.mjs（或 npm run test:webfetch）
// 全程不打活网：单元部分用注入的 lookup/transport 替身计数；实抓部分用本地夹具
// HTTP 服务，经 PIPER_WEB_FETCH_TEST_ALLOW 测试缝放行夹具的 host:port（仅测试进程）。
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FEATURE = "夹具特征句：紫水晶海豹在屋顶上读报纸。";
const SEARCH_KEY = "sk-websearch-1234567890zxcv";
const MODEL_KEY = "sk-webfetch-model-12345678abcd";

const results = [];
let seq = 0;
function check(name, ok, detail = "") {
	seq += 1;
	results.push({ seq, name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${String(seq).padStart(2, "0")} ${name}${ok ? "" : ` — ${detail}`}`);
}

const { isBlockedAddress, webFetch } = await import("../lib/webfetch.mjs");

// ---------- 1. 地址判定表 ----------
const blockedIps = ["127.0.0.1", "127.1.2.3", "0.0.0.0", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "169.254.0.1", "100.64.0.1", "224.0.0.1", "::1", "::", "fe80::1", "febf::ffff", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8".replace("8.8.8.8", "10.0.0.9")];
const allowedIps = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "172.15.0.1", "192.169.0.1", "2606:2800:220:1:248:1893:25c8:1946", "::ffff:8.8.8.8"];
check(
	"isBlockedAddress：回环/私网/链路本地/元数据/CGNAT/组播/IPv6 等价地址全拦，公网地址放行",
	blockedIps.every((ip) => isBlockedAddress(ip) === true) && allowedIps.every((ip) => isBlockedAddress(ip) === false),
	`拦错=${blockedIps.filter((ip) => !isBlockedAddress(ip))} 放错=${allowedIps.filter((ip) => isBlockedAddress(ip))}`,
);

// ---------- 2. 替身层：拦截发生在出站之前 ----------
function stubDeps(resolveMap) {
	const state = { transportCalls: 0, connectedTo: [] };
	const lookupAll = async (hostname) => {
		const v = resolveMap[hostname];
		if (!v) throw new Error(`ENOTFOUND ${hostname}`);
		return v;
	};
	const transport = async (url, pinned) => {
		state.transportCalls += 1;
		state.connectedTo.push(pinned?.[0] ?? null);
		return { status: 200, headers: { "content-type": "text/html" }, body: `<html><body><p>${FEATURE}</p></body></html>`, downloadTruncated: false };
	};
	return { state, lookupAll, transport };
}

async function expectBlocked(name, url, resolveMap) {
	const { state, lookupAll, transport } = stubDeps(resolveMap);
	let err = null;
	try {
		await webFetch(url, { lookupAll, transport });
	} catch (e) {
		err = e;
	}
	check(
		name,
		err?.code === "WEB_FETCH_BLOCKED" && err.message === "不允许访问该地址" && state.transportCalls === 0,
		`err=${err?.code}/${err?.message} transport=${state.transportCalls}`,
	);
}

await expectBlocked("SSRF：域名解析到 10.0.0.1 在出站前被拦（替身计数 0、原因不摊地址）", "http://evil-a.example/", { "evil-a.example": ["10.0.0.1"] });
await expectBlocked("SSRF：域名解析到 169.254.169.254（云元数据）在出站前被拦", "http://evil-b.example/latest/meta-data", { "evil-b.example": ["169.254.169.254"] });
await expectBlocked("SSRF：localhost 解析到回环在出站前被拦", "http://localhost/admin", { localhost: ["127.0.0.1", "::1"] });
await expectBlocked("SSRF：IP 字面量 192.168.1.1 在出站前被拦", "http://192.168.1.1/", { "192.168.1.1": ["192.168.1.1"] });
await expectBlocked("SSRF：IPv6 字面量 [::1] 在出站前被拦", "http://[::1]/", { "::1": ["::1"] });
await expectBlocked("SSRF：非 http/https 协议（file/ftp）在出站前被拦", "ftp://example.com/", { "example.com": ["93.184.216.34"] });

// DNS 钉住：校验后解析结果变化（rebinding）也不影响——连接只去校验过的地址
{
	const answers = [["93.184.216.34"], ["10.0.0.1"]];
	let call = 0;
	const state = { transportCalls: 0, connectedTo: [] };
	const lookupAll = async () => answers[Math.min(call++, answers.length - 1)];
	const transport = async (url, pinned) => {
		state.transportCalls += 1;
		state.connectedTo.push(pinned?.[0] ?? null);
		return { status: 200, headers: { "content-type": "text/plain" }, body: FEATURE, downloadTruncated: false };
	};
	const out = await webFetch("http://rebind.example/page", { lookupAll, transport });
	check(
		"DNS 钉住：校验通过后即使再解析变私网，连接仍只去已校验的公网地址",
		out.text.includes(FEATURE) && state.connectedTo[0] === "93.184.216.34",
		`connectedTo=${state.connectedTo}`,
	);
}

// 重定向逐跳复检
{
	const { state, lookupAll } = stubDeps({ "a.example": ["93.184.216.34"], "10.0.0.1": ["10.0.0.1"] });
	let n = 0;
	const transport = async () => {
		n += 1;
		state.transportCalls = n;
		return { status: 302, headers: { location: "http://10.0.0.1/admin" }, body: "", downloadTruncated: false };
	};
	let err = null;
	try {
		await webFetch("http://a.example/go", { lookupAll, transport });
	} catch (e) {
		err = e;
	}
	check("重定向到私网：第二跳在出站前被拦（transport 只调用 1 次）", err?.code === "WEB_FETCH_BLOCKED" && n === 1, `err=${err?.code} transport=${n}`);
}
{
	const { lookupAll } = stubDeps({ "a.example": ["93.184.216.34"], "b.example": ["8.8.8.8"] });
	let n = 0;
	const transport = async (url) => {
		n += 1;
		if (String(url).includes("a.example")) return { status: 302, headers: { location: "http://b.example/final" }, body: "", downloadTruncated: false };
		return { status: 200, headers: { "content-type": "text/html" }, body: `<p>${FEATURE}</p>`, downloadTruncated: false };
	};
	const out = await webFetch("http://a.example/go", { lookupAll, transport });
	check("重定向到公网：两跳后正常取回正文", out.text.includes(FEATURE) && n === 2 && out.url === "http://b.example/final", `n=${n} url=${out.url}`);
}

// 截断：超大正文 → 注入文本 ≤8000 且标明截断
{
	const { lookupAll, transport } = stubDeps({ "big.example": ["8.8.8.8"] });
	const bigTransport = async () => ({ status: 200, headers: { "content-type": "text/plain" }, body: "x".repeat(50000), downloadTruncated: true });
	const out = await webFetch("http://big.example/huge", { lookupAll, transport: bigTransport });
	check("超大响应：注入文本 ≤8000 字且 truncated 标明", out.text.length <= 8000 && out.truncated === true, `len=${out.text.length} truncated=${out.truncated}`);
}

// ---------- 3. 本地夹具 HTTP 服务实抓（测试缝放行夹具 host:port） ----------
let fixtureHits = 0;
const fixture = createServer((reqHttp, resHttp) => {
	fixtureHits += 1;
	const u = new URL(reqHttp.url ?? "/", "http://fixture.invalid");
	if (u.pathname === "/page") {
		resHttp.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		resHttp.end(`<html><head><title>夹具页</title><style>.x{}</style><script>var a=1;</script></head><body><h1>示例文档</h1><p>${FEATURE}</p></body></html>`);
	} else if (u.pathname === "/big") {
		resHttp.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
		resHttp.end("y".repeat(2 * 1024 * 1024));
	} else if (u.pathname === "/redir-private") {
		resHttp.writeHead(302, { Location: "http://10.0.0.1/secret" });
		resHttp.end();
	} else if (u.pathname === "/search") {
		resHttp.writeHead(200, { "Content-Type": "application/json" });
		resHttp.end(JSON.stringify({ results: [{ title: "Piper 搜索结果标题", url: "https://example.com/piper", snippet: "关于 Piper 的说明片段" }] }));
	} else {
		resHttp.statusCode = 404;
		resHttp.end("not found");
	}
});
await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
const FIX_PORT = fixture.address().port;
const FIX_BASE = `http://127.0.0.1:${FIX_PORT}`;
process.env.PIPER_WEB_FETCH_TEST_ALLOW = `127.0.0.1:${FIX_PORT}`;

{
	const out = await webFetch(`${FIX_BASE}/page`);
	check("夹具实抓：特征句页取回可见文本（脚本/样式已剥离）", out.text.includes(FEATURE) && !out.text.includes("var a=1"), `text=${out.text.slice(0, 80)}`);
}
{
	const before = fixtureHits;
	let err = null;
	try {
		await webFetch(`${FIX_BASE}/redir-private`);
	} catch (e) {
		err = e;
	}
	check("夹具 302 到私网：被拦且只命中夹具一次（第二跳未出站）", err?.code === "WEB_FETCH_BLOCKED" && fixtureHits === before + 1, `err=${err?.code} hits=${fixtureHits - before}`);
}
{
	const out = await webFetch(`${FIX_BASE}/big`);
	check("夹具超大响应（2MB）：下载在上限处截断、注入 ≤8000 且标明", out.truncated === true && out.text.length <= 8000, `len=${out.text.length} truncated=${out.truncated}`);
}
{
	// 关掉测试缝后，同一个回环地址必须被拦（证明缝只在测试进程内生效）
	delete process.env.PIPER_WEB_FETCH_TEST_ALLOW;
	const before = fixtureHits;
	let err = null;
	try {
		await webFetch(`${FIX_BASE}/page`);
	} catch (e) {
		err = e;
	}
	check("无测试缝时回环地址照样被拦（出站计数 0）", err?.code === "WEB_FETCH_BLOCKED" && fixtureHits === before, `err=${err?.code} hitsDelta=${fixtureHits - before}`);
	process.env.PIPER_WEB_FETCH_TEST_ALLOW = `127.0.0.1:${FIX_PORT}`;
}

// ---------- 4. 对话链路：stub 模型 + 被测 server ----------
const ghStub = createServer((reqHttp, resHttp) => {
	const u = new URL(reqHttp.url ?? "/", "http://stub.invalid");
	resHttp.setHeader("Content-Type", "application/json");
	let payload;
	if (u.pathname.includes("/actions/runs")) payload = { workflow_runs: [] };
	else if (/\/(commits|pulls|issues)$/.test(u.pathname) || u.pathname.includes("/reviews")) payload = [];
	else if (/^\/repos\/[^/]+\/[^/]+$/.test(u.pathname)) payload = { stargazers_count: 1, forks_count: 0, default_branch: "main", pushed_at: "2026-11-10T00:00:00Z" };
	else {
		resHttp.statusCode = 404;
		payload = { message: "Not Found" };
	}
	resHttp.end(JSON.stringify(payload));
});
await new Promise((r) => ghStub.listen(0, "127.0.0.1", r));
const GH_BASE = `http://127.0.0.1:${ghStub.address().port}`;

const modelRequests = [];
const modelStub = createServer((reqHttp, resHttp) => {
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
		modelRequests.push(body);
		const model = body.model || "stub-model";
		const toolNames = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
		const messages = body.messages ?? [];
		const last = messages[messages.length - 1] ?? {};
		const lastUser = [...messages].reverse().find((m) => m.role === "user");
		const userText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
		const sendChunks = (chunks, finish) => {
			resHttp.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
			const chunk = (delta, finishReason = null) =>
				`data: ${JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1762732800, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
			resHttp.write(chunk({ role: "assistant" }));
			for (const d of chunks) resHttp.write(chunk(d));
			resHttp.write(chunk({}, finish));
			resHttp.end("data: [DONE]\n\n");
		};
		if (!body.stream) {
			resHttp.writeHead(200, { "Content-Type": "application/json" });
			resHttp.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1762732800, model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
			return;
		}
		if (last.role === "tool") {
			const toolText = typeof last.content === "string" ? last.content : JSON.stringify(last.content ?? "");
			sendChunks([{ content: `工具结果要点：${toolText.slice(0, 300)}` }], "stop");
			return;
		}
		const urlMatch = /https?:\/\/[^\s"']+/.exec(userText);
		if (urlMatch && toolNames.includes("web.fetch") && userText.includes("打开")) {
			const args = JSON.stringify({ url: urlMatch[0] });
			sendChunks(
				[
					{ tool_calls: [{ index: 0, id: "call_fetch", type: "function", function: { name: "web.fetch", arguments: "" } }] },
					{ tool_calls: [{ index: 0, function: { arguments: args } }] },
				],
				"tool_calls",
			);
			return;
		}
		if (toolNames.includes("web.search") && userText.includes("搜索")) {
			const args = JSON.stringify({ query: "Piper 是什么" });
			sendChunks(
				[
					{ tool_calls: [{ index: 0, id: "call_search", type: "function", function: { name: "web.search", arguments: "" } }] },
					{ tool_calls: [{ index: 0, function: { arguments: args } }] },
				],
				"tool_calls",
			);
			return;
		}
		sendChunks([{ content: "好的（无工具可用时的普通回复）。" }], "stop");
	});
});
await new Promise((r) => modelStub.listen(0, "127.0.0.1", r));
const MODEL_BASE = `http://127.0.0.1:${modelStub.address().port}/v1`;

const TMP_ROOT = mkdtempSync(join(tmpdir(), "piper-webfetch-"));
const TMP_DATA = join(TMP_ROOT, "data");
const PORT = Number(process.env.WEBFETCH_PORT || 4396);
const BASE = `http://127.0.0.1:${PORT}`;
const env = {
	...process.env,
	PORT: String(PORT),
	PIPER_DATA_DIR: TMP_DATA,
	PIPER_GITHUB_API_BASE: GH_BASE,
	PIPER_WEB_FETCH_TEST_ALLOW: `127.0.0.1:${FIX_PORT}`,
};
delete env.PIPER_TOKEN;
delete env.PIPER_HOST;
for (const k of ["PIPER_MODEL_API_KEY", "OPENAI_API_KEY", "PIPER_MODEL_BASE_URL", "PIPER_MODEL_ID", "GITHUB_TOKEN"]) delete env[k];
const proc = spawn("node", ["server.mjs"], { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
proc.stdout.on("data", (d) => (serverLog += d));
proc.stderr.on("data", (d) => (serverLog += d));

let cookie = "";
async function req(path, init = {}) {
	const res = await fetch(BASE + path, { ...init, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(init.headers || {}) } });
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		/* 非 JSON */
	}
	return { status: res.status, json, text };
}
async function chatEvents(botId, message) {
	const res = await fetch(`${BASE}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Cookie: cookie },
		body: JSON.stringify({ botId, message }),
		signal: AbortSignal.timeout(60000),
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
async function waitReady() {
	for (let i = 0; i < 60; i++) {
		if (proc.exitCode !== null) return false;
		try {
			const res = await fetch(`${BASE}/api/bots`);
			if (res.status === 401) return true;
		} catch {
			/* 还没起来 */
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}
const lastStreamRequest = () => [...modelRequests].reverse().find((b) => b.stream);
const toolsOf = (b) => (b?.tools ?? []).map((t) => t.function?.name ?? t.name);

try {
	check("被测 server 在隔离目录启动成功", await waitReady(), serverLog.slice(-400));
	const login = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "piper-dev" }) });
	cookie = (login.headers.get("set-cookie") || "").split(";")[0];
	check("登录成功", login.status === 200 && Boolean(cookie), `实际 ${login.status}`);

	await req("/api/settings/model", { method: "PUT", body: JSON.stringify({ baseUrl: MODEL_BASE, modelId: "stub-model", apiKey: MODEL_KEY }) });

	// 未启用时：主 bot 也没有 web.fetch
	await chatEvents("piper-main", `打开 ${FIX_BASE}/page 看看`);
	check(
		"未启用网页查询时主 bot 的请求里没有 web.fetch 工具、无 tool 事件",
		!toolsOf(lastStreamRequest()).includes("web.fetch"),
		`tools=${JSON.stringify(toolsOf(lastStreamRequest()))}`,
	);

	// 启用抓取（不配搜索）
	const putWeb = await req("/api/settings/connectors/web", { method: "PUT", body: JSON.stringify({ fetchEnabled: true }) });
	const list1 = await req("/api/settings/connectors");
	const web1 = (list1.json?.connectors ?? []).find((c) => c.id === "web");
	check(
		"PUT 启用后网页查询卡 connected、可用范围含主 bot、configurable=true",
		putWeb.status === 200 && web1?.status === "connected" && web1?.configurable === true && (web1?.bots ?? []).includes("piper-main"),
		`put=${putWeb.status} card=${JSON.stringify(web1)}`,
	);

	// 主 bot 真调 web.fetch 取夹具页并引用特征句
	const ev1 = await chatEvents("piper-main", `打开 ${FIX_BASE}/page 看看里面写了什么`);
	const toolEvents = ev1.filter((e) => e.event === "tool");
	const assistantText = ev1.filter((e) => e.event === "delta").map((e) => e.data?.text ?? "").join("");
	check(
		"主 bot 对话出现 web.fetch 的 tool 事件（SSE tool 事件名不变）",
		toolEvents.some((e) => e.data?.name === "web.fetch"),
		`toolEvents=${JSON.stringify(toolEvents.map((t) => t.data?.name))}`,
	);
	check(
		"助手回答引用到夹具特征句（工具结果已回喂模型）",
		assistantText.includes("紫水晶海豹"),
		`text=${assistantText.slice(0, 120)}`,
	);

	// 其他 bot：工具根本不在请求里（调不到），无 tool 事件
	const ev2 = await chatEvents("repo-keeper", `打开 ${FIX_BASE}/page 看看里面写了什么`);
	check(
		"仓库管家（不在可用范围）的请求里没有 web.fetch、无 tool 事件",
		!toolsOf(lastStreamRequest()).includes("web.fetch") && !ev2.some((e) => e.event === "tool"),
		`tools=${JSON.stringify(toolsOf(lastStreamRequest()))}`,
	);

	// SSRF 经对话：回环非放行端口 → 工具结果为通用拒绝口径
	const ev3 = await chatEvents("piper-main", "打开 http://127.0.0.1:9/secret 看看");
	const toolReq = lastStreamRequest();
	const toolMsg = [...(toolReq?.messages ?? [])].reverse().find((m) => m.role === "tool");
	const toolText = typeof toolMsg?.content === "string" ? toolMsg.content : JSON.stringify(toolMsg?.content ?? "");
	check(
		"对话里抓回环地址：工具结果只说「不允许访问该地址」，不摊内部地址细节",
		toolText.includes("不允许访问该地址"),
		`toolText=${toolText.slice(0, 160)}`,
	);

	// 搜索：未配置端点时没有 web.search 工具
	await chatEvents("piper-main", "搜索一下 Piper 是什么");
	check("未配置搜索端点时请求里没有 web.search 工具", !toolsOf(lastStreamRequest()).includes("web.search"), `tools=${JSON.stringify(toolsOf(lastStreamRequest()))}`);

	// 配置搜索端点+密钥：读回只有掩码、响应与会话不含密钥全文
	const putSearch = await req("/api/settings/connectors/web", {
		method: "PUT",
		body: JSON.stringify({ searchEndpoint: `${FIX_BASE}/search`, searchApiKey: SEARCH_KEY }),
	});
	const list2 = await req("/api/settings/connectors");
	const web2 = (list2.json?.connectors ?? []).find((c) => c.id === "web");
	check(
		"保存搜索配置后读回只有末四位掩码、响应不含密钥全文",
		putSearch.status === 200 &&
			web2?.searchConfigured === true &&
			String(web2?.searchKeyHint ?? "").endsWith("zxcv") &&
			!JSON.stringify(list2.json).includes(SEARCH_KEY),
		`card=${JSON.stringify(web2)}`,
	);
	const ev4 = await chatEvents("piper-main", "搜索一下 Piper 是什么");
	const assistantText4 = ev4.filter((e) => e.event === "delta").map((e) => e.data?.text ?? "").join("");
	check(
		"配置搜索后主 bot 出现 web.search tool 事件且回答带搜索结果标题",
		ev4.some((e) => e.event === "tool" && e.data?.name === "web.search") && assistantText4.includes("Piper 搜索结果标题"),
		`text=${assistantText4.slice(0, 120)}`,
	);
	const sessionFile = join(TMP_DATA, "sessions", "piper-main.jsonl");
	const sessionText = existsSync(sessionFile) ? readFileSync(sessionFile, "utf8") : "";
	check(
		"会话 JSONL 不含搜索密钥与模型 Key 全文",
		sessionText.length > 0 && !sessionText.includes(SEARCH_KEY) && !sessionText.includes(MODEL_KEY),
		`len=${sessionText.length}`,
	);

	// 非法搜索端点被拒
	const badPut = await req("/api/settings/connectors/web", { method: "PUT", body: JSON.stringify({ searchEndpoint: "ftp://example.com/x" }) });
	check("搜索端点非 http/https 时 PUT 回 400", badPut.status === 400, `实际 ${badPut.status}`);
} finally {
	proc.kill("SIGTERM");
	ghStub.close();
	modelStub.close();
	fixture.close();
	rmSync(TMP_ROOT, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
	console.log(`server 输出（节选）：\n${serverLog.slice(-800)}`);
	process.exit(1);
}
