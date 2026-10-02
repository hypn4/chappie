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
import { setImmediate } from "node:timers/promises";
import { withFileMutationQueue } from "../src/file-mutation-queue.ts";
import {
	describeResource,
	readSessionResource,
	registerFile,
} from "../src/resources.ts";
import { copyFiles, executeTransfer } from "../src/transfer.ts";
import { within } from "./helpers/async.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const root = await mkdtemp(join(tmpdir(), "chappie-transfer-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

const incoming = [
	{ file_id: "test-file", download_url: "https://93.184.216.34/file" },
];

test("host downloads reject local addresses and oversized responses", async (t) => {
	const cwd = await fixture(t);
	let fetches = 0;
	t.mock.method(globalThis, "fetch", async () => {
		fetches++;
		return new Response("x", {
			headers: { "content-length": String(512 * 1024 * 1024 + 1) },
		});
	});
	const local = await executeTransfer(
		{
			paths: ["local"],
			files: [{ file_id: "local", download_url: "https://127.0.0.1/secret" }],
		},
		undefined,
		undefined,
		{ sessionId: cwd, cwd },
	);
	assert.equal(local.isError, true);
	assert.equal(fetches, 0);

	const oversized = await executeTransfer(
		{ paths: ["large"], files: incoming },
		undefined,
		undefined,
		{ sessionId: cwd, cwd },
	);
	assert.equal(oversized.isError, true);
	assert.match(
		JSON.stringify(oversized.details.files),
		/too large|size limit/i,
	);
	assert.equal(fetches, 1);
});

test("host file imports finish one download before starting the next", async (t) => {
	const cwd = await fixture(t);
	let active = 0;
	let maximum = 0;
	t.mock.method(globalThis, "fetch", async () => {
		active++;
		maximum = Math.max(maximum, active);
		await setImmediate();
		active--;
		return new Response("x");
	});
	const count = 8;
	const result = await executeTransfer(
		{
			paths: Array.from({ length: count }, (_, i) => `file-${i}`),
			files: Array.from({ length: count }, (_, i) => ({
				file_id: String(i),
				download_url: `https://93.184.216.34/${i}`,
			})),
		},
		undefined,
		undefined,
		{ sessionId: cwd, cwd },
	);
	assert.equal(result.isError, false);
	assert.equal(maximum, 1);
	assert.equal(result.details.files.length, count);
	for (let index = 0; index < count; index++)
		assert.equal(await readFile(join(cwd, `file-${index}`), "utf8"), "x");
});

test("session copies finish one resource before starting the next", async (t) => {
	const cwd = await fixture(t);
	let active = 0;
	let maximum = 0;
	const count = 8;
	const resources = Array.from({ length: count }, (_, index) => ({
		uri: `chappie://session/A/file/${index}/file-${index}`,
		name: `file-${index}`,
		mimeType: "text/plain",
		size: 1,
	}));
	const files = await copyFiles(
		resources.map((_, index) => `copy-${index}`),
		resources,
		cwd,
		false,
		async function* () {
			active++;
			maximum = Math.max(maximum, active);
			await setImmediate();
			yield new Uint8Array([120]);
			active--;
		},
		new AbortController().signal,
	);
	assert.equal(files.length, count);
	assert.equal(maximum, 1);
	assert.ok(files.every((file) => "bytes" in file && file.bytes === 1));
});

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
	const streamStarted = Promise.withResolvers<void>();
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
						streamStarted.resolve();
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
	await within(streamStarted.promise, 2500, "Download stream did not start");
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
		// A different path is a registration barrier, not a latency guess.
		await within(
			withFileMutationQueue(join(cwd, "barrier"), async () => {}),
			2500,
			"Mutation queue did not register",
		);
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
				{ file_id: "good", download_url: "https://93.184.216.34/good" },
				{ file_id: "bad", download_url: "https://93.184.216.34/bad" },
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
