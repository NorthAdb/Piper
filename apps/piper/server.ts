// Piper 雏形服务端：Node 内置 http，零框架依赖。
// API 契约（JSON；chat 为 SSE）：
// POST /api/login {token} 单口令登录，种 cookie 会话（同来源连续 11 次错口令后锁定 60 秒，超限回 429）
// 监听与写请求守卫（R2）：默认只监听 127.0.0.1，PIPER_HOST 显式放开；使用默认口令
// （PIPER_TOKEN 未设、为空或显式设为 piper-dev，按值比较，F3）且监听非回环地址时进程拒绝启动。所有写方法（POST/PUT/PATCH/DELETE）
// 校验 Origin（有则必须与 Host 同源，不符 403）并要求 Content-Type: application/json
// （不符 415）；会话 Cookie 为 SameSite=Strict。
// GET /api/session {authenticated, modelConfigured}
// GET /api/bots bot 列表（主 bot 置顶）
// POST /api/bots 界面填卡建 bot
// PUT /api/bots/:id 编辑 bot
// DELETE /api/bots/:id 删除 bot（主 bot 不可删）
// POST /api/bots/draft-confirm {draft} 草案卡确认落库（未确认不落库）
// GET /api/bots/:id/messages 该 bot 的会话流水（JSONL 读出）
// GET /api/bots/:id/trace 轨迹数据（PR-D，lib/trace.ts）：会话流水按轮归一化为
//   {turns:[{index,startedAt,endedAt,durationMs,events}]}，时间统一 epoch 毫秒、
//   无证据为 null；bot 不存在回 404（与 /api/memory/:botId 同口径）
// GET /api/about-me 账号级「关于我」全文
// POST /api/chat {botId, message} SSE 流式对话（事件见下方 sse 注释）
// GET /api/routines routine 列表（含上次运行；morning-scan 附带 nextRunAt）
// POST /api/routines/morning-scan/run 手动跑晨间扫描，生成日报产物（与定时触发同一执行函数；正在运行时回 409）
// GET /api/schedule/status 定时调度只读状态（时区、下次运行、上次运行/结果、是否运行中、补跑次数）
// 定时（P1-4）：进程内调度，默认每天 08:00（routines.schedule 的 "HH:MM"），时区读基础资料；
// 失败在 15 分钟内最多补跑 3 次；启动时今日已过点且未成功则补跑一次（lib/schedule.ts）
// GET /api/artifacts 产物列表（支持 ?botId= 按 bot 过滤，桌面产物走服务端过滤，R10）
// GET /api/artifacts/:id 产物正文
// GET /api/approvals 待批收件箱（读真实存储——带 writeIntent 的 open/approved/executing Finding 的审批视图，含 approvalId 与 intentHash）；纯读无写副作用，过期清理由扫描开始与调度周期显式执行（R10）
// POST /api/approvals/:id/approve {intentHash} 批准并经薄网关执行批准快照（P1-6 + R1）：回 { approval, execution }；
//   intentHash 与当前内容不一致回 409「内容已变，请重新查看」；正在 executing 回 409；
//   执行失败时 Finding 保持 approved、execution 带 reason，再次批准即重试
// POST /api/approvals/:id/reject 驳回（状态 rejected，不产生任何对外写操作）
// GET /api/audit 网关审计记录（可按 findingId 过滤）：denied / approved / executing / executed / failed / rejected
// GET /api/findings Finding 列表（只读，可按 status/repo/botId 过滤）
// GET /api/findings/:id 单条 Finding（不存在 404）
// GET /api/memory/:botId 该 bot 记忆（memory.md，只读）
// GET /api/model-providers 模型服务商目录只读（派生自 pi-ai 内置目录，只含内核兼容的 openai-completions 服务商 + custom）
// GET /api/settings/model 模型设置读回（configured/provider/baseUrl/modelId/apiKeyHint，绝无 Key 全文；
//   旧文件无 provider、或 provider 已不在目录中，按 custom 读回；另带 thinkingLevel 已存挡位
//   与 thinkingLevels 当前模型可选挡位，派生自 pi-ai 目录，目录外模型回落全词表）
// PUT /api/settings/model 保存模型设置（部分字段可单独更新；apiKey 传空串清除；provider 须为目录 id、
//   thinkingLevel 须为七挡词表内的值，未知均回 400 且文件不变），保存即热生效
// POST /api/settings/model/test 用已保存或请求体候选配置打一次最小请求，回 {ok} 或 {ok:false,error}
// POST /api/settings/model/fetch-models 用表单端点与 Key 拉取端点 /models 的模型名单；缺省 Key 时只许端点
//   与已保存配置完全一致时复用已保存 Key（R7 守卫），回 {ok:true,models} 或 {ok:false,status,error}
// GET /api/settings/profile 基础资料读回（displayName/timezone，时区缺省 Asia/Hong_Kong；
//   存量文件里的非法时区回落缺省并在日志提示一次，不把坏值交给调度层）
// PUT /api/settings/profile 保存基础资料（部分字段可单独更新；时区非法回 400 且文件不变，R3）
// PUT /api/about-me 写入账号级「关于我」（需登录；与 GET 同源一份 about-me.md；超 20000 字符回 413，原文件不动）
// GET /api/settings/connectors 连接器列表（统一形状；GitHub 带 tokenHint 末四位掩码，绝无令牌全文）
// PUT /api/settings/connectors/github 保存 GitHub 令牌（token 传空串清除），保存即被 scan 使用
// PUT /api/settings/connectors/web 保存网页查询设置（fetchEnabled 开关、searchEndpoint、searchApiKey；
//   端点只许 http/https，密钥传空串清除；读回只在连接器卡上给 searchConfigured/searchEndpoint/末四位掩码）
// GET /api/notifications 应用内通知列表（新在前）+ 未读数；扫描成功写 routine.completed、整轮失败写 routine.failed
// POST /api/notifications/read 标记已读：{ids:[...]} 只标记这些，无 ids 则全部标记
//
// POST /api/chat 的 SSE 事件（event 名 + JSON data）：
// session {botId, sessionId} 本轮开始
// delta {text} 模型流式增量文本
// thinking {text, level, seg, segStart?} 思考链增量（刻意扩展的新事件；思考挡位非 off 且
//   服务商回传推理时才有，与正文 delta 分开，前端按 seg 拼成独立的思考段渲染；
//   level 是生效挡位，seg 是本轮段号，segStart 只在每段首个增量上出现）
// tool {phase, name, toolCallId, detail} 工具/内核事件（前端折叠卡渲染）
// system {kind, text} 系统提示（如草案已生成、兜底说明）
// draft {draft} Bot 草案卡：{name, systemPrompt, tools, repos, memoryScope, source}
// error {code, message} code=MODEL_NOT_CONFIGURED 时 message 明确写「未配置模型」
// done {botId} 本轮结束
import { createServer} from "node:http";
import type { IncomingMessage, ServerResponse} from "node:http";
import { randomBytes} from "node:crypto";
import { existsSync, readFileSync} from "node:fs";
import { join, extname} from "node:path";
import {
APP_DIR,
acquireDataLock,
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
} from "./lib/store.ts";
import { modelConfig, streamChat, testModelConfig, extractDraftWithModel, extractDraftByRules, looksLikeCreateBotIntent, webToolsForBot} from "./lib/kernel.ts";
import type { ChatEvent} from "./lib/kernel.ts";
import type { ArtifactMeta, Routine, SessionEntry} from "./lib/store.ts";
import type { Finding} from "./lib/findings.ts";
import type { ModelSettings} from "./lib/settings.ts";
import { addNotification, countUnread, listNotifications, markNotificationsRead} from "./lib/notify.ts";
import { isThinkingLevel, listConnectors, readModelSettingsFile, readProfileSettings, saveGithubSettingsFile, saveModelSettingsFile, saveProfileSettings, saveWebSettingsFile, secretHint} from "./lib/settings.ts";
import { fetchUpstreamModels, isKnownModelProvider, loadModelProviders, resolveModelProviderId, thinkingLevelsFor} from "./lib/model-providers.ts";
import { redact } from "./lib/redact.ts";
import { buildTrace} from "./lib/trace.ts";
import { runMorningScan} from "./lib/scan.ts";
import { getFinding, listFindings} from "./lib/findings.ts";
import { createScheduler, formatScheduleText, migrateScheduleFields, parseScheduleTime, profileTimezone} from "./lib/schedule.ts";
import { approveApproval, listApprovals, recoverInterruptedExecutions, rejectApproval, sweepExpiredFindings} from "./lib/approvals.ts";
import { listAudit} from "./lib/audit.ts";

