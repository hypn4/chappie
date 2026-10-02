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

test("modern discovery stays tool-only for Chat and does not serve Events", async (t) => {
	const f = await fixture(t);
	const discovery = resultOf(await f.request("server/discover"));
	assert.equal(discovery.resultType, "complete");
	const capabilities = record(discovery.capabilities);
	assert.equal(capabilities.events, undefined);
	assert.equal(capabilities.tasks, undefined);
	assert.equal(capabilities.extensions, undefined);
	const events = await f.request("events/list");
	assert.ok("error" in events);
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
