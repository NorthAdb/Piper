// 统一秘密脱敏（R7）：全仓落盘与出站文本的唯一脱敏出口——审计预览、通知、产物、
// 会话 JSONL、SSE error、网关正文检查都走这里，不再各处自写一份只覆盖部分秘密的逻辑
// （R1 修过的审计泄漏正是「只脱当前 GitHub 令牌」的窄口径造成的）。
//
// 覆盖口径（两层）：
//   1. 已知秘密精确值：当前设置文件里的 GitHub 令牌与模型 Key、环境变量
//      （GITHUB_TOKEN / PIPER_MODEL_API_KEY / OPENAI_API_KEY）里的值，以及本进程
//      生命周期内曾经收集到的旧值——collectSecrets() 每次调用都把当前值加入进程内
//      集合，令牌/Key 被轮换后旧值在进程不重启期间仍会被脱敏。进程重启后旧值靠第 2
//      层前缀模式兜底。
//   2. 前缀模式：从未保存过、或已轮换且进程重启后不在集合里的秘密，只要形状是
//      常见令牌前缀（ghp_/gho_/ghu_/ghs_/ghr_/github_pat_/sk- 家族）同样替换。
// 本模块绝不把秘密写进任何日志；收集只在内存里进行。
//
// 实现说明：秘密来源直接读设置文件（文件名与 lib/settings.mjs 的定义保持一致，
// 那里是设置文件的属主），不 import settings.mjs——store/settings/redact 三者存在
// 互相引用，经 settings 读会形成循环 import 并在模块求值期撞上 TDZ。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./store.mjs";

export const REDACTED = "[REDACTED]";

// 太短的值不做精确替换，避免把普通词误伤（前缀模式另有长度下限）。
const MIN_EXACT_LENGTH = 6;

const knownSecrets = new Set();

function readSettingsJson(name) {
	const file = join(DATA_DIR, name);
	if (!existsSync(file)) return {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function collectSecrets() {
	const model = readSettingsJson("settings-model.json");
	if (typeof model.apiKey === "string" && model.apiKey.length >= MIN_EXACT_LENGTH) knownSecrets.add(model.apiKey);
	const github = readSettingsJson("settings-github.json");
	if (typeof github.token === "string" && github.token.length >= MIN_EXACT_LENGTH) knownSecrets.add(github.token);
	const web = readSettingsJson("settings-web.json");
	if (typeof web.searchApiKey === "string" && web.searchApiKey.length >= MIN_EXACT_LENGTH) knownSecrets.add(web.searchApiKey);
	for (const v of [process.env.GITHUB_TOKEN, process.env.PIPER_MODEL_API_KEY, process.env.OPENAI_API_KEY]) {
		if (typeof v === "string" && v.length >= MIN_EXACT_LENGTH) knownSecrets.add(v);
	}
	return knownSecrets;
}

const SECRET_PATTERNS = [
	/github_pat_[A-Za-z0-9_]{20,}/g,
	/gh[pousr]_[A-Za-z0-9]{20,}/g,
	/sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}/g,
];

export function redact(text) {
	if (typeof text !== "string" || !text) return typeof text === "string" ? text : "";
	let out = text;
	// 长的先替换，避免短秘密是长秘密子串时留下残段。
	for (const secret of [...collectSecrets()].sort((a, b) => b.length - a.length)) {
		if (out.includes(secret)) out = out.split(secret).join(REDACTED);
	}
	for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
	return out;
}

// 结构化字段的深脱敏：逐个字符串过 redact()，非字符串原样保留。会话 tool
// 条目的 args/result 落盘前在 server.mjs 里有一份同口径的本地实现；轨迹接口
// 出参（lib/trace.mjs）用这一份，对老文件里未脱敏的结构化字段兜底。
export function redactDeep(value) {
	if (typeof value === "string") return redact(value);
	if (Array.isArray(value)) return value.map(redactDeep);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
	return value;
}

// 文本是否含秘密（精确值或前缀模式）——网关发送前检查用。
export function containsSecret(text) {
	if (typeof text !== "string" || !text) return false;
	return redact(text) !== text;
}
