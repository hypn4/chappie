import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { DeliveryRecord, DeliveryReference } from "../src/delivery.ts";
import { OperationArchive } from "../src/operation-archive.ts";
import type { OperationReceipt } from "../src/operations.ts";
import { ResponseStore } from "../src/responses.ts";
import { State } from "../src/state.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "ch-state-capacity-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const now = 2_000_000_000_000;
	t.mock.method(Date, "now", () => now);
	const store = new ResponseStore(root);
	const publicText = JSON.stringify({
		content: [
			{
				type: "text",
				text: JSON.stringify({
					sessionId: "A",
					cwd: root,
					continuation: {
						scope: "native_batch",
						userGoal: "not_evaluated",
						nextAction: "verify_requested_scope",
					},
				}),
			},
			{
				type: "text",
				text: JSON.stringify({
					toolCallId: "fixture-tool",
					toolName: "read",
					isError: false,
				}),
			},
			{ type: "text", text: "complete fixture output" },
		],
		isError: false,
	});
	const resultId = await store.save("owner", publicText);
	const path = join(root, "chappie.state.json");
	const receipt = (index: number): OperationReceipt => ({
		key: `key-${index}`,
		operationId: `operation-${index}`,
		executionId: randomUUID(),
		signature: `signature-${index}`,
		chatId: "owner",
		sessionId: "A",
		cwd: root,
		status: "completed",
		updatedAt: now - 1000 + index,
		resultId,
		resultAcknowledged: true,
		resultUnread: false,
	});
	const reference = (operation: OperationReceipt): DeliveryReference => ({
		id: `operation:${operation.executionId}`,
		operationKey: operation.key,
		executionId: operation.executionId,
		chatId: operation.chatId,
		sessionId: operation.sessionId,
		cwd: root,
		complete: true,
		resultId,
		bytes: Buffer.byteLength(publicText),
		failed: false,
	});
	const delivery = (operation: OperationReceipt): DeliveryRecord => ({
		id: `operation:${operation.executionId}`,
		operationKey: operation.key,
		executionId: operation.executionId,
		chatId: operation.chatId,
		sessionId: operation.sessionId,
		cwd: root,
		complete: true,
		toolResults: [
			{
				role: "toolResult",
				toolCallId: "fixture-tool",
				toolName: "read",
				content: [{ type: "text", text: "complete fixture output" }],
				isError: false,
				timestamp: now,
			},
		],
	});
	return {
		root,
		path,
		now,
		store,
		resultId,
		publicText,
		receipt,
		reference,
		delivery,
	};
}

async function nearMetadataCapacity(
	f: Awaited<ReturnType<typeof fixture>>,
	withSecondaryReferences: boolean,
) {
	const error = "E".repeat(64 * 1024);
	const pending = {
		...f.receipt(0),
		error,
		resultAcknowledged: false,
	};
	pending.resultId = await f.store.save("owner", `${f.publicText} `);
	const pendingReference = {
		...f.reference(pending),
		resultId: pending.resultId,
		error,
	};
	const unread = {
		...f.receipt(-1),
		error,
		resultUnread: true,
		resultId: await f.store.save("owner", `${f.publicText}  `, {
			pin: "unread",
		}),
	};
	const next = {
		...f.receipt(20_000),
		status: "uncertain" as const,
		resultId: undefined,
		resultAcknowledged: undefined,
	};
	const operations: OperationReceipt[] = [pending, next, unread];
	const operationResults = [
		{ operationKey: pending.key, delivery: pendingReference },
	];
	const saved = {
		schemaVersion: 1,
		bindings: {},
		deliveries: [pendingReference],
		operationResults,
		questions: [],
		operations,
		deliveredIds: [],
	};
	let bytes = Buffer.byteLength(`${JSON.stringify(saved, null, 2)}\n`);
	const entryBytes = (value: unknown) => {
		const text = JSON.stringify(value, null, 2);
		return Buffer.byteLength(text) + 4 * text.split("\n").length + 2;
	};
	for (let index = 1; ; index++) {
		const receipt = { ...f.receipt(index), error };
		const secondary = {
			operationKey: receipt.key,
			delivery: { ...f.reference(receipt), error },
		};
		const added =
			entryBytes(receipt) +
			(withSecondaryReferences ? entryBytes(secondary) : 0);
		if (bytes + added > 128 * 1024 * 1024 - 32 * 1024) break;
		operations.push(receipt);
		if (withSecondaryReferences) operationResults.push(secondary);
		bytes += added;
	}
	const contents = `${JSON.stringify(saved, null, 2)}\n`;
	assert.equal(Buffer.byteLength(contents), bytes);
	assert.ok(bytes < 128 * 1024 * 1024);
	assert.ok(bytes > 128 * 1024 * 1024 - 192 * 1024);
	assert.ok(operations.length < 16_384);
	await f.store.pin(
		"owner",
		pending.resultId,
		`delivery:${pendingReference.id}`,
	);
	await writeFile(f.path, contents);
	return { operations, pending, pendingReference, unread, next, error };
}

