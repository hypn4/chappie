import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { State } from "../src/state.ts";

test("obsolete string bindings are rejected without rewriting saved state", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-state-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "chappie.state.json");
	const source = JSON.stringify({ bindings: { chat: "A" } });
	await writeFile(path, source);
	await assert.rejects(new State(root).load());
	assert.equal(await readFile(path, "utf8"), source);
});

test("RC.11 event state is discarded without losing durable operations", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-state-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "chappie.state.json");
	const now = Date.now();
	await writeFile(
		path,
		JSON.stringify({
			operations: [
				{
					key: "existing-key",
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
	await state.load();
	assert.equal(state.operation("chat", "existing").status, "completed");
	await state.reserveOperation({
		key: "new-key",
		signature: "new-sig",
		chatId: "chat",
		sessionId: "A",
		cwd: root,
		status: "running",
		updatedAt: now,
	});
	const saved = JSON.parse(await readFile(path, "utf8"));
	assert.equal(saved.eventSubscriptions, undefined);
	assert.equal(saved.eventOutbox, undefined);
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
			operations: Array.from({ length: 16_384 }, (_, index) => ({
				key: `old-${index}`,
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
