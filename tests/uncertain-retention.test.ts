import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { OperationReceipt } from "../src/operations.ts";
import { State } from "../src/state.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "ch-cold-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let now = 2_000_000_000_000;
	t.mock.method(Date, "now", () => now);
	const state = new State(root);
	const receipt: OperationReceipt = {
		key: "legacy-request",
		signature: "original",
		chatId: "owner",
		sessionId: "session",
		cwd: root,
		status: "running",
		updatedAt: now,
	};
	const handle = `receipt-${createHash("sha256").update(receipt.key).digest("hex")}`;
	await state.reserveOperation(receipt);
	const executionId = state.executionSource(receipt.key).executionId;
	assert.ok(executionId);
	return {
		root,
		state,
		receipt,
		handle,
		executionId,
		advance: () => {
			now += 25 * 60 * 60 * 1000;
		},
		maintain: () =>
			state.reserveOperation({ ...receipt, key: `new-${now}`, updatedAt: now }),
	};
}

test("old unaliased uncertainty leaves hot state but remains queryable and unreplayable", async (t) => {
	const f = await fixture(t);
	await f.state.finishOperation(f.receipt.key, "uncertain");
	f.advance();
	await f.maintain();
	const saved = JSON.parse(
		await readFile(join(f.root, "chappie.state.json"), "utf8"),
	);
	assert.equal(
		saved.operations.some((r: OperationReceipt) => r.key === f.receipt.key),
		false,
	);
	const reopened = new State(f.root);
	await reopened.load();
	assert.equal(reopened.operation("owner", f.handle).status, "uncertain");
	assert.equal(
		reopened.operation("owner", f.receipt.key).executionId,
		f.executionId,
	);
	const replay = await reopened.reserveOperation(f.receipt);
	assert.equal(replay?.executionId, f.executionId);
	assert.equal(replay?.status, "uncertain");
	await assert.rejects(
		reopened.reserveOperation({ ...f.receipt, signature: "changed" }),
		/different arguments/,
	);
	assert.throws(() => reopened.operation("other", f.handle), /not found/);
});

test("archived public aliases cannot be reused in another session", async (t) => {
	const f = await fixture(t);
	await f.state.reserveOperation({
		...f.receipt,
		key: "explicit",
		operationId: "long-job",
	});
	await f.state.finishOperation("explicit", "uncertain");
	f.advance();
	await f.maintain();
	assert.equal(f.state.operation("owner", "long-job").status, "uncertain");
	await assert.rejects(
		f.state.reserveOperation({
			...f.receipt,
			key: "different",
			operationId: "long-job",
			sessionId: "other",
		}),
		/another session|another.*operation/,
	);
});

test("a matching late result restores the archived acceptance without executing again", async (t) => {
	const f = await fixture(t);
	await f.state.finishOperation(f.receipt.key, "uncertain");
	f.advance();
	await f.maintain();
	assert.equal(f.state.ownsOperation(f.receipt.key, "owner", "session"), true);
	await assert.rejects(
		f.state.addDelivery({
			id: "wrong",
			operationKey: f.receipt.key,
			executionId: "different",
			chatId: "owner",
			sessionId: "session",
			cwd: f.root,
			toolResults: [],
			complete: true,
		}),
		/different execution/,
	);
	await f.state.addDelivery({
		id: "late",
		operationKey: f.receipt.key,
		executionId: f.executionId,
		chatId: "owner",
		sessionId: "session",
		cwd: f.root,
		toolResults: [],
		complete: true,
	});
	assert.equal(f.state.operation("owner", f.handle).status, "completed");
	assert.equal(f.state.operation("owner", f.handle).executionId, f.executionId);
	assert.equal(f.state.resultForOperation("owner", f.handle)?.id, "late");
	const reopened = new State(f.root);
	await reopened.load();
	assert.equal(reopened.operation("owner", f.handle).status, "completed");
});

test("undelivered output is not retired with an uncertain receipt", async (t) => {
	const f = await fixture(t);
	await f.state.addDelivery({
		id: "pending",
		operationKey: f.receipt.key,
		executionId: f.executionId,
		chatId: "owner",
		sessionId: "session",
		cwd: f.root,
		toolResults: [],
		complete: false,
	});
	f.advance();
	await f.maintain();
	assert.equal(f.state.deliveries("owner")[0]?.id, "pending");
	const saved = JSON.parse(
		await readFile(join(f.root, "chappie.state.json"), "utf8"),
	);
	assert.equal(
		saved.operations.some((r: OperationReceipt) => r.key === f.receipt.key),
		true,
	);
});

test("archive persistence failure cannot discard an uncertain receipt", async (t) => {
	const f = await fixture(t);
	await f.state.finishOperation(f.receipt.key, "uncertain");
	await writeFile(join(f.root, "chappie.uncertain"), "blocked directory");
	const before = await readFile(join(f.root, "chappie.state.json"), "utf8");
	f.advance();
	await assert.rejects(f.maintain());
	assert.equal(
		await readFile(join(f.root, "chappie.state.json"), "utf8"),
		before,
	);
	assert.equal(
		f.state.executionSource(f.receipt.key).executionId,
		f.executionId,
	);
});

for (const cold of [false, true]) {
	test(`legacy recovery keys cannot be shadowed by a new explicit ID (${cold ? "cold" : "hot"})`, async (t) => {
		const f = await fixture(t);
		await f.state.finishOperation(f.receipt.key, "uncertain");
		if (cold) {
			f.advance();
			await f.maintain();
		}
		await assert.rejects(
			f.state.reserveOperation({
				...f.receipt,
				key: "shadow",
				operationId: f.receipt.key,
			}),
			/another.*operation|another session/,
		);
		assert.equal(
			f.state.operation("owner", f.receipt.key).executionId,
			f.executionId,
		);
	});
}