test("byte pressure retires acknowledged secondary references before cold receipts", {
	timeout: 30_000,
}, async (t) => {
	const f = await fixture(t);
	const seeded = await nearMetadataCapacity(f, true);
	const state = new State(f.root);
	await state.load();
	await state.addDelivery({ ...f.delivery(seeded.next), error: seeded.error });
	const contents = await readFile(f.path, "utf8");
	assert.ok(Buffer.byteLength(contents) < 128 * 1024 * 1024);
	const saved = JSON.parse(contents);
	assert.equal(saved.operations.length, seeded.operations.length);
	assert.ok(saved.operationResults.length < seeded.operations.length - 1);
	assert.equal(new OperationArchive(f.root).get("key-1"), undefined);
	assert.equal(
		state.operation("owner", "operation-1").executionId,
		seeded.operations[3]?.executionId,
	);
	assert.equal(state.deliveries("owner")[0]?.id, seeded.pendingReference.id);
	assert.equal(state.operation("owner", "operation-20000").status, "completed");
});

test("byte pressure archives safe terminal receipts and survives an archive write failure", {
	timeout: 30_000,
}, async (t) => {
	const f = await fixture(t);
	const seeded = await nearMetadataCapacity(f, false);
	const state = new State(f.root);
	await state.load();
	const archivePath = join(f.root, "chappie.uncertain");
	await writeFile(archivePath, "blocked archive directory");
	const delivery = { ...f.delivery(seeded.next), error: seeded.error };
	await assert.rejects(state.addDelivery(delivery));
	assert.equal(state.operation("owner", "operation-20000").status, "uncertain");
	assert.equal(state.deliveries("owner").length, 1);
	await state.bind("another-chat", "B");
	assert.equal(state.binding("another-chat"), "B");
	await rm(archivePath);
	await state.addDelivery(delivery);
	const cold = new OperationArchive(f.root);
	const firstArchived = cold.get("key-1");
	assert.ok(firstArchived);
	assert.equal(firstArchived.executionId, seeded.operations[3]?.executionId);
	assert.equal(firstArchived.updatedAt, seeded.operations[3]?.updatedAt);
	assert.equal(cold.get(seeded.pending.key), undefined);
	assert.equal(cold.get(seeded.unread.key), undefined);
	assert.equal(
		state.operation("owner", seeded.unread.operationId ?? "").resultUnread,
		true,
	);
	assert.equal(state.operation("owner", "operation-1").resultId, f.resultId);
	assert.equal(
		state.findOperation("different-owner", "operation-1"),
		undefined,
	);
	await assert.rejects(
		state.reserveOperation({ ...firstArchived, signature: "changed" }),
		/different arguments/,
	);
	const contents = await readFile(f.path, "utf8");
	assert.ok(Buffer.byteLength(contents) < 128 * 1024 * 1024);
	assert.ok(JSON.parse(contents).operations.length < seeded.operations.length);
	const restored = new State(f.root);
	await restored.load();
	assert.equal(
		restored.operation("owner", "operation-1").executionId,
		firstArchived.executionId,
	);
	assert.ok(
		restored.deliveries("owner").some((item) => item.id === delivery.id),
	);
	assert.equal(await f.store.read("owner", f.resultId), f.publicText);
});

