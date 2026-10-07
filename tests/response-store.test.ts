import assert from "node:assert/strict";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
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

test("unread status observes current shared pins without changing stored protection", async (t) => {
	const { root, store, directory } = await fixture(t);
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const id = await store.save("owner", "original", { pin: "unread" });
	await store.pin("owner", id, "delivery:pending");
	const body = join(directory, `${id}.json`);
	const metadata = join(directory, `${id}.meta.json`);
	const beforeBody = await readFile(body, "utf8");
	const beforeMetadata = await readFile(metadata, "utf8");
	const beforeStat = await lstat(metadata, { bigint: true });
	const reopened = new ResponseStore(root);
	now += 48 * 60 * 60 * 1000;
	assert.equal(await store.isUnread("owner", id), true);
	assert.equal(await reopened.isUnread("owner", id), true);
	assert.equal(await readFile(body, "utf8"), beforeBody);
	assert.equal(await readFile(metadata, "utf8"), beforeMetadata);
	assert.equal(
		(await lstat(metadata, { bigint: true })).mtimeNs,
		beforeStat.mtimeNs,
	);

	await reopened.markRead("owner", id);
	assert.equal(await store.isUnread("owner", id), true);
	await reopened.unpin("owner", id, "unread");
	assert.equal(await store.isUnread("owner", id), false);
	assert.equal(await store.read("owner", id), "original");
	await reopened.unpin("owner", id, "delivery:pending");
	assert.equal(await store.isUnread("owner", id), false);
	assert.equal(await readFile(body, "utf8"), beforeBody);
});

test("unread status validates ownership, identifiers and immutable body integrity", async (t) => {
	const { store, directory } = await fixture(t);
	const id = await store.save("owner", "original", { pin: "unread" });
	await assert.rejects(store.isUnread("other", id), /not found/);
	for (const invalid of ["../file", "", "g".repeat(64), "a".repeat(63)])
		await assert.rejects(
			store.isUnread("owner", invalid),
			/Invalid result identifier/,
		);
	assert.equal(await store.isUnread("owner", id), true);
	await writeFile(
		join(directory, `${id}.json`),
		JSON.stringify({ chatId: "owner", text: "changed", createdAt: Date.now() }),
	);
	await assert.rejects(
		store.isUnread("owner", id),
		/Response snapshot changed/,
	);
});

test("missing, expired and legacy unread lookups never create or collect files", async (t) => {
	const { root, store, directory } = await fixture(t);
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	assert.equal(await store.isUnread("owner", "a".repeat(64)), false);
	assert.deepEqual(await readdir(root), []);
	const id = await store.save("owner", "legacy without companion metadata");
	const original = await readFile(join(directory, `${id}.json`), "utf8");
	assert.equal(await store.isUnread("owner", id), false);
	assert.deepEqual(await readdir(directory), [`${id}.json`]);
	now += 24 * 60 * 60 * 1000;
	assert.equal(await new ResponseStore(root).isUnread("owner", id), false);
	assert.equal(await store.isUnread("owner", "b".repeat(64)), false);
	assert.deepEqual(await readdir(directory), [`${id}.json`]);
	assert.equal(await readFile(join(directory, `${id}.json`), "utf8"), original);
});

