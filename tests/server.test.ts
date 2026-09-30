import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpFixture } from "./helpers/mcp-fixture.ts";
import { sessionFixture } from "./helpers/session-fixture.ts";

const resource = {
	uri: "not a valid URI",
	name: "test.txt",
	mimeType: "text/plain",
	size: 1,
};
const tool = {
	role: "toolResult",
	toolCallId: "tool-1",
	toolName: "transfer",
	isError: false,
	timestamp: 1,
	content: [{ type: "text", text: "done" }],
	details: { resources: [resource] },
};
const delivery = {
	id: "pending-1",
	chatId: "server-test",
	sessionId: "A",
	cwd: "/fixture",
	toolResults: [
		{
			...tool,
			details: {},
			content: [{ type: "text", text: "PENDING_RESULT" }],
		},
	],
};

test("MCP tool annotations describe mutation and external access accurately", async (t) => {
	const f = await mcpFixture(t);
	const result = await f.request("tools/list", {});
	const tools = result.tools as {
		name: string;
		annotations: Record<string, boolean>;
	}[];
	for (const name of ["write", "edit", "bash", "call", "transfer"]) {
		const info = tools.find((tool) => tool.name === name);
		assert.equal(info?.annotations.readOnlyHint, false, name);
		assert.equal(info?.annotations.idempotentHint, false, name);
	}
	assert.equal(
		tools.find((tool) => tool.name === "history")?.annotations.readOnlyHint,
		true,
	);
	assert.equal(
		tools.find((tool) => tool.name === "transfer")?.annotations.openWorldHint,
		true,
	);
});

test("sessions remains responsive when a registered session never answers inspect", async (t) => {
	const f = await mcpFixture(t, { inputs: () => new Promise(() => {}) });
	const result = await f.call("sessions");
	assert.equal(result.isError, undefined);
	assert.match(JSON.stringify(result), /fixture/);
});

test("format failures do not consume pending results", async (t) => {
	const f = await mcpFixture(t, {
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

test("duplicate receipts do not consume or duplicate another completion", async (t) => {
	const f = await mcpFixture(t, {
		deliveries: () => [delivery],
		call: async () => ({
			sessionId: "A",
			cwd: "/fixture",
			inputs: [],
			toolResults: [],
			replay: {
				id: "operation-1",
				status: "completed",
				instructions: "Do not repeat",
			},
		}),
	});
	const result = await f.call("transfer", {
		paths: ["file"],
		operationId: "one",
	});
	assert.doesNotMatch(JSON.stringify(result), /PENDING_RESULT/);
	assert.equal(f.acknowledgements, 0);
});

test("new sessions expose their host and agent directory", async (t) => {
	const f = await sessionFixture(t);
	const session = f.broker.listSessions()[0] as unknown as {
		host?: string;
		agentDir?: string;
	};
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

test("legacy native failure details remain an MCP error with all member results", async (t) => {
	const f = await mcpFixture(t, {
		call: async () => ({
			sessionId: "A",
			cwd: "/fixture",
			inputs: [],
			toolResults: [
				{
					...tool,
					toolName: "transfer",
					content: [{ type: "text", text: "member results" }],
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
});

test("observer initialization does not deliver another execution's pending result", async (t) => {
	const f = await mcpFixture(t, {
		deliveries: () => [delivery],
		initialize: async () => ({
			session: { id: "A", cwd: "/fixture" },
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
