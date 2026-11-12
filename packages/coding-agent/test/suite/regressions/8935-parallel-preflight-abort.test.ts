import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

describe("#8935 parallel preflight abort", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("does not start prepared tools after a later preflight aborts", async () => {
		const executions: string[] = [];
		const preflights: string[] = [];
		const resultHooks: string[] = [];
		const externalWrite: AgentTool = {
			name: "external_write",
			label: "External write",
			description: "Perform an external write",
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_toolCallId, params) => {
				const value =
					typeof params === "object" && params !== null && "value" in params ? String(params.value) : "";
				executions.push(value);
				return { content: [{ type: "text", text: value }], details: { value } };
			},
		};
		const harness = await createHarness({
			tools: [externalWrite],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async (event, ctx) => {
						const value = "value" in event.input ? String(event.input.value) : "";
						preflights.push(value);
						if (value === "second") ctx.abort();
					});
					pi.on("tool_result", async (event) => {
						resultHooks.push(event.toolCallId);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("external_write", { value: "first" }), fauxToolCall("external_write", { value: "second" })],
				{ stopReason: "toolUse" },
			),
		]);

		await harness.session.prompt("run both writes");

		expect(preflights).toEqual(["first", "second"]);
		expect(executions).toEqual([]);
		expect(resultHooks).toEqual([]);

		const starts = harness.eventsOfType("tool_execution_start");
		const ends = harness.eventsOfType("tool_execution_end");
		// Piper P2-1 event contract: `tool_execution_start` fires only once a call is actually
		// about to execute (in the parallel path, inside the execution thunk, after the abort
		// check). Neither call executes in this scenario, so there are no starts at all.
		// Upstream #8935 pinned two starts under the old preflight-start timing; the regression
		// property (no prepared tool executes) is unchanged.
		expect(starts).toHaveLength(0);
		expect(ends).toHaveLength(2);
		expect(ends.every((event) => event.isError)).toBe(true);
		for (const start of starts) {
			expect(ends.map((event) => event.toolCallId)).toContain(start.toolCallId);
		}

		const assistantMessage = harness.session.messages.find((message) => message.role === "assistant");
		const issuedIds = (assistantMessage?.content ?? []).flatMap((content) =>
			content.type === "toolCall" ? [content.id] : [],
		);
		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults.map((message) => message.toolCallId)).toEqual(issuedIds);
		expect(toolResults.map(getMessageText)).toEqual(["Operation aborted", "Operation aborted"]);
	});
});