test("an unread result stays discoverable after reference acknowledgement and 25 hours", async (t) => {
	const f = await fixture(t);
	let now = f.now;
	t.mock.method(Date, "now", () => now);
	const state = new State(f.root);
	const next = {
		...f.receipt(0),
		status: "running" as const,
		resultId: undefined,
		resultAcknowledged: undefined,
	};
	await state.reserveOperation(next);
	await state.addDelivery(
		f.delivery(state.operation("owner", next.operationId ?? "")),
	);
	await state.acknowledge(
		state.deliveries("owner"),
		[],
		new AbortController().signal,
	);
	const acknowledged = state.operation("owner", next.operationId ?? "");
	assert.equal(acknowledged.resultAcknowledged, true);
	assert.equal(acknowledged.resultUnread, true);
	now += 25 * 60 * 60 * 1000;
	const restored = new State(f.root);
	await restored.load();
	assert.equal(
		restored.operation("owner", next.operationId ?? "").resultId,
		f.resultId,
	);
	assert.equal(restored.recentOperations("owner", "A").operations.length, 1);
	assert.equal(
		restored.findOperation("different-owner", next.operationId ?? ""),
		undefined,
	);
	const body = await f.store.read("owner", f.resultId);
	await f.store.markRead("owner", f.resultId);
	await restored.acknowledgeResult("owner", f.resultId);
	await f.store.unpin("owner", f.resultId, "unread");
	assert.equal(body, f.publicText);
	assert.equal(
		restored.findOperation("owner", next.operationId ?? ""),
		undefined,
	);
	await f.store.save("another-chat", "trigger expired cache collection");
	await assert.rejects(
		f.store.read("owner", f.resultId),
		/not found or expired/,
	);
});

test("body consumption before reference acknowledgement does not recreate an unread pin", async (t) => {
	const f = await fixture(t);
	const state = new State(f.root);
	const next = {
		...f.receipt(0),
		status: "running" as const,
		resultId: undefined,
		resultAcknowledged: undefined,
	};
	await state.reserveOperation(next);
	await state.addDelivery(
		f.delivery(state.operation("owner", next.operationId ?? "")),
	);
	const body = await f.store.read("owner", f.resultId);
	await f.store.recordRead("owner", f.resultId, 0, body.length, body.length, {
		preserveUnreadPin: true,
	});
	await state.acknowledgeResult("owner", f.resultId);
	await f.store.unpin("owner", f.resultId, "unread");
	await state.acknowledge(
		state.deliveries("owner"),
		[],
		new AbortController().signal,
	);
	const metadata = JSON.parse(
		await readFile(
			join(f.root, "chappie.results", `${f.resultId}.meta.json`),
			"utf8",
		),
	);
	assert.deepEqual(metadata.pins, []);
	assert.equal(typeof metadata.readAt, "number");
	assert.equal(state.operation("owner", "operation-0").resultUnread, false);
});

test("restart repairs a stale unread pin after durable consumption and keeps pending delivery protection", async (t) => {
	const f = await fixture(t);
	const state = new State(f.root);
	const next = {
		...f.receipt(0),
		status: "running" as const,
		resultId: undefined,
		resultAcknowledged: undefined,
	};
	await state.reserveOperation(next);
	await state.addDelivery(
		f.delivery(state.operation("owner", next.operationId ?? "")),
	);
	const beforeCrash = new State(f.root);
	await beforeCrash.load();
	const pending = beforeCrash.deliveries("owner")[0];
	assert.ok(pending);
	await f.store.markRead("owner", f.resultId);
	await beforeCrash.acknowledgeResult("owner", f.resultId);
	assert.equal(await f.store.isUnread("owner", f.resultId), true);
	// Simulate termination after state commit, before removing the unread pin.
	const restored = new State(f.root);
	await restored.load();
	assert.equal(restored.operation("owner", "operation-0").resultUnread, false);
	assert.equal(restored.deliveries("owner")[0]?.id, pending.id);
	const metadata = JSON.parse(
		await readFile(
			join(f.root, "chappie.results", `${f.resultId}.meta.json`),
			"utf8",
		),
	);
	assert.deepEqual(metadata.pins, [`delivery:${pending.id}`]);
	assert.equal(await f.store.read("owner", f.resultId), f.publicText);
});

test("hot receipt pressure archives a completed acceptance while protecting older pending work", async (t) => {
	const f = await fixture(t);
	const pending = { ...f.receipt(0), resultAcknowledged: false };
	const retained = f.receipt(1);
	const pendingReference = f.reference(pending);
	pending.resultId = await f.store.save("owner", `${f.publicText} `, {
		pin: `delivery:${pendingReference.id}`,
	});
	pendingReference.resultId = pending.resultId;
	await writeFile(
		f.path,
		JSON.stringify({
			schemaVersion: 1,
			operations: [
				pending,
				retained,
				...Array.from({ length: 16_382 }, (_, index) => ({
					...f.receipt(index + 2),
					status: "uncertain",
					resultId: undefined,
					resultAcknowledged: undefined,
				})),
			],
			deliveries: [pendingReference],
			operationResults: [
				{ operationKey: retained.key, delivery: f.reference(retained) },
			],
		}),
	);
	const state = new State(f.root);
	await state.load();
	const next = {
		...f.receipt(20_000),
		status: "running" as const,
		resultId: undefined,
		resultAcknowledged: undefined,
	};
	assert.equal(await state.reserveOperation(next), undefined);
	const cold = new OperationArchive(f.root);
	assert.equal(cold.get(retained.key)?.executionId, retained.executionId);
	assert.equal(cold.get(pending.key), undefined);
	assert.equal(
		state.operation("owner", retained.operationId ?? "").resultId,
		f.resultId,
	);
	assert.equal(state.deliveries("owner")[0]?.id, pendingReference.id);
	await assert.rejects(
		state.reserveOperation({ ...retained, signature: "changed" }),
		/different arguments/,
	);
	const saved = JSON.parse(await readFile(f.path, "utf8"));
	assert.equal(saved.operations.length, 16_384);
	assert.equal(
		saved.operations.some(
			(item: OperationReceipt) => item.key === retained.key,
		),
		false,
	);
	assert.equal(
		saved.operationResults.some(
			(item: { operationKey: string }) => item.operationKey === retained.key,
		),
		false,
	);
	assert.equal(
		state.operation("owner", next.operationId ?? "").status,
		"running",
	);
});

