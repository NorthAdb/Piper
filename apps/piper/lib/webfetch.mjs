// 网页抓取（L0-6）：只读 web.fetch 的唯一实现。安全模型（SSRF）：
//   - 只许 http/https；每一跳（含重定向）在出站之前先校验：解析主机名得到全部
//     地址，任一地址落在本机/回环/私网/链路本地/云元数据/CGNAT/组播等保留段
//     即整条拒绝——域名只要沾一个私网解析就不抓，避免轮询解析蒙混。
//   - 校验与连接用同一份地址：连接时把已校验地址钉给 socket 的 lookup，
//     校验之后再解析变私网（DNS rebinding）也连不到——socket 只去钉住的地址，
//     TLS 的 SNI/证书校验仍按原主机名走。
//   - 被拒时对模型与用户只给一句「不允许访问该地址」，不摊开命中的网段或
//     解析到的私网 IP（那些是内网拓扑信息）。
// 上限写死：总超时 10 秒、下载最多 1MB（超限断流并标明）、注入上下文的
// 可见文本最多 8000 字（超限截断并标明）。
// 测试缝：环境变量 PIPER_WEB_FETCH_TEST_ALLOW 是逗号分隔的 host:port 白名单，
// 只供本地夹具测试在测试进程内放行夹具地址；生产环境不设即无任何放行。
import { lookup as dnsLookupCallback } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { promisify } from "node:util";

const dnsLookup = promisify(dnsLookupCallback);

export const WEB_FETCH_TIMEOUT_MS = 10_000;
export const WEB_FETCH_MAX_DOWNLOAD_BYTES = 1_000_000;
export const WEB_FETCH_MAX_TEXT_CHARS = 8_000;
const MAX_REDIRECTS = 5;

export const BLOCKED_MESSAGE = "不允许访问该地址";

function blockedError() {
	return Object.assign(new Error(BLOCKED_MESSAGE), { code: "WEB_FETCH_BLOCKED" });
}

// ---------- 地址判定（纯函数，测试直接钉表） ----------
export function isBlockedAddress(ip) {
	if (typeof ip !== "string") return true;
	const family = isIP(ip);
	if (family === 4) return isBlockedV4(ip);
	if (family === 6) return isBlockedV6(ip.toLowerCase());
	return true; // 不是合法 IP 字面量：一律按不安全处理
}

function isBlockedV4(ip) {
	const parts = ip.split(".").map((s) => Number(s));
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
	const [a, b] = parts;
	if (a === 0) return true; // 0.0.0.0/8 本网络
	if (a === 10) return true; // 私网
	if (a === 127) return true; // 回环
	if (a === 169 && b === 254) return true; // 链路本地（含云元数据 169.254.169.254）
	if (a === 172 && b >= 16 && b <= 31) return true; // 私网
	if (a === 192 && b === 168) return true; // 私网
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
	if (a === 192 && b === 0) return true; // 192.0.0.0/24 等保留
	if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试段
	if (a >= 224) return true; // 组播与保留（含广播）
	return false;
}

function isBlockedV6(ip) {
	if (ip === "::" || ip === "::1") return true; // 未指定 / 回环
	if (ip.startsWith("::ffff:")) {
		const mapped = ip.slice("::ffff:".length);
		if (isIP(mapped) === 4) return isBlockedV4(mapped);
		return true;
	}
	const head = ip.split(":")[0];
	const headVal = Number.parseInt(head || "0", 16);
	if (Number.isNaN(headVal)) return true;
	if (headVal >= 0xfe80 && headVal <= 0xfebf) return true; // 链路本地 fe80::/10
	if (headVal >= 0xfc00 && headVal <= 0xfdff) return true; // 唯一本地 fc00::/7
	if (headVal >= 0xff00) return true; // 组播
	return false;
}

