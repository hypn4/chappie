import assert from "node:assert/strict";
import { test } from "node:test";
import type { Broker } from "../src/broker.ts";
import type { DeliveryRecord } from "../src/delivery.ts";
import type { SessionInput } from "../src/ipc.ts";
import { mcpClient, resultOf } from "./helpers/mcp-client.ts";
import { quietDiagnostics } from "./helpers/mcp-fixture.ts";

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
		diagnostics: quietDiagnostics(),
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

test("cancelled response staging cannot acknowledge old data on a reused request id", async (t) => {
	const saving = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	t.after(() => release.resolve());
	let acknowledgements = 0;
	const client = mcpClient(t, {
		askEnabled: false,
		diagnostics: quietDiagnostics(),
		initialize: async (
			_chat: string,
			_session: string | undefined,
			_request: unknown,
			signal: AbortSignal,
		) => {
			signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			return {
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
				inputs: [
					{
						id: "unread",
						sessionId: "A",
						message: {
							role: "user",
							timestamp: 1,
							content: "x".repeat(40_000),
						},
					},
				],
			};
		},
		deliveries: () => [],
		answers: () => [],
		acknowledgeInputs: async () => {
			acknowledgements++;
		},
		saveResponse: async () => {
			saving.resolve();
			await release.promise;
			return "a".repeat(64);
		},
	} as unknown as Broker);
	const request = client.call("init", { sessionId: "A" }, { id: 90 });
	const cancelled = assert.rejects(request, /fixture cancellation/);
	await saving.promise;
	client.cancel(90);
	await aborted.promise;
	await cancelled;
	release.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
	await client.request("server/discover", {}, { id: 90 });
	assert.equal(
		acknowledgements,
		0,
		"a discovery response did not deliver or acknowledge the cancelled input",
	);
});
