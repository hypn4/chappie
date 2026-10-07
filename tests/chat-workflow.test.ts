import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { ProviderOutput } from "../src/provider-core.ts";
import { toolResult } from "../src/tools.ts";
import { until } from "./helpers/async.ts";
import { assertRpcError, mcpClient, resultOf } from "./helpers/mcp-client.ts";
import { mcpFixture } from "./helpers/mcp-fixture.ts";
import { sessionFixture } from "./helpers/session-fixture.ts";

function deadline(t: TestContext) {
	const controller = new AbortController();
	const timer = setTimeout(
		() =>
			controller.abort(
				new Error("Progress incorrectly waited for a provider turn"),
			),
		1500,
	);
	t.after(() => clearTimeout(timer));
	return controller.signal;
}

function todoEntry(
	statuses: Array<
		"pending" | "in_progress" | "completed" | "blocked" | "abandoned"
	>,
): SessionEntry {
	return {
		type: "custom",
		id: "native-todo",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		customType: "user_todo_edit",
		data: {
			phases: [
				{
					name: "Requested work",
					tasks: statuses.map((status, index) => ({
						content: `Step ${index + 1}`,
						status,
					})),
				},
			],
		},
	};
}

test("Chat progress is the default; model replies and explicit messages retain their route", async (t) => {
	const modes: unknown[] = [];
	const f = await mcpFixture(t, {
		chat: async (...args) => {
			modes.push(args[6]);
			return { sessionId: "A", cwd: "/fixture", inputs: [] };
		},
	});
	await f.call("chat", { text: "Step 1 finished; continuing Step 2." });
	await f.call("chat", {
		text: "Verified the requested scope.",
		mode: "message",
	});
	await f.call("chat", { text: "Compacted context", replyTo: "model-1" });
	assert.deepEqual(modes, ["progress", "message", "message"]);
});

test("progress returns through IPC without waking or completing an OMP provider turn", async (t) => {
	const f = await sessionFixture(t);
	const wakes = t.mock.method(f.api, "sendMessage");
	const notes = t.mock.method(f.api, "appendEntry");
	const result = await f.broker.chat(
		"test-chat",
		"A",
		"Continuing the remaining scope.",
		"progress-only",
		deadline(t),
		undefined,
		"progress",
	);
	assert.equal(result.progress, true);
	assert.equal(wakes.mock.callCount(), 0);
	assert.equal(f.aborts, 0);
	assert.ok(
		notes.mock.calls.some(
			({ arguments: args }) =>
				args[0] === "chappie.notice" &&
				(args[1] as { event?: string }).event === "progress",
		),
	);
});

test("progress cannot end or cancel a running native batch", async (t) => {
	const f = await sessionFixture(t);
	const queued = await f.queue("working-batch");
	const output = await f.dispatch();
	let finished = false;
	void queued.pending.then(() => {
		finished = true;
	});
	const result = await f.broker.chat(
		"test-chat",
		"A",
		"Native work is still running.",
		"running-progress",
		deadline(t),
		undefined,
		"progress",
	);
	assert.equal(result.progress, true);
	assert.equal(finished, false);
	assert.equal(f.aborts, 0);
	await f.complete(output);
	const outcome = await queued.pending;
	assert.ok("result" in outcome);
});

test("native TODO observations survive a batch return without claiming the user's goal is complete", async (t) => {
	const f = await sessionFixture(t);
	let branch = [todoEntry(["completed", "in_progress", "pending", "blocked"])];
	t.mock.method(f.current.sessionManager, "getBranch", () => branch);
	const initial = await f.broker.initialize(
		"test-chat",
		"A",
		"work-observation",
		f.controller.signal,
	);
	assert.equal(initial.work?.state, "actionable");
	assert.deepEqual(initial.work?.counts, {
		pending: 1,
		inProgress: 1,
		blocked: 1,
		completed: 1,
		abandoned: 0,
	});
	const queued = await f.queue("first-step");
	const first = await f.dispatch();
	await f.complete(first);
	const firstResult = await queued.pending;
	assert.ok("result" in firstResult);
	assert.equal(firstResult.result.work?.state, "actionable");
	branch = [todoEntry(["completed", "completed", "completed", "completed"])];
	const next = await f.queue("second-step");
	await f.complete(await f.dispatch());
	const secondResult = await next.pending;
	assert.ok("result" in secondResult);
	assert.equal(secondResult.result.work?.state, "settled");
	assert.equal(
		initial.work?.counts.pending,
		1,
		"prior snapshots must remain immutable",
	);
});

