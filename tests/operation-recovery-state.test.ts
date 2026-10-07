import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { State } from "../src/state.ts";

const base = {
	key: "key",
	operationId: "op",
	signature: "sig",
	chatId: "chat",
	sessionId: "A",
	cwd: "/fixture",
	status: "running" as const,
};

test("snapshot references keep acceptance identity, immutability and sticky cancellation across restart", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ch-response-inc-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let now = 2_000_000_000_000;
	t.mock.method(Date, "now", () => now);
	const state = new State(root);
	await state.reserveOperation({ ...base, updatedAt: now });
	const executionId = state.operation("chat", "op").executionId;
	assert.ok(executionId);
	await state.finishOperation("key", "cancelled");
	await state.finishOperation("key", "completed", [], undefined, {
		executionId,
		resultId: "a".repeat(64),
	});
	assert.equal(state.operation("chat", "op").status, "cancelled");
	await assert.rejects(
		state.finishOperation("key", "completed", [], undefined, {
			executionId,
			resultId: "b".repeat(64),
		}),
		/immutable/,
	);
	const restored = new State(root);
	await restored.load();
	assert.equal(restored.operation("chat", "op").resultId, "a".repeat(64));
	now += 25 * 60 * 60 * 1000;
	assert.equal(restored.operation("chat", "op").resultUnread, true);
	await restored.acknowledgeResult("chat", "a".repeat(64));
	assert.deepEqual(restored.recentOperations("chat", "A").operations, []);
	await restored.reserveOperation({ ...base, updatedAt: now });
	await assert.rejects(
		restored.finishOperation("key", "completed", [], undefined, {
			executionId,
			resultId: "a".repeat(64),
		}),
		/replaced acceptance/,
	);
	assert.equal(restored.operation("chat", "op").status, "running");
	assert.equal(restored.operation("chat", "op").resultId, undefined);
	await assert.rejects(
		restored.finishOperation("missing", "completed", [], undefined, {
			executionId,
			resultId: "a".repeat(64),
		}),
		/replaced acceptance/,
	);
});

test("recent discovery is bounded, newest first, owner-scoped and does not extend retention", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ch-response-list-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let now = 2_000_000_000_000;
	t.mock.method(Date, "now", () => now);
	const state = new State(root);
	for (let i = 0; i < 22; i++) {
		now++;
		await state.reserveOperation({
			...base,
			key: `k-${i}`,
			operationId: `op-${i}`,
			updatedAt: now,
		});
		await state.finishOperation(`k-${i}`, "completed");
	}
	await state.reserveOperation({
		...base,
		key: "other-chat",
		operationId: "secret",
		chatId: "other",
		updatedAt: ++now,
	});
	await state.reserveOperation({
		...base,
		key: "other-session",
		operationId: "other-session",
		sessionId: "B",
		updatedAt: ++now,
	});
	const recent = state.recentOperations("chat", "A");
	assert.equal(recent.operations.length, 10);
	assert.equal(recent.operations[0]?.operationId, "op-21");
	assert.equal(recent.operations[9]?.operationId, "op-12");
	assert.equal(recent.hasOlder, true);
	assert.equal(state.recentOperations("chat", "A", 20).operations.length, 20);
	assert.deepEqual(
		state.recentOperations("other", "A").operations.map((op) => op.operationId),
		["secret"],
	);
	assert.deepEqual(
		state.recentOperations("chat", "B").operations.map((op) => op.operationId),
		["other-session"],
	);
	assert.throws(() => state.recentOperations("chat", "A", 21), /limit/);
	const timestamp = recent.operations[0]?.updatedAt;
	now += 23 * 60 * 60 * 1000;
	assert.equal(
		state.recentOperations("chat", "A").operations[0]?.updatedAt,
		timestamp,
	);
	now += 2 * 60 * 60 * 1000;
	assert.deepEqual(state.recentOperations("chat", "A").operations, []);
	assert.equal(
		state.recentOperations("chat", "B").operations[0]?.status,
		"running",
	);
});
