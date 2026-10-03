import assert from "node:assert/strict";
import { test } from "node:test";
import { until } from "./helpers/async.ts";
import { sessionFixture } from "./helpers/session-fixture.ts";

test("an interrupted chat message exposes the same durable acceptance for recovery", async (t) => {
	const f = await sessionFixture(t);
	const probes = t.mock.method(f.current, "isIdle", () => false);
	const controller = new AbortController();
	const pending = f.broker
		.chat(
			"test-chat",
			"A",
			"approved message",
			"interrupted-chat",
			controller.signal,
		)
		.then(
			() => undefined,
			(error: unknown) => error,
		);
	await until(() => probes.mock.callCount() > 0);
	controller.abort(new Error("caller disconnected"));
	const error = await pending;
	assert.ok(error instanceof Error);
	const match = /Recovery operation: (receipt-[a-f0-9]{64})/.exec(
		error.message,
	);
	assert.ok(
		match?.[1],
		"the caller needs an addressable receipt, not just a timeout",
	);
	const id = match[1];
	await until(
		() => f.broker.operation("test-chat", id).operation.status === "uncertain",
	);
	const before = probes.mock.callCount();
	const replay = await f.broker.chat(
		"test-chat",
		"A",
		"approved message",
		"interrupted-chat",
		f.controller.signal,
	);
	assert.equal(replay.replay?.status, "uncertain");
	assert.equal(
		probes.mock.callCount(),
		before,
		"the same accepted message must not execute again",
	);
	assert.throws(() => f.broker.operation("other", id), /not found/);
});
