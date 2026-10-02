import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DeliveryRecord } from "../src/delivery.ts";
import type { OperationReceipt } from "../src/operations.ts";
import { State } from "../src/state.ts";

for (const terminal of ["completed", "failed", "cancelled"] as const) {
	test(`execution isolation after expiry: ${terminal}`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "ch-inc-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		let now = 2_000_000_000_000;
		t.mock.method(Date, "now", () => now);
		const state = new State(root);
		const receipt: OperationReceipt = {
			key: "key",
			operationId: "id",
			signature: "sig",
			chatId: "chat",
			sessionId: "A",
			cwd: root,
			status: "running",
			updatedAt: now,
		};
		await state.reserveOperation(receipt);
		const old = state.operation("chat", "id");
		assert.equal(typeof old.executionId, "string");
		await state.finishOperation("key", terminal);
		const replay = await state.reserveOperation({ ...receipt });
		assert.equal(replay?.status, terminal);
		now += 25 * 60 * 60 * 1000;
		await state.reserveOperation({ ...receipt, updatedAt: now });
		const next = state.operation("chat", "id");
		assert.notEqual(next.executionId, old.executionId);
		const delivery: DeliveryRecord = {
			id: "old-result",
			operationKey: "key",
			executionId: old.executionId,
			chatId: "chat",
			sessionId: "A",
			cwd: root,
			complete: true,
			toolResults: [],
		};
		await assert.rejects(state.addDelivery(delivery), /execution|incarnation/i);
		assert.equal(state.operation("chat", "id").status, "running");
		await state.addDelivery({
			...delivery,
			id: "new-result",
			executionId: next.executionId,
		});
		assert.equal(state.operation("chat", "id").status, "completed");
		const restored = new State(root);
		await restored.load();
		assert.equal(
			restored.operation("chat", "id").executionId,
			next.executionId,
		);
	});
}
for (const status of ["running", "waiting_input", "uncertain"] as const) {
	test(`unresolved operation is never retired: ${status}`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "ch-unresolved-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		let now = 2_000_000_000_000;
		t.mock.method(Date, "now", () => now);
		const state = new State(root);
		await state.reserveOperation({
			key: "key",
			operationId: "id",
			signature: "sig",
			chatId: "chat",
			sessionId: "A",
			cwd: root,
			status,
			updatedAt: now,
		});
		const before = state.operation("chat", "id");
		now += 50 * 60 * 60 * 1000;
		assert.equal(state.operation("chat", "id").status, status);
		await assert.rejects(
			state.reserveOperation({ ...before, signature: "conflict" }),
			/different arguments/,
		);
		assert.equal(state.operation("chat", "id").executionId, before.executionId);
	});
}
test("acknowledgement of a replaced delivery does not remove its successor", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ch-ack-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = new State(root);
	const first: DeliveryRecord = {
		id: "same",
		chatId: "chat",
		sessionId: "A",
		cwd: root,
		toolResults: [],
	};
	await state.addDelivery(first);
	const snapshot = state.deliveries("chat");
	const second = { ...first, error: "new" };
	await state.addDelivery(second);
	await state.acknowledge(snapshot, [], new AbortController().signal);
	assert.equal(state.deliveries("chat")[0]?.error, "new");
});

test("concurrent waiting_input reclaims keep one acceptance identity", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ch-wait-id-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = new State(root);
	const receipt: OperationReceipt = {
		key: "key",
		operationId: "id",
		signature: "sig",
		chatId: "chat",
		sessionId: "A",
		cwd: root,
		status: "running",
		updatedAt: Date.now(),
	};
	await state.reserveOperation(receipt);
	const before = state.operation("chat", "id");
	await state.waitForInput("key", [
		{ id: "model", sessionId: "A", request: { kind: "compaction", input: {} } },
	]);
	const claims = await Promise.all([
		state.reserveOperation({ ...receipt }),
		state.reserveOperation({ ...receipt }),
	]);
	assert.equal(claims.filter((value) => value === undefined).length, 1);
	assert.equal(state.operation("chat", "id").executionId, before.executionId);
});

test("resuming an old unaliased input wait adopts recovery identity without changing its execution", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ch-upgrade-wait-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = new State(root);
	const old: OperationReceipt = {
		key: "original-request-key",
		signature: "sig",
		chatId: "chat",
		sessionId: "A",
		cwd: root,
		status: "running",
		updatedAt: Date.now(),
	};
	await state.reserveOperation(old);
	const execution = state.executionSource(old.key).executionId;
	await state.waitForInput(old.key, [
		{ id: "model", sessionId: "A", request: { kind: "compaction", input: {} } },
	]);
	await state.reserveOperation({ ...old, operationId: "call-recovery" });
	const resumed = state.operation("chat", "call-recovery");
	assert.equal(resumed.key, old.key);
	assert.equal(resumed.executionId, execution);
	assert.equal(resumed.status, "running");
	const restored = new State(root);
	await restored.load();
	assert.equal(
		restored.operation("chat", "call-recovery").executionId,
		execution,
	);
});
