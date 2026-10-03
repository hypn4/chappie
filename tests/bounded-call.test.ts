import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { ProviderOutput } from "../src/provider-core.ts";
import { State } from "../src/state.ts";
import { until } from "./helpers/async.ts";
import { mcpClient, record, resultOf } from "./helpers/mcp-client.ts";
import { sessionFixture } from "./helpers/session-fixture.ts";

const calls = [{ name: "read", arguments: { path: "test.txt" } }];

/** Advance only the call's soft budget; real filesystem/IPC scheduling is untouched. */
function callClock(t: TestContext) {
	const original = globalThis.setTimeout;
	const deadlines: Array<() => void> = [];
	t.mock.method(
		globalThis,
		"setTimeout",
		(...args: Parameters<typeof setTimeout>) => {
			const timer = original(...args);
			if (args[1] === 25000)
				deadlines.push(() => {
					clearTimeout(timer);
					args[0](...args.slice(2));
				});
			return timer;
		},
	);
	return {
		expire() {
			assert.ok(
				deadlines.length,
				"call must install a bounded response deadline",
			);
			for (const expire of deadlines.splice(0)) expire();
		},
	};
}

test("a slow call yields a recoverable operation without cancelling the native batch", async (t) => {
	const clock = callClock(t);
	const f = await sessionFixture(t);
	const caller = new AbortController();
	const pending = f.broker.call(
		"test-chat",
		"A",
		calls,
		"bounded-one",
		caller.signal,
	);
	void pending.catch(() => {});
	const output = await f.dispatch();
	clock.expire();
	const yielded = await pending;
	assert.ok(yielded.operation, "slow call must expose an operationId");
	assert.equal(yielded.operation.status, "running");
	assert.equal(yielded.toolResults.length, 0);
	assert.equal(f.aborts, 0);
	caller.abort(new Error("MCP response already returned"));
	await f.complete(output);
	const id = yielded.operation.operationId;
	await until(() => Boolean(f.broker.operation("test-chat", id).result));
	const finished = f.broker.operation("test-chat", id);
	assert.equal(finished.operation.status, "completed");
	assert.equal(finished.result?.toolResults[0]?.content[0]?.type, "text");
	assert.equal(f.aborts, 0);
	assert.throws(() => f.broker.operation("other-chat", id), /not found/i);
	await f.broker.acknowledge(finished.deliveries, [], f.controller.signal);
	await f.reconnect();
	assert.equal(
		f.broker.operation("test-chat", id).result?.toolResults.length,
		1,
	);
});

test("fast calls remain inline and do not queue a duplicate deferred delivery", async (t) => {
	const f = await sessionFixture(t);
	const queued = await f.queue("fast-inline");
	await f.complete(await f.dispatch());
	const result = await queued.pending;
	assert.ok("result" in result);
	assert.equal(result.result.toolResults.length, 1);
	assert.equal(result.result.operation?.status, "completed");
	assert.ok(result.result.operation?.resultId);
	assert.equal(f.broker.deliveries("test-chat").length, 0);
});

test("a caller abort before the soft deadline still cancels native execution", async (t) => {
	const f = await sessionFixture(t);
	const caller = new AbortController();
	const pending = f.broker.call(
		"test-chat",
		"A",
		calls,
		"early-abort",
		caller.signal,
	);
	await f.dispatch();
	const reason = new Error("user cancelled before detach");
	caller.abort(reason);
	await assert.rejects(pending, (error) => error === reason);
	await until(() => f.aborts === 1);
});

test("soft-detached work remains explicitly cancellable and never silently restarts", async (t) => {
	const clock = callClock(t);
	const f = await sessionFixture(t);
	const pending = f.broker.call(
		"test-chat",
		"A",
		calls,
		"cancel-yielded",
		f.controller.signal,
	);
	void pending.catch(() => {});
	await f.dispatch();
	clock.expire();
	const yielded = await pending;
	assert.ok(yielded.operation);
	const id = yielded.operation.operationId;
	const cancelled = await f.broker.cancelOperation("test-chat", id);
	assert.equal(cancelled.operation.status, "cancelled");
	assert.equal(f.aborts, 1);
	const again = await f.broker.startCall(
		"test-chat",
		"A",
		calls,
		id,
		"explicit-retry",
		f.controller.signal,
	);
	assert.equal(again.operation.status, "cancelled");
});