test("progress with replyTo is rejected before broker execution", async (t) => {
	let called = false;
	const f = await mcpFixture(t, {
		chat: async () => {
			called = true;
			return { sessionId: "A", cwd: "/fixture", inputs: [] };
		},
	});
	const r = await f.call("chat", {
		text: "not a reply",
		mode: "progress",
		replyTo: "pending",
	});
	assert.equal(r.isError, true);
	assert.equal(called, false);
});

test("progress preserves a pending model reply obligation and its provider output", async (t) => {
	const f = await sessionFixture(t);
	const output = new ProviderOutput(
		{ api: "chappie", provider: "chappie", id: "chatgpt" },
		f.controller.signal,
	);
	const finished = f.local.generate(
		output,
		{ kind: "compaction", input: { messages: ["context"] } },
		"A",
	);
	let requestId: string | undefined;
	await until(async () => {
		requestId = (
			await f.broker.inputs("test-chat", "A", f.controller.signal)
		).find((i) => "request" in i)?.id;
		return requestId !== undefined;
	});
	assert.ok(requestId);
	const r = await f.broker.chat(
		"test-chat",
		"A",
		"Still working.",
		"report-wait",
		deadline(t),
		undefined,
		"progress",
	);
	assert.equal(r.progress, true);
	assert.ok(r.inputs.some((i) => i.id === requestId));
	assert.equal(output.closed, false);
	assert.equal(f.aborts, 0);
	await f.broker.chat(
		"test-chat",
		"A",
		"summary",
		"reply-wait",
		f.controller.signal,
		requestId,
	);
	await finished;
	assert.equal(output.closed, true);
});

test("retrying a progress request does not duplicate the notice or reuse it as a message", async (t) => {
	const f = await sessionFixture(t);
	const notes = t.mock.method(f.api, "appendEntry");
	await f.broker.chat(
		"test-chat",
		"A",
		"Update",
		"same-progress",
		deadline(t),
		undefined,
		"progress",
	);
	const replay = await f.broker.chat(
		"test-chat",
		"A",
		"Update",
		"same-progress",
		deadline(t),
		undefined,
		"progress",
	);
	assert.equal(replay.replay?.status, "completed");
	const reports = notes.mock.calls.filter(
		({ arguments: args }) =>
			args[0] === "chappie.notice" &&
			(args[1] as { event?: string }).event === "progress",
	);
	assert.equal(reports.length, 1);
	await assert.rejects(
		f.broker.chat(
			"test-chat",
			"A",
			"Update",
			"same-progress",
			deadline(t),
			undefined,
			"message",
		),
		/different|conflict|signature|identifier/i,
	);
});

test("detached work observation survives acknowledgement and broker restart", async (t) => {
	const f = await sessionFixture(t);
	t.mock.method(f.current.sessionManager, "getBranch", () => [
		todoEntry(["completed", "pending"]),
	]);
	await f.broker.startCall(
		"test-chat",
		"A",
		[{ name: "read", arguments: { path: "x" } }],
		"work-detached",
		"start-work",
		f.controller.signal,
	);
	await f.complete(await f.dispatch());
	await until(
		() =>
			f.broker.operation("test-chat", "work-detached").operation.status ===
			"completed",
	);
	const completed = f.broker.operation("test-chat", "work-detached");
	assert.equal(completed.result?.work?.state, "actionable");
	await f.broker.acknowledge(completed.deliveries, [], f.controller.signal);
	await f.reconnect();
	const client = mcpClient(t, f.broker);
	await client.request("server/discover");
	const r = resultOf(
		await client.call(
			"get_operation",
			{ operationId: "work-detached" },
			{ chatId: "test-chat" },
		),
	);
	const text = (r.structuredContent as { text: string }).text;
	assert.match(text, /"userGoal":"not_evaluated"/);
	assert.match(text, /"nextAction":"continue_requested_work"/);
	assert.match(text, /"state":"actionable"/);
	const wrongOwner = await client.call(
		"get_operation",
		{ operationId: "work-detached" },
		{ chatId: "other-chat" },
	);
	assertRpcError(wrongOwner, /not found|belong|unknown/i);
});

for (const dispatched of [false, true]) {
	test(`request cancellation distinguishes queued from dispatched native work (${dispatched})`, async (t) => {
		const f = await sessionFixture(t);
		const notes = t.mock.method(f.api, "appendEntry");
		const queued = await f.queue("cancel-phase");
		if (dispatched) await f.dispatch();
		f.controller.abort(new Error("Request ended"));
		await queued.pending;
		await until(() =>
			notes.mock.calls.some(
				({ arguments: args }) =>
					args[0] === "chappie.notice" &&
					(args[1] as { event?: string }).event === "cancelled",
			),
		);
		const note = notes.mock.calls.find(
			({ arguments: args }) =>
				args[0] === "chappie.notice" &&
				(args[1] as { event?: string }).event === "cancelled",
		)?.arguments[1] as { message: string; executionPhase: string };
		assert.match(note.message, /Request ended/);
		assert.equal(note.executionPhase, dispatched ? "in_flight" : "queued");
		assert.equal(f.aborts, dispatched ? 1 : 0);
	});
}

