import assert from "node:assert/strict";
import { test } from "node:test";
import type { Broker } from "../src/broker.ts";
import type { DeliveryRecord } from "../src/delivery.ts";
import type { SessionInput } from "../src/ipc.ts";
import { mcpClient, resultOf } from "./helpers/mcp-client.ts";

test("failed response send preserves pending output and input until a successful retry", async (t) => {
	const delivery: DeliveryRecord = {
		id: "deferred-1",
		chatId: "review-chat",
		sessionId: "A",
		cwd: "/fixture",
		toolResults: [
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "read",
				content: [{ type: "text", text: "PENDING_REVIEW_RESULT" }],
				isError: false,
				timestamp: 1,
			},
		],
	};
	const input: SessionInput = {
		id: "input-1",
		sessionId: "A",
		message: { role: "user", content: "INPUT", timestamp: 1 },
	};
	let pending = [delivery];
	const acknowledged: string[] = [];
	const acknowledgedInputs: string[] = [];
	const broker: Partial<Broker> = {
		askEnabled: false,
		initialize: async () => ({
			selection: "explicit",
			session: {
				id: "A",
				cwd: "/fixture",
				device: "test",
				host: "omp",
				status: "idle",
			},
			tools: [],
			skills: [],
			inputs: [input],
		}),
		deliveries: () => pending,
		answers: () => [],
		acknowledge: async (deliveries) => {
			acknowledged.push(...deliveries.map((item) => item.id));
			pending = [];
		},
		acknowledgeInputs: async (sessionId, inputs) => {
			assert.equal(sessionId, "A");
			acknowledgedInputs.push(...inputs.map((item) => item.id));
		},
	};
	const client = mcpClient(t, broker as Broker);
	await client.request("server/discover");
	client.failNextSend();
	await assert.rejects(
		client.call("init", { sessionId: "A" }, { chatId: "review-chat" }),
		/simulated send failure/,
	);
	assert.deepEqual(acknowledged, []);
	assert.deepEqual(acknowledgedInputs, []);
	assert.deepEqual(pending, [delivery]);

	const response = resultOf(
		await client.call("init", { sessionId: "A" }, { chatId: "review-chat" }),
	);
	assert.match(JSON.stringify(response.content), /PENDING_REVIEW_RESULT/);
	assert.match(JSON.stringify(response.content), /input-1/);
	assert.deepEqual(acknowledged, ["deferred-1"]);
	assert.deepEqual(acknowledgedInputs, ["input-1"]);
	assert.deepEqual(pending, []);
});
