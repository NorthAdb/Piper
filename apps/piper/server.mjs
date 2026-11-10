// Piper 雏形服务端：Node 内置 http，零框架依赖。
// API 契约（JSON；chat 为 SSE）：
// POST /api/login {token} 单口令登录，种 cookie 会话
// GET /api/session {authenticated, modelConfigured}
// GET /api/bots bot 列表（主 bot 置顶）
// POST /api/bots 界面填卡建 bot
// PUT /api/bots/:id 编辑 bot
// DELETE /api/bots/:id 删除 bot（主 bot 不可删）
// POST /api/bots/draft-confirm {draft} 草案卡确认落库（未确认不落库）
// GET /api/bots/:id/messages 该 bot 的会话流水（JSONL 读出）
// GET /api/about-me 账号级「关于我」全文
// POST /api/chat {botId, message} SSE 流式对话（事件见下方 sse 注释）
// GET /api/routines routine 列表（含上次运行）
// POST /api/routines/morning-scan/run 手动跑晨间扫描，生成日报产物
// GET /api/artifacts 产物列表
// GET /api/artifacts/:id 产物正文
// GET /api/approvals 待批收件箱（雏形占位，恒为空数组）
// GET /api/memory/:botId 该 bot 记忆（memory.md，只读）
// GET /api/settings/model 模型设置读回（configured/baseUrl/modelId/apiKeyHint，绝无 Key 全文）
// PUT /api/settings/model 保存模型设置（部分字段可单独更新；apiKey 传空串清除），保存即热生效
// POST /api/settings/model/test 用已保存或请求体候选配置打一次最小请求，回 {ok} 或 {ok:false,error}
//
// POST /api/chat 的 SSE 事件（event 名 + JSON data）：
// session {botId, sessionId} 本轮开始
// delta {text} 模型流式增量文本
// tool {phase, name, detail} 工具/内核事件（前端折叠卡渲染）
// system {kind, text} 系统提示（如草案已生成、兜底说明）
// draft {draft} Bot 草案卡：{name, systemPrompt, tools, repos, memoryScope, source}
// error {code, message} code=MODEL_NOT_CONFIGURED 时 message 明确写「未配置模型」
// done {botId} 本轮结束
import { createServer} from "node:http";
import { randomBytes} from "node:crypto";
import { existsSync, readFileSync} from "node:fs";
import { join, extname} from "node:path";
import {
APP_DIR,
ensureData,
listBots,
getBot,
createBot,
updateBot,
deleteBot,
readAboutMe,
appendSession,
readSession,
listRoutines,
updateRoutine,
saveArtifact,
listArtifacts,
readArtifact,
readBotMemory,
} from "./lib/store.mjs";
import { modelConfig, streamChat, testModelConfig, extractDraftWithModel, extractDraftByRules, looksLikeCreateBotIntent} from "./lib/kernel.mjs";
import { saveModelSettingsFile} from "./lib/settings.mjs";
import { runMorningScan} from "./lib/scan.mjs";

const PORT = Number(process.env.PORT || 4310);
const TOKEN = process.env.PIPER_TOKEN || "piper-dev";
const sessions = new Set();

ensureData();

function sendJson(res, status, obj) {
const body = JSON.stringify(obj);
res.writeHead(status, { "Content-Type": "application/json; charset=utf-8"});
res.end(body);
}

function parseCookies(req) {
const out = {};
for (const part of String(req.headers.cookie || "").split(";")) {
const i = part.indexOf("=");
if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
}
return out;
}

function isAuthed(req) {
const cookie = parseCookies(req).piper_session;
if (cookie && sessions.has(cookie)) return true;
return req.headers.authorization === `Bearer ${TOKEN}`;
}

async function readBody(req) {
const chunks = [];
for await (const c of req) chunks.push(c);
const raw = Buffer.concat(chunks).toString("utf8");
return raw? JSON.parse(raw): {};
}

