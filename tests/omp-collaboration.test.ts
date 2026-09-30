import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	ExtensionAPI as OmpExtensionAPI,
	ExtensionContext as OmpExtensionContext,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	createOmpCollaborationTools,
	installOmpCollaborationTools,
	type OmpCollaborationSession,
} from "../src/local.omp.ts";
import { ProviderOutput } from "../src/provider-core.ts";
import { multiSessionFixture, until } from "./helpers/session-fixture.ts";

function fixtureSession() {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const session: OmpCollaborationSession = {
		async sessions(sessionId, signal) {
			calls.push({ method: "sessions", args: [sessionId, signal] });
			return {
				self: "LOCAL",
				sessions: [
					{
						id: "REMOTE",
						cwd: "/remote",
						device: "fixture",
						status: "idle",
						bindingCount: 0,
					},
				],
			};
		},
		async tools(sessionId, names, signal) {
			calls.push({ method: "tools", args: [sessionId, names, signal] });
			return {
				session: {
					id: sessionId,
					cwd: "/remote",
					device: "fixture",
					status: "idle",
				},
				tools: [
					{ name: "read", description: "read", parameters: { type: "object" } },
				],
				skills: [],
				inputs: [],
			};
		},
		async remoteCall(sessionId, remoteCalls, signal) {
			calls.push({
				method: "remoteCall",
				args: [sessionId, remoteCalls, signal],
			});
			return {
				sessionId,
				cwd: "/remote",
				inputs: [],
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "one",
						toolName: "transfer",
						isError: false,
						timestamp: 1,
						content: [{ type: "text", text: "done" }],
						details: {
							resources: [
								{
									uri: "chappie://session/REMOTE/file/id/result.txt",
									name: "result.txt",
									mimeType: "text/plain",
									size: 4,
								},
							],
						},
					},
				],
			};
		},
		async remoteChat(sessionId, text, replyTo, signal) {
			calls.push({
				method: "remoteChat",
				args: [sessionId, text, replyTo, signal],
			});
			return {
				sessionId,
				cwd: "/remote",
				inputs: [],
				message: {
					role: "assistant",
					content: [{ type: "text", text: "reply accepted" }],
					api: "chappie",
					provider: "chappie",
					model: "chatgpt",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					stopReason: "stop",
					timestamp: 1,
				},
			};
		},
		async remoteHistory(range, sessionId, signal) {
			calls.push({ method: "remoteHistory", args: [range, sessionId, signal] });
			return {
				count: 1,
				hasMore: false,
				content: [{ type: "text", text: "history" }],
			};
		},
	};
	return { session, calls };
}

test("collaboration tools delegate explicit sessions and preserve resource ownership", async () => {
	const f = fixtureSession();
	const tools = createOmpCollaborationTools(f.session);
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["sessions", "remote_tools", "remote_call", "remote_chat", "history"],
	);
	const byName = new Map(tools.map((tool) => [tool.name, tool] as const));
	const signal = new AbortController().signal;
	const call = byName.get("remote_call");
	assert.ok(call);
	const result = await call.execute(
		"remote-call",
		{
			sessionId: "REMOTE",
			calls: [
				{ name: "transfer", arguments: { operationId: "x", paths: ["a"] } },
			],
		},
		signal,
		undefined,
		{} as OmpExtensionContext,
	);
	assert.match(JSON.stringify(result.content), /done/);
	assert.deepEqual(result.details, {
		resources: [
			{
				uri: "chappie://session/REMOTE/file/id/result.txt",
				name: "result.txt",
				mimeType: "text/plain",
				size: 4,
			},
		],
	});
	const chat = byName.get("remote_chat");
	assert.ok(chat);
	await chat.execute(
		"remote-chat",
		{ sessionId: "REMOTE", text: "summary", replyTo: "generation-1" },
		signal,
		undefined,
		{} as OmpExtensionContext,
	);
	assert.ok(
		f.calls.some(
			(entry) =>
				entry.method === "remoteChat" &&
				entry.args[0] === "REMOTE" &&
				entry.args[2] === "generation-1",
		),
	);
});