// ---------- 测试缝（仅测试进程设置；生产不设即不存在） ----------
function testAllowSet() {
	const raw = process.env.PIPER_WEB_FETCH_TEST_ALLOW;
	if (!raw) return null;
	return new Set(
		raw
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
}

function isTestAllowed(url) {
	const set = testAllowSet();
	if (!set) return false;
	const port = url.port || (url.protocol === "https:" ? "443" : "80");
	return set.has(`${url.hostname.toLowerCase()}:${port}`) || set.has(url.hostname.toLowerCase());
}

// ---------- 解析与校验 ----------
async function defaultLookupAll(hostname) {
	const records = await dnsLookup(hostname, { all: true, verbatim: true });
	return records.map((r) => r.address);
}

// 校验一个 URL：协议 + 解析全部地址。返回钉住的地址数组（测试缝放行时为 null，
// 表示走系统解析——只可能发生在测试进程内对夹具地址）。任一地址被拦即抛
// WEB_FETCH_BLOCKED，错误信息只有通用口径。
async function assertUrlAllowed(url, lookupAll) {
	if (url.protocol !== "http:" && url.protocol !== "https:") throw blockedError();
	if (isTestAllowed(url)) return null;
	// WHATWG URL 对 IPv6 字面量保留方括号（[::1]），判定前先剥掉
	const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
	let addresses;
	if (isIP(hostname)) {
		addresses = [hostname];
	} else {
		try {
			addresses = await lookupAll(hostname);
		} catch {
			throw Object.assign(new Error("无法解析该地址"), { code: "WEB_FETCH_FAILED" });
		}
	}
	if (!addresses?.length) throw Object.assign(new Error("无法解析该地址"), { code: "WEB_FETCH_FAILED" });
	for (const addr of addresses) {
		if (isBlockedAddress(addr)) throw blockedError();
	}
	return addresses;
}

// ---------- 传输（默认实现：把已校验地址钉给 socket） ----------
function defaultTransport(url, pinnedAddresses, { signal } = {}) {
	return new Promise((resolvePromise, rejectPromise) => {
		const isHttps = url.protocol === "https:";
		const requestFn = isHttps ? httpsRequest : httpRequest;
		const options = {
			method: "GET",
			headers: {
				"User-Agent": "Piper web.fetch (read-only)",
				Accept: "text/html, text/plain, application/json;q=0.8, */*;q=0.5",
			},
			signal,
		};
		if (pinnedAddresses?.length) {
			// lookup 钉住：socket 只连校验过的地址；返回什么由我们决定，
			// 连接阶段不再重新解析。SNI/证书仍按 URL 主机名（Node 以 hostname 为准）。
			options.lookup = (hostname, lookupOptions, callback) => {
				if (lookupOptions?.all) {
					callback(
						null,
						pinnedAddresses.map((address) => ({ address, family: isIP(address) })),
					);
				} else {
					callback(null, pinnedAddresses[0], isIP(pinnedAddresses[0]));
				}
			};
		}
		let settled = false;
		let downloadTruncated = false;
		const chunks = [];
		const req = requestFn(url, options, (res) => {
			let received = 0;
			const finishPartial = () => {
				if (settled) return;
				settled = true;
				resolvePromise({
					status: res.statusCode ?? 0,
					headers: res.headers ?? {},
					body: Buffer.concat(chunks).toString("utf8"),
					downloadTruncated: true,
				});
			};
			res.on("data", (chunk) => {
				received += chunk.length;
				if (received > WEB_FETCH_MAX_DOWNLOAD_BYTES) {
					// 超过下载上限：断流，用已收到的部分正文收尾并标明截断
					downloadTruncated = true;
					finishPartial();
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			res.on("end", () => {
				if (settled) return;
				settled = true;
				resolvePromise({
					status: res.statusCode ?? 0,
					headers: res.headers ?? {},
					body: Buffer.concat(chunks).toString("utf8"),
					downloadTruncated,
				});
			});
			// destroy 断流时 end 不触发而 error/close 可能先到：已截断就走部分正文
			res.on("close", () => {
				if (downloadTruncated) finishPartial();
			});
			res.on("error", (err) => {
				if (downloadTruncated) return finishPartial();
				if (settled) return;
				settled = true;
				rejectPromise(err);
			});
		});
		req.on("error", (err) => {
			if (downloadTruncated || settled) return;
			settled = true;
			rejectPromise(err);
		});
		req.end();
	});
}

// ---------- 可见文本抽取 ----------
function extractVisibleText(body, contentType) {
	const type = String(contentType ?? "");
	if (type.includes("application/json") || type.includes("text/plain") || type.includes("text/markdown")) {
		return body.trim();
	}
	// HTML：去掉不可见块与全部标签，只留可见文字
	const noBlocks = body
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ");
	const noTags = noBlocks.replace(/<[^>]+>/g, " ");
	return noTags
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/\s+/g, " ")
		.trim();
}

// ---------- 网页搜索（web.search）：仅在用户配置了搜索端点与密钥时调用 ----------
// 端点契约（README 有说明）：GET <endpoint>?q=<关键词>，请求头带
// Authorization: Bearer <密钥>；期望 JSON 里有 results/data/items 数组，
// 每项取 title/name、url/link、snippet/description/content 中先出现的字段。
// 搜索端点是用户自己配置的可信服务（和模型端点同类），不走 web.fetch 的
// SSRF 校验；但响应大小与条数仍设上限，错误文本不回显密钥。
export async function webSearch(query, { endpoint, apiKey }) {
	const url = new URL(endpoint);
	url.searchParams.set("q", String(query));
	let res;
	try {
		res = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
		});
	} catch {
		throw Object.assign(new Error("搜索失败：网络错误"), { code: "WEB_SEARCH_FAILED" });
	}
	if (!res.ok) throw Object.assign(new Error(`搜索失败：服务返回 HTTP ${res.status}`), { code: "WEB_SEARCH_FAILED" });
	const raw = await res.text();
	if (raw.length > WEB_FETCH_MAX_DOWNLOAD_BYTES) throw Object.assign(new Error("搜索失败：服务返回内容过大"), { code: "WEB_SEARCH_FAILED" });
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw Object.assign(new Error("搜索失败：服务返回了无法解析的结果"), { code: "WEB_SEARCH_FAILED" });
	}
	const list = Array.isArray(parsed)
		? parsed
		: (parsed?.results ?? parsed?.data ?? parsed?.items ?? parsed?.web?.results ?? []);
	const items = (Array.isArray(list) ? list : []).slice(0, 5).map((item) => ({
		title: String(item?.title ?? item?.name ?? "").slice(0, 200),
		url: String(item?.url ?? item?.link ?? "").slice(0, 500),
		snippet: String(item?.snippet ?? item?.description ?? item?.content ?? "").slice(0, 500),
	}));
	if (!items.length) throw Object.assign(new Error("搜索没有返回结果"), { code: "WEB_SEARCH_FAILED" });
	return items;
}

