import assert from "node:assert/strict";
import { test } from "node:test";
import type { Broker } from "../src/broker.ts";
import type { DeliveryReference } from "../src/delivery.ts";
import type { SessionToolResult } from "../src/ipc.ts";
import { toolResult } from "../src/tools.ts";
import { mcpFixture } from "./helpers/mcp-fixture.ts";
import { sessionFixture } from "./helpers/session-fixture.ts";

const resource = {
	uri: "not a valid URI",
	name: "test.txt",
	mimeType: "text/plain",
	size: 1,
};
const tool: SessionToolResult = {
	role: "toolResult",
	toolCallId: "tool-1",
	toolName: "transfer",
	isError: false,
	timestamp: 1,
	content: [{ type: "text", text: "done" }],
	details: { resources: [resource] },
};
const deliveryOutput = JSON.stringify(
	toolResult(
		[
			{
				...tool,
				details: {},
				content: [{ type: "text", text: "PENDING_RESULT" }],
			},
		],
		"A",
		"/fixture",
	),
);
const delivery: DeliveryReference = {
	id: "pending-1",
	chatId: "server-test",
	sessionId: "A",
	cwd: "/fixture",
	resultId: "d".repeat(64),
	bytes: Buffer.byteLength(deliveryOutput),
	failed: false,
};
const deliveryStore: Pick<Broker, "readResponse" | "markResponseRead"> = {
	readResponse: async (chatId, resultId) => {
		assert.equal(chatId, "server-test");
		assert.equal(resultId, delivery.resultId);
		return deliveryOutput;
	},
	markResponseRead: async (chatId, resultId) => {
		assert.equal(chatId, "server-test");
		assert.equal(resultId, delivery.resultId);
	},
};

test("MCP tool annotations describe mutation and external access accurately", async (t) => {
	const f = await mcpFixture(t);
	const result = await f.request("tools/list", {});
	const tools = result.tools as {
		name: string;
		annotations: Record<string, boolean>;
	}[];
	for (const name of ["call"]) {
		const info = tools.find((tool) => tool.name === name);
		assert.equal(info?.annotations.readOnlyHint, false, name);
		assert.equal(info?.annotations.idempotentHint, false, name);
	}
	assert.equal(
		tools.find((tool) => tool.name === "transfer")?.annotations.idempotentHint,
		true,
	);
	assert.equal(
		tools.find((tool) => tool.name === "history")?.annotations.readOnlyHint,
		true,
	);
	assert.equal(
		tools.find((tool) => tool.name === "transfer")?.annotations.openWorldHint,
		true,
	);
});

test("long-operation tools expose safe annotations and stable IDs", async (t) => {
	const f = await mcpFixture(t);
	const result = await f.request("tools/list", {});
	const tools = result.tools as {
		name: string;
		annotations: Record<string, boolean>;
		inputSchema: { required?: string[] };
	}[];
	const start = tools.find((tool) => tool.name === "start_call");
	assert.equal(start?.annotations.readOnlyHint, false);
	assert.equal(start?.annotations.destructiveHint, true);
	assert.equal(start?.annotations.idempotentHint, true);
	assert.ok(start?.inputSchema.required?.includes("operationId"));
	const status = tools.find((tool) => tool.name === "get_operation");
	assert.equal(status?.annotations.readOnlyHint, true);
	assert.equal(status?.annotations.idempotentHint, true);
	const cancel = tools.find((tool) => tool.name === "cancel_operation");
	assert.equal(cancel?.annotations.readOnlyHint, false);
	assert.equal(cancel?.annotations.destructiveHint, true);
	assert.equal(cancel?.annotations.idempotentHint, true);
});

test("get_operation delivers and acknowledges the matching detached result", async (t) => {
	const pending = {
		...delivery,
		id: "operation-result",
		operationKey: "operation-key",
	};
	const f = await mcpFixture(t, {
		...deliveryStore,
		operation: () => ({
			operation: {
				operationId: "long-read",
				status: "completed",
				sessionId: "A",
				cwd: "/fixture",
				updatedAt: 1,
			},
			deliveries: [pending],
			inputs: [],
		}),
	});
	const result = await f.call("get_operation", { operationId: "long-read" });
	assert.notEqual(result.isError, true);
	assert.match(JSON.stringify(result), /long-read/);
	assert.match(JSON.stringify(result), /PENDING_RESULT/);
	assert.equal(f.acknowledgements, 1);
});

test("start_call returns durable acceptance without waiting for native completion", async (t) => {
	let starts = 0;
	const f = await mcpFixture(t, {
		startCall: async () => {
			starts++;
			return {
				operation: {
					operationId: "long-read",
					status: "running",
					sessionId: "A",
					cwd: "/fixture",
					updatedAt: 1,
				},
			};
		},
	});
	const result = await f.call("start_call", {
		operationId: "long-read",
		calls: [{ name: "read", arguments: { path: "test.txt" } }],
	});
	assert.notEqual(result.isError, true);
	assert.match(
		String((result.structuredContent as { text?: string } | undefined)?.text),
		/"status":"running"/,
	);
	assert.equal(starts, 1);
});

