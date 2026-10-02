import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
	type EventSubscription,
	OPERATION_FINISHED_EVENT,
} from "../src/event-types.ts";
import { State } from "../src/state.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "chappie-events-recovery-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = new State(root);
	const now = Date.now();
	await state.reserveOperation({
		key: "op-key",
		operationId: "op",
		signature: "sig",
		chatId: "owner",
		sessionId: "A",
		cwd: root,
		status: "running",
		createdAt: now,
		updatedAt: now,
	});
	const subscription: EventSubscription = {
		id: "sub_test",
		chatId: "owner",
		name: OPERATION_FINISHED_EVENT,
		operationId: "op",
		url: "https://callback.example.test/events",
		secret: `whsec_${Buffer.alloc(32, 1).toString("base64")}`,
		expiresAt: now + 60000,
		updatedAt: now,
	};
	return { root, state, subscription };
}

test("terminal operation and event outbox are persisted in the same state commit", async (t) => {
	const { root, state, subscription } = await fixture(t);
	await state.upsertEventSubscription(subscription);
	await state.finishOperation("op-key", "completed");
	const restored = new State(root);
	await restored.load();
	assert.equal(restored.operation("owner", "op").status, "completed");
	assert.equal(restored.nextEvent(Date.now())?.data.operation_id, "op");
});

test("subscribing after completion queues the retained terminal snapshot", async (t) => {
	const { state, subscription } = await fixture(t);
	await state.finishOperation("op-key", "completed");
	await state.upsertEventSubscription(subscription);
	assert.equal(state.nextEvent(Date.now())?.data.status, "completed");
});

test("refresh and repeated completion do not enqueue a delivered event again", async (t) => {
	const { root, state, subscription } = await fixture(t);
	await state.upsertEventSubscription(subscription);
	await state.finishOperation("op-key", "completed");
	const event = state.nextEvent(Date.now());
	assert.ok(event, "completion must queue an event");
	await state.removeEvent(event.eventId);
	const finishedAt = state.operation("owner", "op").updatedAt;
	await state.finishOperation("op-key", "completed");
	await state.upsertEventSubscription(subscription);
	assert.equal(state.operation("owner", "op").updatedAt, finishedAt);
	assert.equal(state.nextEvent(Date.now()), undefined);
	const restored = new State(root);
	await restored.load();
	await restored.upsertEventSubscription(subscription);
	assert.equal(restored.nextEvent(Date.now()), undefined);
});

test("failed subscription persistence never leaves an active in-memory subscription", async (t) => {
	const { root, state, subscription } = await fixture(t);
	await mkdir(join(root, "chappie.state.json.tmp"));
	await assert.rejects(state.upsertEventSubscription(subscription));
	assert.equal(state.eventSubscription(subscription.id), undefined);
});

test("state retains a running operation older than one day", async (t) => {
	const { state, root } = await fixture(t);
	const old = Date.now() - 25 * 60 * 60 * 1000;
	await state.reserveOperation({
		key: "old-key",
		operationId: "old-op",
		signature: "sig",
		chatId: "owner",
		sessionId: "A",
		cwd: root,
		status: "running",
		createdAt: old,
		updatedAt: old,
	});
	assert.equal(state.operation("owner", "old-op").status, "running");
});

test("rejected foreign operation output never enters pending deliveries", async (t) => {
	const { state, root } = await fixture(t);
	await assert.rejects(
		state.addDelivery({
			id: "foreign",
			operationKey: "op-key",
			chatId: "other",
			sessionId: "A",
			cwd: root,
			toolResults: [],
			complete: true,
		}),
		/another conversation/,
	);
	assert.deepEqual(state.deliveries("other"), []);
	assert.equal(state.resultForOperation("owner", "op"), undefined);
});

test("an older successful write cannot mask a newer snapshot failure", async (t) => {
	const { state, root } = await fixture(t);
	const valid = state.reserveOperation({
		key: "valid",
		signature: "sig",
		chatId: "owner",
		sessionId: "A",
		cwd: root,
		status: "running",
		updatedAt: Date.now(),
	});
	await assert.rejects(
		state.reserveOperation({
			key: "oversized",
			signature: "sig",
			chatId: "owner",
			sessionId: "A",
			cwd: "x".repeat(33 * 1024 * 1024),
			status: "running",
			updatedAt: Date.now(),
		}),
		/32 MiB/,
	);
	await valid;
	await assert.rejects(state.flush(), /32 MiB/);
});

test("input waits survive persistence without a terminal event and cancellation clears the wait", async (t) => {
	const { state, root, subscription } = await fixture(t);
	await state.upsertEventSubscription(subscription);
	await assert.rejects(
		state.waitForInput("op-key", [
			{
				id: "other",
				sessionId: "B",
				request: { kind: "compaction", input: {} },
			},
		]),
		/another operation session/,
	);
	await state.waitForInput("op-key", [
		{ id: "model", sessionId: "A", request: { kind: "compaction", input: {} } },
	]);
	assert.equal(state.nextEvent(Date.now()), undefined);
	const restored = new State(root);
	await restored.load();
	assert.equal(restored.operation("owner", "op").status, "waiting_input");
	assert.equal(
		restored.operation("owner", "op").waitingInputs?.[0]?.id,
		"model",
	);
	await restored.finishOperation(
		"op-key",
		"cancelled",
		[],
		"Explicitly cancelled",
	);
	assert.equal(restored.operation("owner", "op").waitingInputs, undefined);
	assert.equal(restored.nextEvent(Date.now())?.data.status, "cancelled");
});
