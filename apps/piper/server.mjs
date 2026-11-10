// Piper 雏形服务端：Node 内置 http，零框架依赖。
// API 契约（JSON；chat 为 SSE）：
// POST /api/login {token} 单口令登录，种 cookie 会话（同来源连续 11 次错口令后锁定 60 秒，超限回 429）
// 监听与写请求守卫（R2）：默认只监听 127.0.0.1，PIPER_HOST 显式放开；未设 PIPER_TOKEN
// （默认口令）且监听非回环地址时进程拒绝启动。所有写方法（POST/PUT/PATCH/DELETE）
// 校验 Origin（有则必须与 Host 同源，不符 403）并要求 Content-Type: application/json
// （不符 415）；会话 Cookie 为 SameSite=Strict。
// GET /api/session {authenticated, modelConfigured}
// GET /api/bots bot 列表（主 bot 置顶）
// POST /api/bots 界面填卡建 bot
// PUT /api/bots/:id 编辑 bot
// DELETE /api/bots/:id 删除 bot（主 bot 不可删）
// POST /api/bots/draft-confirm {draft} 草案卡确认落库（未确认不落库）
// GET /api/bots/:id/messages 该 bot 的会话流水（JSONL 读出）
// GET /api/about-me 账号级「关于我」全文
// POST /api/chat {botId, message} SSE 流式对话（事件见下方 sse 注释）
// GET /api/routines routine 列表（含上次运行；morning-scan 附带 nextRunAt）
// POST /api/routines/morning-scan/run 手动跑晨间扫描，生成日报产物（与定时触发同一执行函数；正在运行时回 409）
// GET /api/schedule/status 定时调度只读状态（时区、下次运行、上次运行/结果、是否运行中、补跑次数）
// 定时（P1-4）：进程内调度，默认每天 08:00（routines.schedule 的 "HH:MM"），时区读基础资料；
// 失败在 15 分钟内最多补跑 3 次；启动时今日已过点且未成功则补跑一次（lib/schedule.mjs）
// GET /api/artifacts 产物列表
// GET /api/artifacts/:id 产物正文
// GET /api/approvals 待批收件箱（读真实存储——带 writeIntent 的 open/approved/executing Finding 的审批视图，含 approvalId 与 intentHash）
// POST /api/approvals/:id/approve {intentHash} 批准并经薄网关执行批准快照（P1-6 + R1）：回 { approval, execution }；
//   intentHash 与当前内容不一致回 409「内容已变，请重新查看」；正在 executing 回 409；
//   执行失败时 Finding 保持 approved、execution 带 reason，再次批准即重试
// POST /api/approvals/:id/reject 驳回（状态 rejected，不产生任何对外写操作）
// GET /api/audit 网关审计记录（可按 findingId 过滤）：denied / approved / executing / executed / failed / rejected
// GET /api/findings Finding 列表（只读，可按 status/repo/botId 过滤）
// GET /api/findings/:id 单条 Finding（不存在 404）
// GET /api/memory/:botId 该 bot 记忆（memory.md，只读）
// GET /api/settings/model 模型设置读回（configured/baseUrl/modelId/apiKeyHint，绝无 Key 全文）
// PUT /api/settings/model 保存模型设置（部分字段可单独更新；apiKey 传空串清除），保存即热生效
// POST /api/settings/model/test 用已保存或请求体候选配置打一次最小请求，回 {ok} 或 {ok:false,error}
// GET /api/settings/profile 基础资料读回（displayName/timezone，时区缺省 Asia/Hong_Kong；
//   存量文件里的非法时区回落缺省并在日志提示一次，不把坏值交给调度层）
// PUT /api/settings/profile 保存基础资料（部分字段可单独更新；时区非法回 400 且文件不变，R3）
// PUT /api/about-me 写入账号级「关于我」（需登录；与 GET 同源一份 about-me.md；超 20000 字符回 413，原文件不动）
// GET /api/settings/connectors 连接器列表（统一形状；GitHub 带 tokenHint 末四位掩码，绝无令牌全文）
// PUT /api/settings/connectors/github 保存 GitHub 令牌（token 传空串清除），保存即被 scan 使用
// GET /api/notifications 应用内通知列表（新在前）+ 未读数；扫描成功写 routine.completed、整轮失败写 routine.failed
// POST /api/notifications/read 标记已读：{ids:[...]} 只标记这些，无 ids 则全部标记
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
writeAboutMe,
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
import { addNotification, countUnread, listNotifications, markNotificationsRead} from "./lib/notify.mjs";
import { listConnectors, readProfileSettings, saveGithubSettingsFile, saveModelSettingsFile, saveProfileSettings, secretHint} from "./lib/settings.mjs";
import { redact } from "./lib/redact.mjs";
import { runMorningScan} from "./lib/scan.mjs";
import { getFinding, listFindings} from "./lib/findings.mjs";
import { createScheduler, formatScheduleText, migrateScheduleFields, parseScheduleTime, profileTimezone} from "./lib/schedule.mjs";
import { approveApproval, listApprovals, rejectApproval} from "./lib/approvals.mjs";
import { listAudit} from "./lib/audit.mjs";