test("cancel_operation returns durable cancellation state", async (t) => {
	let cancellations = 0;
	const f = await mcpFixture(t, {
		cancelOperation: async () => {
			cancellations++;
			return {
				operation: {
					operationId: "long-read",
					status: "cancelled",
					sessionId: "A",
					cwd: "/fixture",
					updatedAt: 2,
					error: "Operation cancelled by ChatGPT",
				},
				deliveries: [],
				inputs: [],
			};
		},
	});
	const result = await f.call("cancel_operation", {
		operationId: "long-read",
	});
	assert.notEqual(result.isError, true);
	assert.match(
		String((result.structuredContent as { text?: string } | undefined)?.text),
		/"status":"cancelled"/,
	);
	assert.equal(cancellations, 1);
});

test("sessions remains responsive when a registered session never answers inspect", async (t) => {
	const f = await mcpFixture(t, { inputs: () => new Promise(() => {}) });
	const result = await f.call("sessions");
	assert.equal(result.isError, undefined);
	assert.match(JSON.stringify(result), /fixture/);
});

test("format failures do not consume pending results", async (t) => {
	const f = await mcpFixture(t, {
		...deliveryStore,
		deliveries: () => [delivery],
		call: async () => ({
			sessionId: "A",
			cwd: "/fixture",
			inputs: [],
			toolResults: [tool],
		}),
	});
	const result = await f.call("transfer", {
		paths: ["file"],
		operationId: "one",
	});
	assert.equal(result.isError, true);
	assert.equal(f.acknowledgements, 0);
});

test("completed replay still delivers and acknowledges other pending results", async (t) => {
	const f = await mcpFixture(t, {
		...deliveryStore,
		deliveries: () => [delivery],
		call: async () => ({
			sessionId: "A",
			cwd: "/fixture",
			inputs: [],
			toolResults: [],
			replay: {
				id: "operation-1",
				status: "completed",
				replayed: true,
			},
		}),
	});
	const result = await f.call("transfer", {
		paths: ["file"],
		operationId: "one",
	});
	assert.match(JSON.stringify(result), /PENDING_RESULT/);
	assert.equal(f.acknowledgements, 1);
});

test("completed chat replay still delivers and acknowledges other pending results", async (t) => {
	const f = await mcpFixture(t, {
		...deliveryStore,
		deliveries: () => [delivery],
		chat: async () => ({
			sessionId: "A",
			cwd: "/fixture",
			inputs: [],
			replay: {
				id: "operation-chat",
				status: "completed",
				replayed: true,
			},
		}),
	});
	const result = await f.call("chat", { text: "hello" });
	assert.match(JSON.stringify(result), /PENDING_RESULT/);
	assert.equal(f.acknowledgements, 1);
});

test("completed transfer replay re-exposes unread resources to the same ChatGPT session", async (t) => {
	const replayResource = {
		uri: "chappie://session/A/file/replay/file.txt",
		name: "file.txt",
		mimeType: "text/plain",
		size: 1,
	};
	const f = await mcpFixture(t, {
		call: async () => ({
			sessionId: "A",
			cwd: "/fixture",
			inputs: [],
			toolResults: [],
			replay: {
				id: "operation-resource",
				status: "completed",
				replayed: true,
				delivery: {
					hostReceipt: "unconfirmed",
					resources: [replayResource],
				},
			},
		}),
	});
	const result = await f.call("transfer", {
		paths: ["file.txt"],
		operationId: "resource-replay",
	});
	const links = (result.content as Array<Record<string, unknown>>).filter(
		(block) => block.type === "resource_link",
	);
	assert.equal(links.length, 1);
	assert.match(String(links[0]?.uri), /chatId=server-test/);
});

test("new sessions expose their host and agent directory", async (t) => {
	const f = await sessionFixture(t);
	const session = f.broker.listSessions()[0];
	assert.ok(session);
	assert.equal(session.host, "omp");
	assert.equal(session.agentDir, f.root);
});

test("direct transfer requires a stable operation ID in its public schema", async (t) => {
	const f = await mcpFixture(t);
	const catalog = await f.request("tools/list", {});
	const tools = catalog.tools as {
		name: string;
		inputSchema: { required?: string[] };
	}[];
	assert.ok(
		tools
			.find((tool) => tool.name === "transfer")
			?.inputSchema.required?.includes("operationId"),
	);
	const rejected = await f.call("transfer", { paths: ["test.txt"] });
	assert.equal(rejected.isError, true);
});

