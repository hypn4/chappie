import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";
import type { Broker } from "../src/broker.ts";
import { serveMcp } from "../src/stdio.ts";

const owner = "modern-test";
const operation = {
	operationId: "long-op",
	sessionId: "A",
	cwd: "/fixture",
	updatedAt: Date.now(),
	status: "running",
};
const eventParams = {
	name: "operation.finished",
	arguments: { operation_id: "long-op" },
	delivery: {
		mode: "webhook",
		url: "https://events.example.test/callback",
		secret: `whsec_${Buffer.alloc(32, 1).toString("base64")}`,
	},
};
function record(value: unknown): Record<string, unknown> {
	assert.ok(value && typeof value === "object" && !Array.isArray(value));
	return value as Record<string, unknown>;
}
async function fixture(
	t: TestContext,
	overrides: Record<string, unknown> = {},
) {
	const broker = {
		askEnabled: false,
		deliveries: () => [],
		answers: () => [],
		acknowledge: async () => {},
		startCall: async () => ({ operation }),
		operation: (chatId: string, id: string) => {
			if (id !== "long-op" || chatId !== owner)
				throw new Error("Operation not found");
			return { operation, deliveries: [] };
		},
		subscribeOperationEvent: async () => ({ id: "sub_test", expiresAt: null }),
		unsubscribeOperationEvent: async () => {},
		...overrides,
	} as unknown as Broker;
	const pending = new Map<number, (message: JSONRPCMessage) => void>();
	const transport: Transport = {
		async start() {},
		async close() {
			transport.onclose?.();
		},
		async send(message) {
			if ("id" in message && typeof message.id === "number")
				pending.get(message.id)?.(message);
		},
	};
	const errors: Error[] = [];
	const handle = serveMcp(broker, {
		transport,
		onerror: (error) => errors.push(error),
	});
	t.after(() => handle.close());
	let id = 0;
	async function request(
		method: string,
		params: Record<string, unknown> = {},
		chat: string | null = owner,
		modern = true,
	) {
		const next = ++id;
		const completion = Promise.withResolvers<JSONRPCMessage>();
		pending.set(next, completion.resolve);
		const timer = setTimeout(
			() =>
				completion.reject(
					new Error(
						`MCP ${method} timed out: ${errors.map((e) => e.message).join("; ")}`,
					),
				),
			1500,
		);
		transport.onmessage?.({
			jsonrpc: "2.0",
			id: next,
			method,
			params: {
				...params,
				_meta: {
					...(modern
						? {
								"io.modelcontextprotocol/protocolVersion": "2026-07-28",
								"io.modelcontextprotocol/clientCapabilities": {},
							}
						: {}),
					...(chat === null ? {} : { "openai/session": chat }),
					"otunnel/requestId": `test-${next}`,
				},
			},
		});
		try {
			return await completion.promise;
		} finally {
			clearTimeout(timer);
			pending.delete(next);
		}
	}
	return { request };
}
function resultOf(message: JSONRPCMessage) {
	assert.ok("result" in message, JSON.stringify(message));
	return record(message.result);
}

test("modern discovery advertises Events without nonfunctional Tasks support", async (t) => {
	const f = await fixture(t);
	const discovery = resultOf(await f.request("server/discover"));
	assert.equal(discovery.resultType, "complete");
	const capabilities = record(discovery.capabilities);
	assert.deepEqual(capabilities.events, {});
	assert.equal(capabilities.tasks, undefined);
	assert.equal(capabilities.extensions, undefined);
	const events = resultOf(await f.request("events/list"));
	assert.ok(Array.isArray(events.events));
	assert.equal(record(events.events[0]).name, "operation.finished");
});

test("modern start_call returns supported durable operation output, not a fake Task", async (t) => {
	const f = await fixture(t);
	const result = resultOf(
		await f.request("tools/call", {
			name: "start_call",
			arguments: {
				operationId: "long-op",
				calls: [{ name: "read", arguments: { path: "file" } }],
			},
		}),
	);
	assert.equal(result.resultType, "complete");
	assert.deepEqual(JSON.parse(String(record(result.structuredContent).text)), {
		operation,
	});
});

