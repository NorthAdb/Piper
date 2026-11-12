// P2-2 单测：权限策略 + 每 bot 文件工作区硬闸。
// 覆盖切片验收 1–6（验收 7 是聚合 npm test 不回退，由 npm test 本身保证）：
// 界内读写、越界三形态（绝对路径 / .. 穿越 / 符号链接）失败且目标不变、
// 策略被人为改成 allow 时 execute 仍越界失败、跨 bot 隔离、
// workspaceAllowedRoots 只放开被授权的根、非法 botId 拒绝。
// 全程用临时 PIPER_DATA_DIR，无 Key、无网络。
// 用法（在 apps/piper 下）：node dist/scripts/test-workspace.js（或 npm run test:workspace）
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "piper-workspace-"));
const TMP_DATA = join(TMP_ROOT, "data");
process.env.PIPER_DATA_DIR = TMP_DATA;

const results: { seq: number; name: string; ok: boolean }[] = [];
let seq = 0;
function check(name: string, ok: boolean, detail = "") {
	seq += 1;
	results.push({ seq, name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${String(seq).padStart(2, "0")} ${name}${ok ? "" : ` — ${detail}`}`);
}

const store = await import("../lib/store.ts");
const { WorkspaceGuard } = await import("../lib/workspace-guard.ts");
const { PolicyEngine } = await import("../lib/policy.ts");
const { workspaceToolsForBot } = await import("../lib/workspace-tools.ts");
type ToolMap = Map<string, (args: Record<string, unknown>) => Promise<{ isError?: boolean; details?: any; content: { text: string }[] }>>;
function toolsOf(botId: string): ToolMap {
	const map: ToolMap = new Map();
	for (const tool of workspaceToolsForBot(botId)) {
		map.set(tool.name, async (args) => (await tool.execute("test-call", args)) as any);
	}
	return map;
}
function resultText(r: { content: { text: string }[] }): string {
	return r.content.map((c) => c.text).join("\n");
}

try {
	store.ensureData();
	const botA = store.createBot({ id: "bot-a", name: "Bot A" });
	const botB = store.createBot({ id: "bot-b", name: "Bot B" });
	check("旧数据归一：新建 bot 的 workspaceAllowedRoots 为 []", Array.isArray(botA.workspaceAllowedRoots) && botA.workspaceAllowedRoots.length === 0);

	const wsA = store.botWorkspace("bot-a");
	const wsB = store.botWorkspace("bot-b");
	const toolsA = toolsOf("bot-a");

	// ---------- 验收 1：界内读写 ----------
	const writeHello = await toolsA.get("workspace_write")!({ path: "hello.txt", content: "你好，工作区" });
	check("验收1 workspace_write 界内写入成功", !writeHello.isError, resultText(writeHello));
	check(
		"验收1 文件落在 workspaces/bot-a/hello.txt 且内容一致",
		existsSync(join(wsA, "hello.txt")) && readFileSync(join(wsA, "hello.txt"), "utf8") === "你好，工作区",
	);
	const listRoot = await toolsA.get("workspace_list")!({});
	check("验收1 workspace_list 能看到 hello.txt", !listRoot.isError && resultText(listRoot).includes("hello.txt"), resultText(listRoot));
	const readHello = await toolsA.get("workspace_read")!({ path: "hello.txt" });
	check("验收1 workspace_read 读回内容一致", !readHello.isError && resultText(readHello) === "你好，工作区", resultText(readHello));
	check(
		"策略默认：界内 list/read 为 allow、write/edit 为 ask",
		PolicyEngine.decide({ botId: "bot-a", toolName: "workspace_list", args: {} }) === "allow" &&
			PolicyEngine.decide({ botId: "bot-a", toolName: "workspace_read", args: { path: "hello.txt" } }) === "allow" &&
			PolicyEngine.decide({ botId: "bot-a", toolName: "workspace_write", args: { path: "x.txt", content: "" } }) === "ask" &&
			PolicyEngine.decide({ botId: "bot-a", toolName: "workspace_edit", args: { path: "hello.txt", oldText: "a", newText: "b" } }) === "ask",
	);
	const editHello = await toolsA.get("workspace_edit")!({ path: "hello.txt", oldText: "工作区", newText: "workspace" });
	check(
		"workspace_edit 唯一片段替换成功",
		!editHello.isError && readFileSync(join(wsA, "hello.txt"), "utf8") === "你好，workspace",
		resultText(editHello),
	);

	// ---------- 验收 2：越界三形态，目标内容不变 ----------
	const outsideFile = join(TMP_ROOT, "outside.txt");
	writeFileSync(outsideFile, "outside-original", "utf8");
	mkdirSync(wsB, { recursive: true });
	writeFileSync(join(wsB, "secret.txt"), "bot-b-secret", "utf8");

	const absWrite = await toolsA.get("workspace_write")!({ path: outsideFile, content: "pwned" });
	check(
		"验收2a 绝对路径写工作区外失败（reason=escape）且目标不变",
		absWrite.isError === true && absWrite.details?.reason === "escape" && readFileSync(outsideFile, "utf8") === "outside-original",
		resultText(absWrite),
	);
	const relWrite = await toolsA.get("workspace_write")!({ path: "../bot-b/secret.txt", content: "pwned" });
	check(
		"验收2b 相对 .. 穿越到 bot-b 失败（reason=escape）且目标不变",
		relWrite.isError === true && relWrite.details?.reason === "escape" && readFileSync(join(wsB, "secret.txt"), "utf8") === "bot-b-secret",
		resultText(relWrite),
	);
	const relUpWrite = await toolsA.get("workspace_write")!({ path: "../outside.txt", content: "pwned" });
	check("验收2b ../outside.txt 同样失败且目标不变", relUpWrite.isError === true && readFileSync(outsideFile, "utf8") === "outside-original");

	const outsideDir = join(TMP_ROOT, "outside-dir");
	mkdirSync(outsideDir, { recursive: true });
	writeFileSync(join(outsideDir, "inner.txt"), "inner-secret", "utf8");
	symlinkSync(outsideDir, join(wsA, "link"));
	const linkRead = await toolsA.get("workspace_read")!({ path: "link/inner.txt" });
	check(
		"验收2c 经工作区内符号链接读根外文件失败（reason=escape）",
		linkRead.isError === true && linkRead.details?.reason === "escape",
		resultText(linkRead),
	);
	const linkWrite = await toolsA.get("workspace_write")!({ path: "link/new.txt", content: "pwned" });
	check(
		"验收2c 经符号链接写根外失败且根外无新文件",
		linkWrite.isError === true && linkWrite.details?.reason === "escape" && !existsSync(join(outsideDir, "new.txt")),
		resultText(linkWrite),
	);
	check(
		"策略默认：越界路径在 decide 层就是 deny（读与写）",
		PolicyEngine.decide({ botId: "bot-a", toolName: "workspace_read", args: { path: outsideFile } }) === "deny" &&
			PolicyEngine.decide({ botId: "bot-a", toolName: "workspace_write", args: { path: "../bot-b/secret.txt", content: "" } }) === "deny",
	);

	// ---------- 验收 3：策略人为放行，execute 仍越界失败 ----------
	const originalDecide = PolicyEngine.decide;
	(PolicyEngine as any).decide = () => "allow";
	let forcedRead: any;
	let forcedWrite: any;
	try {
		forcedRead = await toolsA.get("workspace_read")!({ path: outsideFile });
		forcedWrite = await toolsA.get("workspace_write")!({ path: outsideFile, content: "pwned" });
	} finally {
		(PolicyEngine as any).decide = originalDecide;
	}
	check(
		"验收3 PolicyEngine 被人为改成 allow，execute 仍以 escape 失败、目标不变",
		forcedRead.isError === true &&
			forcedRead.details?.reason === "escape" &&
			forcedWrite.isError === true &&
			forcedWrite.details?.reason === "escape" &&
			readFileSync(outsideFile, "utf8") === "outside-original",
	);

	// ---------- 验收 4：跨 bot 隔离 ----------
	const crossAbs = await toolsA.get("workspace_read")!({ path: join(wsB, "secret.txt") });
	check(
		"验收4 bot-a 的工具以绝对路径读 bot-b 文件失败",
		crossAbs.isError === true && crossAbs.details?.reason === "escape",
		resultText(crossAbs),
	);
	check(
		"验收4 Guard 直接判定：bot-a 解析 bot-b 路径为 escape，bot-b 解析自己路径 ok",
		WorkspaceGuard.resolve("bot-a", join(wsB, "secret.txt")).ok === false && WorkspaceGuard.resolve("bot-b", "secret.txt").ok === true,
	);

	// ---------- 验收 5：workspaceAllowedRoots 只放开被授权的根 ----------
	const sharedDir = join(TMP_ROOT, "shared");
	mkdirSync(sharedDir, { recursive: true });
	writeFileSync(join(sharedDir, "shared.txt"), "shared-content", "utf8");
	const beforeRoot = await toolsA.get("workspace_read")!({ path: join(sharedDir, "shared.txt") });
	check("验收5 未配置允许根时，额外目录的绝对路径读取失败", beforeRoot.isError === true && beforeRoot.details?.reason === "escape");
	store.updateBot("bot-a", { workspaceAllowedRoots: [sharedDir] });
	const afterRoot = await toolsA.get("workspace_read")!({ path: join(sharedDir, "shared.txt") });
	check(
		"验收5 写入 workspaceAllowedRoots 后该根可读",
		!afterRoot.isError && resultText(afterRoot) === "shared-content",
		resultText(afterRoot),
	);
	const parentRead = await toolsA.get("workspace_read")!({ path: outsideFile });
	check(
		"验收5 被授权根的父目录仍不可读（只放开该根本身）",
		parentRead.isError === true && parentRead.details?.reason === "escape",
		resultText(parentRead),
	);
	check(
		"验收5 授权根内的写在策略层为 ask 而非 deny",
		PolicyEngine.decide({ botId: "bot-a", toolName: "workspace_write", args: { path: join(sharedDir, "n.txt"), content: "" } }) === "ask",
	);

	// ---------- 验收 6：非法 botId ----------
	let threwTraversal = false;
	try {
		store.botWorkspace("../sessions");
	} catch {
		threwTraversal = true;
	}
	let threwSlash = false;
	try {
		store.botWorkspace("a/b");
	} catch {
		threwSlash = true;
	}
	check("验收6 botWorkspace('../sessions') 与带 / 的 botId 都抛错", threwTraversal && threwSlash);
	check("验收6 Guard 对非法 botId 返回 escape 而不是抛错", WorkspaceGuard.resolve("../sessions", "x.txt").ok === false);

	// ---------- 策略表其余锁定项 ----------
	check(
		"策略默认：web_fetch/web_search allow、github.read allow、github_comment ask、未知工具 deny",
		PolicyEngine.decide({ botId: "bot-a", toolName: "web_fetch", args: { url: "https://example.com" } }) === "allow" &&
			PolicyEngine.decide({ botId: "bot-a", toolName: "web_search", args: { query: "x" } }) === "allow" &&
			PolicyEngine.decide({ botId: "bot-a", toolName: "github.read", args: {} }) === "allow" &&
			PolicyEngine.decide({ botId: "bot-a", toolName: "github_comment", args: {} }) === "ask" &&
			PolicyEngine.decide({ botId: "bot-a", toolName: "some_unknown_writer", args: {} }) === "deny",
	);
} finally {
	rmSync(TMP_ROOT, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