test("a literal JSON message cannot impersonate a previous progress request", async (t) => {
	const f = await sessionFixture(t);
	await f.broker.chat(
		"test-chat",
		"A",
		"Update",
		"mode-identity",
		deadline(t),
		undefined,
		"progress",
	);
	await assert.rejects(
		f.broker.chat(
			"test-chat",
			"A",
			JSON.stringify({ text: "Update", mode: "progress" }),
			"mode-identity",
			deadline(t),
			undefined,
			"message",
		),
		/different|conflict|signature|identifier/i,
	);
});

test("public MCP can continue two scoped batches around a default progress report", async (t) => {
	const f = await sessionFixture(t);
	let branch = [todoEntry(["in_progress", "pending"])];
	t.mock.method(f.current.sessionManager, "getBranch", () => branch);
	const client = mcpClient(t, f.broker);
	await client.request("server/discover", {}, { chatId: "test-chat" });
	const firstCall = client.call(
		"call",
		{ sessionId: "A", calls: [{ name: "read", arguments: { path: "one" } }] },
		{ chatId: "test-chat" },
	);
	const first = await f.dispatch();
	await until(() => first.closed);
	branch = [todoEntry(["completed", "in_progress"])];
	await f.complete(first);
	const firstResult = resultOf(await firstCall);
	const firstHeader = JSON.parse(
		(firstResult.structuredContent as { text: string }).text.split("\n")[0] ??
			"",
	);
	assert.equal(firstHeader.continuation.nextAction, "continue_requested_work");
	const progress = resultOf(
		await client.call(
			"chat",
			{ sessionId: "A", text: "Step one done, proceeding to step two." },
			{ chatId: "test-chat" },
		),
	);
	const progressHeader = JSON.parse(
		(progress.structuredContent as { text: string }).text.split("\n")[0] ?? "",
	);
	assert.equal(progressHeader.continuation.scope, "progress");
	assert.equal(progressHeader.work.state, "actionable");
	const secondCall = client.call(
		"call",
		{ sessionId: "A", calls: [{ name: "read", arguments: { path: "two" } }] },
		{ chatId: "test-chat" },
	);
	const second = await f.dispatch();
	await until(() => second.closed);
	branch = [todoEntry(["completed", "completed"])];
	await f.complete(second);
	const secondResult = resultOf(await secondCall);
	const secondHeader = JSON.parse(
		(secondResult.structuredContent as { text: string }).text.split("\n")[0] ??
			"",
	);
	assert.equal(secondHeader.work.state, "settled");
	assert.deepEqual(secondHeader.continuation, {
		scope: "native_batch",
		userGoal: "not_evaluated",
		nextAction: "verify_requested_scope",
	});
	assert.equal(f.aborts, 0);
});

test("recovered cancelled work cannot emit a contradictory continue cue from retained content", async (t) => {
	const resultId = "c".repeat(64);
	const work = {
		source: "omp_todo" as const,
		scope: "session" as const,
		observedAt: 1,
		state: "actionable" as const,
	};
	const output = JSON.stringify(
		toolResult([], "A", "/fixture", [], undefined, undefined, undefined, {
			work,
		}),
	);
	const f = await mcpFixture(t, {
		readResponse: async (chatId, requestedId) => {
			assert.equal(chatId, "server-test");
			assert.equal(requestedId, resultId);
			return output;
		},
		markResponseRead: async () => {},
		operation: () => ({
			operation: {
				operationId: "cancelled-work",
				status: "cancelled",
				sessionId: "A",
				cwd: "/fixture",
				updatedAt: 1,
			},
			inputs: [],
			deliveries: [],
			result: {
				id: "retained",
				chatId: "server-test",
				sessionId: "A",
				cwd: "/fixture",
				resultId,
				bytes: Buffer.byteLength(output),
				failed: false,
				work,
			},
		}),
	});
	const r = await f.call("get_operation", { operationId: "cancelled-work" });
	const blocks = r.content as Array<{ type: string; text?: string }>;
	const actions = blocks
		.filter((b) => b.type === "text")
		.map((b) => JSON.parse(b.text ?? "{}"))
		.filter((b) => b.continuation)
		.map((b) => b.continuation.nextAction);
	assert.deepEqual(actions, ["reconcile_operation"]);
});