// ---------- 主入口 ----------
// 返回 { url（最终地址）, status, text（≤8000）, truncated, downloadTruncated }。
// deps 可注入 lookupAll / transport（测试替身用，生产不传）。
export async function webFetch(rawUrl, deps = {}) {
	const lookupAll = deps.lookupAll ?? defaultLookupAll;
	const transport = deps.transport ?? defaultTransport;
	let current;
	try {
		current = new URL(String(rawUrl));
	} catch {
		throw blockedError();
	}
	const deadline = AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS);
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const pinned = await assertUrlAllowed(current, lookupAll);
		let res;
		try {
			res = await transport(current, pinned, { signal: deadline });
		} catch (err) {
			if (err?.code === "WEB_FETCH_BLOCKED") throw err;
			if (err?.name === "TimeoutError" || err?.name === "AbortError" || err?.code === "ABORT_ERR") {
				throw Object.assign(new Error("抓取超时"), { code: "WEB_FETCH_FAILED" });
			}
			throw Object.assign(new Error("抓取失败：网络错误"), { code: "WEB_FETCH_FAILED" });
		}
		const location = res.headers?.location ?? res.headers?.Location;
		if ([301, 302, 303, 307, 308].includes(res.status) && location) {
			if (hop === MAX_REDIRECTS) throw Object.assign(new Error("抓取失败：重定向次数过多"), { code: "WEB_FETCH_FAILED" });
			try {
				current = new URL(location, current);
			} catch {
				throw blockedError();
			}
			continue; // 下一跳回到循环开头重新校验（逐跳复检）
		}
		if (res.status < 200 || res.status >= 300) {
			throw Object.assign(new Error(`抓取失败：对方返回 HTTP ${res.status}`), { code: "WEB_FETCH_FAILED" });
		}
		const contentType = res.headers?.["content-type"] ?? res.headers?.["Content-Type"] ?? "";
		const fullText = extractVisibleText(String(res.body ?? ""), contentType);
		const textTruncated = fullText.length > WEB_FETCH_MAX_TEXT_CHARS;
		return {
			url: current.toString(),
			status: res.status,
			text: textTruncated ? fullText.slice(0, WEB_FETCH_MAX_TEXT_CHARS) : fullText,
			truncated: textTruncated || Boolean(res.downloadTruncated),
			downloadTruncated: Boolean(res.downloadTruncated),
		};
	}
	throw Object.assign(new Error("抓取失败：重定向次数过多"), { code: "WEB_FETCH_FAILED" });
}
