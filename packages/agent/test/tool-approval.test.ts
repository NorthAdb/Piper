import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { obj, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { runAgentLoop, runToolCall } from "../src/agent-loop.ts";
import type {
	AgentEvent,
	AgentMessage,
	AgentTool,
	BeforeToolCallResult,
	StreamFn,
	ToolApprovalResolution,
} from "../src/types.ts";
import { waitForTick } from "./utils/wait-for-tick.ts";

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

function createToolUseMessage(calls: ToolCallContent[]): AssistantMessage {
	return {
		role: "assistant",
		content: calls,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function scriptedStream(messages: AssistantMessage[]): StreamFn {
	let index = 0;
	return () => {
		const stream = createAssistantMessageEventStream();
		const message = messages[Math.min(index, messages.length - 1)];
		index++;
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
				message,
			});
		});
		return stream;
	};
}

function countingTool(name: string, executedArgs: unknown[]): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: obj({ value: str() }),
		execute: async (_toolCallId: string, params: unknown) => {
			executedArgs.push(params);
			return { content: [{ type: "text", text: `${name} done` }], details: {} };
		},
	};
}

function collectEvents(agent: Agent): AgentEvent[] {
	const events: AgentEvent[] = [];
	agent.subscribe((event) => {
		events.push(event);
	});
	return events;
}

async function waitForEvent(events: AgentEvent[], predicate: (event: AgentEvent) => boolean): Promise<AgentEvent> {
	const startedAt = Date.now();
	for (;;) {
		const found = events.find(predicate);
		if (found) return found;
		if (Date.now() - startedAt > 5000) throw new Error("timed out waiting for event");
		await waitForTick();
	}
}

function toolResults(agent: Agent): Extract<AgentMessage, { role: "toolResult" }>[] {
	return agent.state.messages.filter(
		(message): message is Extract<AgentMessage, { role: "toolResult" }> => message.role === "toolResult",
	);
}

const askAll = async (): Promise<BeforeToolCallResult> => ({ decision: "ask" });
const neverSettles = (): Promise<ToolApprovalResolution> => new Promise(() => {});

