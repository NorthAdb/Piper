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

	// 悬挂符号链接（审计 BLOCKER）：链接目标尚不存在时，existsSync 会把链接
	// 误判为「不存在」而漏掉目标——判定必须按 readlink 算出最终落点。
	const danglingTarget = join(TMP_ROOT, "dangling-pwned.txt");
	symlinkSync(danglingTarget, join(wsA, "dangling-file"));
	const danglingWrite = await toolsA.get("workspace_write")!({ path: "dangling-file", content: "PWNED-DANGLING" });
	check(
		"审计BLOCKER 悬挂文件链接 write 为 escape 且根外零字节（目标未被创建）",
		danglingWrite.isError === true && danglingWrite.details?.reason === "escape" && !existsSync(danglingTarget),
		resultText(danglingWrite),
	);
	const danglingRead = await toolsA.get("workspace_read")!({ path: "dangling-file" });
	check(
		"审计BLOCKER 悬挂文件链接 read 统一为 escape（不是 io/ENOENT）",
		danglingRead.isError === true && danglingRead.details?.reason === "escape",
		resultText(danglingRead),
	);
	const danglingEdit = await toolsA.get("workspace_edit")!({ path: "dangling-file", oldText: "a", newText: "b" });
	check(
		"审计BLOCKER 悬挂文件链接 edit 同样为 escape 且目标未被创建",
		danglingEdit.isError === true && danglingEdit.details?.reason === "escape" && !existsSync(danglingTarget),
		resultText(danglingEdit),
	);
	const danglingDirTarget = join(TMP_ROOT, "dangling-dir-target");
	symlinkSync(danglingDirTarget, join(wsA, "dangling-dir"));
	const danglingDirWrite = await toolsA.get("workspace_write")!({ path: "dangling-dir/new.txt", content: "pwned" });
	check(
		"审计BLOCKER 悬挂目录链接 write 为 escape 且根外目录未被创建",
		danglingDirWrite.isError === true && danglingDirWrite.details?.reason === "escape" && !existsSync(danglingDirTarget),
		resultText(danglingDirWrite),
	);
	check(
		"审计BLOCKER Guard 与策略对悬挂链接口径一致（decide 写 ask 不再出现、读不再 allow）",
		WorkspaceGuard.resolve("bot-a", "dangling-file").ok === false &&
			PolicyEngine.decide({ botId: "bot-a", toolName: "workspace_write", args: { path: "dangling-file", content: "" } }) === "deny" &&
			PolicyEngine.decide({ botId: "bot-a", toolName: "workspace_read", args: { path: "dangling-file" } }) === "deny",
	);
	check(
		"策略默认：越界路径在 decide 层就是 deny（读与写）",
		PolicyEngine.decide({ botId: "bot-a", toolName: "workspace_read", args: { path: outsideFile } }) === "deny" &&
			PolicyEngine.decide({ botId: "bot-a", toolName: "workspace_write", args: { path: "../bot-b/secret.txt", content: "" } }) === "deny",
	);

	// ---------- 验收 3：策略人为放行，execute 仍越界失败 ----------
	// 按审计意见走「先 decide、再 execute」的完整形状：decide 被人为改成恒
	// allow 并真的先跑一遍拿到 allow，execute 仍须以 escape 拒绝——钉住
	// 「execute 的 Guard 独立于策略层答案」这一性质。
	const originalDecide = PolicyEngine.decide;
	(PolicyEngine as any).decide = () => "allow";
	let stubbedDecision = "";
	let forcedRead: any;
	let forcedWrite: any;
	try {
		stubbedDecision = PolicyEngine.decide({ botId: "bot-a", toolName: "workspace_write", args: { path: outsideFile, content: "pwned" } });
		forcedRead = await toolsA.get("workspace_read")!({ path: outsideFile });
		forcedWrite = await toolsA.get("workspace_write")!({ path: outsideFile, content: "pwned" });
	} finally {
		(PolicyEngine as any).decide = originalDecide;
	}
	check(
		"验收3 decide 被人为改成 allow（且已实际返回 allow），execute 仍以 escape 失败、目标不变",
		stubbedDecision === "allow" &&
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

	// ---------- edit 出现次数与 read 截断（审计建议钉死） ----------
	writeFileSync(join(wsA, "multi.txt"), "foo bar foo", "utf8");
	const editMissing = await toolsA.get("workspace_edit")!({ path: "multi.txt", oldText: "baz", newText: "x" });
	check(
		"workspace_edit oldText 出现 0 次失败且文件不变",
		editMissing.isError === true && readFileSync(join(wsA, "multi.txt"), "utf8") === "foo bar foo",
		resultText(editMissing),
	);
	const editTwice = await toolsA.get("workspace_edit")!({ path: "multi.txt", oldText: "foo", newText: "x" });
	check(
		"workspace_edit oldText 出现 2 次失败且文件不变",
		editTwice.isError === true && readFileSync(join(wsA, "multi.txt"), "utf8") === "foo bar foo",
		resultText(editTwice),
	);
	writeFileSync(join(wsA, "big.txt"), "x".repeat(70 * 1024), "utf8");
	const readBig = await toolsA.get("workspace_read")!({ path: "big.txt" });
	check(
		"workspace_read 超过 64 KiB 截断并注明（details.truncated）",
		!readBig.isError && readBig.details?.truncated === true && resultText(readBig).includes("已截断"),
	);

	// ---------- NUL 路径（审计顺手项） ----------
	check(
		"含 NUL 的路径在 Guard 层直接 escape、策略层 deny",
		WorkspaceGuard.resolve("bot-a", "a\0b").ok === false &&
			PolicyEngine.decide({ botId: "bot-a", toolName: "workspace_read", args: { path: "a\0b" } }) === "deny",
	);

	// ---------- createBot 先验后写（审计 MAJOR） ----------
	const botsFile = join(TMP_DATA, "bots.json");
	const botsFileBefore = readFileSync(botsFile, "utf8");
	let createThrew = false;
	try {
		store.createBot({ id: "../sessions", name: "poison" });
	} catch {
		createThrew = true;
	}
	check(
		"审计MAJOR createBot 非法 id 抛错且 bots.json 一字不变（无毒记录）",
		createThrew && readFileSync(botsFile, "utf8") === botsFileBefore && store.getBot("../sessions") === null,
	);

	// ---------- 工作区目录本身被换成悬挂链接 ----------
	const botC = store.createBot({ id: "bot-c", name: "Bot C" });
	const wsC = store.botWorkspace(botC.id);
	rmSync(wsC, { recursive: true, force: true });
	const wsCTarget = join(TMP_ROOT, "bot-c-elsewhere");
	symlinkSync(wsCTarget, wsC);
	let wsThrew = false;
	try {
		store.botWorkspace("bot-c");
	} catch {
		wsThrew = true;
	}
	check(
		"审计BLOCKER 工作区目录本身是悬挂链接时 botWorkspace 抛错、Guard 返回 escape",
		wsThrew && WorkspaceGuard.resolve("bot-c", "x.txt").ok === false,
	);

	// ---------- 审计探针形态补进官方套件（复审留项，防回归） ----------
	// 嵌套链接：link1 → link2（界内）→ 根外目录，两跳后仍须 escape。
	symlinkSync(outsideDir, join(wsA, "nested-2"));
	symlinkSync("nested-2", join(wsA, "nested-1"));
	const nestedWrite = await toolsA.get("workspace_write")!({ path: "nested-1/evil.txt", content: "pwned" });
	check(
		"复审留项 嵌套链接 write escape 且根外无新文件",
		nestedWrite.isError === true && nestedWrite.details?.reason === "escape" && !existsSync(join(outsideDir, "evil.txt")),
		resultText(nestedWrite),
	);
	const nestedRead = await toolsA.get("workspace_read")!({ path: "nested-1/secret.txt" });
	check(
		"复审留项 嵌套链接 read escape",
		nestedRead.isError === true && nestedRead.details?.reason === "escape",
		resultText(nestedRead),
	);
	// 相对目标含 ..：链接目标按链接所在目录解析，走出工作区即 escape。
	const relTarget = join(TMP_ROOT, "rel-pwned.txt");
	symlinkSync("../../../rel-pwned.txt", join(wsA, "rel-file"));
	const dotdotLinkWrite = await toolsA.get("workspace_write")!({ path: "rel-file", content: "pwned" });
	check(
		"复审留项 相对 .. 目标的链接 write escape 且目标未被创建",
		dotdotLinkWrite.isError === true && dotdotLinkWrite.details?.reason === "escape" && !existsSync(relTarget),
		resultText(dotdotLinkWrite),
	);
	// 链接环：展开上限收尾，Guard 与工具都按 escape。
	symlinkSync("loop-b", join(wsA, "loop-a"));
	symlinkSync("loop-a", join(wsA, "loop-b"));
	const loopWrite = await toolsA.get("workspace_write")!({ path: "loop-a/x.txt", content: "pwned" });
	check(
		"复审留项 链接环 Guard escape、write escape",
		WorkspaceGuard.resolve("bot-a", "loop-a/x.txt").ok === false && loopWrite.isError === true && loopWrite.details?.reason === "escape",
		resultText(loopWrite),
	);
	// 链到悬挂链接：link → 界内另一链接 → 根外不存在目标。
	const chainTarget = join(TMP_ROOT, "chain-pwned.txt");
	symlinkSync(chainTarget, join(wsA, "chain-2"));
	symlinkSync("chain-2", join(wsA, "chain-1"));
	const chainWrite = await toolsA.get("workspace_write")!({ path: "chain-1", content: "pwned" });
	check(
		"复审留项 链到悬挂链接 write escape 且最终目标未被创建",
		chainWrite.isError === true && chainWrite.details?.reason === "escape" && !existsSync(chainTarget),
		resultText(chainWrite),
	);
	// 中途目录链接加多层尾分量：链接后还有两层不存在的目录。
	const deepWrite = await toolsA.get("workspace_write")!({ path: "link/deep/deeper.txt", content: "pwned" });
	check(
		"复审留项 中途目录链接加尾分量 write escape 且根外无新目录",
		deepWrite.isError === true && deepWrite.details?.reason === "escape" && !existsSync(join(outsideDir, "deep")),
		resultText(deepWrite),
	);
	// 跨层悬挂：悬挂目录链接之后再叠不存在的中间目录与文件。
	const crossTarget = join(TMP_ROOT, "cross-target");
	symlinkSync(crossTarget, join(wsA, "cross-link"));
	const crossWrite = await toolsA.get("workspace_write")!({ path: "cross-link/mid/file.txt", content: "pwned" });
	check(
		"复审留项 跨层悬挂 write escape 且根外目录未被创建",
		crossWrite.isError === true && crossWrite.details?.reason === "escape" && !existsSync(crossTarget),
		resultText(crossWrite),
	);
	// 检查路径与写入路径同一条：界内活链接指向界内子目录时，Guard 返回
	// 解析后的真实路径（不是字面链接路径），工具写入恰好落在该处。
	mkdirSync(join(wsA, "real-dir"), { recursive: true });
	symlinkSync("real-dir", join(wsA, "inner-link"));
	const innerResolved = WorkspaceGuard.resolve("bot-a", "inner-link/same.txt");
	const expectedReal = store.resolveRealPath(join(wsA, "real-dir", "same.txt"));
	check(
		"复审留项 Guard 返回解析后的真实路径（与 resolveRealPath 一致，非字面链接路径）",
		innerResolved.ok === true && innerResolved.path === expectedReal && innerResolved.path !== join(wsA, "inner-link", "same.txt"),
		innerResolved.ok ? innerResolved.path : "escape",
	);
	const innerWrite = await toolsA.get("workspace_write")!({ path: "inner-link/same.txt", content: "same-path" });
	check(
		"复审留项 经界内链接写入落在解析目标处且内容一致",
		!innerWrite.isError && readFileSync(join(wsA, "real-dir", "same.txt"), "utf8") === "same-path",
		resultText(innerWrite),
	);

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
