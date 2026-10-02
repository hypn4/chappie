import assert from "node:assert/strict";
import { test } from "node:test";
import type { Broker } from "../src/broker.ts";
import { mcpFixture } from "./helpers/mcp-fixture.ts";
import { sessionFixture } from "./helpers/session-fixture.ts";

const bridgeTools = [
	"sessions",
	"init",
	"tools",
	"call",
	"chat",
	"history",
	"transfer",
	"start_call",
	"get_operation",
	"cancel_operation",
];

test("MCP exposes only bridge operations, never duplicate native wrappers", async (t) => {
	const f = await mcpFixture(t);
	const catalog = await f.request("tools/list", {});
	const tools = catalog.tools as {
		name: string;
		_meta?: Record<string, unknown>;
	}[];
	assert.deepEqual(
		tools.map(({ name }) => name).sort(),
		[...bridgeTools].sort(),
	);
	assert.deepEqual(
		tools.find(({ name }) => name === "transfer")?._meta?.["openai/fileParams"],
		["files"],
	);
});

test("native calls are transparent while host file provenance stays exclusive to transfer", async (t) => {
	const seen: unknown[][] = [];
	const f = await mcpFixture(t, {
		call: async (...args: unknown[]) => {
			seen.push(args);
			return { sessionId: "A", cwd: "/fixture", inputs: [], toolResults: [] };
		},
	});
	const calls = [
		{
			name: "extension_native_tool",
			arguments: { nested: { mode: "native" }, extra: [1, true, null] },
		},
	];
	await f.call("call", { sessionId: "A", calls });
	assert.deepEqual(seen[0]?.[2], calls);
	assert.notEqual(seen[0]?.[5], true);
	await f.call("transfer", {
		operationId: "host-transfer",
		paths: ["result.txt"],
	});
	assert.deepEqual(seen[1]?.[2], [
		{
			name: "transfer",
			arguments: { operationId: "host-transfer", paths: ["result.txt"] },
		},
	]);
	assert.equal(seen[1]?.[5], true);
});

test("removed wrapper names fail instead of being silently redirected", async (t) => {
	const f = await mcpFixture(t);
	for (const name of ["read", "bash", "edit", "write"]) {
		await assert.rejects(f.call(name, {}), /not found|unknown tool/i);
	}
});

test("sync and detached MCP batches reject malformed envelopes before broker execution", async (t) => {
	let executions = 0;
	const f = await mcpFixture(t, {
		call: async () => {
			executions++;
			return { sessionId: "A", cwd: "/fixture", toolResults: [], inputs: [] };
		},
		startCall: async () => {
			executions++;
			throw new Error("Malformed batch reached execution");
		},
	});
	for (const name of ["call", "start_call"]) {
		for (const calls of [
			[],
			[{ name: "", arguments: {} }],
			[{ name: "read", arguments: {}, hidden: true }],
		]) {
			const result = await f.call(name, {
				calls,
				...(name === "start_call" ? { operationId: "invalid-envelope" } : {}),
			});
			assert.equal(result.isError, true, `${name}: ${JSON.stringify(calls)}`);
		}
	}
	assert.equal(executions, 0);
});

test("discovery follows active OMP definitions without a hardcoded tool list or stale cache", async (t) => {
	const f = await sessionFixture(t);
	const native = {
		name: "project_lookup",
		description: "Find project symbols.\nUse the repository's index.",
		parameters: {
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
		},
	};
	t.mock.method(f.api, "getActiveTools", () => ["project_lookup"]);
	t.mock.method(f.api, "getAllTools", () => [
		native,
		{ ...native, name: "inactive" },
	]);
	const initialized = await f.broker.initialize(
		"test-chat",
		"A",
		"discover",
		f.controller.signal,
	);
	assert.deepEqual(initialized.tools, [
		{ name: "project_lookup", description: "Find project symbols." },
	]);
	const full = await f.broker.tools(
		"test-chat",
		"A",
		["project_lookup"],
		"describe",
		f.controller.signal,
	);
	assert.deepEqual(full.tools[0]?.parameters, native.parameters);
	assert.equal(full.tools.length, 1);
	await assert.rejects(
		f.broker.tools(
			"test-chat",
			"A",
			["inactive"],
			"inactive",
			f.controller.signal,
		),
		/not active|unknown/i,
	);
	native.description = "Updated native definition";
	const refreshed = await f.broker.tools(
		"test-chat",
		"A",
		["project_lookup"],
		"refresh",
		f.controller.signal,
	);
	assert.equal(refreshed.tools[0]?.description, native.description);
});

test("Chat init exposes compact OMP skill discovery without filesystem metadata", async (t) => {
	const f = await sessionFixture(t);
	t.mock.method(f.api, "getCommands", () => [
		{
			name: "skill:codebase-memory",
			description: "Use the codebase graph.\nLong internal guidance.",
			source: "skill",
			path: "/private/cache/codebase-memory/SKILL.md",
		},
		{
			name: "skill:superpowers/brainstorming",
			description: "Design before implementation.",
			source: "skill",
			path: "/private/cache/brainstorming/SKILL.md",
		},
	]);
	const initialized = await f.broker.initialize(
		"test-chat",
		"A",
		"skills-shortlist",
		f.controller.signal,
	);
	assert.deepEqual(initialized.skills, [
		{
			name: "codebase-memory",
			description: "Use the codebase graph.",
			uri: "skill://codebase-memory",
		},
		{
			name: "superpowers/brainstorming",
			description: "Design before implementation.",
			uri: "skill://superpowers/brainstorming",
		},
	]);
	assert.doesNotMatch(
		JSON.stringify(initialized),
		/\/private\/cache|SKILL\.md/,
	);
});