describe("tool approval gate", () => {
	it("never executes an unapproved call and emits pending instead of start", async () => {
		const executedArgs: unknown[] = [];
		const order: string[] = [];
		const agent = new Agent({
			initialState: { tools: [countingTool("guarded", executedArgs)] },
			streamFn: scriptedStream([
				createToolUseMessage([{ type: "toolCall", id: "call-1", name: "guarded", arguments: { value: "a" } }]),
				createAssistantMessage("done"),
			]),
			beforeToolCall: askAll,
			onToolApprovalPending: async () => {
				order.push("persist");
			},
			waitForToolApproval: () => {
				order.push("wait");
				return neverSettles();
			},
		});
		const events = collectEvents(agent);

		const promptPromise = agent.prompt("go");
		const pending = await waitForEvent(events, (event) => event.type === "tool_approval_pending");
		expect(pending).toMatchObject({ toolCallId: "call-1", toolName: "guarded", args: { value: "a" } });
		// The pending record is persisted before the wait begins.
		expect(order).toEqual(["persist", "wait"]);
		expect(executedArgs).toHaveLength(0);
		expect(events.some((event) => event.type === "tool_execution_start" && event.toolCallId === "call-1")).toBe(
			false,
		);

		agent.abort();
		await promptPromise;
		expect(executedArgs).toHaveLength(0);
		expect(toolResults(agent)[0]?.isError).toBe(true);
	});

	it("executes exactly once with the approved snapshot after resolveToolCall", async () => {
		const executedArgs: unknown[] = [];
		const agent = new Agent({
			initialState: { tools: [countingTool("guarded", executedArgs)] },
			streamFn: scriptedStream([
				createToolUseMessage([{ type: "toolCall", id: "call-1", name: "guarded", arguments: { value: "snap" } }]),
				createAssistantMessage("done"),
			]),
			beforeToolCall: askAll,
			waitForToolApproval: neverSettles,
		});
		const events = collectEvents(agent);

		const promptPromise = agent.prompt("go");
		await waitForEvent(events, (event) => event.type === "tool_approval_pending");
		await agent.resolveToolCall("call-1", { decision: "allow" });
		await promptPromise;

		expect(executedArgs).toEqual([{ value: "snap" }]);
		const sequence = events
			.filter(
				(event) =>
					(event.type === "tool_approval_pending" ||
						event.type === "tool_execution_start" ||
						event.type === "tool_execution_end") &&
					event.toolCallId === "call-1",
			)
			.map((event) => event.type);
		expect(sequence).toEqual(["tool_approval_pending", "tool_execution_start", "tool_execution_end"]);
		const start = events.find((event) => event.type === "tool_execution_start");
		expect(start && "args" in start ? start.args : undefined).toEqual({ value: "snap" });
		expect(toolResults(agent)[0]?.isError).toBe(false);
	});

	it("lets the host's own wait implementation deliver the decision", async () => {
		const executedArgs: unknown[] = [];
		let release: ((resolution: ToolApprovalResolution) => void) | undefined;
		const agent = new Agent({
			initialState: { tools: [countingTool("guarded", executedArgs)] },
			streamFn: scriptedStream([
				createToolUseMessage([{ type: "toolCall", id: "call-1", name: "guarded", arguments: { value: "a" } }]),
				createAssistantMessage("done"),
			]),
			beforeToolCall: askAll,
			waitForToolApproval: () =>
				new Promise<ToolApprovalResolution>((resolve) => {
					release = resolve;
				}),
		});
		const events = collectEvents(agent);

		const promptPromise = agent.prompt("go");
		await waitForEvent(events, (event) => event.type === "tool_approval_pending");
		release?.({ decision: "deny" });
		await promptPromise;

		expect(executedArgs).toHaveLength(0);
		expect(toolResults(agent)[0]?.isError).toBe(true);
		expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
	});

	it("denies when beforeToolCall returns decision deny, without a start event", async () => {
		const executedArgs: unknown[] = [];
		const agent = new Agent({
			initialState: { tools: [countingTool("guarded", executedArgs)] },
			streamFn: scriptedStream([
				createToolUseMessage([{ type: "toolCall", id: "call-1", name: "guarded", arguments: { value: "a" } }]),
				createAssistantMessage("done"),
			]),
			beforeToolCall: async () => ({ decision: "deny", reason: "not today" }),
		});
		const events = collectEvents(agent);

		await agent.prompt("go");

		expect(executedArgs).toHaveLength(0);
		expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
		const result = toolResults(agent)[0];
		expect(result?.isError).toBe(true);
		expect(result?.content).toEqual([{ type: "text", text: "not today" }]);
	});

	it("denies an ask at the loop level when no approval handler is configured", async () => {
		// The Agent class always installs a wait bridged to resolveToolCall, so the
		// unconfigured case is exercised through the low-level loop entry point.
		const executedArgs: unknown[] = [];
		const tool = countingTool("guarded", executedArgs);
		const events: AgentEvent[] = [];
		const messages = await runAgentLoop(
			[{ role: "user", content: "go", timestamp: Date.now() }],
			{ messages: [], tools: [tool] },
			{
				model: {
					id: "mock",
					name: "mock",
					api: "openai-responses",
					provider: "openai",
					baseUrl: "https://example.invalid",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 2048,
				},
				convertToLlm: (input) =>
					input.filter(
						(message) =>
							message.role === "system" ||
							message.role === "user" ||
							message.role === "assistant" ||
							message.role === "toolResult",
					) as never,
				beforeToolCall: askAll,
			},
			(event) => {
				events.push(event);
			},
			undefined,
			scriptedStream([
				createToolUseMessage([{ type: "toolCall", id: "call-1", name: "guarded", arguments: { value: "a" } }]),
				createAssistantMessage("done"),
			]),
		);

		expect(executedArgs).toHaveLength(0);
		expect(events.some((event) => event.type === "tool_approval_pending")).toBe(true);
		const result = messages.find((message) => message.role === "toolResult");
		expect(result?.isError).toBe(true);
	});

	it("denies when persisting the pending record fails", async () => {
		const executedArgs: unknown[] = [];
		const agent = new Agent({
			initialState: { tools: [countingTool("guarded", executedArgs)] },
			streamFn: scriptedStream([
				createToolUseMessage([{ type: "toolCall", id: "call-1", name: "guarded", arguments: { value: "a" } }]),
				createAssistantMessage("done"),
			]),
			beforeToolCall: askAll,
			onToolApprovalPending: async () => {
				throw new Error("disk full");
			},
			waitForToolApproval: neverSettles,
		});

		await agent.prompt("go");

		expect(executedArgs).toHaveLength(0);
		const result = toolResults(agent)[0];
		expect(result?.isError).toBe(true);
		expect(result?.content).toEqual([{ type: "text", text: "disk full" }]);
	});

	it("applies hook-rewritten arguments and rejects rewrites that fail validation", async () => {
		const executedArgs: unknown[] = [];
		const tool = countingTool("guarded", executedArgs);
		const rewriting = new Agent({
			initialState: { tools: [tool] },
			streamFn: scriptedStream([
				createToolUseMessage([{ type: "toolCall", id: "call-1", name: "guarded", arguments: { value: "raw" } }]),
				createAssistantMessage("done"),
			]),
			beforeToolCall: async () => ({ decision: "allow", arguments: { value: "rewritten" } }),
		});
		await rewriting.prompt("go");
		expect(executedArgs).toEqual([{ value: "rewritten" }]);

		const executedArgs2: unknown[] = [];
		const invalid = new Agent({
			initialState: { tools: [countingTool("guarded", executedArgs2)] },
			streamFn: scriptedStream([
				createToolUseMessage([{ type: "toolCall", id: "call-1", name: "guarded", arguments: { value: "raw" } }]),
				createAssistantMessage("done"),
			]),
			beforeToolCall: async () => ({ decision: "allow", arguments: "not-an-object" }),
		});
		await invalid.prompt("go");
		expect(executedArgs2).toHaveLength(0);
		expect(toolResults(invalid)[0]?.isError).toBe(true);
	});

	it("uses arguments supplied at resolve time as the new snapshot", async () => {
		const executedArgs: unknown[] = [];
		const agent = new Agent({
			initialState: { tools: [countingTool("guarded", executedArgs)] },
			streamFn: scriptedStream([
				createToolUseMessage([{ type: "toolCall", id: "call-1", name: "guarded", arguments: { value: "draft" } }]),
				createAssistantMessage("done"),
			]),
			beforeToolCall: askAll,
			waitForToolApproval: neverSettles,
		});
		const events = collectEvents(agent);

		const promptPromise = agent.prompt("go");
		await waitForEvent(events, (event) => event.type === "tool_approval_pending");
		await agent.resolveToolCall("call-1", { decision: "allow", arguments: { value: "edited" } });
		await promptPromise;

		expect(executedArgs).toEqual([{ value: "edited" }]);
	});

	it("does not let a parallel batch run ahead of a suspended call", async () => {
		const executedA: unknown[] = [];
		const executedB: unknown[] = [];
		const agent = new Agent({
			initialState: { tools: [countingTool("first", executedA), countingTool("second", executedB)] },
			streamFn: scriptedStream([
				createToolUseMessage([
					{ type: "toolCall", id: "call-a", name: "first", arguments: { value: "a" } },
					{ type: "toolCall", id: "call-b", name: "second", arguments: { value: "b" } },
				]),
				createAssistantMessage("done"),
			]),
			toolExecution: "parallel",
			beforeToolCall: async (context) =>
				context.toolCall.name === "first" ? { decision: "ask" } : { decision: "allow" },
			waitForToolApproval: neverSettles,
		});
		const events = collectEvents(agent);

		const promptPromise = agent.prompt("go");
		await waitForEvent(events, (event) => event.type === "tool_approval_pending");
		await waitForTick();
		expect(executedA).toHaveLength(0);
		expect(executedB).toHaveLength(0);

		await agent.resolveToolCall("call-a", { decision: "allow" });
		await promptPromise;
		expect(executedA).toHaveLength(1);
		expect(executedB).toHaveLength(1);
	});

	it("does not start an allowed call while a later batch sibling is suspended (parallel)", async () => {
		const executedA: unknown[] = [];
		const executedB: unknown[] = [];
		const agent = new Agent({
			initialState: { tools: [countingTool("first", executedA), countingTool("second", executedB)] },
			streamFn: scriptedStream([
				createToolUseMessage([
					{ type: "toolCall", id: "call-a", name: "first", arguments: { value: "a" } },
					{ type: "toolCall", id: "call-b", name: "second", arguments: { value: "b" } },
				]),
				createAssistantMessage("done"),
			]),
			toolExecution: "parallel",
			beforeToolCall: async (context) =>
				context.toolCall.name === "second" ? { decision: "ask" } : { decision: "allow" },
			waitForToolApproval: neverSettles,
		});
		const events = collectEvents(agent);

		const promptPromise = agent.prompt("go");
		await waitForEvent(events, (event) => event.type === "tool_approval_pending");
		await waitForTick();
		// The allowed sibling is prepared but must not have started: in the parallel path the
		// start event fires inside the execution thunk, which runs only after preflight ends.
		expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
		expect(executedA).toHaveLength(0);

		agent.abort();
		await promptPromise;
		expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
		expect(executedA).toHaveLength(0);
		expect(executedB).toHaveLength(0);
	});

	it("rejects resolutions for unknown or settled ids during an active run", async () => {
		const executedArgs: unknown[] = [];
		const agent = new Agent({
			initialState: { tools: [countingTool("guarded", executedArgs)] },
			streamFn: scriptedStream([
				createToolUseMessage([{ type: "toolCall", id: "call-1", name: "guarded", arguments: { value: "a" } }]),
				createToolUseMessage([{ type: "toolCall", id: "call-2", name: "guarded", arguments: { value: "b" } }]),
				createAssistantMessage("done"),
			]),
			beforeToolCall: askAll,
			waitForToolApproval: neverSettles,
		});
		const events = collectEvents(agent);

		const promptPromise = agent.prompt("go");
		await waitForEvent(events, (event) => event.type === "tool_approval_pending" && event.toolCallId === "call-1");
		await expect(agent.resolveToolCall("call-nope", { decision: "allow" })).rejects.toThrow(
			"no such tool call in the current run",
		);

		// A duplicate resolve issued in the same task window as the delivery is stale too:
		// the first decision wins and the second one throws instead of silently no-oping.
		const delivered = agent.resolveToolCall("call-1", { decision: "allow" });
		const duplicate = agent.resolveToolCall("call-1", { decision: "deny" });
		await expect(duplicate).rejects.toThrow("already been settled");
		await delivered;
		await waitForEvent(events, (event) => event.type === "tool_approval_pending" && event.toolCallId === "call-2");
		expect(executedArgs).toEqual([{ value: "a" }]);
		// call-1 is settled by now; a second resolution for it in the same run is stale.
		await expect(agent.resolveToolCall("call-1", { decision: "allow" })).rejects.toThrow("already been settled");
		expect(executedArgs).toEqual([{ value: "a" }]);

		agent.abort();
		await promptPromise;
	});

	it("holds a resolution that arrives before the approval wait begins", async () => {
		const executedArgs: unknown[] = [];
		let releaseHook: (() => void) | undefined;
		const hookGate = new Promise<void>((resolve) => {
			releaseHook = resolve;
		});
		const agent = new Agent({
			initialState: { tools: [countingTool("guarded", executedArgs)] },
			streamFn: scriptedStream([
				createToolUseMessage([{ type: "toolCall", id: "call-1", name: "guarded", arguments: { value: "a" } }]),
				createAssistantMessage("done"),
			]),
			beforeToolCall: async () => {
				await hookGate;
				return { decision: "ask" };
			},
			waitForToolApproval: neverSettles,
		});

		let earlyResolve: Promise<void> | undefined;
		agent.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.content.some((content) => content.type === "toolCall")
			) {
				// The call has been issued but its preflight hook has not returned yet, so no
				// approval wait exists: the decision must be held, not dropped or rejected.
				earlyResolve = agent.resolveToolCall("call-1", { decision: "allow" });
			}
		});

		const promptPromise = agent.prompt("go");
		const startedAt = Date.now();
		while (!earlyResolve) {
			if (Date.now() - startedAt > 5000) throw new Error("assistant message never landed");
			await waitForTick();
		}
		await expect(earlyResolve).resolves.toBeUndefined();
		releaseHook?.();
		await promptPromise;
		expect(executedArgs).toEqual([{ value: "a" }]);
	});

	it("aborting during the wait cancels the call; aborting during execution fails it", async () => {
		const executedArgs: unknown[] = [];
		const waiting = new Agent({
			initialState: { tools: [countingTool("guarded", executedArgs)] },
			streamFn: scriptedStream([
				createToolUseMessage([{ type: "toolCall", id: "call-1", name: "guarded", arguments: { value: "a" } }]),
				createAssistantMessage("done"),
			]),
			beforeToolCall: askAll,
			waitForToolApproval: neverSettles,
		});
		const waitingEvents = collectEvents(waiting);
		const waitingPrompt = waiting.prompt("go");
		await waitForEvent(waitingEvents, (event) => event.type === "tool_approval_pending");
		waiting.abort();
		await waitingPrompt;
		expect(executedArgs).toHaveLength(0);
		expect(toolResults(waiting)[0]?.isError).toBe(true);

		let sawAbort = false;
		const slowTool: AgentTool = {
			name: "slow",
			label: "slow",
			description: "slow tool",
			parameters: obj({ value: str() }),
			execute: (_toolCallId: string, _params: unknown, signal?: AbortSignal) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => {
						sawAbort = true;
						reject(new Error("stopped"));
					});
				}),
		};
		const running = new Agent({
			initialState: { tools: [slowTool] },
			streamFn: scriptedStream([
				createToolUseMessage([{ type: "toolCall", id: "call-1", name: "slow", arguments: { value: "a" } }]),
				createAssistantMessage("done"),
			]),
		});
		const runningEvents = collectEvents(running);
		const runningPrompt = running.prompt("go");
		await waitForEvent(runningEvents, (event) => event.type === "tool_execution_start");
		running.abort();
		await runningPrompt;
		expect(sawAbort).toBe(true);
		expect(toolResults(running)[0]?.isError).toBe(true);
	});

	it("gates nested runToolCall invocations the same way", async () => {
		const innerExecuted: unknown[] = [];
		const innerTool = countingTool("inner", innerExecuted);
		let releaseInner: ((resolution: ToolApprovalResolution) => void) | undefined;
		const hooks = {
			beforeToolCall: askAll,
			onToolApprovalPending: async () => {},
			waitForToolApproval: () =>
				new Promise<ToolApprovalResolution>((resolve) => {
					releaseInner = resolve;
				}),
		};
		const outerTool: AgentTool = {
			name: "outer",
			label: "outer",
			description: "outer tool",
			parameters: obj({ value: str() }),
			execute: async () => {
				const outcome = await runToolCall(
					{ type: "toolCall", id: "call-inner", name: "inner", arguments: { value: "n" } },
					{
						tools: [innerTool],
						assistantMessage: createToolUseMessage([
							{ type: "toolCall", id: "call-inner", name: "inner", arguments: { value: "n" } },
						]),
						context: { messages: [], tools: [innerTool] },
						...hooks,
					},
				);
				return {
					content: [{ type: "text", text: outcome.isError ? "inner failed" : "inner ok" }],
					details: {},
				};
			},
		};
		const agent = new Agent({
			initialState: { tools: [outerTool] },
			streamFn: scriptedStream([
				createToolUseMessage([{ type: "toolCall", id: "call-outer", name: "outer", arguments: { value: "o" } }]),
				createAssistantMessage("done"),
			]),
		});

		const promptPromise = agent.prompt("go");
		// Wait until the nested call is suspended inside the outer tool.
		const startedAt = Date.now();
		while (!releaseInner) {
			if (Date.now() - startedAt > 5000) throw new Error("nested call never reached the approval wait");
			await waitForTick();
		}
		expect(innerExecuted).toHaveLength(0);
		releaseInner({ decision: "allow" });
		await promptPromise;
		expect(innerExecuted).toEqual([{ value: "n" }]);
	});
});