const PORT = Number(process.env.PORT || 4310);
const HOST = process.env.PIPER_HOST || "127.0.0.1";
const TOKEN = process.env.PIPER_TOKEN || "piper-dev";
const USING_DEFAULT_TOKEN = !process.env.PIPER_TOKEN;
const sessions = new Set();

function isLoopbackHost(host) {
return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

// 默认口令只允许回环监听：非回环 + 默认口令的组合会把可写网关与设置面直接暴露给
// 局域网，进程拒绝启动并写明原因（R2）。显式设置 PIPER_TOKEN 后可自由放开监听。
if (USING_DEFAULT_TOKEN && !isLoopbackHost(HOST)) {
console.error(`拒绝启动：未设置 PIPER_TOKEN 时使用默认口令，只允许回环监听（127.0.0.1），但 PIPER_HOST=${HOST}。请先设置 PIPER_TOKEN 环境变量再放开监听地址。`);
process.exit(1);
}

// 常驻进程底线（R3）：未处理的 Promise 拒绝只记日志、不退出——调度 tick、扫描等
// 后台路径的一次异常不该把整个服务带走。同步异常仍走各路径自己的 try/catch。
process.on("unhandledRejection", (err) => {
console.error(`[piper] unhandledRejection（已记录，进程继续运行）：${err?.stack ?? err}`);
});

// 登录限速（R2）：同一来源连续错口令超过 10 次后锁定 60 秒，锁定期间一律 429；
// 登录成功清零计数。来源以 TCP 对端地址计（单用户单进程，内存态即可）。
const loginAttempts = new Map();
function loginLocked(source) {
const entry = loginAttempts.get(source);
return Boolean(entry && entry.lockedUntil > Date.now());
}
function noteLoginFailure(source) {
const entry = loginAttempts.get(source) || { fails: 0, lockedUntil: 0 };
entry.fails += 1;
if (entry.fails > 10) entry.lockedUntil = Date.now() + 60 * 1000;
loginAttempts.set(source, entry);
}

// 写请求守卫（R2）：跨站表单/脚本不得驱动本服务的任何写接口。Origin 有则必须与
// Host 同源（不符 403）；Content-Type 必须是 application/json（不符 415）。
// 无 Origin 的非浏览器客户端（curl、脚本、回归）不受影响。
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
function writeGuardViolation(req) {
const origin = req.headers.origin;
if (origin) {
let originHost = null;
try {
originHost = new URL(origin).host;
} catch {
originHost = null;
}
if (originHost !== req.headers.host) return { status: 403, error: "跨源请求被拒绝（Origin 与 Host 不一致）" };
}
const contentType = String(req.headers["content-type"] || "").toLowerCase();
if (!contentType.startsWith("application/json")) return { status: 415, error: "写请求要求 Content-Type: application/json" };
return null;
}

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
apiKeyHint: secretHint(cfg.apiKey),
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
// 错误文本进会话 JSONL 与 SSE 前统一脱敏+截断（R7）：内核已在源头处理厂商错误，
// 这里是其余错误路径的兜底出口。
const safeMessage = redact(String(err?.message?? err)).slice(0, 300);
appendSession(bot.id, { role: "system", kind: "error", text: safeMessage, code: err.code?? "ERROR"});
emit("error", { code: err.code?? "ERROR", message: safeMessage});
}
emit("done", { botId: bot.id});
res.end();
}