test("concurrent transport retries share a single soft-detached acceptance", async (t) => {
	const clock = callClock(t);
	const f = await sessionFixture(t);
	const first = f.broker.call(
		"test-chat",
		"A",
		calls,
		"retry-slow",
		f.controller.signal,
	);
	const second = f.broker.call(
		"test-chat",
		"A",
		calls,
		"retry-slow",
		f.controller.signal,
	);
	void first.catch(() => {});
	void second.catch(() => {});
	const output = await f.dispatch();
	clock.expire();
	const [one, two] = await Promise.all([first, second]);
	assert.ok(one.operation && two.operation);
	const id = one.operation.operationId;
	assert.equal(one.operation.operationId, two.operation.operationId);
	assert.equal(
		output.message.content.filter((item) => item.type === "toolCall").length,
		1,
	);
	await assert.rejects(
		f.broker.call(
			"test-chat",
			"A",
			[{ name: "read", arguments: { path: "different" } }],
			"retry-slow",
			f.controller.signal,
		),
		/different|reuse/i,
	);
	await f.complete(output);
	await until(() => Boolean(f.broker.operation("test-chat", id).result));
	assert.equal(f.broker.operation("test-chat", id).deliveries.length, 1);
});

test("the public MCP call returns a durable reference and continues through get_operation", async (t) => {
	const clock = callClock(t);
	const f = await sessionFixture(t);
	const client = mcpClient(t, f.broker);
	const pending = client.call(
		"call",
		{ sessionId: "A", calls },
		{ chatId: "test-chat" },
	);
	void pending.catch(() => {});
	const output = await f.dispatch();
	clock.expire();
	const response = resultOf(await pending);
	assert.notEqual(response.isError, true);
	const summaryText = String(record(response.structuredContent).text).split(
		"\n",
	)[0];
	assert.ok(summaryText);
	const summary = JSON.parse(summaryText);
	assert.equal(summary.operation.status, "running");
	assert.equal(summary.continuation.nextAction, "inspect_operation");
	assert.equal(summary.continuation.userGoal, "not_evaluated");
	await f.complete(output);
	await until(() =>
		Boolean(
			f.broker.operation("test-chat", summary.operation.operationId).result,
		),
	);
	const recovered = resultOf(
		await client.call(
			"get_operation",
			{ operationId: summary.operation.operationId },
			{ chatId: "test-chat" },
		),
	);
	assert.match(String(record(recovered.structuredContent).text), /completed/);
});

test("an auto-yielded queued call preserves model-input wait and resumes the same acceptance", async (t) => {
	const clock = callClock(t);
	const f = await sessionFixture(t);
	const queued = await f.queue("yield-before-model");
	clock.expire();
	const yielded = await queued.pending;
	assert.ok("result" in yielded && yielded.result.operation);
	const id = yielded.result.operation.operationId;
	const model = new ProviderOutput(
		{ api: "chappie", provider: "chappie", id: "chatgpt" },
		f.controller.signal,
	);
	const generation = f.local.generate(
		model,
		{ kind: "compaction", input: { messages: ["summarize"] } },
		"A",
	);
	await until(
		() =>
			f.broker.operation("test-chat", id).operation.status === "waiting_input",
	);
	const input = f.broker.operation("test-chat", id).inputs[0];
	assert.ok(input);
	assert.equal(model.closed, false);
	await f.broker.chat(
		"test-chat",
		"A",
		"summary",
		"reply-model",
		f.controller.signal,
		input.id,
	);
	await generation;
	const resumed = await f.broker.startCall(
		"test-chat",
		"A",
		calls,
		id,
		"resume-yielded",
		f.controller.signal,
	);
	assert.equal(resumed.operation.operationId, id);
	const output = await f.dispatch();
	await f.complete(output);
	await until(() => Boolean(f.broker.operation("test-chat", id).result));
	assert.equal(
		f.broker.operation("test-chat", id).operation.status,
		"completed",
	);
	assert.equal(
		f.broker.operation("test-chat", id).result?.toolResults.length,
		1,
	);
});

