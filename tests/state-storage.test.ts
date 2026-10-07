import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import type { DeliveryRecord } from "../src/delivery.ts";
import { ResponseStore } from "../src/responses.ts";
import { State } from "../src/state.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "ch-state-storage-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = new State(root);
	const receipt = {
		key: "native-operation",
		operationId: "native-output",
		signature: "native-signature",
		chatId: "owner",
		sessionId: "A",
		cwd: root,
		status: "running" as const,
		updatedAt: Date.now(),
	};
	await state.reserveOperation(receipt);
	const execution = state.executionSource(receipt.key);
	const delivery: DeliveryRecord = {
		id: `operation:${execution.executionId}`,
		...execution,
		chatId: "owner",
		requestId: "request-one",
		sessionId: "A",
		cwd: root,
		complete: true,
		toolResults: [
			{
				role: "toolResult",
				toolCallId: "tool-one",
				toolName: "read",
				content: [{ type: "text", text: "native output" }],
				isError: false,
				timestamp: Date.now(),
			},
		],
	};
	return {
		root,
		state,
		receipt,
		delivery,
		path: join(root, "chappie.state.json"),
	};
}

function digest(text: string) {
	return createHash("sha256").update(text).digest("hex");
}

function renameFailed(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		typeof error.code === "string" &&
		["EISDIR", "ENOTDIR", "EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)
	);
}

test("a 17 MiB native result stores only small references and its public output", async (t) => {
	const f = await fixture(t);
	const body = "X".repeat(17 * 1024 * 1024);
	const result = f.delivery.toolResults[0];
	assert.ok(result);
	result.content = [{ type: "text", text: body }];
	result.details = { failed: true, privateMetadata: "PRIVATE_NATIVE_DETAILS" };
	await f.state.addDelivery(f.delivery);
	const reference = f.state.resultForOperation("owner", f.receipt.operationId);
	assert.ok(reference);
	assert.match(reference.resultId, /^[a-f0-9]{64}$/);
	assert.equal(reference.failed, true);
	assert.equal("toolResults" in reference, false);
	const metadata = await readFile(f.path, "utf8");
	assert.ok(Buffer.byteLength(metadata) < 64 * 1024);
	assert.equal(metadata.includes("PRIVATE_NATIVE_DETAILS"), false);
	assert.equal(metadata.includes('"toolResults"'), false);
	const publicOutput = await new ResponseStore(f.root).read(
		"owner",
		reference.resultId,
	);
	const expected = {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					sessionId: "A",
					cwd: f.root,
					continuation: {
						scope: "native_batch",
						userGoal: "not_evaluated",
						nextAction: "inspect_failure",
					},
				}),
			},
			{
				type: "text",
				text: JSON.stringify({
					toolCallId: "tool-one",
					toolName: "read",
					isError: true,
				}),
			},
			{ type: "text", text: body },
		],
		isError: true,
	};
	assert.equal(digest(publicOutput), digest(JSON.stringify(expected)));
	assert.equal(publicOutput.includes("PRIVATE_NATIVE_DETAILS"), false);
	assert.equal(f.state.deliveries("owner")[0]?.resultId, reference.resultId);
	assert.equal(
		f.state.operation("owner", f.receipt.operationId).resultId,
		reference.resultId,
	);
});

test("a 17 MiB delivery error stays recoverable outside bounded state metadata", async (t) => {
	const f = await fixture(t);
	const error = "E".repeat(17 * 1024 * 1024);
	f.delivery.error = error;
	await f.state.addDelivery(f.delivery);
	const reference = f.state.resultForOperation("owner", f.receipt.operationId);
	assert.ok(reference);
	assert.equal(reference.failed, true);
	assert.equal(reference.error?.length, 64 * 1024);
	assert.equal(
		digest(reference.error ?? ""),
		digest(error.slice(0, 64 * 1024)),
	);
	assert.ok(Buffer.byteLength(await readFile(f.path, "utf8")) < 512 * 1024);
	const publicOutput = JSON.parse(
		await new ResponseStore(f.root).read("owner", reference.resultId),
	);
	assert.equal(publicOutput.isError, true);
	assert.equal(digest(publicOutput.content.at(-1).text), digest(error));
	assert.equal(
		JSON.parse(publicOutput.content[0].text).continuation.nextAction,
		"inspect_failure",
	);
	await f.state.addDelivery(f.delivery);
	assert.equal(
		f.state.resultForOperation("owner", f.receipt.operationId)?.resultId,
		reference.resultId,
	);
	await assert.rejects(
		f.state.addDelivery({ ...f.delivery, error: `${error}!` }),
		/immutable/,
	);
	const restored = new State(f.root);
	await restored.load();
	assert.equal(restored.deliveries("owner")[0]?.resultId, reference.resultId);
	assert.equal(restored.deliveries("owner")[0]?.failed, true);
});

