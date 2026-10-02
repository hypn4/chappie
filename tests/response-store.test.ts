import assert from "node:assert/strict";
import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { ResponseStore } from "../src/responses.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "ch-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return {
		root,
		store: new ResponseStore(root),
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

test("capacity fails closed without evicting an unexpired response", async (t) => {
	const { store, directory } = await fixture(t);
	const first = await store.save("owner", "first");
	for (let i = 1; i < 128; i++) await store.save("owner", String(i));
	await assert.rejects(store.save("owner", "overflow"), /storage limit/);
	assert.equal((await readdir(directory)).length, 128);
	assert.equal(await store.read("owner", first), "first");
});
