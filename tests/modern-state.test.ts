import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { uuidV7 } from "../src/ids.ts";
import { OperationArchive } from "../src/operation-archive.ts";
import { ResponseStore } from "../src/responses.ts";
import { State } from "../src/state.ts";

test("saved operations without an execution identity are rejected without rewriting state", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-state-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "chappie.state.json");
	const source = JSON.stringify({
		schemaVersion: 1,
		operations: [
			{
				key: "missing-execution",
				operationId: "missing-execution",
				signature: "sig",
				chatId: "chat",
				sessionId: "A",
				cwd: root,
				status: "uncertain",
				updatedAt: Date.now(),
			},
		],
	});
	await writeFile(path, source);
	await assert.rejects(new State(root).load(), { name: "ZodError" });
	assert.equal(await readFile(path, "utf8"), source);
});

test("obsolete string bindings are rejected without rewriting saved state", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-state-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "chappie.state.json");
	const source = JSON.stringify({ bindings: { chat: "A" } });
	await writeFile(path, source);
	await assert.rejects(new State(root).load(), { name: "ZodError" });
	assert.equal(await readFile(path, "utf8"), source);
});

test("archived operations without an execution identity fail closed without rewriting", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-state-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const key = "missing-archived-execution";
	const directory = join(root, "chappie.uncertain");
	await mkdir(directory);
	const path = join(
		directory,
		`key-${createHash("sha256").update(key).digest("hex")}.json`,
	);
	const source = JSON.stringify({
		key,
		signature: "sig",
		chatId: "chat",
		sessionId: "A",
		cwd: root,
		status: "uncertain",
		updatedAt: Date.now(),
	});
	await writeFile(path, source);
	assert.throws(() => new OperationArchive(root).get(key), {
		name: "ZodError",
	});
	assert.equal(await readFile(path, "utf8"), source);
});

test("a delivery with only one acceptance field cannot enter durable state", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-state-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = new State(root);
	await state.reserveOperation({
		key: "tracked",
		operationId: "tracked",
		signature: "sig",
		chatId: "chat",
		sessionId: "A",
		cwd: root,
		status: "running",
		updatedAt: Date.now(),
	});
	const path = join(root, "chappie.state.json");
	const before = await readFile(path, "utf8");
	for (const identity of [
		{ operationKey: "tracked" },
		{ executionId: state.executionSource("tracked").executionId },
	]) {
		await assert.rejects(
			state.addDelivery({
				id: "half-pair",
				chatId: "chat",
				sessionId: "A",
				cwd: root,
				toolResults: [],
				complete: true,
				...identity,
			}),
			{ name: "ZodError" },
		);
		assert.equal(await readFile(path, "utf8"), before);
		assert.deepEqual(state.deliveries("chat"), []);
		assert.equal(state.operation("chat", "tracked").status, "running");
	}
});

test("saved delivery references with only one acceptance field are rejected without rewriting", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-state-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "chappie.state.json");
	for (const identity of [
		{ operationKey: "tracked" },
		{ executionId: "8f6d6c83-98aa-4199-a95d-268d62c95db4" },
	]) {
		const source = JSON.stringify({
			schemaVersion: 1,
			deliveries: [
				{
					id: "half-pair",
					chatId: "chat",
					sessionId: "A",
					cwd: root,
					resultId: "a".repeat(64),
					bytes: 0,
					failed: false,
					...identity,
				},
			],
		});
		await writeFile(path, source);
		await assert.rejects(new State(root).load(), { name: "ZodError" });
		assert.equal(await readFile(path, "utf8"), source);
	}
});

test("retired event fields are rejected without rewriting the store", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-state-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "chappie.state.json");
	const now = Date.now();
	await writeFile(
		path,
		JSON.stringify({
			schemaVersion: 1,
			operations: [
				{
					key: "existing-key",
					executionId: uuidV7(),
					operationId: "existing",
					signature: "sig",
					chatId: "chat",
					sessionId: "A",
					cwd: root,
					status: "completed",
					updatedAt: now,
				},
			],
			eventSubscriptions: [],
			eventOutbox: [],
		}),
	);
	const state = new State(root);
	const before = await readFile(path, "utf8");
	await assert.rejects(state.load(), { name: "ZodError" });
	assert.equal(await readFile(path, "utf8"), before);
});

