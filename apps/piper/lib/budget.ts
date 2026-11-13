// 预算熔断（P2-8）：给单次 run 加硬上限——步数 / token / 外部调用
// 三项，任一跳闸就经基座 finishTurn 的 { action: "end" } 结束本轮
// （已流出的文本不删、进程不死、会话可再打开）。策略数字只在本文件
// 与配置里，绝不写进基座 agent-loop。
//
// 口径：
//   - 步数与 token 在每轮（assistant turn）结束时由 finishTurn 累计：
//     步数 +1，token 加本轮 usage.totalTokens。token 是事后才知道的
//     数字，跨限的那一轮必然已消费，熔断挡的是它之后的请求。
//   - 外部调用（web_fetch / web_search / github_comment 这类走出
//     进程的副作用调用）在工具 execute 入口计数：真的要执行了才
//     +1；待批未执行的、被策略闸拒的都不算（它们根本到不了
//     execute）。达到上限后，下一次 execute 不真正执行、直接回
//     预算错误结果——验收口径「下一次外部 execute 不得发生」。
//   - 跳闸只发生一次（onTrip 回调在那一刻写审计与会话提示）；跳闸
//     后仍未批准的工具调用保持 pending，不偷偷执行、不改成 error
//     （结束发生在轮次边界，停泊中的批次由批准/中止路径按既有
//     语义处置）。
//   - 计数以一段 run（一个 Agent 生命周期）为界：streamChat 一段、
//     待批恢复续跑是新的一段、重新计数——人工批准本身就是一道
//     闸，恢复段的预算从零起算（落点，README 有记）。
//
// 配置：缺省写死在 DEFAULT_BUDGET_POLICY；可被
// PIPER_DATA_DIR/settings-budget.json（{ maxSteps, maxTokens,
// maxExternalCalls }，正整数才收）覆盖；环境变量
// PIPER_BUDGET_MAX_STEPS / PIPER_BUDGET_MAX_TOKENS /
// PIPER_BUDGET_MAX_EXTERNAL_CALLS 优先级最高（运维与测试用）。
// 每次 run 现读（readBudgetPolicy），改配置下一轮即生效。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./store.ts";

export interface BudgetPolicy {
	maxSteps: number; // 默认 20，可配置
	maxTokens: number; // 默认 100_000，可配置
	maxExternalCalls: number; // 默认 30，可配置；只计真正执行的外部副作用调用
}

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = { maxSteps: 20, maxTokens: 100_000, maxExternalCalls: 30 };

export type BudgetLimit = "steps" | "tokens" | "external_calls";

export interface BudgetSnapshot {
	steps: number;
	tokens: number;
	externalCalls: number;
	policy: BudgetPolicy;
	tripped: BudgetLimit | null;
}

// 走出进程的外部副作用工具（模型侧名）。工作区文件工具是本地
// 副作用，由步数兜底，不进这一项。
export const EXTERNAL_TOOL_NAMES: ReadonlySet<string> = new Set(["web_fetch", "web_search", "github_comment"]);

export const BUDGET_LIMIT_LABELS: Record<BudgetLimit, string> = {
	steps: "步数",
	tokens: "token",
	external_calls: "外部调用",
};

function positiveInt(value: unknown): number | null {
	const n = typeof value === "string" ? Number(value) : value;
	return typeof n === "number" && Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : null;
}

