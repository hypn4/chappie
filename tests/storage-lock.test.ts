import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type TestContext, test } from "node:test";
import { StorageLock, StorageLockedError } from "../src/storage-lock.ts";
import { within } from "./helpers/async.ts";

const workerSource = `
import { createInterface } from "node:readline";
import { StorageLock, StorageLockedError } from ${JSON.stringify(new URL("../src/storage-lock.ts", import.meta.url).href)};
const input = createInterface({ input: process.stdin });
let lock;
console.log("ready");
try {
	for await (const command of input) {
		if (command === "acquire") {
			try {
				lock = await StorageLock.acquire(process.env.CHAPPIE_TEST_LOCK_DIR);
				console.log("acquired");
			} catch (error) {
				if (!(error instanceof StorageLockedError)) throw error;
				console.log("locked");
				break;
			}
		} else if (command === "release") {
			await lock.release();
			console.log("released");
			break;
		}
	}
} catch (error) {
	console.error(error);
	process.exitCode = 1;
} finally {
	input.close();
	process.stdin.pause();
}
`;

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "ch-storage-lock-"));
	const children: Array<{
		child: ReturnType<typeof spawn>;
		exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	}> = [];
	t.after(async () => {
		for (const { child } of children) {
			if (child.exitCode === null && child.signalCode === null)
				child.kill("SIGKILL");
		}
		await Promise.allSettled(children.map(({ exit }) => exit));
		await rm(root, { recursive: true, force: true });
	});
	async function worker() {
		const child = spawn(process.execPath, ["--eval", workerSource], {
			env: { ...process.env, CHAPPIE_TEST_LOCK_DIR: root },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8").on("data", (text: string) => {
			stderr += text;
		});
		const exit = new Promise<{
			code: number | null;
			signal: NodeJS.Signals | null;
		}>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) => resolve({ code, signal }));
		});
		children.push({ child, exit });
		const output = createInterface({ input: child.stdout });
		const lines = output[Symbol.asyncIterator]();
		async function nextLine() {
			const next = await within(
				lines.next(),
				10000,
				"Lock subprocess did not respond",
			);
			assert.equal(next.done, false, stderr);
			return next.value;
		}
		assert.equal(await nextLine(), "ready", stderr);
		return {
			child,
			exit,
			async command(command: "acquire" | "release") {
				child.stdin.write(`${command}\n`);
				return nextLine();
			},
			async finished() {
				const result = await within(
					exit,
					10000,
					"Lock subprocess did not exit",
				);
				assert.deepEqual(result, { code: 0, signal: null }, stderr);
				output.close();
			},
		};
	}
	return { root, worker };
}

async function ownerMetadata(root: string) {
	const path = join(root, "writer.lock");
	const files = await readdir(path);
	assert.equal(files.length, 1);
	const name = files[0];
	assert.ok(name);
	const text = await readFile(join(path, name), "utf8");
	const value = JSON.parse(text);
	assert.equal(name, `owner-${value.token}.json`);
	return { path, name, text, value };
}

test("a live writer excludes other processes until release and leaves store data unchanged", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.root, "state.json"), "unchanged");
	const first = await f.worker();
	assert.equal(await first.command("acquire"), "acquired");
	const metadata = await ownerMetadata(f.root);
	assert.equal(metadata.value.pid, first.child.pid);
	assert.equal(metadata.value.hostname, hostname());
	assert.match(
		metadata.value.token,
		/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
	const second = await f.worker();
	assert.equal(await second.command("acquire"), "locked");
	await second.finished();
	await assert.rejects(StorageLock.acquire(f.root), StorageLockedError);
	assert.equal((await ownerMetadata(f.root)).text, metadata.text);

	const other = await StorageLock.acquire(join(f.root, "another-store"));
	await other.release();
	assert.equal(await first.command("release"), "released");
	await first.finished();
	const successor = await StorageLock.acquire(f.root);
	await Promise.all([successor.release(), successor.release()]);
	await successor.release();
	assert.equal(await readFile(join(f.root, "state.json"), "utf8"), "unchanged");
	assert.deepEqual((await readdir(f.root)).sort(), [
		"another-store",
		"state.json",
	]);
});

