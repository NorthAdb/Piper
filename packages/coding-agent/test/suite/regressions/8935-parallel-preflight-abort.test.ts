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
		// Piper P2-1 event contract: `tool_execution_start` fires only after a call has passed
		// preflight and is about to execute, so the call whose preflight aborted emits an end
		// without a start. Upstream #8935 pinned two starts under the old preflight-start
		// timing; the regression property (no prepared tool executes) is unchanged.
		expect(starts).toHaveLength(1);
		expect(starts[0]?.args).toEqual({ value: "first" });
		expect(ends).toHaveLength(2);
		expect(ends.every((event) => event.isError)).toBe(true);

		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(new Set(toolResults.map((message) => message.toolCallId))).toEqual(
			new Set(ends.map((event) => event.toolCallId)),
		);
		expect(toolResults.map(getMessageText)).toEqual(["Operation aborted", "Operation aborted"]);
	});
});
