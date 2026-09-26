import assert from "node:assert/strict";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	truncate,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { withFileMutationQueue } from "../src/file-mutation-queue.ts";
import {
	describeResource,
	readSessionResource,
	registerFile,
} from "../src/resources.ts";
import { copyFiles, executeTransfer } from "../src/transfer.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const root = await mkdtemp(join(tmpdir(), "chappie-transfer-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

const incoming = [
	{ file_id: "test-file", download_url: "https://example.invalid/file" },
];

test("failed download preserves an existing destination and cleans staging", async (t) => {
	const cwd = await fixture(t);
	await writeFile(join(cwd, "existing"), "ORIGINAL");
	t.mock.method(
		globalThis,
		"fetch",
		async () => new Response("unavailable", { status: 503 }),
	);
	const failure = await executeTransfer(
		{ paths: ["existing"], files: incoming, overwrite: true },
		undefined,
		undefined,
		{ sessionId: cwd, cwd },
	);
	assert.equal(failure.isError, true);
	assert.match(JSON.stringify(failure.details.files), /503/);
	assert.equal(await readFile(join(cwd, "existing"), "utf8"), "ORIGINAL");
	assert.deepEqual(await readdir(cwd), ["existing"]);
});

test("cancelled download preserves an existing destination", async (t) => {
	const cwd = await fixture(t);
	await writeFile(join(cwd, "existing"), "ORIGINAL");
	const controller = new AbortController();
	t.mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(stream) {
						stream.enqueue(new TextEncoder().encode("partial"));
						controller.signal.addEventListener(
							"abort",
							() => stream.error(new Error("cancelled")),
							{ once: true },
						);
					},
				}),
			),
	);
	const running = executeTransfer(
		{ paths: ["existing"], files: incoming, overwrite: true },
		controller.signal,
		undefined,
		{ sessionId: cwd, cwd },
	);
	const failure = running.then((result) => {
		assert.equal(result.isError, true);
		assert.match(JSON.stringify(result.details.files), /abort|cancel/i);
	});
	await delay(20);
	controller.abort();
	await failure;
	assert.equal(await readFile(join(cwd, "existing"), "utf8"), "ORIGINAL");
	assert.deepEqual(await readdir(cwd), ["existing"]);
});

test("successful staged import replaces only the requested destination", async (t) => {
	const cwd = await fixture(t);
	await writeFile(join(cwd, "existing"), "OLD");
	t.mock.method(globalThis, "fetch", async () => new Response("NEW"));
	await executeTransfer(
		{ paths: ["existing"], files: incoming, overwrite: true },
		undefined,
		undefined,
		{ sessionId: cwd, cwd },
	);
	assert.equal(await readFile(join(cwd, "existing"), "utf8"), "NEW");
	assert.deepEqual(await readdir(cwd), ["existing"]);
});

test("short session copy fails without replacing its destination", async (t) => {
	const cwd = await fixture(t);
	await writeFile(join(cwd, "source"), "123456");
	await writeFile(join(cwd, "destination"), "ORIGINAL");
	const resource = await registerFile(cwd, join(cwd, "source"));
	const result = await copyFiles(
		["destination"],
		[resource],
		cwd,
		true,
		async function* () {
			yield Buffer.from("123");
		},
		new AbortController().signal,
	);
	assert.ok(
		result[0] && "error" in result[0],
		"short stream must not be reported as a successful copy",
	);
	assert.equal(await readFile(join(cwd, "destination"), "utf8"), "ORIGINAL");
});

test("no-overwrite import refuses an existing destination", async (t) => {
	const cwd = await fixture(t);
	await writeFile(join(cwd, "existing"), "ORIGINAL");
	t.mock.method(globalThis, "fetch", async () => new Response("NEW"));
	const failure = await executeTransfer(
		{ paths: ["existing"], files: incoming },
		undefined,
		undefined,
		{ sessionId: cwd, cwd },
	);
	assert.equal(failure.isError, true);
	assert.match(JSON.stringify(failure.details.files), /exist/i);
	assert.equal(await readFile(join(cwd, "existing"), "utf8"), "ORIGINAL");
});

test("decorated resource URI is reusable but keeps session ownership", async (t) => {
	const cwd = await fixture(t);
	await writeFile(join(cwd, "source"), "contents");
	const descriptor = await registerFile(cwd, join(cwd, "source"));
	const decorated = `${descriptor.uri}?chatId=sample#view`;
	assert.equal(describeResource(cwd, decorated).uri, descriptor.uri);
	assert.equal(
		Buffer.from(
			(await readSessionResource(cwd, decorated)).blob,
			"base64",
		).toString(),
		"contents",
	);
	assert.throws(
		() => describeResource("different-session", decorated),
		/another/,
	);
});