test("retry after yielding returns the original running operation without waiting for another budget", async (t) => {
	const clock = callClock(t);
	const f = await sessionFixture(t);
	const queued = await f.queue("already-yielded");
	const output = await f.dispatch();
	clock.expire();
	const yielded = await queued.pending;
	assert.ok("result" in yielded && yielded.result.operation);
	const id = yielded.result.operation.operationId;
	const retried = await f.broker.call(
		"test-chat",
		"A",
		calls,
		"already-yielded",
		f.controller.signal,
	);
	assert.equal(retried.operation?.operationId, id);
	assert.equal(retried.operation?.status, "running");
	await f.complete(output);
	await until(() => Boolean(f.broker.operation("test-chat", id).result));
});

test("soft detach cannot bypass caller cancellation while durable admission is paused", async (t) => {
	const clock = callClock(t);
	const f = await sessionFixture(t);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	t.after(() => release.resolve());
	const original = State.prototype.reserveOperation;
	let id = "";
	t.mock.method(
		State.prototype,
		"reserveOperation",
		async function (
			this: State,
			receipt: Parameters<State["reserveOperation"]>[0],
		) {
			const existing = await original.call(this, receipt);
			id = receipt.operationId ?? "";
			entered.resolve();
			await release.promise;
			return existing;
		},
	);
	const caller = new AbortController();
	const pending = f.broker.call(
		"test-chat",
		"A",
		calls,
		"cancel-admitting",
		caller.signal,
	);
	void pending.catch(() => {});
	await entered.promise;
	clock.expire();
	const reason = new Error("stop before durable admission returns");
	caller.abort(reason);
	await assert.rejects(pending, (error) => error === reason);
	release.resolve();
	await until(
		() => f.broker.operation("test-chat", id).operation.status === "uncertain",
	);
	assert.equal(f.aborts, 0, "no native execution was dispatched");
	assert.equal(f.broker.operation("test-chat", id).result, undefined);
});

test("a result racing the soft deadline is retained once even after delivery acknowledgement", async (t) => {
	const clock = callClock(t);
	const f = await sessionFixture(t);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const committed = Promise.withResolvers<void>();
	t.after(() => release.resolve());
	const original = State.prototype.finishOperation;
	let first = true;
	t.mock.method(
		State.prototype,
		"finishOperation",
		async function (
			this: State,
			...args: Parameters<State["finishOperation"]>
		) {
			if (args[1] === "completed" && first) {
				first = false;
				entered.resolve();
				await release.promise;
				await original.apply(this, args);
				committed.resolve();
				return;
			}
			return original.apply(this, args);
		},
	);
	const queued = await f.queue("completion-race");
	await f.complete(await f.dispatch());
	await entered.promise;
	clock.expire();
	const yielded = await queued.pending;
	assert.ok("result" in yielded && yielded.result.operation);
	const id = yielded.result.operation.operationId;
	const complete = f.broker.operation("test-chat", id);
	assert.equal(complete.result?.toolResults.length, 1);
	assert.equal(complete.deliveries.length, 1);
	await f.broker.acknowledge(complete.deliveries, [], f.controller.signal);
	release.resolve();
	await committed.promise;
	await f.broker.tools(
		"test-chat",
		"A",
		["read"],
		"completion-barrier",
		f.controller.signal,
	);
	assert.equal(f.broker.operation("test-chat", id).deliveries.length, 0);
	assert.equal(
		f.broker.operation("test-chat", id).result?.toolResults.length,
		1,
	);
});