test("modern operation retrieval requires the originating conversation", async (t) => {
	const f = await fixture(t);
	for (const chat of [null, "another-chat"]) {
		const response = await f.request(
			"tools/call",
			{ name: "get_operation", arguments: { operationId: "long-op" } },
			chat,
		);
		assert.ok("error" in response || resultOf(response).isError === true);
	}
	const result = resultOf(
		await f.request("tools/call", {
			name: "get_operation",
			arguments: { operationId: "long-op" },
		}),
	);
	assert.notEqual(result.isError, true);
});

test("Events subscribe and unsubscribe follow the documented wire profile", async (t) => {
	const f = await fixture(t);
	const subscribed = resultOf(await f.request("events/subscribe", eventParams));
	assert.equal(subscribed.id, "sub_test");
	assert.equal(subscribed.cursor, null);
	assert.equal(subscribed.refreshBefore, null);
	assert.equal(subscribed.truncated, false);
	const { secret: _secret, ...delivery } = eventParams.delivery;
	const removed = resultOf(
		await f.request("events/unsubscribe", { ...eventParams, delivery }),
	);
	assert.equal(removed.resultType, "complete");
	const denied = await f.request(
		"events/subscribe",
		eventParams,
		"another-chat",
	);
	assert.ok("error" in denied);
});

test("Events callback verification errors are protocol errors without secrets", async (t) => {
	const f = await fixture(t, {
		subscribeOperationEvent: async () => {
			throw new Error("Webhook verification challenge mismatch");
		},
	});
	const response = await f.request("events/subscribe", eventParams);
	assert.ok("error" in response);
	assert.equal(record(response.error).code, -32015);
	assert.equal(record(record(response.error).data).reason, "challenge_failed");
	assert.ok(!JSON.stringify(response).includes(eventParams.delivery.secret));
});

test("Events rejects unsupported delivery modes and replay cursors", async (t) => {
	const f = await fixture(t);
	for (const params of [
		{ ...eventParams, cursor: "unsupported" },
		{ ...eventParams, delivery: { mode: "poll" } },
	]) {
		const response = await f.request("events/subscribe", params);
		assert.ok("error" in response);
		assert.equal(record(response.error).code, -32602);
	}
});

test("get_operation returns retained native output after pending delivery was acknowledged", async (t) => {
	const f = await fixture(t, {
		operation: () => ({
			operation: { ...operation, status: "completed" },
			deliveries: [],
			result: {
				id: "retained",
				chatId: owner,
				operationKey: "key",
				sessionId: "A",
				cwd: "/fixture",
				complete: true,
				toolResults: [
					{
						toolCallId: "read-result",
						toolName: "read",
						isError: false,
						content: [{ type: "text", text: "RETAINED_OUTPUT" }],
					},
				],
			},
		}),
	});
	const result = resultOf(
		await f.request("tools/call", {
			name: "get_operation",
			arguments: { operationId: "long-op" },
		}),
	);
	assert.match(
		String(record(result.structuredContent).text),
		/RETAINED_OUTPUT/,
	);
});

test("legacy initialize is rejected without downgrading the connection", async (t) => {
	const f = await fixture(t);
	const refused = await f.request(
		"initialize",
		{
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "old-client", version: "1" },
		},
		owner,
		false,
	);
	assert.ok("error" in refused, JSON.stringify(refused));
	assert.equal(record(refused.error).code, -32022);
	const discovery = resultOf(await f.request("server/discover"));
	assert.deepEqual(discovery.supportedVersions, ["2026-07-28"]);
});

test("tool batches use one JSON contract and reject the removed Base64 alias", async (t) => {
	const f = await fixture(t);
	const listed = resultOf(await f.request("tools/list"));
	assert.ok(Array.isArray(listed.tools));
	for (const name of ["call", "start_call"]) {
		const definition: Record<string, unknown> | undefined = listed.tools
			.map(record)
			.find((tool) => tool.name === name);
		assert.ok(definition);
		const schema = record(definition.inputSchema);
		assert.equal(record(schema.properties).base64, undefined);
		assert.ok(
			Array.isArray(schema.required) && schema.required.includes("calls"),
		);
		const rejected = await f.request("tools/call", {
			name,
			arguments: { operationId: "op", base64: "W10=" },
		});
		assert.ok("error" in rejected || resultOf(rejected).isError === true);
	}
});