test("full page confirmation can preserve unread protection for a later durable receipt commit", async (t) => {
	const { store, directory } = await fixture(t);
	const text = "complete body";
	const id = await store.save("owner", text, { pin: "unread" });
	assert.equal(
		await store.recordRead("owner", id, 0, text.length, text.length, {
			preserveUnreadPin: true,
		}),
		true,
	);
	const path = join(directory, `${id}.meta.json`);
	const confirmed = JSON.parse(await readFile(path, "utf8"));
	assert.equal(typeof confirmed.readAt, "number");
	assert.equal(confirmed.readThrough, text.length);
	assert.equal(await store.isUnread("owner", id), true);
	assert.equal(
		await store.recordRead("owner", id, 0, text.length, text.length),
		true,
	);
	assert.equal(await store.isUnread("owner", id), false);
	assert.equal(
		JSON.parse(await readFile(path, "utf8")).readAt,
		confirmed.readAt,
	);
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

test("capacity pressure reclaims the oldest confirmed result, without changing newer results", async (t) => {
	const { root, store, directory } = await fixture(t, {
		maxSnapshots: 4,
		maxConversationSnapshots: 2,
	});
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const first = await store.save("a", "first");
	now++;
	const second = await store.save("a", "second");
	const original = await readFile(join(directory, `${second}.json`), "utf8");
	await store.markRead("a", first);
	await store.markRead("a", second);
	const other = await store.save("b", "independent");
	assert.equal(await store.read("a", first), "first");
	const third = await new ResponseStore(root, {
		maxSnapshots: 4,
		maxConversationSnapshots: 2,
	}).save("a", "third");
	await assert.rejects(store.read("a", first), /not found|expired/);
	assert.equal(await store.read("a", second), "second");
	assert.equal(await store.read("a", third), "third");
	assert.equal(await store.read("b", other), "independent");
	assert.equal(
		await readFile(join(directory, `${second}.json`), "utf8"),
		original,
	);
});

test("broker pressure can reclaim another owner's oldest confirmed result", async (t) => {
	const { store } = await fixture(t, {
		maxSnapshots: 3,
		maxConversationSnapshots: 2,
	});
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const first = await store.save("a", "oldest");
	now++;
	const second = await store.save("b", "newer");
	const unread = await store.save("b", "unread");
	await store.markRead("a", first);
	await store.markRead("b", second);
	const admitted = await store.save("c", "new owner");
	await assert.rejects(store.read("a", first), /not found|expired/);
	assert.equal(await store.read("b", second), "newer");
	assert.equal(await store.read("b", unread), "unread");
	assert.equal(await store.read("c", admitted), "new owner");
});

test("an insufficient reclamation plan leaves every existing result intact", async (t) => {
	const { store, directory } = await fixture(t, {
		maxBytes: 1024,
		maxConversationBytes: 300,
		maxSnapshotBytes: 512,
		maxSnapshots: 4,
		maxConversationSnapshots: 2,
	});
	const confirmed = await store.save("a", "confirmed");
	const unread = await store.save("a", "unread");
	await store.markRead("a", confirmed);
	const before = (await readdir(directory)).sort();
	await assert.rejects(
		store.save("a", "x".repeat(350)),
		/conversation.*capacity/i,
	);
	assert.equal(await store.read("a", confirmed), "confirmed");
	assert.equal(await store.read("a", unread), "unread");
	assert.deepEqual((await readdir(directory)).sort(), before);
});

test("a late first read stays protected until every pending pin is released", async (t) => {
	const limits = { maxSnapshots: 1, maxConversationSnapshots: 1 };
	const { root, store, directory } = await fixture(t, limits);
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const id = await store.save("owner", "late result", { pin: "unread" });
	const body = join(directory, `${id}.json`);
	const contents = await readFile(body, "utf8");
	const before = await lstat(body, { bigint: true });
	await store.pin("owner", id, "delivery:one");
	now += 24 * 60 * 60 * 1000;
	const reopened = new ResponseStore(root, limits);
	assert.equal(await reopened.read("owner", id), "late result");
	await assert.rejects(
		reopened.save("other", "new result"),
		/broker.*capacity/i,
	);
	await reopened.markRead("owner", id);
	await reopened.unpin("owner", id, "unread");
	assert.equal(await store.read("owner", id), "late result");
	await assert.rejects(
		store.save("owner", "next result"),
		/conversation.*capacity/i,
	);
	await reopened.unpin("owner", id, "delivery:one");
	await assert.rejects(store.read("owner", id), /expired/);
	const after = await lstat(body, { bigint: true });
	assert.equal(after.ino, before.ino);
	assert.equal(after.mtimeNs, before.mtimeNs);
	assert.equal(await readFile(body, "utf8"), contents);
	const next = await store.save("other", "new result");
	assert.equal(await store.read("other", next), "new result");
	assert.ok(!(await readdir(directory)).some((name) => name.startsWith(id)));
});

test("confirmation alone does not release a pending snapshot for capacity reclamation", async (t) => {
	const { store } = await fixture(t, {
		maxSnapshots: 1,
		maxConversationSnapshots: 1,
	});
	const id = await store.save("owner", "pending", { pin: "unread" });
	await store.markRead("owner", id);
	await assert.rejects(store.save("owner", "next"), /conversation.*capacity/i);
	await store.unpin("owner", id, "unread");
	const next = await store.save("owner", "next");
	await assert.rejects(store.read("owner", id), /not found|expired/);
	assert.equal(await store.read("owner", next), "next");
});

test("concurrent stores preserve all independent pins and first delivery confirmation", async (t) => {
	const limits = { maxSnapshots: 1, maxConversationSnapshots: 1 };
	const { root, store } = await fixture(t, limits);
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const id = await store.save("owner", "shared", { pin: "unread" });
	const second = new ResponseStore(root, limits);
	await second.save("owner", "shared");
	await Promise.all([
		store.pin("owner", id, "delivery:one"),
		second.pin("owner", id, "delivery:two"),
		store.markRead("owner", id),
		second.unpin("owner", id, "unread"),
	]);
	now += 24 * 60 * 60 * 1000;
	const reopened = new ResponseStore(root, limits);
	await reopened.unpin("owner", id, "delivery:one");
	assert.equal(await reopened.read("owner", id), "shared");
	await assert.rejects(reopened.save("other", "blocked"), /broker.*capacity/i);
	await reopened.unpin("owner", id, "delivery:two");
	await assert.rejects(reopened.read("owner", id), /expired/);
});

test("pin and confirmation mutations preserve ownership and content validation", async (t) => {
	const { store, directory } = await fixture(t);
	const id = await store.save("owner", "original", { pin: "unread" });
	await assert.rejects(store.pin("other", id, "delivery"), /not found/);
	await assert.rejects(store.unpin("other", id, "unread"), /not found/);
	await assert.rejects(store.markRead("other", id), /not found/);
	await assert.rejects(
		store.pin("owner", "../file", "delivery"),
		/Invalid result identifier/,
	);
	await assert.rejects(store.pin("owner", id, ""), /Invalid.*pin/i);
	await writeFile(
		join(directory, `${id}.json`),
		JSON.stringify({ chatId: "owner", text: "changed", createdAt: Date.now() }),
	);
	await assert.rejects(
		store.markRead("owner", id),
		/Response snapshot changed/,
	);
	await assert.rejects(
		store.unpin("owner", id, "unread"),
		/Response snapshot changed/,
	);
});

test("an expired unpinned result cannot be revived by adding a pin", async (t) => {
	const { store } = await fixture(t);
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const id = await store.save("owner", "expired");
	now += 24 * 60 * 60 * 1000;
	await assert.rejects(store.pin("owner", id, "unread"), /expired/);
	await assert.rejects(store.read("owner", id), /expired/);
});

test("invalid companion metadata cannot confirm or evict an immutable result", async (t) => {
	const { store, directory } = await fixture(t, {
		maxSnapshots: 1,
		maxConversationSnapshots: 1,
	});
	const id = await store.save("owner", "original");
	const metadata = join(directory, `${id}.meta.json`);
	await mkdir(metadata);
	await assert.rejects(store.markRead("owner", id), /metadata|directory/i);
	await rm(metadata, { recursive: true });
	assert.equal(await store.read("owner", id), "original");
	await assert.rejects(store.save("owner", "next"), /conversation.*capacity/i);
});

test("a failed new metadata commit does not evict already confirmed cache candidates", async (t) => {
	const { store, directory } = await fixture(t, {
		maxSnapshots: 1,
		maxConversationSnapshots: 1,
	});
	const { store: identityStore } = await fixture(t);
	const nextId = await identityStore.save("owner", "replacement");
	const current = await store.save("owner", "confirmed");
	await store.markRead("owner", current);
	await mkdir(join(directory, `${nextId}.meta.json`));
	const before = (await readdir(directory)).sort();
	await assert.rejects(store.save("owner", "replacement", { pin: "unread" }));
	assert.equal(await store.read("owner", current), "confirmed");
	await assert.rejects(store.read("owner", nextId), /not found/);
	assert.deepEqual((await readdir(directory)).sort(), before);
});

test("reclamation requires enough confirmed bytes for both owner and broker quotas", async (t) => {
	const { store, directory } = await fixture(t, {
		maxBytes: 600,
		maxConversationBytes: 350,
		maxSnapshotBytes: 512,
	});
	const confirmed = await store.save("a", "ok");
	const unread = await store.save("b", "x".repeat(280));
	await store.markRead("a", confirmed);
	const before = (await readdir(directory)).sort();
	await assert.rejects(store.save("a", "y".repeat(280)), /broker.*capacity/i);
	assert.equal(await store.read("a", confirmed), "ok");
	assert.equal(await store.read("b", unread), "x".repeat(280));
	assert.deepEqual((await readdir(directory)).sort(), before);
});

test("only a contiguous confirmed page prefix releases unread protection", async (t) => {
	const limits = { maxSnapshots: 1, maxConversationSnapshots: 1 };
	const { root, store } = await fixture(t, limits);
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const id = await store.save("owner", "a🙂한z", { pin: "unread" });
	await store.pin("owner", id, "delivery:pending");
	assert.equal(await store.recordRead("owner", id, 3, 5, 5), false);
	assert.equal(await store.recordRead("owner", id, 0, 2, 5), false);
	const reopened = new ResponseStore(root, limits);
	now += 24 * 60 * 60 * 1000;
	assert.equal(await reopened.recordRead("owner", id, 3, 5, 5), false);
	await assert.rejects(reopened.save("other", "blocked"), /broker.*capacity/i);
	assert.equal(await reopened.recordRead("owner", id, 1, 3, 5), false);
	assert.equal(await reopened.recordRead("owner", id, 3, 5, 5), true);
	assert.equal(await store.read("owner", id), "a🙂한z");
	await assert.rejects(
		store.save("other", "still pending"),
		/broker.*capacity/i,
	);
	await store.unpin("owner", id, "delivery:pending");
	await assert.rejects(store.read("owner", id), /expired/);
	const next = await store.save("other", "next");
	assert.equal(await store.read("other", next), "next");
});

test("page confirmation validates body length, ownership and string offsets", async (t) => {
	const { store } = await fixture(t, {
		maxSnapshots: 1,
		maxConversationSnapshots: 1,
	});
	const id = await store.save("owner", "한🙂", { pin: "unread" });
	await assert.rejects(store.recordRead("other", id, 0, 3, 3), /not found/);
	await assert.rejects(store.recordRead("owner", id, 0, 2, 2), /length.*body/);
	await assert.rejects(store.recordRead("owner", id, 0, 7, 7), /length.*body/);
	for (const [offset, next, total] of [
		[-1, 1, 3],
		[0, 0.5, 3],
		[2, 1, 3],
		[0, 4, 3],
		[0, 1, Number.NaN],
	] as const) {
		await assert.rejects(
			store.recordRead("owner", id, offset, next, total),
			/read range/,
		);
	}
	await assert.rejects(
		store.save("owner", "blocked"),
		/conversation.*capacity/i,
	);
	assert.equal(await store.recordRead("owner", id, 0, 3, 3), true);
	const next = await store.save("owner", "next");
	assert.equal(await store.read("owner", next), "next");
});

test("repeated full-page confirmation never renews retention or rewrites the body", async (t) => {
	const { store, directory } = await fixture(t);
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const id = await store.save("owner", "abc", { pin: "unread" });
	const body = await readFile(join(directory, `${id}.json`), "utf8");
	assert.equal(await store.recordRead("owner", id, 0, 3, 3), true);
	const metadataFile = join(directory, `${id}.meta.json`);
	const metadata = await readFile(metadataFile, "utf8");
	now += 1000;
	assert.equal(await store.recordRead("owner", id, 0, 3, 3), true);
	assert.equal(await readFile(metadataFile, "utf8"), metadata);
	assert.equal(await readFile(join(directory, `${id}.json`), "utf8"), body);
	now += 24 * 60 * 60 * 1000 - 1000;
	await assert.rejects(store.read("owner", id), /expired/);
});

test("empty bodies can complete their zero-length page without remaining pinned", async (t) => {
	const { store } = await fixture(t, {
		maxSnapshots: 1,
		maxConversationSnapshots: 1,
	});
	const id = await store.save("owner", "", { pin: "unread" });
	assert.equal(await store.recordRead("owner", id, 0, 0, 0), true);
	const next = await store.save("owner", "next");
	assert.equal(await store.read("owner", next), "next");
});

test("a stale store index cannot expire a newly recreated snapshot with the same ID", async (t) => {
	const { root, store } = await fixture(t);
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const id = await store.save("owner", "same body");
	now += 24 * 60 * 60 * 1000;
	const reopened = new ResponseStore(root);
	assert.equal(await reopened.save("owner", "same body"), id);
	await store.save("owner", "other body");
	assert.equal(await store.read("owner", id), "same body");
});

test("startup reconciliation drops only stale delivery pins and preserves unread results", async (t) => {
	const { root, store } = await fixture(t);
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const retained = await store.save("owner", "retained", { pin: "unread" });
	await store.pin("owner", retained, "delivery:live");
	await store.pin("owner", retained, "delivery:stale");
	const orphan = await store.save("owner", "orphan", {
		pin: "delivery:orphan",
	});
	const unread = await store.save("other", "unread", { pin: "unread" });
	now += 24 * 60 * 60 * 1000;
	const reopened = new ResponseStore(root);
	await reopened.reconcileDeliveryPins([
		{ chatId: "owner", resultId: retained, pin: "delivery:live" },
	]);
	assert.equal(await reopened.read("owner", retained), "retained");
	assert.equal(await reopened.read("other", unread), "unread");
	await assert.rejects(reopened.read("owner", orphan), /expired/);
	await reopened.unpin("owner", retained, "unread");
	assert.equal(await reopened.read("owner", retained), "retained");
	await reopened.unpin("owner", retained, "delivery:live");
	await assert.rejects(reopened.read("owner", retained), /expired/);
});

test("authoritative pending state restores its missing delivery pin before expiry cleanup", async (t) => {
	const { store } = await fixture(t);
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const id = await store.save("owner", "pending");
	now += 24 * 60 * 60 * 1000;
	await store.reconcileDeliveryPins([
		{ chatId: "owner", resultId: id, pin: "delivery:restored" },
	]);
	assert.equal(await store.read("owner", id), "pending");
});

test("invalid pending ownership cannot discard other stale delivery pins", async (t) => {
	const { store } = await fixture(t);
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	const id = await store.save("owner", "protected", { pin: "delivery:stale" });
	await assert.rejects(
		store.reconcileDeliveryPins([
			{ chatId: "other", resultId: id, pin: "delivery:live" },
		]),
		/not found/,
	);
	await assert.rejects(
		store.reconcileDeliveryPins([
			{ chatId: "owner", resultId: id, pin: "unread" },
		]),
		/delivery pin/,
	);
	now += 24 * 60 * 60 * 1000;
	assert.equal(await store.read("owner", id), "protected");
});