test("a full unresolved receipt set rejects new work without poisoning another session", async (t) => {
	const f = await fixture(t);
	await writeFile(
		f.path,
		JSON.stringify({
			schemaVersion: 1,
			operations: Array.from({ length: 16_384 }, (_, index) => ({
				...f.receipt(index),
				status: "uncertain",
				resultId: undefined,
				resultAcknowledged: undefined,
			})),
		}),
	);
	const state = new State(f.root);
	await state.load();
	await assert.rejects(
		state.reserveOperation({ ...f.receipt(20_000), status: "running" }),
		/receipt limit/,
	);
	await state.bind("other-chat", "B");
	assert.equal(state.binding("other-chat"), "B");
	const saved = JSON.parse(await readFile(f.path, "utf8"));
	assert.equal(saved.operations.length, 16_384);
	assert.equal(
		saved.operations.every(
			(item: OperationReceipt) => item.status === "uncertain",
		),
		true,
	);
});

test("a full secondary result cache retires acknowledged references without losing replay protection", async (t) => {
	const f = await fixture(t);
	const receipts = Array.from({ length: 2048 }, (_, index) => f.receipt(index));
	const pending = receipts[0];
	const evicted = receipts[1];
	assert.ok(pending && evicted);
	pending.resultAcknowledged = false;
	const pendingReference = f.reference(pending);
	await f.store.pin("owner", f.resultId, `delivery:${pendingReference.id}`);
	await writeFile(
		f.path,
		JSON.stringify({
			schemaVersion: 1,
			operations: receipts,
			deliveries: [pendingReference],
			operationResults: receipts.map((operation) => ({
				operationKey: operation.key,
				delivery: f.reference(operation),
			})),
		}),
	);
	const state = new State(f.root);
	await state.load();
	const next = {
		...f.receipt(3000),
		status: "running" as const,
		resultId: undefined,
		resultAcknowledged: undefined,
	};
	await state.reserveOperation(next);
	await state.addDelivery(
		f.delivery(state.operation("owner", next.operationId ?? "")),
	);
	assert.equal(
		state.resultForOperation("owner", pending.operationId ?? "")?.id,
		pendingReference.id,
	);
	assert.equal(
		state.resultForOperation("owner", evicted.operationId ?? ""),
		undefined,
	);
	assert.equal(
		state.operation("owner", evicted.operationId ?? "").resultId,
		f.resultId,
	);
	assert.equal(await f.store.read("owner", f.resultId), f.publicText);
	await state.addDelivery(f.delivery(evicted));
	assert.equal(state.deliveries("owner").length, 2);
	await assert.rejects(
		state.reserveOperation({ ...evicted, signature: "changed" }),
		/different arguments/,
	);
	const saved = JSON.parse(await readFile(f.path, "utf8"));
	assert.equal(saved.operationResults.length, 2048);
});