test("native transfer failure details remain an MCP error with all member results", async (t) => {
	const f = await mcpFixture(t, {
		call: async () => ({
			sessionId: "A",
			cwd: "/fixture",
			inputs: [],
			toolResults: [
				{
					...tool,
					toolName: "transfer",
					content: [
						{
							type: "text",
							text: JSON.stringify({
								failed: true,
								files: [
									{ path: "good", bytes: 3 },
									{ path: "bad", error: "HTTP 404" },
								],
							}),
						},
					],
					details: {
						failed: true,
						files: [
							{ path: "good", bytes: 3 },
							{ path: "bad", error: "HTTP 404" },
						],
					},
				},
			],
		}),
	});
	const result = await f.call("transfer", {
		paths: ["good", "bad"],
		operationId: "mixed",
	});
	assert.equal(result.isError, true);
	const content = result.content as Array<{ type: string; text?: string }>;
	const members = content
		.filter((block) => block.type === "text")
		.map((block) => {
			try {
				return JSON.parse(block.text ?? "");
			} catch {
				return undefined;
			}
		})
		.find((value) => value?.files);
	assert.deepEqual(members, {
		failed: true,
		files: [
			{ path: "good", bytes: 3 },
			{ path: "bad", error: "HTTP 404" },
		],
	});
});

test("observer initialization does not deliver another execution's pending result", async (t) => {
	const f = await mcpFixture(t, {
		...deliveryStore,
		deliveries: () => [delivery],
		initialize: async () => ({
			selection: "explicit",
			tools: [],
			skills: [],
			session: {
				id: "A",
				cwd: "/fixture",
				host: "omp",
				device: "test",
				status: "idle",
			},
			inputs: [],
			initialization: {
				sessionId: "A",
				mode: "observer",
				instructions: "Do not repeat completion",
			},
		}),
	});
	const result = await f.call("init", { sessionId: "A" });
	assert.doesNotMatch(JSON.stringify(result), /PENDING_RESULT/);
	assert.equal(f.acknowledgements, 0);
});

test("otunnel metadata preserves conversation and request identity at the broker boundary", async (t) => {
	const observed: { chatId: string; requestId: unknown }[] = [];
	const f = await mcpFixture(t, {
		call: async (
			chatId: string,
			_sessionId: string | undefined,
			_calls: unknown[],
			requestId: unknown,
		) => {
			observed.push({ chatId, requestId });
			return {
				sessionId: "A",
				cwd: "/fixture",
				inputs: [],
				toolResults: [],
			};
		},
	});
	for (let index = 0; index < 2; index++) {
		await f.request("tools/call", {
			name: "call",
			arguments: {
				calls: [{ name: "read", arguments: { path: "test.txt" } }],
			},
			_meta: {
				"openai/session": "tunnel-chat",
				"otunnel/requestId": "tunnel-request",
			},
		});
	}
	assert.deepEqual(observed, [
		{ chatId: "tunnel-chat", requestId: "tunnel-request" },
		{ chatId: "tunnel-chat", requestId: "tunnel-request" },
	]);
});

test("call accepts the native JSON batch", async (t) => {
	const observed: unknown[] = [];
	const f = await mcpFixture(t, {
		call: async (
			_chatId: string,
			_sessionId: string | undefined,
			calls: unknown[],
		) => {
			observed.push(calls);
			return {
				sessionId: "A",
				cwd: "/fixture",
				inputs: [],
				toolResults: [],
			};
		},
	});
	const calls = [{ name: "read", arguments: { path: "file.txt" } }];
	const result = await f.call("call", { calls });
	assert.equal(result.isError, false);
	assert.deepEqual(observed, [calls]);
});

test("call rejects removed Base64 arguments before execution", async (t) => {
	let executions = 0;
	const f = await mcpFixture(t, {
		call: async () => {
			executions++;
			throw new Error("must not execute");
		},
	});
	const calls = [{ name: "read", arguments: { path: "file.txt" } }];
	const encoded = Buffer.from(JSON.stringify(calls), "utf8").toString("base64");
	for (const args of [
		{ calls, base64: encoded },
		{ base64: "not base64!" },
		{ base64: Buffer.from([0xff, 0xfe, 0xfd]).toString("base64") },
		{
			base64: Buffer.from(JSON.stringify({ calls }), "utf8").toString("base64"),
		},
	]) {
		const result = await f.call("call", args);
		assert.equal(result.isError, true, JSON.stringify(args));
	}
	assert.equal(executions, 0);
});

test("history does not read or acknowledge pending session input", async (t) => {
	let inputReads = 0;
	const f = await mcpFixture(t, {
		history: async () => ({
			sessionId: "A",
			cwd: "/fixture",
			history: { count: 0, hasMore: false, content: [] },
		}),
		inputs: async () => {
			inputReads++;
			return [];
		},
	});
	const result = await f.call("history", { sessionId: "A", limit: 20 });
	assert.equal(result.isError, undefined);
	assert.equal(inputReads, 0);
	assert.equal(f.acknowledgements, 0);
});
