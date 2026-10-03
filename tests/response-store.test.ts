import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { ResponseStore } from "../src/responses.ts";

async function fixture(
	t: TestContext,
	limits?: ConstructorParameters<typeof ResponseStore>[1],
) {
	const root = await mkdtemp(join(tmpdir(), "ch-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return {
		root,
		store: new ResponseStore(root, limits),
		directory: join(root, "chappie.results"),
	};
}

test("snapshot identity and contents survive reopening the store", async (t) => {
	const { root, store, directory } = await fixture(t);
	const id = await store.save("owner", "original");
	assert.equal(await store.save("owner", "original"), id);
	assert.equal(await new ResponseStore(root).read("owner", id), "original");
	if (process.platform !== "win32")
		assert.equal(
			(await lstat(join(directory, `${id}.json`))).mode & 0o777,
			0o600,
		);
});

test("snapshot IDs cannot grant another conversation access or escape the store", async (t) => {
	const { store } = await fixture(t);
	const id = await store.save("owner", "original");
	await assert.rejects(store.read("other", id), /not found/);
	for (const invalid of ["../file", "", "g".repeat(64), "a".repeat(63)]) {
		await assert.rejects(
			store.read("owner", invalid),
			/Invalid result identifier/,
		);
	}
	const otherId = await store.save("other", "original");
	assert.notEqual(otherId, id);
	assert.equal(await store.read("other", otherId), "original");
});

test("changed snapshot contents fail the integrity check", async (t) => {
	const { store, directory } = await fixture(t);
	const id = await store.save("owner", "original");
	await writeFile(
		join(directory, `${id}.json`),
		JSON.stringify({ chatId: "owner", text: "changed", createdAt: Date.now() }),
	);
	await assert.rejects(store.read("owner", id), /Response snapshot changed/);
});

test("concurrent identical snapshots create one immutable file", async (t) => {
	const { store, directory } = await fixture(t);
	const ids = await Promise.all(
		Array.from({ length: 8 }, () => store.save("owner", "same")),
	);
	assert.equal(new Set(ids).size, 1);
	const id = ids[0];
	assert.ok(id);
	assert.deepEqual(await readdir(directory), [`${id}.json`]);
	assert.equal(await store.read("owner", id), "same");
});

test("snapshots expire at the 24-hour boundary without a restart", async (t) => {
	const { store, directory } = await fixture(t);
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const id = await store.save("owner", "original");
	now += 24 * 60 * 60 * 1000 - 1;
	assert.equal(await store.read("owner", id), "original");
	now++;
	await assert.rejects(store.read("owner", id), /expired/);
	now += 1000;
	const nextId = await store.save("owner", "different");
	assert.deepEqual(await readdir(directory), [`${nextId}.json`]);
});

test("one heavy conversation cannot consume every broker snapshot slot", async (t) => {
	const { store, directory } = await fixture(t, {
		maxSnapshots: 4,
		maxConversationSnapshots: 2,
	});
	const first = await store.save("heavy", "first");
	await store.save("heavy", "second");
	await assert.rejects(
		store.save("heavy", "overflow"),
		/conversation.*capacity/i,
	);
	const other = await store.save("other", "independent response");
	assert.equal(await store.read("heavy", first), "first");
	assert.equal(await store.read("other", other), "independent response");
	assert.equal((await readdir(directory)).length, 3);
});

test("a long workflow can recover more than 128 distinct snapshots", async (t) => {
	const { store } = await fixture(t);
	const ids = [];
	for (let i = 0; i < 160; i++)
		ids.push(await store.save("owner", `response ${i}`));
	const first = ids[0];
	const last = ids[159];
	assert.ok(first && last);
	assert.equal(await store.read("owner", first), "response 0");
	assert.equal(await store.read("owner", last), "response 159");
});

test("broker capacity never evicts unexpired results, even after reading them", async (t) => {
	const { store, directory } = await fixture(t, {
		maxSnapshots: 4,
		maxConversationSnapshots: 2,
	});
	const first = await store.save("a", "first");
	await store.save("a", "second");
	await store.save("b", "third");
	await store.save("b", "fourth");
	assert.equal(await store.read("a", first), "first");
	await assert.rejects(store.save("c", "overflow"), /broker.*capacity/i);
	assert.equal((await readdir(directory)).length, 4);
	assert.equal(await store.save("a", "first"), first);
});

test("conversation UTF-8 byte budgets leave space for another owner after reopening", async (t) => {
	const limits = {
		maxBytes: 1024,
		maxConversationBytes: 512,
		maxSnapshotBytes: 512,
	};
	const { root, store } = await fixture(t, limits);
	const body = "한".repeat(90);
	const first = await store.save("a", body);
	const reopened = new ResponseStore(root, limits);
	await assert.rejects(
		reopened.save("a", `${body}!`),
		/conversation.*capacity/i,
	);
	const other = await reopened.save("b", body);
	assert.equal(await reopened.read("a", first), body);
	assert.equal(await reopened.read("b", other), body);
});

test("separate store instances share quota admission without losing snapshots", async (t) => {
	const limits = { maxSnapshots: 4, maxConversationSnapshots: 2 };
	const { root, store, directory } = await fixture(t, limits);
	const second = new ResponseStore(root, limits);
	const attempts = await Promise.allSettled([
		store.save("owner", "first"),
		second.save("owner", "second"),
		store.save("owner", "third"),
		second.save("other", "independent"),
	]);
	assert.equal(
		attempts.filter((attempt) => attempt.status === "fulfilled").length,
		3,
	);
	assert.equal(attempts[2]?.status, "rejected");
	assert.equal((await readdir(directory)).length, 3);
});

test("an expired owner releases its quota without extending other snapshots", async (t) => {
	const { store } = await fixture(t, {
		maxSnapshots: 4,
		maxConversationSnapshots: 2,
	});
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const first = await store.save("a", "first");
	await store.save("a", "second");
	now += 60 * 60 * 1000;
	const other = await store.save("b", "newer");
	assert.equal(await store.save("a", "first"), first);
	now += 23 * 60 * 60 * 1000;
	await store.save("a", "after expiry");
	await assert.rejects(store.read("a", first), /not found|expired/);
	assert.equal(await store.read("b", other), "newer");
});