test("completed result acknowledgements continue past 4096 receipts and stale packets stay suppressed", async (t) => {
	const f = await fixture(t);
	await writeFile(
		f.path,
		JSON.stringify({
			schemaVersion: 1,
			operations: Array.from({ length: 4096 }, (_, index) => f.receipt(index)),
			deliveredIds: Array.from({ length: 4096 }, (_, index) => [
				`legacy-delivery-${index}`,
				f.now,
			]),
		}),
	);
	const state = new State(f.root);
	await state.load();
	let latest: DeliveryRecord | undefined;
	for (let index = 4096; index < 4099; index++) {
		const next = {
			...f.receipt(index),
			status: "running" as const,
			resultId: undefined,
			resultAcknowledged: undefined,
		};
		await state.reserveOperation(next);
		latest = f.delivery(state.operation("owner", next.operationId ?? ""));
		await state.addDelivery(latest);
		await state.acknowledge(
			state.deliveries("owner"),
			[],
			new AbortController().signal,
		);
	}
	assert.ok(latest);
	const restored = new State(f.root);
	await restored.load();
	await restored.addDelivery(latest);
	await restored.addDelivery({ ...latest, complete: false, toolResults: [] });
	assert.deepEqual(restored.deliveries("owner"), []);
	await assert.rejects(
		restored.addDelivery({ ...latest, executionId: randomUUID() }),
		/execution/,
	);
	await restored.bind("another-chat", "B");
	const saved = JSON.parse(await readFile(f.path, "utf8"));
	assert.equal(saved.operations.length, 4099);
	assert.equal(saved.deliveredIds.length, 4096);
	assert.deepEqual(saved.deliveries, []);
});

test("a failed state write releases only its new delivery pin and preserves unread recovery", async (t) => {
	const f = await fixture(t);
	await f.store.pin("owner", f.resultId, "unread");
	const state = new State(f.root);
	const next = {
		...f.receipt(0),
		status: "running" as const,
		resultId: undefined,
		resultAcknowledged: undefined,
	};
	await state.reserveOperation(next);
	const delivery = f.delivery(state.operation("owner", next.operationId ?? ""));
	const backup = join(f.root, "original-state.json");
	await rename(f.path, backup);
	await mkdir(f.path);
	try {
		await assert.rejects(state.addDelivery(delivery));
		const metadata = JSON.parse(
			await readFile(
				join(f.root, "chappie.results", `${f.resultId}.meta.json`),
				"utf8",
			),
		);
		assert.deepEqual(metadata.pins, ["unread"]);
		assert.deepEqual(state.deliveries("owner"), []);
	} finally {
		await rm(f.path, { recursive: true, force: true });
		await rename(backup, f.path);
	}
	await state.bind("another-chat", "B");
	assert.equal(await f.store.read("owner", f.resultId), f.publicText);
});

test("post-commit pin release failure does not restore an acknowledged delivery", async (t) => {
	const f = await fixture(t);
	const state = new State(f.root);
	const next = {
		...f.receipt(0),
		status: "running" as const,
		resultId: undefined,
		resultAcknowledged: undefined,
	};
	await state.reserveOperation(next);
	const delivery = f.delivery(state.operation("owner", next.operationId ?? ""));
	await state.addDelivery(delivery);
	const unpin = ResponseStore.prototype.unpin;
	let blocked = true;
	t.mock.method(
		ResponseStore.prototype,
		"unpin",
		async function (
			this: ResponseStore,
			...args: Parameters<ResponseStore["unpin"]>
		) {
			if (blocked && args[2].startsWith("delivery:")) {
				blocked = false;
				throw new Error("simulated pin release write failure");
			}
			return unpin.apply(this, args);
		},
	);
	await assert.rejects(
		state.acknowledge(
			state.deliveries("owner"),
			[],
			new AbortController().signal,
		),
		/pin release/,
	);
	assert.deepEqual(state.deliveries("owner"), []);
	assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")).deliveries, []);
	assert.equal(
		state.operation("owner", next.operationId ?? "").resultAcknowledged,
		true,
	);
	const restored = new State(f.root);
	await restored.load();
	const metadata = JSON.parse(
		await readFile(
			join(f.root, "chappie.results", `${f.resultId}.meta.json`),
			"utf8",
		),
	);
	assert.deepEqual(metadata.pins, ["unread"]);
	assert.equal(await f.store.read("owner", f.resultId), f.publicText);
});

test("acknowledging a partial result does not suppress its later complete result", async (t) => {
	const f = await fixture(t);
	const state = new State(f.root);
	const next = {
		...f.receipt(0),
		status: "running" as const,
		resultId: undefined,
		resultAcknowledged: undefined,
	};
	await state.reserveOperation(next);
	const delivery = f.delivery(state.operation("owner", next.operationId ?? ""));
	await state.addDelivery({ ...delivery, complete: false, toolResults: [] });
	await state.acknowledge(
		state.deliveries("owner"),
		[],
		new AbortController().signal,
	);
	await state.addDelivery(delivery);
	assert.equal(
		state.operation("owner", next.operationId ?? "").status,
		"completed",
	);
	assert.equal(state.deliveries("owner")[0]?.complete, true);
	assert.equal(state.deliveries("owner")[0]?.resultId, f.resultId);
});
