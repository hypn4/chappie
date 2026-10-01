import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { sessionFixture, until } from "./helpers/session-fixture.ts";

const calls = [{ name: "read", arguments: { path: "test.txt" } }];

test("detached calls outlive the originating MCP request and deliver completion", async (t) => {
	const f = await sessionFixture(t);
	const caller = new AbortController();
	const started = await f.broker.startCall(
		"test-chat",
		"A",
		calls,
		"long-read",
		"transport-request",
		caller.signal,
	);
	assert.equal(started.operation.operationId, "long-read");
	assert.equal(started.operation.status, "running");

	caller.abort(new Error("ChatGPT request ended"));
	await delay(10);
	const output = await f.dispatch();
	await f.complete(output);

	await until(
		() =>
			f.broker.operation("test-chat", "long-read").operation.status ===
			"completed",
	);
	const completed = f.broker.operation("test-chat", "long-read");
	assert.equal(completed.operation.status, "completed");
	assert.equal(completed.deliveries.length, 1);
	assert.equal(completed.deliveries[0]?.toolResults.length, 1);
});

test("detached operation IDs are idempotent and immutable", async (t) => {
	const f = await sessionFixture(t);
	const first = await f.broker.startCall(
		"test-chat",
		"A",
		calls,
		"stable-long-call",
		"request-one",
		f.controller.signal,
	);
	const replay = await f.broker.startCall(
		"test-chat",
		"A",
		calls,
		"stable-long-call",
		"request-two",
		f.controller.signal,
	);
	assert.equal(first.operation.status, "running");
	assert.equal(replay.operation.status, "running");

	await assert.rejects(
		f.broker.startCall(
			"test-chat",
			"A",
			[{ name: "read", arguments: { path: "other.txt" } }],
			"stable-long-call",
			"request-three",
			f.controller.signal,
		),
		/different|identifier|reuse/i,
	);

	const output = await f.dispatch();
	await f.complete(output);
	await until(
		() =>
			f.broker.operation("test-chat", "stable-long-call").operation.status ===
			"completed",
	);
	assert.equal(
		f.broker.operation("test-chat", "stable-long-call").deliveries.length,
		1,
	);
});

test("detached operations can be explicitly cancelled without reusing the MCP request signal", async (t) => {
	const f = await sessionFixture(t);
	await f.broker.startCall(
		"test-chat",
		"A",
		calls,
		"cancel-long-call",
		"request",
		f.controller.signal,
	);
	await f.dispatch();
	const cancelled = await f.broker.cancelOperation(
		"test-chat",
		"cancel-long-call",
	);
	assert.equal(cancelled.operation.status, "cancelled");
	assert.match(cancelled.operation.error ?? "", /cancel/i);
	assert.equal(f.aborts, 1);

	const repeated = await f.broker.cancelOperation(
		"test-chat",
		"cancel-long-call",
	);
	assert.equal(repeated.operation.status, "cancelled");
});
test("unfinished detached operations become uncertain across broker restart", async (t) => {
	const f = await sessionFixture(t);
	await f.broker.startCall(
		"test-chat",
		"A",
		calls,
		"restart-long-call",
		"request",
		f.controller.signal,
	);
	await f.reconnect();
	const resumed = f.broker.operation("test-chat", "restart-long-call");
	assert.equal(resumed.operation.status, "uncertain");
});

test("detached results remain retrievable after delivery acknowledgement and restart", async (t) => {
	const f = await sessionFixture(t);
	await f.broker.startCall(
		"test-chat",
		"A",
		calls,
		"retained-result",
		"request",
		f.controller.signal,
	);
	await f.complete(await f.dispatch());
	await until(
		() =>
			f.broker.operation("test-chat", "retained-result").operation.status ===
			"completed",
	);
	const completed = f.broker.operation("test-chat", "retained-result");
	await f.broker.acknowledge(completed.deliveries, [], f.controller.signal);
	assert.ok(
		f.broker.operation("test-chat", "retained-result").result,
		"acknowledgement must not delete the result",
	);
	await f.reconnect();
	const restored = f.broker.operation("test-chat", "retained-result");
	assert.equal(restored.result?.toolResults.length, 1);
	assert.throws(
		() => f.broker.operation("another-chat", "retained-result"),
		/not found/i,
	);
});

test("completed operation retries do not require an online native session", async (t) => {
	const f = await sessionFixture(t);
	await f.broker.startCall(
		"test-chat",
		"A",
		calls,
		"offline-replay",
		"first-request",
		f.controller.signal,
	);
	await f.complete(await f.dispatch());
	await until(
		() =>
			f.broker.operation("test-chat", "offline-replay").operation.status ===
			"completed",
	);
	f.local.close();
	await until(() => f.broker.listSessions().length === 0);
	const retried = await f.broker.startCall(
		"test-chat",
		"A",
		calls,
		"offline-replay",
		"retry-request",
		AbortSignal.timeout(200),
	);
	assert.equal(retried.operation.status, "completed");
});