// ---------- 晨间扫描执行（手动触发与定时调度共用同一条路径，L0-5 通知语义只写一份） ----------
// 重入防护：同一时刻只允许一轮扫描；已有运行在途时返回 { skipped: true }，手动路由据此回 409、
// 调度器据此跳过本 tick。整轮失败（全部仓库取证失败）不报成功：状态记 failed 并发失败通知；
// 意料外抛错同样记 failed + 通知后把错误回传（手动路由保持原 500 行为）。
let scanInFlight = false;

async function executeMorningScan() {
if (scanInFlight) return { skipped: true};
scanInFlight = true;
try {
const routine = listRoutines().find((r) => r.id === "morning-scan");
const bot = getBot(routine?.botId || "repo-keeper");
const repos = bot?.repos?.length? bot.repos: ["NorthAdb/LinkForge", "NorthAdb/Loom"];
const routineName = routine?.name?? "晨间仓库扫描";
try {
const { artifact, report, failures, total, findings} = await runMorningScan({ repos, botId: bot?.id?? "repo-keeper", saveArtifact});
// 新开的带 writeIntent 的 Finding 即新的待批写操作（P1-6）：逐条写 approval.pending 通知。
for (const f of findings) {
if (f.writeIntent) addNotification({ type: "approval.pending", title: `待批写操作：${f.title}`, body: `建议在 ${f.repo} 的 PR #${f.writeIntent.prNumber} 下发表模板评论，请到待批收件箱批准或驳回。证据：${f.evidenceUrl}`, routineId: "morning-scan", artifactId: artifact.id, findingId: f.id});
}
if (total > 0 && failures >= total) {
updateRoutine("morning-scan", { lastRunAt: new Date().toISOString(), lastArtifactId: artifact.id, lastStatus: "failed"});
addNotification({ type: "routine.failed", title: `${routineName}失败`, body: `${total} 个仓库全部取证失败，详情见日报：${artifact.title}`, routineId: "morning-scan", artifactId: artifact.id});
if (bot) appendSession(bot.id, { role: "system", kind: "routine", text: `晨间仓库扫描失败（全部仓库取证失败），日报：${artifact.title}`});
return { failed: true, artifact, report, findings};
}
if (failures > 0) {
// 部分仓失败（R6）：整轮不算失败，但状态记 partial、通知写明几个仓失败，不许把「扫了一半」报成全绿的 ok。
updateRoutine("morning-scan", { lastRunAt: new Date().toISOString(), lastArtifactId: artifact.id, lastStatus: "partial"});
addNotification({ type: "routine.completed", title: `${routineName}已完成（部分失败）`, body: `日报：${artifact.title}（${total} 个仓库中 ${failures} 个取证失败，原因见日报；本轮新开 ${findings.length} 条待拍板事项）`, routineId: "morning-scan", artifactId: artifact.id});
if (bot) appendSession(bot.id, { role: "system", kind: "routine", text: `晨间仓库扫描完成（${failures}/${total} 个仓库取证失败），日报：${artifact.title}`});
return { failed: false, partial: true, artifact, report, findings};
}
updateRoutine("morning-scan", { lastRunAt: new Date().toISOString(), lastArtifactId: artifact.id, lastStatus: "ok"});
addNotification({ type: "routine.completed", title: `${routineName}已完成`, body: `日报：${artifact.title}（本轮新开 ${findings.length} 条待拍板事项，见日报开头的拍板清单）`, routineId: "morning-scan", artifactId: artifact.id});
if (bot) appendSession(bot.id, { role: "system", kind: "routine", text: `晨间仓库扫描完成，日报：${artifact.title}`});
return { failed: false, artifact, report, findings};
} catch (err) {
updateRoutine("morning-scan", { lastRunAt: new Date().toISOString(), lastStatus: "failed"});
addNotification({ type: "routine.failed", title: `${routineName}失败`, body: String(err.message?? err), routineId: "morning-scan"});
return { failed: true, error: err};
}
} finally {
scanInFlight = false;
}
}

// ---------- 定时调度（P1-4）：进程内，启动时迁移旧版 schedule 文本并装配 ----------

function morningRoutine() {
return listRoutines().find((r) => r.id === "morning-scan")?? null;
}