test("changed export fails for both full and chunk reads", async (t) => {
	const cwd = await fixture(t);
	await writeFile(join(cwd, "source"), "abc");
	const descriptor = await registerFile(cwd, join(cwd, "source"));
	await writeFile(join(cwd, "replacement"), "abcdef");
	await rename(join(cwd, "replacement"), join(cwd, "source"));
	await assert.rejects(readSessionResource(cwd, descriptor.uri), /changed/i);
	await assert.rejects(readSessionResource(cwd, descriptor.uri, 0), /changed/i);
});

test("new destinations through a directory alias share a mutation queue", async (t) => {
	const cwd = await fixture(t);
	await mkdir(join(cwd, "real"));
	await symlink(
		join(cwd, "real"),
		join(cwd, "alias"),
		process.platform === "win32" ? "junction" : "dir",
	);
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	let secondEntered = false;
	const first = withFileMutationQueue(join(cwd, "real/new/file"), async () => {
		entered.resolve();
		await gate.promise;
	});
	await entered.promise;
	const second = withFileMutationQueue(
		join(cwd, "alias/new/file"),
		async () => {
			secondEntered = true;
		},
	);
	try {
		await delay(20);
		assert.equal(secondEntered, false);
	} finally {
		gate.resolve();
		await Promise.all([first, second]);
	}
});

test("full resource reads are bounded while chunk copies remain available", async (t) => {
	const cwd = await fixture(t);
	const path = join(cwd, "large");
	await writeFile(path, "");
	await truncate(path, 33 * 1024 * 1024);
	const descriptor = await registerFile(cwd, path);
	await assert.rejects(
		readSessionResource(cwd, descriptor.uri),
		/too large|limit/i,
	);
	assert.equal(
		Buffer.from(
			(await readSessionResource(cwd, descriptor.uri, 0)).blob,
			"base64",
		).length,
		1024 * 1024,
	);
});

test("resource registrations have a finite retention budget", async (t) => {
	const cwd = await fixture(t);
	await writeFile(join(cwd, "source"), "data");
	const first = await registerFile(cwd, join(cwd, "source"));
	let latest = first;
	for (let index = 0; index < 512; index++)
		latest = await registerFile(cwd, join(cwd, "source"));
	assert.throws(
		() => describeResource(cwd, first.uri),
		/Unknown|expired|evicted/,
	);
	assert.equal(describeResource(cwd, latest.uri).uri, latest.uri);
});

test("expired resources no longer remain addressable", async (t) => {
	const cwd = await fixture(t);
	await writeFile(join(cwd, "source"), "data");
	const first = await registerFile(cwd, join(cwd, "source"));
	const later = Date.now() + 61 * 60 * 1000;
	t.mock.method(Date, "now", () => later);
	assert.throws(() => describeResource(cwd, first.uri), /Unknown|expired/);
});

test("partial imports preserve successful files in a structured error result", async (t) => {
	const cwd = await fixture(t);
	t.mock.method(globalThis, "fetch", async (url: URL) =>
		url.pathname === "/good"
			? new Response("NEW")
			: new Response("missing", { status: 404 }),
	);
	const result = await executeTransfer(
		{
			paths: ["good", "bad"],
			files: [
				{ file_id: "good", download_url: "https://example.invalid/good" },
				{ file_id: "bad", download_url: "https://example.invalid/bad" },
			],
		},
		undefined,
		undefined,
		{ sessionId: cwd, cwd },
	);
	assert.equal(result.isError, true);
	assert.equal(result.details.files.length, 2);
	assert.deepEqual(result.details.files[0], {
		path: join(cwd, "good"),
		bytes: 3,
	});
	assert.match(JSON.stringify(result.details.files[1]), /404/);
	assert.equal(await readFile(join(cwd, "good"), "utf8"), "NEW");
});

test("staged overwrite preserves a regular destination's permission bits", {
	skip: process.platform === "win32",
}, async (t) => {
	const cwd = await fixture(t);
	const path = join(cwd, "executable");
	await writeFile(path, "OLD");
	await chmod(path, 0o751);
	t.mock.method(globalThis, "fetch", async () => new Response("NEW"));
	await executeTransfer(
		{ paths: [path], files: incoming, overwrite: true },
		undefined,
		undefined,
		{ sessionId: cwd, cwd },
	);
	assert.equal((await stat(path)).mode & 0o777, 0o751);
});