test("lost soft-detach response can be recovered by the same request without another native execution", async (t) => {
	const clock = callClock(t);
	const f = await sessionFixture(t);
	const client = mcpClient(t, f.broker);
	const params = {
		name: "call",
		arguments: { sessionId: "A", calls },
		_meta: { "otunnel/requestId": "lost-response" },
	};
	const pending = client.request("tools/call", params, { chatId: "test-chat" });
	void pending.catch(() => {});
	const output = await f.dispatch();
	client.failNextSend();
	clock.expire();
	await assert.rejects(pending, /send failure/);
	assert.equal(f.aborts, 0);
	const retried = resultOf(
		await client.request("tools/call", params, { chatId: "test-chat" }),
	);
	const summaryText = String(record(retried.structuredContent).text).split(
		"\n",
	)[0];
	assert.ok(summaryText);
	const id: string = JSON.parse(summaryText).operation.operationId;
	assert.ok(id);
	await f.complete(output);
	await until(() => Boolean(f.broker.operation("test-chat", id).result));
	assert.equal(
		f.broker.operation("test-chat", id).result?.toolResults.length,
		1,
	);
	assert.equal(f.aborts, 0);
});

test("broker restart leaves unfinished soft-detached work uncertain without replaying it", async (t) => {
	const clock = callClock(t);
	const f = await sessionFixture(t);
	const queued = await f.queue("restart-yielded");
	await f.dispatch();
	clock.expire();
	const yielded = await queued.pending;
	assert.ok("result" in yielded && yielded.result.operation);
	const id = yielded.result.operation.operationId;
	await f.reconnect();
	assert.equal(
		f.broker.operation("test-chat", id).operation.status,
		"uncertain",
	);
	const retry = await f.broker.startCall(
		"test-chat",
		"A",
		calls,
		id,
		"retry-after-restart",
		f.controller.signal,
	);
	assert.equal(retry.operation.status, "uncertain");
});

test("native failure after soft detach remains visible instead of becoming goal completion", async (t) => {
	const clock = callClock(t);
	const f = await sessionFixture(t);
	const queued = await f.queue("yielded-tool-error");
	const output = await f.dispatch();
	clock.expire();
	const yielded = await queued.pending;
	assert.ok("result" in yielded && yielded.result.operation);
	const id = yielded.result.operation.operationId;
	const call = output.message.content.find((item) => item.type === "toolCall");
	assert.ok(call?.type === "toolCall");
	await f.emit("turn_end", {
		message: structuredClone(output.message),
		toolResults: [
			{
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: "native validation failed" }],
				isError: true,
				timestamp: Date.now(),
			},
		],
	});
	await until(() => Boolean(f.broker.operation("test-chat", id).result));
	assert.equal(
		f.broker.operation("test-chat", id).result?.toolResults[0]?.isError,
		true,
	);
	const client = mcpClient(t, f.broker);
	const recovered = resultOf(
		await client.call(
			"get_operation",
			{ operationId: id },
			{ chatId: "test-chat" },
		),
	);
	const text = String(record(recovered.structuredContent).text);
	assert.match(text, /inspect_failure/);
	assert.match(text, /native validation failed/);
});

test("the response budget can expire during fast snapshot persistence without losing either recovery path", async (t) => {
	const clock = callClock(t);
	const f = await sessionFixture(t);
	const saving = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	t.after(() => release.resolve());
	const save = f.broker.saveResponse.bind(f.broker);
	t.mock.method(
		f.broker,
		"saveResponse",
		async (chat: string, text: string) => {
			saving.resolve();
			await release.promise;
			return save(chat, text);
		},
	);
	const pending = f.broker.call(
		"test-chat",
		"A",
		calls,
		"snapshot-budget",
		f.controller.signal,
	);
	void pending.catch(() => {});
	await f.complete(await f.dispatch());
	await saving.promise;
	clock.expire();
	const yielded = await pending;
	assert.ok(yielded.operation);
	const id = yielded.operation.operationId;
	assert.equal(
		f.broker.operation("test-chat", id).result?.toolResults.length,
		1,
	);
	release.resolve();
	await until(() =>
		Boolean(f.broker.operation("test-chat", id).operation.resultId),
	);
	const completed = f.broker.operation("test-chat", id);
	assert.ok(completed.operation.resultId);
	assert.match(
		await f.broker.readResponse("test-chat", completed.operation.resultId),
		/completed/,
	);
	await f.broker.acknowledge(completed.deliveries, [], f.controller.signal);
	assert.equal(f.broker.deliveries("test-chat").length, 0);
	assert.equal(f.aborts, 0);
});