const PORT = Number(process.env.PORT || 4310);
const HOST = process.env.PIPER_HOST || "127.0.0.1";
const DEFAULT_TOKEN = "piper-dev";
const TOKEN = process.env.PIPER_TOKEN || DEFAULT_TOKEN;
// 「使用默认口令」按值比较（F3，第二轮返工）：未设、设为空串（回落默认值）、或
// 显式 PIPER_TOKEN=piper-dev 都算默认口令——只看变量有没有设会让显式写出默认值
// 的部署绕过下面的非回环拒启。
const USING_DEFAULT_TOKEN = TOKEN === DEFAULT_TOKEN;
const sessions = new Set<string>();

function isLoopbackHost(host: string): boolean {
return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

// 默认口令只允许回环监听：非回环 + 默认口令的组合会把可写网关与设置面直接暴露给
// 局域网，进程拒绝启动并写明原因（R2）。把 PIPER_TOKEN 设置为非默认值后可自由放开监听。
if (USING_DEFAULT_TOKEN && !isLoopbackHost(HOST)) {
console.error(`拒绝启动：当前使用默认口令（PIPER_TOKEN 未设置、为空或显式设为 piper-dev），只允许回环监听（127.0.0.1），但 PIPER_HOST=${HOST}。请先把 PIPER_TOKEN 设置为非默认值再放开监听地址。`);
process.exit(1);
}

// 常驻进程底线（R3）：未处理的 Promise 拒绝只记日志、不退出——调度 tick、扫描等
// 后台路径的一次异常不该把整个服务带走。同步异常仍走各路径自己的 try/catch。
process.on("unhandledRejection", (err) => {
console.error(`[piper] unhandledRejection（已记录，进程继续运行）：${(err as { stack?: string } | null | undefined)?.stack ?? err}`);
});

// 登录限速（R2）：同一来源连续错口令超过 10 次后锁定 60 秒，锁定期间一律 429；
// 登录成功清零计数。来源以 TCP 对端地址计（单用户单进程，内存态即可）。
const loginAttempts = new Map<string, { fails: number; lockedUntil: number }>();
function loginLocked(source: string): boolean {
const entry = loginAttempts.get(source);
return Boolean(entry && entry.lockedUntil > Date.now());
}
function noteLoginFailure(source: string): void {
const entry = loginAttempts.get(source) || { fails: 0, lockedUntil: 0 };
entry.fails += 1;
if (entry.fails > 10) entry.lockedUntil = Date.now() + 60 * 1000;
loginAttempts.set(source, entry);
}

// 写请求守卫（R2）：跨站表单/脚本不得驱动本服务的任何写接口。Origin 有则必须与
// Host 同源（不符 403）；Content-Type 必须是 application/json（不符 415）。
// 无 Origin 的非浏览器客户端（curl、脚本、回归）不受影响。
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
function writeGuardViolation(req: IncomingMessage): { status: number; error: string } | null {
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

// 双进程防护（R10）：同一数据目录只允许一个服务进程（锁在 lib/store.ts）。
// 已有存活进程时拒绝启动；持有者退出（含信号）时释放，陈旧锁自动接管。
let releaseDataLock: () => void;
try {
releaseDataLock = acquireDataLock();
} catch (err) {
console.error(`拒绝启动：${(err as Error).message}`);
process.exit(1);
}
process.on("exit", () => releaseDataLock());
for (const sig of ["SIGINT", "SIGTERM"]) {
process.on(sig, () => {
releaseDataLock();
process.exit(0);
});
}

// executing 崩溃恢复（F1）：上一进程若在网关执行途中死亡，Finding 会卡在 executing。
// 本进程刚起、数据锁在手，不可能有别的活进程在执行——残留的 executing 全量退回
// approved 并写审计 failed/interrupted，不自动重发（用户再批准时网关靠标记查重防双发）。
{
const recovered = recoverInterruptedExecutions({ olderThanMs: 0 });
if (recovered > 0) console.log(`[piper] 启动恢复：${recovered} 条卡在 executing 的 Finding 已退回 approved（审计 failed/interrupted）`);
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
const body = JSON.stringify(obj);
res.writeHead(status, { "Content-Type": "application/json; charset=utf-8"});
res.end(body);
}

function parseCookies(req: IncomingMessage): Record<string, string> {
const out: Record<string, string> = {};
for (const part of String(req.headers.cookie || "").split(";")) {
const i = part.indexOf("=");
if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
}
return out;
}

function isAuthed(req: IncomingMessage): boolean {
const cookie = parseCookies(req).piper_session;
if (cookie && sessions.has(cookie)) return true;
return req.headers.authorization === `Bearer ${TOKEN}`;
}

// 请求体是 wire 边界：解析结果以 any 交给各路由逐字段校验（全仓统一口径）。
async function readBody(req: IncomingMessage): Promise<any> {
const chunks: Buffer[] = [];
for await (const c of req) chunks.push(c);
const raw = Buffer.concat(chunks).toString("utf8");
return raw? JSON.parse(raw): {};
}

// 模型设置对外视图：只暴露是否已配置、端点、模型名与 Key 末四位掩码，绝不含 Key 全文。
// provider 归属与思考挡位支持集要查 pi-ai 派生目录（异步加载），所以本函数是 async。
// thinkingLevel 是已存的选择（存量不因模型支持集而改写，生效值由内核 clamp）；
// thinkingLevels 是当前 (provider, modelId) 可选的挡位（目录外模型回落全词表）。
async function modelSettingsView() {
const cfg = modelConfig();
const provider = await resolveModelProviderId(readModelSettingsFile());
return {
configured: cfg.configured,
provider,
baseUrl: cfg.baseUrl,
modelId: cfg.modelId,
apiKeyHint: secretHint(cfg.apiKey),
thinkingLevel: cfg.thinkingLevel,
thinkingLevels: await thinkingLevelsFor(provider, cfg.modelId),
};
}

function sse(res: ServerResponse): (event: string, data: unknown) => boolean {
res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive"});
return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
res.end();
return;
}

// 工具调用落盘前的深脱敏：会话 JSONL 是秘密禁入面，appendSession 只脱 text 字段，
// tool 条目的 args/result 是结构化字段，落盘前逐个字符串过 redact()（复用统一出口）。
function redactDeep(value: unknown): unknown {
if (typeof value === "string") return redact(value);
if (Array.isArray(value)) return value.map(redactDeep);
if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
return value;
}

// 本轮的思考段与工具条目共用一个递增 seq：条目定型时按事件发生顺序领号，
// 回合结束按 seq 排序一并落盘，前端刷新回来据此还原与直播一致的交错顺序。
let leadSeq = 0;
const leadThinkingEntries: SessionEntry[] = [];

// 本轮工具调用按 toolCallId 收集：直播事件只透传不落盘，回合结束时把最终态逐条写进
// 会话流水、排在 assistant（或 error）条目之前，前端刷新/切 bot 回来据此还原工具卡。
// end 事件到达时领 seq（与思考段的定型顺序共用一本账），决定它在流水中的位置。
// 轨迹时间（PR-D）：同时记事件时刻——firstSeenAt 是服务端首次观察到该调用
// （call 阶段）的时刻，startedAt 是 start 阶段（工具开始执行）的时刻，
// endedAt 是 end 阶段的时刻；落盘时在 persistLead 里定型为
// startedAt/endedAt/durationMs（缺失回落口径见那里）。
interface ToolRec {
toolCallId: string;
name: string;
args: unknown;
status: string;
result: unknown;
seq: number | undefined;
firstSeenAt: number | undefined;
startedAt: number | undefined;
endedAt: number | undefined;
}
const toolCalls = new Map<string, ToolRec>();
const collectTool = (e: ChatEvent & { type: "tool" }): void => {
const id = e.toolCallId || `${e.name}:${toolCalls.size}`;
const rec: ToolRec = toolCalls.get(id) ?? { toolCallId: id, name: e.name, args: null, status: "running", result: null, seq: undefined, firstSeenAt: undefined, startedAt: undefined, endedAt: undefined };
if (rec.firstSeenAt === undefined) rec.firstSeenAt = Date.now();
if (e.name) rec.name = e.name;
if (e.phase === "start" && rec.startedAt === undefined) rec.startedAt = Date.now();
if (e.phase === "end") {
rec.status = (e.detail as { isError?: unknown } | null | undefined)?.isError ? "error" : "complete";
rec.result = e.detail ?? null;
rec.endedAt = Date.now();
if (rec.seq === undefined) rec.seq = leadSeq++;
} else if (e.detail != null) {
rec.args = e.detail;
}
toolCalls.set(id, rec);
};

// 思考链落盘（按段定型）：直播时逐段透传 SSE thinking 事件（带生效挡位 level
// 与段号 seg），服务端按事件流切段——段在工具事件、正文 delta 或回合结束时
// 关闭；关闭时定型为一条 role:"thinking" 条目，带 seq（与 tool 条目共用）、
// durationMs（段首个 thinking 事件到段关闭）、startedAt（段首个 thinking
// 事件的时刻，轨迹时间用，PR-D）与 level（生效挡位）。空段（只有
// 空白）不落盘。单段文本落盘上限 THINKING_PERSIST_MAX_CHARS，超出截断并以
// truncated 标明；text 字段由 appendSession 统一过 redact（与 tool 条目同一
// 秘密禁入面）。思考不回喂模型（kernel 的 toPiMessages 只取 user/assistant
// 条目）。旧落盘形状（整轮一条、无 seq/durationMs/level）由前端读回兼容。
const THINKING_PERSIST_MAX_CHARS = 16_000;
let openSeg: { text: string; startedAt: number; level: string; index: number } | null = null;
let segIndex = 0;
const closeThinkingSeg = (): void => {
if (!openSeg) return;
const seg = openSeg;
openSeg = null;
if (!seg.text.trim()) return;
const truncated = seg.text.length > THINKING_PERSIST_MAX_CHARS;
leadThinkingEntries.push({
role: "thinking",
text: truncated ? seg.text.slice(0, THINKING_PERSIST_MAX_CHARS) : seg.text,
truncated,
seq: leadSeq++,
durationMs: Math.max(0, Date.now() - seg.startedAt),
startedAt: seg.startedAt,
level: seg.level,
sessionId,
});
};

// 回合收尾落盘：先关掉仍开着的思考段，再把思考段与工具条目按 seq 合并排序
// 逐条写进会话流水（排在 assistant 或 error 条目之前）。
const persistLead = (): void => {
closeThinkingSeg();
const toolEntries: SessionEntry[] = [];
for (const rec of toolCalls.values()) {
if (rec.seq === undefined) rec.seq = leadSeq++;
// 轨迹时间定型（PR-D）：endedAt 取 end 事件时刻；回合结束仍无 end 的中断
// 调用以收尾落盘时刻为 endedAt（口径：至少持续到回合结束）。startedAt 取
// start 阶段时刻，缺失回落首次观察时刻（call 阶段），再缺失回落 endedAt
// （durationMs=0）。durationMs 恒为 endedAt - startedAt（不为负）。
const endedAt = rec.endedAt ?? Date.now();
const startedAt = rec.startedAt ?? rec.firstSeenAt ?? endedAt;
toolEntries.push({
role: "tool",
toolCallId: rec.toolCallId,
name: rec.name,
args: redactDeep(rec.args),
// 回合已结束仍无 end 事件的调用视为中断，落盘为 error 而不是永远 running
status: rec.status === "running" ? "error" : rec.status,
result: redactDeep(rec.result),
seq: rec.seq,
startedAt,
endedAt,
durationMs: Math.max(0, endedAt - startedAt),
sessionId,
});
}
for (const entry of [...leadThinkingEntries, ...toolEntries].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
appendSession(bot.id, entry);
}
};

const history = readSession(bot.id);
try {
const { text} = await streamChat({
systemPrompt: `${bot.systemPrompt}\n\n\n${readAboutMe()}`,
history,
message,
tools: webToolsForBot(bot),
onEvent: (e) => {
if (e.type === "delta") {
// 正文出现即关闭当前思考段（思考→正文→思考是两段，不是一段）
closeThinkingSeg();
emit("delta", { text: e.text});
}
else if (e.type === "thinking") {
if (!openSeg) openSeg = { text: "", startedAt: Date.now(), level: e.level ?? "off", index: segIndex++ };
const segStart = openSeg.text.length === 0;
openSeg.text += e.text;
emit("thinking", { text: e.text, level: openSeg.level, seg: openSeg.index, ...(segStart ? { segStart: true } : {}) });
}
else if (e.type === "tool") {
// 工具调用打断思考段：先关段，工具条目在 end 时领到更大的 seq，顺序不乱
closeThinkingSeg();
collectTool(e);
emit("tool", { phase: e.phase, name: e.name, toolCallId: e.toolCallId, detail: e.detail});
}
},
});
persistLead();
appendSession(bot.id, { role: "assistant", text, sessionId});
} catch (err) {
persistLead();
// 错误文本进会话 JSONL 与 SSE 前统一脱敏+截断（R7）：内核已在源头处理厂商错误，
// 这里是其余错误路径的兜底出口。
const e = err as { message?: unknown; code?: string } | null | undefined;
const safeMessage = redact(String(e?.message?? err)).slice(0, 300);
appendSession(bot.id, { role: "system", kind: "error", text: safeMessage, code: e?.code?? "ERROR"});
emit("error", { code: e?.code?? "ERROR", message: safeMessage});
}
emit("done", { botId: bot.id});
res.end();
}

// ---------- 晨间扫描执行（手动触发与定时调度共用同一条路径，L0-5 通知语义只写一份） ----------
// 重入防护：同一时刻只允许一轮扫描；已有运行在途时返回 { skipped: true }，手动路由据此回 409、
// 调度器据此跳过本 tick。整轮失败（全部仓库取证失败）不报成功：状态记 failed 并发失败通知；
// 意料外抛错同样记 failed + 通知后把错误回传（手动路由保持原 500 行为）。
let scanInFlight = false;

interface MorningScanResult {
skipped?: boolean;
failed?: boolean;
partial?: boolean;
artifact?: ArtifactMeta;
report?: string;
findings?: Finding[];
error?: unknown;
}

async function executeMorningScan(): Promise<MorningScanResult> {
if (scanInFlight) return { skipped: true};
scanInFlight = true;
// 过期清理的显式触发点之一（R10）：扫描开始前把已过期的 open Finding 转 expired
// （GET 读路径不再做这件事）。清理失败不挡扫描，记日志继续。
try {
sweepExpiredFindings();
} catch (err) {
console.error(`[piper] 扫描前过期清理失败（继续扫描）：${(err as { message?: unknown } | null | undefined)?.message ?? err}`);
}
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
addNotification({ type: "routine.failed", title: `${routineName}失败`, body: String((err as Error).message?? err), routineId: "morning-scan"});
return { failed: true, error: err};
}
} finally {
scanInFlight = false;
}
}

