import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { OperationArchive } from "../src/operation-archive.ts";
import type { OperationReceipt } from "../src/operations.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "ch-terminal-archive-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let now = 2_000_000_000_000;
	t.mock.method(Date, "now", () => now);
	const receipt: OperationReceipt = {
		key: "original-key",
		operationId: "original-operation",
		executionId: randomUUID(),
		signature: "original-signature",
		chatId: "owner",
		sessionId: "session",
		cwd: root,
		status: "completed",
		updatedAt: now,
		resultId: "a".repeat(64),
	};
	return {
		root,
		directory: join(root, "chappie.uncertain"),
		archive: new OperationArchive(root),
		receipt,
		advance(milliseconds: number) {
			now += milliseconds;
		},
		get now() {
			return now;
		},
	};
}

for (const status of ["completed", "failed", "cancelled"] as const) {
	test(`cold ${status} receipts expire before a fresh acceptance reuses their identity`, async (t) => {
		const f = await fixture(t);
		const original = { ...f.receipt, status };
		await f.archive.save(original);
		f.advance(24 * 60 * 60 * 1000);
		assert.equal(
			f.archive.find("owner", "original-operation")?.executionId,
			original.executionId,
			"The exact boundary matches hot-state terminal retention",
		);
		f.advance(1);
		assert.equal(f.archive.get(original.key), undefined);
		assert.equal(f.archive.find("owner", "original-operation"), undefined);
		assert.equal(new OperationArchive(f.root).get(original.key), undefined);

		const successor: OperationReceipt = {
			...original,
			executionId: randomUUID(),
			signature: "new-arguments",
			status: "uncertain",
			updatedAt: f.now,
		};
		await f.archive.save(successor);
		assert.equal(
			new OperationArchive(f.root).find("owner", "original-operation")
				?.executionId,
			successor.executionId,
		);
		assert.equal((await readdir(f.directory)).length, 2);
		await assert.rejects(f.archive.remove(original), /acceptance changed/);
		assert.equal(
			f.archive.get(original.key)?.executionId,
			successor.executionId,
		);
	});
}

test("terminal reclamation removes expired files and aliases but never unresolved receipts", async (t) => {
	const f = await fixture(t);
	await f.archive.save(f.receipt);
	for (const status of ["running", "waiting_input", "uncertain"] as const)
		await f.archive.save({
			...f.receipt,
			key: status,
			operationId: status,
			status,
		});
	f.advance(25 * 60 * 60 * 1000);
	await f.archive.save({
		...f.receipt,
		key: "new-owner-key",
		chatId: "other",
		updatedAt: f.now,
	});
	assert.equal(f.archive.find("owner", "original-operation"), undefined);
	assert.equal(
		f.archive.find("other", "original-operation")?.key,
		"new-owner-key",
	);
	for (const status of ["running", "waiting_input", "uncertain"] as const)
		assert.equal(f.archive.find("owner", status)?.status, status);
	assert.equal((await readdir(f.directory)).length, 8);
	f.advance(100 * 24 * 60 * 60 * 1000);
	const reopened = new OperationArchive(f.root);
	await reopened.save({
		...f.receipt,
		key: "another-key",
		operationId: "another-operation",
		updatedAt: f.now,
	});
	for (const status of ["running", "waiting_input", "uncertain"] as const)
		assert.equal(reopened.find("owner", status)?.status, status);
	assert.equal((await readdir(f.directory)).length, 8);
});

test("live cold aliases cannot be rebound to another acceptance", async (t) => {
	const f = await fixture(t);
	await f.archive.save(f.receipt);
	await assert.rejects(
		f.archive.save({
			...f.receipt,
			key: "different-key",
			executionId: randomUUID(),
			sessionId: "other-session",
		}),
		/alias|identifier|another acceptance/,
	);
	await assert.rejects(
		f.archive.save({ ...f.receipt, chatId: "other" }),
		/acceptance cannot be replaced/,
	);
	assert.equal(
		f.archive.find("owner", "original-operation")?.key,
		f.receipt.key,
	);
	assert.equal(f.archive.find("other", "original-operation"), undefined);
	assert.equal((await readdir(f.directory)).length, 2);
});

test("an expired terminal alias can name a new key without changing another owner's alias", async (t) => {
	const f = await fixture(t);
	await f.archive.save(f.receipt);
	f.advance(60 * 60 * 1000);
	await f.archive.save({
		...f.receipt,
		key: "other-owner",
		chatId: "other",
		updatedAt: f.now,
	});
	f.advance(23 * 60 * 60 * 1000 + 1);
	await f.archive.save({
		...f.receipt,
		key: "successor-key",
		executionId: randomUUID(),
		updatedAt: f.now,
	});
	assert.equal(
		f.archive.find("owner", "original-operation")?.key,
		"successor-key",
	);
	assert.equal(
		f.archive.find("other", "original-operation")?.key,
		"other-owner",
	);
	assert.equal((await readdir(f.directory)).length, 4);
});

test("an internal key is not a public alias while another owner's explicit alias stays isolated", async (t) => {
	const f = await fixture(t);
	await f.archive.save(f.receipt);
	await f.archive.save({
		...f.receipt,
		key: "other-key",
		operationId: f.receipt.key,
		chatId: "other",
	});
	assert.equal(f.archive.find("other", f.receipt.key)?.key, "other-key");
	assert.equal(f.archive.find("owner", f.receipt.key), undefined);
	assert.equal(
		f.archive.find("owner", "original-operation")?.key,
		f.receipt.key,
	);
	assert.equal(f.archive.find("owner", "other-key"), undefined);
});

test("separate archive instances serialize claims on one public alias", async (t) => {
	const f = await fixture(t);
	const other = new OperationArchive(f.root);
	const results = await Promise.allSettled([
		f.archive.save(f.receipt),
		other.save({
			...f.receipt,
			key: "competing-key",
			executionId: randomUUID(),
		}),
	]);
	assert.equal(
		results.filter((result) => result.status === "fulfilled").length,
		1,
	);
	assert.equal(
		results.filter((result) => result.status === "rejected").length,
		1,
	);
	assert.equal(
		f.archive.find("owner", "original-operation")?.key,
		f.receipt.key,
	);
	assert.equal((await readdir(f.directory)).length, 2);
});

test("reclaiming an expired key leaves an alias that already points to its successor", async (t) => {
	const f = await fixture(t);
	await f.archive.save(f.receipt);
	f.advance(25 * 60 * 60 * 1000);
	const successor: OperationReceipt = {
		...f.receipt,
		key: "successor-key",
		executionId: randomUUID(),
		updatedAt: f.now,
	};
	const digest = (value: string) =>
		createHash("sha256").update(value).digest("hex");
	// Model an old persisted record whose alias has already been safely replaced.
	await writeFile(
		join(f.directory, `key-${digest(successor.key)}.json`),
		JSON.stringify(successor),
	);
	await writeFile(
		join(
			f.directory,
			`alias-${digest(JSON.stringify(["owner", "original-operation"]))}.json`,
		),
		JSON.stringify({ key: successor.key }),
	);
	await f.archive.save({
		...f.receipt,
		key: "trigger-key",
		operationId: "trigger-operation",
		updatedAt: f.now,
	});
	assert.equal(f.archive.get(f.receipt.key), undefined);
	assert.equal(
		f.archive.find("owner", "original-operation")?.key,
		successor.key,
	);
	assert.equal((await readdir(f.directory)).length, 4);
});