test("old terminal explicit receipts do not permanently exhaust operation admission", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-state-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "chappie.state.json");
	const now = Date.now();
	const old = now - 25 * 60 * 60 * 1000;
	await writeFile(
		path,
		JSON.stringify({
			schemaVersion: 1,
			operations: Array.from({ length: 16_384 }, (_, index) => ({
				key: `old-${index}`,
				executionId: uuidV7(),
				operationId: `old-${index}`,
				signature: `sig-${index}`,
				chatId: "chat",
				sessionId: "A",
				cwd: root,
				status: "completed",
				updatedAt: old,
			})),
		}),
	);
	const state = new State(root);
	await state.load();
	await state.reserveOperation({
		key: "new-key",
		operationId: "new-operation",
		signature: "new-signature",
		chatId: "chat",
		sessionId: "A",
		cwd: root,
		status: "running",
		updatedAt: now,
	});
	assert.equal(state.operation("chat", "new-operation").status, "running");
});

test("a consumed terminal operation retires before same-ID reuse", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-state-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let now = 2_000_000_000_000;
	t.mock.method(Date, "now", () => now);
	const state = new State(root);
	const key = "stable-key";
	await state.reserveOperation({
		key,
		operationId: "reuse-me",
		signature: "old-signature",
		chatId: "chat",
		sessionId: "A",
		cwd: root,
		status: "running",
		updatedAt: now,
	});
	await state.addDelivery({
		id: `operation:${key}`,
		...state.executionSource(key),
		operationKey: key,
		chatId: "chat",
		sessionId: "A",
		cwd: root,
		complete: true,
		toolResults: [
			{
				role: "toolResult",
				toolCallId: "old-tool",
				toolName: "read",
				content: [{ type: "text", text: "OLD_RESULT" }],
				isError: false,
				timestamp: now,
			},
		],
	});
	await state.acknowledge(
		state.deliveries("chat"),
		[],
		new AbortController().signal,
	);
	const resultId = state.operation("chat", "reuse-me").resultId;
	assert.ok(resultId);
	const store = new ResponseStore(root);
	await store.read("chat", resultId);
	await store.markRead("chat", resultId);
	await state.acknowledgeResult("chat", resultId);
	await store.unpin("chat", resultId, "unread");
	now += 25 * 60 * 60 * 1000;
	await state.reserveOperation({
		key,
		operationId: "reuse-me",
		signature: "new-signature",
		chatId: "chat",
		sessionId: "A",
		cwd: root,
		status: "running",
		updatedAt: now,
	});
	assert.equal(state.operation("chat", "reuse-me").status, "running");
	assert.deepEqual(state.deliveriesForOperation("chat", key), []);
	assert.equal(state.resultForOperation("chat", "reuse-me"), undefined);
});

test("late delivery for a retired operation is rejected", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-state-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let now = 2_000_000_000_000;
	t.mock.method(Date, "now", () => now);
	const state = new State(root);
	const key = "retired-key";
	await state.reserveOperation({
		key,
		operationId: "retired",
		signature: "signature",
		chatId: "chat",
		sessionId: "A",
		cwd: root,
		status: "running",
		updatedAt: now,
	});
	await state.finishOperation(key, "completed");
	const identity = state.executionSource(key);
	now += 25 * 60 * 60 * 1000;
	assert.equal(state.findOperation("chat", "retired"), undefined);
	await assert.rejects(
		state.addDelivery({
			id: "late-old-result",
			...identity,
			chatId: "chat",
			sessionId: "A",
			cwd: root,
			complete: true,
			toolResults: [],
		}),
		/operation.*receipt|receipt.*operation/i,
	);
	assert.deepEqual(state.deliveriesForOperation("chat", key), []);
});