// ---------- 定时调度（P1-4）：进程内，启动时迁移旧版 schedule 文本并装配 ----------

function morningRoutine(): Routine | null {
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
// "08:00" 恒可解析（与 lib/schedule.ts migrate 的兜底同口径），字面量仅为类型完备。
timeFn: () => parseScheduleTime(morningRoutine()?.schedule)?? { hour: 8, minute: 0 },
// 调度自身异常（如时区换算失败）不杀进程：记日志并落一条 routine.failed 通知（R3）。
onError: (err) => {
const e = err as { stack?: string; message?: unknown } | null | undefined;
console.error(`[piper] 调度 tick 异常（已拦截，进程继续运行）：${e?.stack ?? err}`);
addNotification({ type: "routine.failed", title: "晨间仓库扫描调度异常", body: String(e?.message?? err), routineId: "morning-scan"});
},
});

const server = createServer(async (req, res) => {
const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
const path = url.pathname;
try {
if (path.startsWith("/api/") && WRITE_METHODS.has(req.method ?? "")) {
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
if (path === "/api/model-providers" && req.method === "GET") return sendJson(res, 200, { providers: await loadModelProviders()});
if (path === "/api/settings/model" && req.method === "GET") return sendJson(res, 200, await modelSettingsView());
if (path === "/api/settings/model" && req.method === "PUT") {
const body = await readBody(req);
const patch: ModelSettings = {};
if (body.provider !== undefined) {
if (typeof body.provider !== "string" || !(await isKnownModelProvider(body.provider))) return sendJson(res, 400, { error: `未知服务商：${String(body.provider)}（须为服务商目录中的 id）`});
patch.provider = body.provider;
}
if (typeof body.baseUrl === "string") patch.baseUrl = body.baseUrl;
if (typeof body.modelId === "string") patch.modelId = body.modelId;
if (typeof body.apiKey === "string") patch.apiKey = body.apiKey;
if (body.thinkingLevel !== undefined) {
if (!isThinkingLevel(body.thinkingLevel)) return sendJson(res, 400, { error: `未知思考挡位：${String(body.thinkingLevel)}（须为 off/minimal/low/medium/high/xhigh/max 之一）`});
patch.thinkingLevel = body.thinkingLevel;
}
saveModelSettingsFile(patch);
return sendJson(res, 200, await modelSettingsView());
}
if (path === "/api/settings/model/test" && req.method === "POST") {
const body = await readBody(req);
const hasBaseUrl = typeof body.baseUrl === "string" && Boolean(body.baseUrl);
const hasApiKey = typeof body.apiKey === "string" && Boolean(body.apiKey);
// R7：请求体给了 baseUrl 就必须同时给 apiKey——否则会把已保存的 Key 发往请求体
// 指定的地址，等于一个现成的 Key 外送口。baseUrl 本身也只许 http/https。
if (hasBaseUrl && !hasApiKey) return sendJson(res, 400, { error: "指定 baseUrl 时必须同时提供 apiKey（不会把已保存的 Key 发往请求体给定的地址）"});
if (hasBaseUrl && !/^https?:\/\//i.test(body.baseUrl.trim())) return sendJson(res, 400, { error: "baseUrl 必须是 http/https 地址"});
const overrides: { apiKey?: string; baseUrl?: string; modelId?: string } = {};
if (hasBaseUrl) overrides.baseUrl = body.baseUrl;
if (typeof body.modelId === "string" && body.modelId) overrides.modelId = body.modelId;
if (hasApiKey) overrides.apiKey = body.apiKey;
return sendJson(res, 200, await testModelConfig(overrides));
}
if (path === "/api/settings/model/fetch-models" && req.method === "POST") {
const body = await readBody(req);
const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
if (!baseUrl) return sendJson(res, 400, { error: "baseUrl 必填"});
if (!/^https?:\/\//i.test(baseUrl)) return sendJson(res, 400, { error: "baseUrl 必须是 http/https 地址"});
let apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
if (!apiKey) {
// R7 守卫（与 /test 同源）：缺省 Key 时只许复用已保存 Key，且端点必须与已保存
// 配置的 baseUrl 完全一致（忽略末尾斜杠）——否则等于把已保存 Key 发往请求体
// 另给的地址。不满足回 400，且不发出任何上游请求。
const saved = readModelSettingsFile();
const norm = (u: unknown) => String(u ?? "").trim().replace(/\/+$/, "");
if (!saved.apiKey || norm(saved.baseUrl) !== norm(baseUrl)) {
return sendJson(res, 400, { error: "未提供 apiKey，且端点与已保存配置不一致：不会把已保存的 Key 发往该地址，请填入 API Key 后再拉取"});
}
apiKey = saved.apiKey;
}
const r = await fetchUpstreamModels({ baseUrl, apiKey });
if (!r.ok) return sendJson(res, 200, { ok: false, status: r.status, error: r.error });
return sendJson(res, 200, { ok: true, models: r.models });
}
if (path === "/api/settings/connectors" && req.method === "GET") return sendJson(res, 200, { connectors: listConnectors()});
if (path === "/api/settings/connectors/github" && req.method === "PUT") {
const body = await readBody(req);
if (typeof body.token!== "string") return sendJson(res, 400, { error: "token 必填且须为字符串（空串表示清除）"});
saveGithubSettingsFile({ token: body.token});
return sendJson(res, 200, { connector: listConnectors().find((c) => c.id === "github")});
}
if (path === "/api/settings/connectors/web" && req.method === "PUT") {
const body = await readBody(req);
// 搜索端点只许 http/https（与 R7 模型端点同一口径）：非法直接 400，不落盘。
if (body.searchEndpoint!== undefined && typeof body.searchEndpoint!== "string") return sendJson(res, 400, { error: "searchEndpoint 须为字符串"});
if (typeof body.searchEndpoint === "string" && body.searchEndpoint.trim()) {
let parsed: URL;
try { parsed = new URL(body.searchEndpoint.trim()); } catch { return sendJson(res, 400, { error: "searchEndpoint 不是合法 URL"}); }
if (parsed.protocol!== "http:" && parsed.protocol!== "https:") return sendJson(res, 400, { error: "searchEndpoint 只支持 http/https"});
}
if (body.searchApiKey!== undefined && typeof body.searchApiKey!== "string") return sendJson(res, 400, { error: "searchApiKey 须为字符串（空串表示清除）"});
saveWebSettingsFile({ fetchEnabled: body.fetchEnabled, searchEndpoint: body.searchEndpoint, searchApiKey: body.searchApiKey});
return sendJson(res, 200, { connector: listConnectors().find((c) => c.id === "web")});
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
const traceMatch = path.match(/^\/api\/bots\/([\w-]+)\/trace$/);
if (traceMatch && req.method === "GET") {
if (!getBot(traceMatch[1])) return sendJson(res, 404, { error: "bot 不存在"});
return sendJson(res, 200, buildTrace(readSession(traceMatch[1])));
}
if (path === "/api/about-me" && req.method === "GET") return sendJson(res, 200, { markdown: readAboutMe()});
if (path === "/api/about-me" && req.method === "PUT") {
const body = await readBody(req);
if (typeof body.markdown!== "string") return sendJson(res, 400, { error: "markdown 必填且须为字符串"});
return sendJson(res, 200, { markdown: writeAboutMe(body.markdown)});
}
if (path === "/api/settings/profile" && req.method === "GET") return sendJson(res, 200, readProfileSettings());
if (path === "/api/settings/profile" && req.method === "PUT") {
const body = await readBody(req);
const patch: { displayName?: string; timezone?: string } = {};
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
const time = parseScheduleTime(r.schedule)?? { hour: 8, minute: 0 };
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
if (path === "/api/artifacts" && req.method === "GET") {
const botId = url.searchParams.get("botId");
const all = listArtifacts();
return sendJson(res, 200, { artifacts: botId? all.filter((a) => a.botId === botId): all});
}
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
const filters: { status?: string; repo?: string; botId?: string } = {};
for (const key of ["status", "repo", "botId"] as const) {
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
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript"};
res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream"});
return res.end(readFileSync(file));
} catch (err) {
const e = err as { status?: number; message?: unknown } | null | undefined;
return sendJson(res, e?.status || 500, { error: redact(String(e?.message?? err))});
}
});

server.listen(PORT, HOST, () => {
console.log(`Piper prototype listening on http://${HOST}:${PORT} (token: ${USING_DEFAULT_TOKEN? "default piper-dev": "from env"}, model: ${modelConfig().configured? "configured": "NOT configured"})`);
// 定时调度启动：先 tick 一次（处理启动补跑与首次规划），之后每 30 秒推进状态机，
// 并顺带做过期清理（R10 的显式触发点之二：GET 读路径不再写数据，靠周期点收口）。
void scheduler.tick(new Date());
const timer = setInterval(() => {
try {
sweepExpiredFindings();
} catch (err) {
console.error(`[piper] 过期清理失败（下个周期重试）：${(err as { message?: unknown } | null | undefined)?.message ?? err}`);
}
// executing 超时恢复（F1）：运行中进程自身异常残留的 executing 超过阈值同样退回。
try {
const recovered = recoverInterruptedExecutions();
if (recovered > 0) console.log(`[piper] 周期恢复：${recovered} 条超时的 executing Finding 已退回 approved（审计 failed/interrupted）`);
} catch (err) {
console.error(`[piper] executing 恢复失败（下个周期重试）：${(err as { message?: unknown } | null | undefined)?.message ?? err}`);
}
void scheduler.tick(new Date());
}, 30 * 1000);
timer.unref();
});