{
const routine = morningRoutine();
if (routine) {
const migrated = migrateScheduleFields(routine, profileTimezone());
if (migrated) updateRoutine(routine.id, migrated);
}
}

const scheduler = createScheduler({
run: async () => {
const result = await executeMorningScan();
return result.skipped? "skipped": result.failed? "failed": "ok";
},
getRoutineState: () => morningRoutine()?? {},
timezoneFn: () => profileTimezone(),
timeFn: () => parseScheduleTime(morningRoutine()?.schedule)?? parseScheduleTime("08:00"),
// 调度自身异常（如时区换算失败）不杀进程：记日志并落一条 routine.failed 通知（R3）。
onError: (err) => {
console.error(`[piper] 调度 tick 异常（已拦截，进程继续运行）：${err?.stack ?? err}`);
addNotification({ type: "routine.failed", title: "晨间仓库扫描调度异常", body: String(err?.message?? err), routineId: "morning-scan"});
},
});

const server = createServer(async (req, res) => {
const url = new URL(req.url, `http://${req.headers.host}`);
const path = url.pathname;
try {
if (path.startsWith("/api/") && WRITE_METHODS.has(req.method)) {
const violation = writeGuardViolation(req);
if (violation) return sendJson(res, violation.status, { error: violation.error});
}
if (path === "/api/login" && req.method === "POST") {
const source = req.socket.remoteAddress || "unknown";
if (loginLocked(source)) return sendJson(res, 429, { error: "登录尝试过于频繁，请 60 秒后再试"});
const { token} = await readBody(req);
if (token!== TOKEN) {
noteLoginFailure(source);
return sendJson(res, 401, { error: "口令不正确"});
}
loginAttempts.delete(source);
const sid = randomBytes(24).toString("hex");
sessions.add(sid);
res.writeHead(200, {
"Content-Type": "application/json; charset=utf-8",
"Set-Cookie": `piper_session=${sid}; HttpOnly; Path=/; SameSite=Strict`,
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
const hasBaseUrl = typeof body.baseUrl === "string" && Boolean(body.baseUrl);
const hasApiKey = typeof body.apiKey === "string" && Boolean(body.apiKey);
// R7：请求体给了 baseUrl 就必须同时给 apiKey——否则会把已保存的 Key 发往请求体
// 指定的地址，等于一个现成的 Key 外送口。baseUrl 本身也只许 http/https。
if (hasBaseUrl && !hasApiKey) return sendJson(res, 400, { error: "指定 baseUrl 时必须同时提供 apiKey（不会把已保存的 Key 发往请求体给定的地址）"});
if (hasBaseUrl && !/^https?:\/\//i.test(body.baseUrl.trim())) return sendJson(res, 400, { error: "baseUrl 必须是 http/https 地址"});
const overrides = {};
if (hasBaseUrl) overrides.baseUrl = body.baseUrl;
if (typeof body.modelId === "string" && body.modelId) overrides.modelId = body.modelId;
if (hasApiKey) overrides.apiKey = body.apiKey;
return sendJson(res, 200, await testModelConfig(overrides));
}
if (path === "/api/settings/connectors" && req.method === "GET") return sendJson(res, 200, { connectors: listConnectors()});
if (path === "/api/settings/connectors/github" && req.method === "PUT") {
const body = await readBody(req);
if (typeof body.token!== "string") return sendJson(res, 400, { error: "token 必填且须为字符串（空串表示清除）"});
saveGithubSettingsFile({ token: body.token});
return sendJson(res, 200, { connector: listConnectors().find((c) => c.id === "github")});
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
if (path === "/api/about-me" && req.method === "PUT") {
const body = await readBody(req);
if (typeof body.markdown!== "string") return sendJson(res, 400, { error: "markdown 必填且须为字符串"});
return sendJson(res, 200, { markdown: writeAboutMe(body.markdown)});
}
if (path === "/api/settings/profile" && req.method === "GET") return sendJson(res, 200, readProfileSettings());
if (path === "/api/settings/profile" && req.method === "PUT") {
const body = await readBody(req);
const patch = {};
if (typeof body.displayName === "string") patch.displayName = body.displayName;
if (typeof body.timezone === "string") patch.timezone = body.timezone;
return sendJson(res, 200, saveProfileSettings(patch));
}
if (path === "/api/chat" && req.method === "POST") return await handleChat(req, res);
if (path === "/api/routines" && req.method === "GET") {
const tz = profileTimezone();
const status = scheduler.status(new Date());
return sendJson(res, 200, {
routines: listRoutines().map((r) => {
if (r.id!== "morning-scan") return r;
const time = parseScheduleTime(r.schedule)?? parseScheduleTime("08:00");
return { ...r, scheduleText: formatScheduleText(time, tz), nextRunAt: status.nextRunAt};
}),
});
}
if (path === "/api/schedule/status" && req.method === "GET") {
const s = scheduler.status(new Date());
return sendJson(res, 200, { timezone: s.timezone, routines: [{ id: "morning-scan", nextRunAt: s.nextRunAt, nextRetryAt: s.nextRetryAt, running: s.running, attempts: s.attempts, lastRunAt: s.lastRunAt, lastStatus: s.lastStatus}]});
}
if (path === "/api/routines/morning-scan/run" && req.method === "POST") {
const result = await executeMorningScan();
if (result.skipped) return sendJson(res, 409, { error: "晨间扫描正在运行中，请稍后再试"});
if (result.error) throw result.error;
return sendJson(res, 200, result.failed? { artifact: result.artifact, report: result.report, failed: true, findings: result.findings}: { artifact: result.artifact, report: result.report, findings: result.findings});
}
if (path === "/api/notifications" && req.method === "GET") return sendJson(res, 200, { notifications: listNotifications(), unread: countUnread()});
if (path === "/api/notifications/read" && req.method === "POST") {
const body = await readBody(req);
markNotificationsRead(Array.isArray(body.ids)? body.ids: undefined);
return sendJson(res, 200, { notifications: listNotifications(), unread: countUnread()});
}
if (path === "/api/artifacts" && req.method === "GET") return sendJson(res, 200, { artifacts: listArtifacts()});
const artMatch = path.match(/^\/api\/artifacts\/([\w.-]+)$/);
if (artMatch && req.method === "GET") {
const art = readArtifact(artMatch[1]);
return art? sendJson(res, 200, { artifact: art}): sendJson(res, 404, { error: "产物不存在"});
}
if (path === "/api/approvals" && req.method === "GET") return sendJson(res, 200, { approvals: listApprovals()});
const approvalMatch = path.match(/^\/api\/approvals\/([\w-]+)\/(approve|reject)$/);
if (approvalMatch && req.method === "POST") {
if (approvalMatch[2] === "approve") {
const body = await readBody(req);
const out = await approveApproval(approvalMatch[1], { intentHash: typeof body.intentHash === "string"? body.intentHash: undefined});
return out? sendJson(res, 200, { approval: out.approval, execution: out.execution}): sendJson(res, 404, { error: "待批项不存在"});
}
const approval = rejectApproval(approvalMatch[1]);
return approval? sendJson(res, 200, { approval}): sendJson(res, 404, { error: "待批项不存在"});
}
if (path === "/api/audit" && req.method === "GET") {
const findingId = url.searchParams.get("findingId");
return sendJson(res, 200, { records: listAudit(findingId? { findingId}: {})});
}
if (path === "/api/findings" && req.method === "GET") {
const filters = {};
for (const key of ["status", "repo", "botId"]) {
const v = url.searchParams.get(key);
if (v) filters[key] = v;
}
return sendJson(res, 200, { findings: listFindings(filters)});
}
const findingMatch = path.match(/^\/api\/findings\/([\w-]+)$/);
if (findingMatch && req.method === "GET") {
const finding = getFinding(findingMatch[1]);
return finding? sendJson(res, 200, { finding}): sendJson(res, 404, { error: "Finding 不存在"});
}
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
return sendJson(res, err.status || 500, { error: redact(String(err?.message?? err))});
}
});

server.listen(PORT, HOST, () => {
console.log(`Piper prototype listening on http://${HOST}:${PORT} (token: ${process.env.PIPER_TOKEN? "from env": "default piper-dev"}, model: ${modelConfig().configured? "configured": "NOT configured"})`);
// 定时调度启动：先 tick 一次（处理启动补跑与首次规划），之后每 30 秒推进状态机。
void scheduler.tick(new Date());
const timer = setInterval(() => void scheduler.tick(new Date()), 30 * 1000);
timer.unref();
});