describe("resolveToolCall after a restart", () => {
	/** Build an agent, suspend its call, and return the transcript a restart would reload. */
	async function suspendedTranscript(): Promise<{ messages: AgentMessage[]; persistedArgs: unknown[] }> {
		const executedArgs: unknown[] = [];
		const persistedArgs: unknown[] = [];
		const agent = new Agent({
			initialState: { tools: [countingTool("guarded", executedArgs)] },
			streamFn: scriptedStream([
				createToolUseMessage([{ type: "toolCall", id: "call-1", name: "guarded", arguments: { value: "keep" } }]),
				createAssistantMessage("done"),
			]),
			beforeToolCall: askAll,
			onToolApprovalPending: async (context) => {
				persistedArgs.push(context.args);
			},
			waitForToolApproval: neverSettles,
		});
		const events = collectEvents(agent);
		void agent.prompt("go");
		await waitForEvent(events, (event) => event.type === "tool_approval_pending");
		expect(executedArgs).toHaveLength(0);
		// The process "dies" here: the instance is dropped with its wait unsettled.
		return { messages: agent.state.messages.slice(), persistedArgs };
	}

	it("executes a persisted pending call exactly once on a fresh instance", async () => {
		const { messages, persistedArgs } = await suspendedTranscript();
		expect(persistedArgs).toEqual([{ value: "keep" }]);

		const executedArgs: unknown[] = [];
		let pendingHookCalls = 0;
		const revived = new Agent({
			initialState: { messages, tools: [countingTool("guarded", executedArgs)] },
			streamFn: scriptedStream([createAssistantMessage("after")]),
			beforeToolCall: async () => {
				throw new Error("beforeToolCall must not run again for the resolved call");
			},
			onToolApprovalPending: async () => {
				pendingHookCalls++;
			},
		});
		const events = collectEvents(revived);

		await revived.resolveToolCall("call-1", { decision: "allow" });

		expect(executedArgs).toEqual([{ value: "keep" }]);
		expect(pendingHookCalls).toBe(0);
		expect(toolResults(revived)[0]?.isError).toBe(false);
		const last = revived.state.messages[revived.state.messages.length - 1];
		expect(last?.role).toBe("assistant");
		expect(events.some((event) => event.type === "tool_approval_pending")).toBe(false);
	});

	it("executes the persisted snapshot when the host passes it back after a restart", async () => {
		// The preflight hook rewrites the arguments and suspends the call. The persisted
		// approval record holds the rewritten snapshot; the transcript keeps the model's
		// original arguments.
		const persistedSnapshots: unknown[] = [];
		const first = new Agent({
			initialState: { tools: [countingTool("guarded", [])] },
			streamFn: scriptedStream([
				createToolUseMessage([
					{ type: "toolCall", id: "call-1", name: "guarded", arguments: { value: "original" } },
				]),
				createAssistantMessage("done"),
			]),
			beforeToolCall: async () => ({ decision: "ask", arguments: { value: "rewritten" } }),
			onToolApprovalPending: async (context) => {
				persistedSnapshots.push(context.args);
			},
			waitForToolApproval: neverSettles,
		});
		const firstEvents = collectEvents(first);
		void first.prompt("go");
		await waitForEvent(firstEvents, (event) => event.type === "tool_approval_pending");
		expect(persistedSnapshots).toEqual([{ value: "rewritten" }]);
		const transcript = first.state.messages.slice();

		// Host passes the persisted snapshot back: the snapshot executes, not the original.
		const executedWithSnapshot: unknown[] = [];
		const revivedWithSnapshot = new Agent({
			initialState: { messages: transcript, tools: [countingTool("guarded", executedWithSnapshot)] },
			streamFn: scriptedStream([createAssistantMessage("after")]),
		});
		await revivedWithSnapshot.resolveToolCall("call-1", {
			decision: "allow",
			arguments: persistedSnapshots[0],
		});
		expect(executedWithSnapshot).toEqual([{ value: "rewritten" }]);

		// Contract, stated plainly: an allow that omits `arguments` after a restart executes
		// the transcript arguments. The snapshot lives only in the host's record.
		const executedWithoutSnapshot: unknown[] = [];
		const revivedWithoutSnapshot = new Agent({
			initialState: { messages: transcript, tools: [countingTool("guarded", executedWithoutSnapshot)] },
			streamFn: scriptedStream([createAssistantMessage("after")]),
		});
		await revivedWithoutSnapshot.resolveToolCall("call-1", { decision: "allow" });
		expect(executedWithoutSnapshot).toEqual([{ value: "original" }]);
	});

	it("writes an error result instead of executing when the persisted call is denied", async () => {
		const { messages } = await suspendedTranscript();
		const executedArgs: unknown[] = [];
		const revived = new Agent({
			initialState: { messages, tools: [countingTool("guarded", executedArgs)] },
			streamFn: scriptedStream([createAssistantMessage("after")]),
		});

		await revived.resolveToolCall("call-1", { decision: "deny" });

		expect(executedArgs).toHaveLength(0);
		expect(toolResults(revived)[0]?.isError).toBe(true);
	});

	it("rejects stale or unknown resolutions with an explicit error", async () => {
		const { messages } = await suspendedTranscript();
		const executedArgs: unknown[] = [];
		const revived = new Agent({
			initialState: { messages, tools: [countingTool("guarded", executedArgs)] },
			streamFn: scriptedStream([createAssistantMessage("after")]),
		});

		await expect(revived.resolveToolCall("call-unknown", { decision: "allow" })).rejects.toThrow("no such tool call");
		expect(executedArgs).toHaveLength(0);

		await revived.resolveToolCall("call-1", { decision: "allow" });
		expect(executedArgs).toHaveLength(1);
		// A second resolution for the same call is stale: a result already exists.
		await expect(revived.resolveToolCall("call-1", { decision: "allow" })).rejects.toThrow();
		expect(executedArgs).toHaveLength(1);
	});

	it("keeps continue() rejecting the suspended transcript shape", async () => {
		const { messages } = await suspendedTranscript();
		const revived = new Agent({
			initialState: { messages, tools: [countingTool("guarded", [])] },
			streamFn: scriptedStream([createAssistantMessage("after")]),
		});

		await expect(revived.continue()).rejects.toThrow("Cannot continue from message role: assistant");
	});
});