test("Chat init bounds pathological single-line tool and Skill summaries", async (t) => {
	const f = await sessionFixture(t);
	const huge = "x".repeat(1024 * 1024);
	t.mock.method(f.api, "getActiveTools", () => ["huge"]);
	t.mock.method(f.api, "getAllTools", () => [
		{
			name: "huge",
			description: huge,
			parameters: { type: "object", properties: {} },
		},
	]);
	t.mock.method(f.api, "getCommands", () => [
		{ name: "skill:huge", description: huge, source: "skill" },
	]);
	const initialized = await f.broker.initialize(
		"test-chat",
		"A",
		"bounded-shortlist",
		f.controller.signal,
	);
	assert.ok((initialized.tools[0]?.description.length ?? Infinity) <= 512);
	assert.ok((initialized.skills[0]?.description?.length ?? Infinity) <= 512);
	assert.ok(JSON.stringify(initialized).length < 16 * 1024);
});

test("Chat init preserves the complete compact catalog for final response pagination", async (t) => {
	const f = await sessionFixture(t);
	const count = 4096;
	t.mock.method(f.api, "getActiveTools", () =>
		Array.from({ length: count }, (_, index) => `tool-${index}`),
	);
	t.mock.method(f.api, "getAllTools", () =>
		Array.from({ length: count }, (_, index) => ({
			name: `tool-${index}`,
			description: "x".repeat(512),
			parameters: { type: "object", properties: {} },
		})),
	);
	t.mock.method(f.api, "getCommands", () =>
		Array.from({ length: count }, (_, index) => ({
			name: `skill:skill-${index}`,
			description: "y".repeat(512),
			source: "skill",
		})),
	);
	const initialized = await f.broker.initialize(
		"test-chat",
		"A",
		"bounded-catalog",
		f.controller.signal,
	);
	assert.equal(initialized.tools.length, count);
	assert.equal(initialized.skills.length, count);
	assert.equal(initialized.skills.at(-1)?.name, `skill-${count - 1}`);
});

test("selected MCP discovery preserves live schema, origin and routing guidance", async (t) => {
	const f = await sessionFixture(t);
	const native = {
		name: "mcp__project_lookup",
		description: "Search project symbols.\nRead its index before searching.",
		parameters: {
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
		},
		promptGuidelines: ["Read the project index before searching."],
		sourceInfo: { source: "mcp", path: "<mcp:project_lookup>" },
	};
	t.mock.method(f.api, "getActiveTools", () => [native.name]);
	t.mock.method(f.api, "getAllTools", () => [native]);
	const result = await f.broker.tools(
		"test-chat",
		"A",
		[native.name],
		"mcp-guidance",
		f.controller.signal,
	);
	assert.equal(result.tools.length, 1);
	assert.deepEqual(result.tools[0], {
		name: "mcp__project_lookup",
		description: "Search project symbols.\nRead its index before searching.",
		parameters: {
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
		},
		promptGuidelines: ["Read the project index before searching."],
		sourceInfo: { source: "mcp", path: "<mcp:project_lookup>" },
	});
});

test("Skill discovery refreshes registration changes without mutating previous snapshots", async (t) => {
	const f = await sessionFixture(t);
	let name = "skill:review/first";
	t.mock.method(f.api, "getCommands", () => [{ name, source: "skill" }]);
	const first = await f.broker.initialize(
		"test-chat",
		"A",
		"skills-before",
		f.controller.signal,
	);
	name = "skill:review/second";
	const second = await f.broker.initialize(
		"test-chat",
		"A",
		"skills-after",
		f.controller.signal,
	);
	assert.deepEqual(first.skills, [
		{ name: "review/first", uri: "skill://review/first" },
	]);
	assert.deepEqual(second.skills, [
		{ name: "review/second", uri: "skill://review/second" },
	]);
});

test("MCP call and chat expose a model-input wait as unexecuted, not successful completion", async (t) => {
	const wait: Awaited<ReturnType<Broker["call"]>> = {
		sessionId: "A",
		cwd: "/fixture",
		toolResults: [],
		execution: {
			status: "needs_input",
			executed: false,
			reason: "model_request_pending",
		},
		inputs: [
			{
				id: "model-obligation",
				sessionId: "A",
				request: { kind: "compaction", input: { messages: [] } },
			},
		],
	};
	const f = await mcpFixture(t, {
		call: async () => wait,
		chat: async () => wait,
	});
	for (const [name, args] of [
		["call", { calls: [{ name: "read", arguments: { path: "x" } }] }],
		["chat", { text: "assistant message", mode: "message" }],
	] as const) {
		const result = await f.call(name, args);
		assert.equal(result.isError, false, name);
		const text = (result.structuredContent as { text: string }).text;
		assert.match(text, /"executed":false/);
		assert.match(text, /"nextAction":"answer_model_request"/);
		assert.match(text, /model-obligation/);
	}
});

test("get_operation includes the durable model input required to resume a detached batch", async (t) => {
	const f = await mcpFixture(t, {
		operation: () => ({
			operation: {
				operationId: "waiting",
				status: "waiting_input",
				sessionId: "A",
				cwd: "/fixture",
				updatedAt: 1,
			},
			deliveries: [],
			inputs: [
				{
					id: "saved-obligation",
					sessionId: "A",
					request: { kind: "compaction", input: {} },
				},
			],
		}),
	});
	const result = await f.call("get_operation", { operationId: "waiting" });
	assert.match(
		(result.structuredContent as { text: string }).text,
		/saved-obligation/,
	);
});