test("simultaneous processes recover a killed writer with exactly one new owner", async (t) => {
	const f = await fixture(t);
	const previous = await f.worker();
	assert.equal(await previous.command("acquire"), "acquired");
	const oldOwner = await ownerMetadata(f.root);
	assert.equal(previous.child.kill("SIGKILL"), true);
	await within(previous.exit, 10000, "Killed lock owner did not exit");
	assert.equal((await ownerMetadata(f.root)).text, oldOwner.text);

	const contenders = await Promise.all(
		Array.from({ length: 4 }, () => f.worker()),
	);
	const results = await Promise.all(
		contenders.map((worker) => worker.command("acquire")),
	);
	assert.equal(results.filter((result) => result === "acquired").length, 1);
	assert.equal(results.filter((result) => result === "locked").length, 3);
	const winnerIndex = results.indexOf("acquired");
	const winner = contenders[winnerIndex];
	assert.ok(winner);
	const current = await ownerMetadata(f.root);
	assert.equal(current.value.pid, winner.child.pid);
	assert.notEqual(current.value.token, oldOwner.value.token);
	await assert.rejects(StorageLock.acquire(f.root), StorageLockedError);
	for (const [index, contender] of contenders.entries()) {
		if (index !== winnerIndex) await contender.finished();
	}
	assert.equal(await winner.command("release"), "released");
	await winner.finished();
	const successor = await StorageLock.acquire(f.root);
	await successor.release();
	assert.deepEqual(await readdir(f.root), []);
});

test("release cannot remove a replacement owner's token", async (t) => {
	const f = await fixture(t);
	const old = await StorageLock.acquire(f.root);
	const original = await ownerMetadata(f.root);
	await rename(original.path, join(f.root, "displaced-lock"));
	const current = await StorageLock.acquire(f.root);
	const replacement = await ownerMetadata(f.root);
	await assert.rejects(old.release(), StorageLockedError);
	assert.equal((await ownerMetadata(f.root)).text, replacement.text);
	await assert.rejects(StorageLock.acquire(f.root), StorageLockedError);
	await current.release();
	assert.equal(
		await readFile(join(f.root, "displaced-lock", original.name), "utf8"),
		original.text,
	);
});

test("age and EPERM never permit takeover of a live owner", async (t) => {
	const f = await fixture(t);
	const lock = await StorageLock.acquire(f.root);
	const owner = await ownerMetadata(f.root);
	const oldMetadata = JSON.stringify({ ...owner.value, createdAt: 0 });
	await writeFile(join(owner.path, owner.name), oldMetadata);
	await assert.rejects(StorageLock.acquire(f.root), StorageLockedError);
	t.mock.method(process, "kill", () => {
		throw Object.assign(new Error("Operation not permitted"), {
			code: "EPERM",
		});
	});
	await assert.rejects(StorageLock.acquire(f.root), StorageLockedError);
	assert.equal((await ownerMetadata(f.root)).text, oldMetadata);
	await lock.release();
});

test("foreign-host and invalid owner records stay intact", async (t) => {
	const f = await fixture(t);
	const path = join(f.root, "writer.lock");
	await mkdir(path);
	const token = randomUUID();
	const name = `owner-${token}.json`;
	const foreign = JSON.stringify({
		pid: process.pid,
		hostname: `${hostname()}-other`,
		token,
		createdAt: 0,
	});
	await writeFile(join(path, name), foreign);
	await assert.rejects(StorageLock.acquire(f.root), StorageLockedError);
	assert.equal(await readFile(join(path, name), "utf8"), foreign);
	await writeFile(join(path, name), "truncated owner {");
	await assert.rejects(StorageLock.acquire(f.root), StorageLockedError);
	assert.equal(await readFile(join(path, name), "utf8"), "truncated owner {");
	const oversized = JSON.stringify({
		pid: process.pid,
		hostname: "x".repeat(8192),
		token,
		createdAt: 0,
	});
	await writeFile(join(path, name), oversized);
	await assert.rejects(StorageLock.acquire(f.root), StorageLockedError);
	assert.equal(await readFile(join(path, name), "utf8"), oversized);
	assert.deepEqual(await readdir(f.root), ["writer.lock"]);
});

test("an empty interrupted release is recoverable", async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.root, "writer.lock"));
	const lock = await StorageLock.acquire(f.root);
	assert.equal((await ownerMetadata(f.root)).value.pid, process.pid);
	await lock.release();
	assert.deepEqual(await readdir(f.root), []);
});