test("local collaboration tools are opt-in and only active for non-Chappie models", async () => {
	const f = fixtureSession();
	const registered: ToolDefinition[] = [];
	const handlers = new Map<
		string,
		(event: unknown, context: OmpExtensionContext) => unknown
	>();
	let active = ["read", "transfer"];
	const pi = {
		registerTool(tool: ToolDefinition) {
			registered.push(tool);
		},
		getActiveTools() {
			return active;
		},
		async setActiveTools(names: string[]) {
			active = names;
		},
		on(
			name: string,
			handler: (event: unknown, context: OmpExtensionContext) => unknown,
		) {
			handlers.set(name, handler);
		},
	} as unknown as OmpExtensionAPI;

	installOmpCollaborationTools(pi, f.session, false);
	assert.equal(registered.length, 0);

	installOmpCollaborationTools(pi, f.session, true);
	assert.equal(registered.length, 5);
	assert.ok(registered.every((tool) => tool.defaultInactive === true));

	const normal = {
		model: { provider: "anthropic" },
		sessionManager: {},
	} as unknown as OmpExtensionContext;
	await handlers.get("session_start")?.({}, normal);
	for (const name of [
		"sessions",
		"remote_tools",
		"remote_call",
		"remote_chat",
		"history",
	])
		assert.ok(active.includes(name), name);

	const chappie = {
		model: { provider: "chappie" },
		sessionManager: {},
	} as unknown as OmpExtensionContext;
	await handlers.get("before_agent_start")?.({}, chappie);
	for (const name of [
		"sessions",
		"remote_tools",
		"remote_call",
		"remote_chat",
		"history",
	])
		assert.equal(active.includes(name), false, name);
	assert.ok(active.includes("read"));
	assert.ok(active.includes("transfer"));
});

test("collaboration methods route through real broker IPC with explicit session identity", async (t) => {
	const f = await multiSessionFixture(t);
	const a = f.session("A");
	const b = f.session("B");
	const listed = await a.local.sessions("B", f.controller.signal);
	assert.equal(listed.self, "A");
	assert.deepEqual(
		listed.sessions.map((session) => session.id),
		["B"],
	);

	const tools = await a.local.tools("B", ["read"], f.controller.signal);
	assert.equal(tools.session.id, "B");
	assert.deepEqual(
		tools.tools.map((tool) => tool.name),
		["read"],
	);

	b.branch.push({
		type: "custom",
		id: "history-one",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		customType: "chappie.notice",
		data: { message: "remote history", type: "info" },
	});
	const history = await a.local.remoteHistory(
		{ limit: 20 },
		"B",
		f.controller.signal,
	);
	assert.equal(history.count, 1);
	assert.match(JSON.stringify(history.content), /remote history/);

	const output = new ProviderOutput(
		{ api: "chappie", provider: "chappie", id: "chatgpt" },
		f.controller.signal,
	);
	const provider = b.local.start(output, "B");
	const pending = a.local.remoteCall(
		"B",
		[{ name: "read", arguments: { path: "sample.txt" } }],
		f.controller.signal,
	);
	await until(() =>
		output.message.content.some((block) => block.type === "toolCall"),
	);
	const call = output.message.content.find(
		(block) => block.type === "toolCall",
	);
	assert.ok(call && call.type === "toolCall");
	await b.emit("turn_end", {
		message: structuredClone(output.message),
		toolResults: [
			{
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: "REMOTE_RESULT" }],
				isError: false,
				timestamp: Date.now(),
			},
		],
	});
	await b.emit("agent_end", { willContinue: false });
	const result = await pending;
	assert.equal(result.sessionId, "B");
	assert.match(JSON.stringify(result.toolResults), /REMOTE_RESULT/);
	await provider;
});