export function readBudgetPolicy(): BudgetPolicy {
	const policy: BudgetPolicy = { ...DEFAULT_BUDGET_POLICY };
	const file = join(DATA_DIR, "settings-budget.json");
	if (existsSync(file)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (parsed && typeof parsed === "object") {
				const o = parsed as Record<string, unknown>;
				const steps = positiveInt(o.maxSteps);
				const tokens = positiveInt(o.maxTokens);
				const external = positiveInt(o.maxExternalCalls);
				if (steps !== null) policy.maxSteps = steps;
				if (tokens !== null) policy.maxTokens = tokens;
				if (external !== null) policy.maxExternalCalls = external;
			}
		} catch {
			/* 配置文件损坏按缺省走，不因预算配置拖垮对话 */
		}
	}
	const envSteps = positiveInt(process.env.PIPER_BUDGET_MAX_STEPS);
	const envTokens = positiveInt(process.env.PIPER_BUDGET_MAX_TOKENS);
	const envExternal = positiveInt(process.env.PIPER_BUDGET_MAX_EXTERNAL_CALLS);
	if (envSteps !== null) policy.maxSteps = envSteps;
	if (envTokens !== null) policy.maxTokens = envTokens;
	if (envExternal !== null) policy.maxExternalCalls = envExternal;
	return policy;
}

export class BudgetTracker {
	readonly policy: BudgetPolicy;
	steps = 0;
	tokens = 0;
	externalCalls = 0;
	tripped: BudgetLimit | null = null;
	private readonly onTrip: ((snapshot: BudgetSnapshot) => void) | null;

	constructor(policy: BudgetPolicy, onTrip: ((snapshot: BudgetSnapshot) => void) | null = null) {
		this.policy = policy;
		this.onTrip = onTrip;
	}

	snapshot(): BudgetSnapshot {
		return { steps: this.steps, tokens: this.tokens, externalCalls: this.externalCalls, policy: { ...this.policy }, tripped: this.tripped };
	}

	private trip(limit: BudgetLimit): void {
		if (this.tripped) return;
		this.tripped = limit;
		if (this.onTrip) {
			try {
				this.onTrip(this.snapshot());
			} catch {
				/* 跳闸留痕失败不得反过来拖垮 run 的收尾 */
			}
		}
	}

	// 每轮结束累计（finishTurn 调用）：步数 +1、token 加本轮总量；
	// 任一跨限即跳闸。error / aborted 轮由调用方跳过、不计。
	noteTurn(totalTokens: number): void {
		this.steps += 1;
		if (Number.isFinite(totalTokens) && totalTokens > 0) this.tokens += totalTokens;
		if (this.steps >= this.policy.maxSteps) return this.trip("steps");
		if (this.tokens >= this.policy.maxTokens) return this.trip("tokens");
	}

	// 外部工具 execute 入口：允许执行返回 true 并计数；已达上限
	// （或已因别项跳闸）返回 false 且不计数——这次 execute 不发生。
	tryExecuteExternal(): boolean {
		if (this.tripped) return false;
		if (this.externalCalls >= this.policy.maxExternalCalls) {
			this.trip("external_calls");
			return false;
		}
		this.externalCalls += 1;
		return true;
	}
}

// 给外部工具的 execute 加预算闸：计数与拦截都在这里，工具本体
// 不感知预算。被拦下的调用回一个 isError 结果（模型能看到原因），
// 真正的 execute 一次都不会被调到。
export function withBudgetGate<T extends { name: string; execute: (...args: never[]) => Promise<unknown> }>(tools: T[], tracker: BudgetTracker): T[] {
	return tools.map((tool) => {
		if (!EXTERNAL_TOOL_NAMES.has(tool.name)) return tool;
		const original = tool.execute;
		return {
			...tool,
			execute: async (...args: never[]) => {
				if (!tracker.tryExecuteExternal()) {
					const snap = tracker.snapshot();
					return {
						content: [
							{
								type: "text",
								text: `预算已用完：本轮${BUDGET_LIMIT_LABELS[snap.tripped ?? "external_calls"]}已达上限（${snap.externalCalls}/${snap.policy.maxExternalCalls} 次外部调用，步数 ${snap.steps}，token ${snap.tokens}），这次 ${tool.name} 没有执行。请基于已经得到的信息回复用户，不要重试这次调用。`,
							},
						],
						details: { reason: "budget_exceeded", limit: snap.tripped, isError: true },
						isError: true,
					};
				}
				return original(...args);
			},
		};
	});
}