test("a failed state rename does not commit a delivery or poison another session", async (t) => {
	const f = await fixture(t);
	const before = await readFile(f.path, "utf8");
	const backup = join(f.root, "original-state.json");
	await rename(f.path, backup);
	await mkdir(f.path);
	try {
		await assert.rejects(f.state.addDelivery(f.delivery), renameFailed);
		assert.deepEqual(f.state.deliveries("owner"), []);
		assert.equal(
			f.state.resultForOperation("owner", f.receipt.operationId),
			undefined,
		);
		assert.equal(
			f.state.operation("owner", f.receipt.operationId).status,
			"running",
		);
	} finally {
		await rm(f.path, { recursive: true, force: true });
		await rename(backup, f.path);
	}
	assert.equal(await readFile(f.path, "utf8"), before);
	await f.state.bind("another-chat", "B");
	await f.state.flush();
	const persisted = JSON.parse(await readFile(f.path, "utf8"));
	assert.equal(persisted.bindings["another-chat"].sessionId, "B");
	assert.deepEqual(persisted.deliveries, []);
	assert.deepEqual(persisted.operationResults, []);
	await f.state.addDelivery(f.delivery);
	assert.ok(
		f.state.resultForOperation("owner", f.receipt.operationId)?.resultId,
	);
});

test("an unacknowledged result survives 25 hours, unrelated snapshot GC and restart", async (t) => {
	let now = 2_000_000_000_000;
	t.mock.method(Date, "now", () => now);
	const f = await fixture(t);
	await f.state.addDelivery(f.delivery);
	const original = f.state.resultForOperation("owner", f.receipt.operationId);
	assert.ok(original);
	now += 25 * 60 * 60 * 1000;
	await new ResponseStore(f.root).save("another-chat", "unrelated output");
	const restored = new State(f.root);
	await restored.load();
	assert.equal(
		restored.operation("owner", f.receipt.operationId).status,
		"completed",
	);
	assert.equal(
		restored.operation("owner", f.receipt.operationId).executionId,
		f.delivery.executionId,
	);
	const pending = restored.deliveries("owner");
	assert.equal(pending.length, 1);
	assert.equal(pending[0]?.resultId, original.resultId);
	const store = new ResponseStore(f.root);
	const beforeAck = await store.read("owner", original.resultId);
	assert.ok(
		JSON.parse(beforeAck).content.some(
			(block: { text?: string }) => block.text === "native output",
		),
	);
	await restored.acknowledge(pending, [], new AbortController().signal);
	assert.equal(await store.read("owner", original.resultId), beforeAck);
	assert.deepEqual(restored.deliveries("owner"), []);
});

test("an oversized model-input wait is rejected without poisoning shared metadata", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		f.state.waitForInput(f.receipt.key, [
			{
				id: "model-input",
				sessionId: "A",
				request: {
					kind: "compaction",
					input: { text: "W".repeat(5 * 1024 * 1024) },
				},
			},
		]),
		/input|limit|exceed/i,
	);
	const receipt = f.state.operation("owner", f.receipt.operationId);
	assert.equal(receipt.status, "running");
	assert.equal(receipt.waitingInputs, undefined);
	await f.state.bind("another-chat", "B");
	await f.state.flush();
	assert.ok(Buffer.byteLength(await readFile(f.path, "utf8")) < 64 * 1024);
});

test("a model-input persistence failure restores the previous receipt before other writes", async (t) => {
	const f = await fixture(t);
	const backup = join(f.root, "original-state.json");
	await rename(f.path, backup);
	await mkdir(f.path);
	try {
		await assert.rejects(
			f.state.waitForInput(f.receipt.key, [
				{
					id: "model-input",
					sessionId: "A",
					request: {
						kind: "compaction",
						input: { text: "W".repeat(2 * 1024 * 1024) },
					},
				},
			]),
			renameFailed,
		);
		const receipt = f.state.operation("owner", f.receipt.operationId);
		assert.equal(receipt.status, "running");
		assert.equal(receipt.waitingInputs, undefined);
	} finally {
		await rm(f.path, { recursive: true, force: true });
		await rename(backup, f.path);
	}
	await f.state.bind("another-chat", "B");
	await f.state.flush();
	assert.ok(Buffer.byteLength(await readFile(f.path, "utf8")) < 64 * 1024);
});

test("inline result and unversioned formats are rejected without mutation", async (t) => {
	const f = await fixture(t);
	const inline = JSON.stringify({
		schemaVersion: 1,
		deliveries: [f.delivery],
	});
	for (const contents of [inline, '{"deliveries":[]}']) {
		await writeFile(f.path, contents);
		await assert.rejects(new State(f.root).load(), { name: "ZodError" });
		assert.equal(await readFile(f.path, "utf8"), contents);
	}
});