// 模型设置对外视图：只暴露是否已配置、端点、模型名与 Key 末四位掩码，绝不含 Key 全文。
function modelSettingsView() {
const cfg = modelConfig();
return {
configured: cfg.configured,
baseUrl: cfg.baseUrl,
modelId: cfg.modelId,
apiKeyHint: cfg.apiKey? `••••${cfg.apiKey.slice(-4)}`: "",
};
}

function sse(res) {
res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive"});
return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleChat(req, res) {
const { botId, message} = await readBody(req);
const bot = getBot(String(botId || ""));
if (!bot) return sendJson(res, 404, { error: "bot 不存在"});
if (!message || typeof message!== "string") return sendJson(res, 400, { error: "message 必填"});
const emit = sse(res);
const sessionId = `s-${Date.now().toString(36)}`;
emit("session", { botId: bot.id, sessionId});
appendSession(bot.id, { role: "user", text: message, sessionId});

// 主 bot 建 bot：对话里识别建 bot 意图 -> 生成草案卡，未确认不落库（规格二）
if (bot.canManageBots && looksLikeCreateBotIntent(message)) {
const draft = (await extractDraftWithModel(message))?? extractDraftByRules(message);
appendSession(bot.id, { role: "system", kind: "draft", text: `生成 Bot 草案卡：${draft.name}`, draft});
emit("system", { kind: "draft", text: `已按你的描述生成 Bot 草案卡（来源：${draft.source === "model"? "模型抽取": "规则兜底"}），确认后才会创建。`});
emit("draft", { draft});
emit("done", { botId: bot.id});
return res.end();
}

const history = readSession(bot.id);
try {
const { text} = await streamChat({
systemPrompt: `${bot.systemPrompt}\n\n\n${readAboutMe()}`,
history,
message,
onEvent: (e) => {
if (e.type === "delta") emit("delta", { text: e.text});
else if (e.type === "tool") emit("tool", { phase: e.phase, name: e.name, detail: e.detail});
},
});
appendSession(bot.id, { role: "assistant", text, sessionId});
} catch (err) {
appendSession(bot.id, { role: "system", kind: "error", text: err.message, code: err.code?? "ERROR"});
emit("error", { code: err.code?? "ERROR", message: err.message});
}
emit("done", { botId: bot.id});
res.end();
}

const server = createServer(async (req, res) => {
const url = new URL(req.url, `http://${req.headers.host}`);
const path = url.pathname;
try {
if (path === "/api/login" && req.method === "POST") {
const { token} = await readBody(req);
if (token!== TOKEN) return sendJson(res, 401, { error: "口令不正确"});
const sid = randomBytes(24).toString("hex");
sessions.add(sid);
res.writeHead(200, {
"Content-Type": "application/json; charset=utf-8",
"Set-Cookie": `piper_session=${sid}; HttpOnly; Path=/; SameSite=Lax`,
});
return res.end(JSON.stringify({ ok: true}));
}
if (path.startsWith("/api/")) {
if (!isAuthed(req)) return sendJson(res, 401, { error: "未登录"});
if (path === "/api/session") return sendJson(res, 200, { authenticated: true, modelConfigured: modelConfig().configured});
if (path === "/api/settings/model" && req.method === "GET") return sendJson(res, 200, modelSettingsView());
if (path === "/api/settings/model" && req.method === "PUT") {
const body = await readBody(req);
const patch = {};
if (typeof body.baseUrl === "string") patch.baseUrl = body.baseUrl;
if (typeof body.modelId === "string") patch.modelId = body.modelId;
if (typeof body.apiKey === "string") patch.apiKey = body.apiKey;
saveModelSettingsFile(patch);
return sendJson(res, 200, modelSettingsView());
}
if (path === "/api/settings/model/test" && req.method === "POST") {
const body = await readBody(req);
const overrides = {};
if (typeof body.baseUrl === "string" && body.baseUrl) overrides.baseUrl = body.baseUrl;
if (typeof body.modelId === "string" && body.modelId) overrides.modelId = body.modelId;
if (typeof body.apiKey === "string" && body.apiKey) overrides.apiKey = body.apiKey;
return sendJson(res, 200, await testModelConfig(overrides));
}
if (path === "/api/bots" && req.method === "GET") return sendJson(res, 200, { bots: listBots()});
if (path === "/api/bots" && req.method === "POST") return sendJson(res, 201, { bot: createBot(await readBody(req))});
if (path === "/api/bots/draft-confirm" && req.method === "POST") {
const { draft} = await readBody(req);
if (!draft ||!draft.name) return sendJson(res, 400, { error: "draft 必填且需含 name"});
const bot = createBot(draft);
appendSession("piper-main", { role: "system", kind: "bot-created", text: `草案确认，已创建 bot：${bot.name}（${bot.id}）`});
return sendJson(res, 201, { bot});
}
const botMatch = path.match(/^\/api\/bots\/([\w-]+)$/);
if (botMatch && req.method === "PUT") {
const bot = updateBot(botMatch[1], await readBody(req));
return bot? sendJson(res, 200, { bot}): sendJson(res, 404, { error: "bot 不存在"});
}
if (botMatch && req.method === "DELETE") {
return deleteBot(botMatch[1])? sendJson(res, 200, { ok: true}): sendJson(res, 404, { error: "bot 不存在"});
}
const msgMatch = path.match(/^\/api\/bots\/([\w-]+)\/messages$/);
if (msgMatch && req.method === "GET") return sendJson(res, 200, { messages: readSession(msgMatch[1])});
if (path === "/api/about-me" && req.method === "GET") return sendJson(res, 200, { markdown: readAboutMe()});
if (path === "/api/chat" && req.method === "POST") return await handleChat(req, res);
if (path === "/api/routines" && req.method === "GET") return sendJson(res, 200, { routines: listRoutines()});
if (path === "/api/routines/morning-scan/run" && req.method === "POST") {
const routine = listRoutines().find((r) => r.id === "morning-scan");
const bot = getBot(routine?.botId || "repo-keeper");
const repos = bot?.repos?.length? bot.repos: ["NorthAdb/LinkForge", "NorthAdb/Loom"];
const { artifact, report} = await runMorningScan({ repos, botId: bot?.id?? "repo-keeper", saveArtifact});
updateRoutine("morning-scan", { lastRunAt: new Date().toISOString(), lastArtifactId: artifact.id, lastStatus: "ok"});
if (bot) appendSession(bot.id, { role: "system", kind: "routine", text: `晨间仓库扫描完成，日报：${artifact.title}`});
return sendJson(res, 200, { artifact, report});
}
if (path === "/api/artifacts" && req.method === "GET") return sendJson(res, 200, { artifacts: listArtifacts()});
const artMatch = path.match(/^\/api\/artifacts\/([\w.-]+)$/);
if (artMatch && req.method === "GET") {
const art = readArtifact(artMatch[1]);
return art? sendJson(res, 200, { artifact: art}): sendJson(res, 404, { error: "产物不存在"});
}
if (path === "/api/approvals" && req.method === "GET") return sendJson(res, 200, { approvals: []});
const memMatch = path.match(/^\/api\/memory\/([\w-]+)$/);
if (memMatch && req.method === "GET") {
if (!getBot(memMatch[1])) return sendJson(res, 404, { error: "bot 不存在"});
return sendJson(res, 200, { botId: memMatch[1], markdown: readBotMemory(memMatch[1]), aboutMe: readAboutMe()});
}
return sendJson(res, 404, { error: "接口不存在"});
}
// 静态：单页前端
const file = path === "/"? join(APP_DIR, "public", "index.html"): join(APP_DIR, "public", path);
if (!file.startsWith(join(APP_DIR, "public")) ||!existsSync(file)) return sendJson(res, 404, { error: "not found"});
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript"};
res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream"});
return res.end(readFileSync(file));
} catch (err) {
return sendJson(res, err.status || 500, { error: err.message});
}
});

server.listen(PORT, () => {
console.log(`Piper prototype listening on http://localhost:${PORT} (token: ${process.env.PIPER_TOKEN? "from env": "default piper-dev"}, model: ${modelConfig().configured? "configured": "NOT configured"})`);
});
