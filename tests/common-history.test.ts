import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import {
	type CommonHistoryInput,
	type CommonHistoryLimits,
	CommonHistoryStore,
} from "../src/common-history.ts";
import { uuidV7 } from "../src/ids.ts";
import { StorageLock } from "../src/storage-lock.ts";
import { within } from "./helpers/async.ts";

const run = promisify(execFile);
async function fixture(t: TestContext, limits?: Partial<CommonHistoryLimits>) {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "ch-common-history-")),
	);
	t.after(() => rm(root, { recursive: true, force: true }));
	const homeDir = join(root, ".chappie");
	const cwd = join(root, "project");
	await mkdir(cwd);
	const errors: Error[] = [];
	const store = new CommonHistoryStore({
		homeDir,
		...(limits ? { limits } : {}),
		onError: (error) => errors.push(error),
	});
	const project = await store.resolveProject({ cwd });
	assert.ok(project);
	return { root, cwd, homeDir, store, errors, projectId: project.projectId };
}
function input(
	projectId: string,
	cwd: string,
	overrides: Partial<CommonHistoryInput> = {},
): CommonHistoryInput {
	return {
		projectId,
		cwd,
		sessionId: uuidV7(),
		source: { agent: "test-agent", sourceSessionId: "native-session" },
		state: "active",
		current: true,
		startedAt: 1000,
		updatedAt: 2000,
		sourceEntryCount: 1,
		entries: [
			{
				sourceEntryId: "entry-1",
				timestamp: 2000,
				kind: "message",
				role: "user",
				text: "Public work 한글",
			},
		],
		...overrides,
	};
}
async function publish(store: CommonHistoryStore, value: CommonHistoryInput) {
	assert.equal(store.enqueue(value), true);
	await store.flush();
}
function path(homeDir: string, value: CommonHistoryInput) {
	return join(
		homeDir,
		"projects",
		value.projectId,
		"sessions",
		`${value.sessionId}.json`,
	);
}

async function activeWriter(
	t: TestContext,
	homeDir: string,
	value: CommonHistoryInput,
) {
	const source = new URL("../src/common-history.ts", import.meta.url).href;
	const script = `
const { CommonHistoryStore } = await import(${JSON.stringify(source)});
const errors = [];
const store = new CommonHistoryStore({ homeDir: ${JSON.stringify(homeDir)}, onError: error => errors.push(error.message) });
if (!store.enqueue(${JSON.stringify(value)})) throw new Error("Publication was rejected");
await store.flush();
if (errors.length) throw new Error(errors.join("; "));
process.stdout.write(String(process.pid) + "\\n");
for await (const _ of process.stdin) break;
`;
	const child = spawn(process.execPath, ["--eval", script], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.setEncoding("utf8").on("data", (text: string) => {
		stderr += text;
	});
	const exited = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", resolve);
	});
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null)
			child.kill("SIGKILL");
		await exited;
	});
	const output = createInterface({ input: child.stdout });
	const line = await within(
		output[Symbol.asyncIterator]().next(),
		10000,
		"History writer did not start",
	);
	assert.equal(line.done, false, stderr);
	assert.equal(Number(line.value), child.pid);
	assert.ok(child.pid);
	return {
		pid: child.pid,
		async stop() {
			child.stdin.end();
			assert.equal(
				await within(exited, 10000, "History writer did not stop"),
				0,
				stderr,
			);
			output.close();
		},
	};
}

test("stable project UUID v7 and explicit cwd aliases are independent of agent and local folder names", async (t) => {
	const f = await fixture(t);
	assert.match(
		f.projectId,
		/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
	);
	const second = new CommonHistoryStore({ homeDir: f.homeDir });
	assert.equal(
		(await second.resolveProject({ cwd: f.cwd }))?.projectId,
		f.projectId,
	);
	const moved = join(f.root, "another-machine-alias");
	await mkdir(moved);
	const reused = await second.resolveProject({
		cwd: moved,
		projectId: f.projectId,
	});
	assert.deepEqual(reused?.cwdAliases, [f.cwd, moved]);
	const other = join(f.root, "different-project");
	await mkdir(other);
	const otherProject = await f.store.resolveProject({ cwd: other });
	assert.ok(otherProject);
	assert.notEqual(otherProject.projectId, f.projectId);
	assert.equal(
		await f.store.resolveProject({ cwd: other, projectId: f.projectId }),
		undefined,
	);
	assert.equal(f.errors.length, 1);
	assert.equal((await f.store.listProjects()).length, 2);
});

test("readable UTF-8 snapshot contains only public fields and durable text without result cache references", async (t) => {
	const f = await fixture(t);
	const value = input(f.projectId, f.cwd);
	Object.assign(value.entries[0] ?? {}, {
		thinking: "private thought",
		details: { token: "private token" },
		resultId: "expiring",
	});
	Object.assign(value.source, { privatePath: "/agent/private" });
	Object.assign(value, { nativeState: "secret" });
	await publish(f.store, value);
	const text = await readFile(path(f.homeDir, value), "utf8");
	for (const secret of [
		"private thought",
		"private token",
		"expiring",
		"/agent/private",
		"secret",
	])
		assert.equal(text.includes(secret), false);
	const snapshot = JSON.parse(text);
	assert.equal(snapshot.schemaVersion, 1);
	assert.equal(snapshot.entries[0].text, "Public work 한글");
	assert.deepEqual(snapshot.source, {
		agent: "test-agent",
		sourceSessionId: "native-session",
	});
	assert.deepEqual(snapshot.coverage, {
		sourceEntryCount: 1,
		suppliedEntries: 1,
		retainedEntries: 1,
		omittedEntries: 0,
		oversizedEntries: 0,
		complete: true,
		newestEntryRetained: true,
	});
	const otherAgent = input(f.projectId, f.cwd, {
		source: { agent: "another-agent", sourceSessionId: "another-native" },
	});
	await publish(f.store, otherAgent);
	assert.equal((await f.store.listSessions(f.projectId)).length, 2);
	assert.equal(f.errors.length, 0);
});

test("continuous growing sessions publish newest whole entries with honest bounded coverage", async (t) => {
	const f = await fixture(t, { maxSessionBytes: 2048 });
	const value = input(f.projectId, f.cwd);
	for (let count = 1; count <= 8; count++) {
		const entries = Array.from({ length: count }, (_, index) => ({
			sourceEntryId: `entry-${index}`,
			timestamp: 2000 + index,
			kind: "message" as const,
			text: `Entry ${index}: ${"가".repeat(130)}`,
		}));
		await publish(f.store, {
			...value,
			updatedAt: 2000 + count,
			sourceEntryCount: count,
			entries,
		});
		const snapshot = await f.store.readSession(
			value.projectId,
			value.sessionId,
		);
		assert.ok(snapshot);
		assert.equal(snapshot.entries.at(-1)?.sourceEntryId, `entry-${count - 1}`);
		assert.equal(snapshot.entries.at(-1)?.text, entries.at(-1)?.text);
		assert.equal(
			snapshot.coverage.omittedEntries,
			count - snapshot.entries.length,
		);
		assert.equal(snapshot.coverage.complete, count === snapshot.entries.length);
		assert.equal(snapshot.coverage.newestEntryRetained, true);
		assert.ok(
			Buffer.byteLength(await readFile(path(f.homeDir, value), "utf8")) <= 2048,
		);
	}
	assert.equal(f.errors.length, 0);
});

test("oversized newest entry is explicitly omitted while older whole public entries remain readable", async (t) => {
	const f = await fixture(t, { maxSessionBytes: 2048 });
	const value = input(f.projectId, f.cwd, {
		sourceEntryCount: 4,
		entries: [
			{
				sourceEntryId: "previous",
				timestamp: 2000,
				kind: "summary",
				text: "Earlier retained summary",
			},
			{
				sourceEntryId: "oversized",
				timestamp: 2001,
				kind: "tool",
				text: "界".repeat(2048),
				toolName: "read",
			},
		],
	});
	await publish(f.store, value);
	const snapshot = await f.store.readSession(value.projectId, value.sessionId);
	assert.deepEqual(
		snapshot?.entries.map((entry) => entry.sourceEntryId),
		["previous"],
	);
	assert.deepEqual(snapshot?.coverage, {
		sourceEntryCount: 4,
		suppliedEntries: 2,
		retainedEntries: 1,
		omittedEntries: 3,
		oversizedEntries: 1,
		complete: false,
		newestEntryRetained: false,
	});
});

test("project retention removes oldest finished histories and preserves active/current work", async (t) => {
	const f = await fixture(t, {
		maxSessionBytes: 2048,
		maxProjectBytes: 8192,
		maxGlobalBytes: 16384,
		maxProjectSessions: 3,
	});
	const old = input(f.projectId, f.cwd, {
		state: "finished",
		current: false,
		finishedAt: 2000,
	});
	const active = input(f.projectId, f.cwd);
	const current = input(f.projectId, f.cwd, {
		state: "finished",
		current: true,
		finishedAt: 2100,
	});
	const newest = input(f.projectId, f.cwd, {
		state: "finished",
		current: false,
		finishedAt: 3000,
	});
	for (const value of [old, active, current, newest])
		await publish(f.store, value);
	assert.equal(
		await f.store.readSession(f.projectId, old.sessionId),
		undefined,
	);
	for (const value of [active, current, newest])
		assert.ok(await f.store.readSession(f.projectId, value.sessionId));
	assert.equal(f.errors.length, 0);
});

test("global byte pressure reclaims oldest finished history across project boundaries", async (t) => {
	const f = await fixture(t);
	const otherCwd = join(f.root, "second");
	await mkdir(otherCwd);
	const project = await f.store.resolveProject({ cwd: otherCwd });
	assert.ok(project);
	const old = input(f.projectId, f.cwd, {
		state: "finished",
		current: false,
		finishedAt: 2000,
		entries: [
			{
				sourceEntryId: "old",
				timestamp: 2000,
				kind: "message",
				text: "x".repeat(550),
			},
		],
	});
	const active = input(project.projectId, otherCwd, {
		entries: [
			{
				sourceEntryId: "active",
				timestamp: 2000,
				kind: "message",
				text: "x".repeat(550),
			},
		],
	});
	const next = input(project.projectId, otherCwd);
	// Measure complete files on this host: cwd, hostname, and PID affect size.
	for (const value of [old, active, next]) {
		await publish(f.store, value);
		assert.equal(
			(await f.store.readSession(value.projectId, value.sessionId))?.coverage
				.complete,
			true,
		);
	}
	const [oldFile, activeFile, nextFile] = await Promise.all([
		readFile(path(f.homeDir, old)),
		readFile(path(f.homeDir, active)),
		readFile(path(f.homeDir, next)),
	]);
	const maxSessionBytes =
		Math.max(oldFile.length, activeFile.length, nextFile.length) + 512;
	const maxGlobalBytes =
		Math.max(
			oldFile.length + activeFile.length,
			activeFile.length + nextFile.length,
		) + 128;
	assert.ok(maxSessionBytes <= maxGlobalBytes);
	assert.ok(
		oldFile.length + activeFile.length + nextFile.length > maxGlobalBytes,
		"Only the third publication must exceed the global byte budget",
	);
	for (const value of [old, active, next]) await rm(path(f.homeDir, value));
	const store = new CommonHistoryStore({
		homeDir: f.homeDir,
		limits: {
			maxSessionBytes,
			maxProjectBytes: maxGlobalBytes,
			maxGlobalBytes,
		},
		onError: (error) => f.errors.push(error),
	});
	await publish(store, old);
	await publish(store, active);
	assert.deepEqual(await readFile(path(f.homeDir, old)), oldFile);
	assert.deepEqual(await readFile(path(f.homeDir, active)), activeFile);
	await publish(store, next);
	assert.equal(await store.readSession(f.projectId, old.sessionId), undefined);
	assert.deepEqual(await readFile(path(f.homeDir, active)), activeFile);
	assert.deepEqual(await readFile(path(f.homeDir, next)), nextFile);
	assert.equal(f.errors.length, 0);
});

test("protected capacity reports a failed history update without rejecting native work or deleting prior data", async (t) => {
	const f = await fixture(t, { maxProjectSessions: 1 });
	const active = input(f.projectId, f.cwd);
	await publish(f.store, active);
	const before = await readFile(path(f.homeDir, active), "utf8");
	const blocked = input(f.projectId, f.cwd);
	assert.equal(f.store.enqueue(blocked), true);
	await assert.doesNotReject(f.store.flush());
	assert.equal(f.errors.length, 1);
	assert.equal(await readFile(path(f.homeDir, active), "utf8"), before);
	assert.equal(
		await f.store.readSession(f.projectId, blocked.sessionId),
		undefined,
	);
	// The active session itself can keep advancing within the same reserved slot.
	await publish(f.store, {
		...active,
		updatedAt: 3000,
		entries: [
			{
				sourceEntryId: "next",
				timestamp: 3000,
				kind: "message",
				text: "Still working",
			},
		],
	});
	assert.equal(
		(await f.store.readSession(f.projectId, active.sessionId))?.entries[0]
			?.text,
		"Still working",
	);
});

test("failed publication preserves reclaimable files until an atomic replacement succeeds", async (t) => {
	const f = await fixture(t, { maxProjectSessions: 1 });
	const old = input(f.projectId, f.cwd, {
		state: "finished",
		current: false,
		finishedAt: 2000,
	});
	await publish(f.store, old);
	const next = input(f.projectId, f.cwd);
	await mkdir(path(f.homeDir, next));
	await publish(f.store, next);
	assert.equal(f.errors.length, 1);
	assert.ok(await f.store.readSession(f.projectId, old.sessionId));
	await rm(path(f.homeDir, next), { recursive: true });
	await publish(f.store, next);
	assert.equal(
		await f.store.readSession(f.projectId, old.sessionId),
		undefined,
	);
	assert.ok(await f.store.readSession(f.projectId, next.sessionId));
});

test("stale updates and changed provenance cannot overwrite a published session", async (t) => {
	const f = await fixture(t);
	const value = input(f.projectId, f.cwd, { updatedAt: 4000 });
	await publish(f.store, value);
	const before = await readFile(path(f.homeDir, value), "utf8");
	await publish(f.store, { ...value, updatedAt: 3000, entries: [] });
	assert.equal(await readFile(path(f.homeDir, value), "utf8"), before);
	await publish(f.store, {
		...value,
		updatedAt: 5000,
		source: { agent: "different", sourceSessionId: "new" },
	});
	assert.equal(await readFile(path(f.homeDir, value), "utf8"), before);
	assert.equal(f.errors.length, 1);
});

test("bounded pending queue coalesces same-session progress and rejects excess sessions without throwing", async (t) => {
	const f = await fixture(t, { maxPendingSessions: 1 });
	const value = input(f.projectId, f.cwd);
	assert.equal(f.store.enqueue(value), true);
	assert.equal(
		f.store.enqueue({
			...value,
			updatedAt: 3000,
			entries: [
				{
					sourceEntryId: "latest",
					timestamp: 3000,
					kind: "summary",
					text: "Newest progress",
				},
			],
		}),
		true,
	);
	assert.equal(f.store.enqueue(input(f.projectId, f.cwd)), false);
	await f.store.flush();
	assert.equal(
		(await f.store.readSession(f.projectId, value.sessionId))?.entries[0]?.text,
		"Newest progress",
	);
	assert.equal(f.errors.length, 1);
});

test("busy history lock and throwing failure observers never reject the native-facing API", async (t) => {
	const f = await fixture(t);
	const lock = await StorageLock.acquire(join(f.homeDir, "projects"));
	const store = new CommonHistoryStore({
		homeDir: f.homeDir,
		onError: () => {
			throw new Error("Observer failed");
		},
	});
	try {
		assert.equal(store.enqueue(input(f.projectId, f.cwd)), true);
		await assert.doesNotReject(store.flush());
	} finally {
		await lock.release();
	}
	assert.equal(
		store.enqueue(input(f.projectId, f.cwd, { sessionId: "../bad" })),
		false,
	);
	assert.equal((await store.listSessions(f.projectId)).length, 0);
});

test("unknown schema versions are reported without replacing a project catalog or history", async (t) => {
	const f = await fixture(t);
	const catalogPath = join(f.homeDir, "project-catalog.json");
	const original = await readFile(catalogPath, "utf8");
	const unknown = original.replace('"schemaVersion": 1', '"schemaVersion": 2');
	await writeFile(catalogPath, unknown);
	assert.equal(await f.store.resolveProject({ cwd: f.cwd }), undefined);
	assert.equal(await readFile(catalogPath, "utf8"), unknown);
	await assert.rejects(f.store.listProjects());
	await writeFile(catalogPath, original);
	const value = input(f.projectId, f.cwd);
	await publish(f.store, value);
	const historyPath = path(f.homeDir, value);
	const future = (await readFile(historyPath, "utf8")).replace(
		'"schemaVersion":1',
		'"schemaVersion":2',
	);
	await writeFile(historyPath, future);
	await assert.rejects(f.store.readSession(value.projectId, value.sessionId));
	await publish(f.store, { ...value, updatedAt: 3000 });
	assert.equal(await readFile(historyPath, "utf8"), future);
});

test("independent neutral writers share a project identity and retain distinct session snapshots", async (t) => {
	const f = await fixture(t);
	const source = new URL("../src/common-history.ts", import.meta.url).href;
	const ids = Array.from({ length: 4 }, () => uuidV7());
	await Promise.all(
		ids.map((sessionId) => {
			const value = input(f.projectId, f.cwd, { sessionId });
			const code = `const {CommonHistoryStore} = await import(${JSON.stringify(source)}); const errors=[]; const store = new CommonHistoryStore({homeDir:${JSON.stringify(f.homeDir)},onError:e=>errors.push(e.message)}); const project=await store.resolveProject({cwd:${JSON.stringify(f.cwd)}}); store.enqueue(${JSON.stringify(value)}); await store.flush(); if(errors.length)throw new Error(errors.join(';')); process.stdout.write(project.projectId);`;
			return run(process.execPath, ["--eval", code], {
				timeout: 15000,
				maxBuffer: 128 * 1024,
			}).then((result) => assert.equal(result.stdout, f.projectId));
		}),
	);
	assert.equal((await f.store.listProjects()).length, 1);
	assert.deepEqual(
		(await f.store.listSessions(f.projectId))
			.map((item) => item.sessionId)
			.sort(),
		ids.sort(),
	);
	assert.deepEqual((await readdir(f.homeDir)).sort(), [
		"project-catalog.json",
		"projects",
	]);
});

test("explicit finish releases current history without re-reading native state or resurrecting removed sessions", async (t) => {
	const f = await fixture(t, { maxProjectSessions: 1 });
	const current = input(f.projectId, f.cwd);
	await publish(f.store, current);
	await f.store.finishSession(current.projectId, current.sessionId, 1500);
	const finished = await f.store.readSession(
		current.projectId,
		current.sessionId,
	);
	assert.equal(finished?.state, "finished");
	assert.equal(finished?.current, false);
	assert.equal(finished?.updatedAt, 2000);
	assert.equal(finished?.finishedAt, 1500);
	assert.equal(finished?.entries[0]?.text, "Public work 한글");
	const next = input(f.projectId, f.cwd);
	await publish(f.store, next);
	assert.equal(
		await f.store.readSession(current.projectId, current.sessionId),
		undefined,
	);
	await f.store.finishSession(current.projectId, current.sessionId, 4000);
	assert.equal(
		await f.store.readSession(current.projectId, current.sessionId),
		undefined,
	);
	assert.equal(f.errors.length, 0);
});

for (const ending of ["finishSession", "finished publication"] as const) {
	test(`a previous process's ${ending} cannot finish or expose a resumed owner's history to GC`, async (t) => {
		const f = await fixture(t, { maxProjectSessions: 1 });
		const previous = input(f.projectId, f.cwd);
		await publish(f.store, previous);
		await f.store.finishSession(previous.projectId, previous.sessionId, 2500);
		const resumed = {
			...previous,
			updatedAt: 3000,
			entries: [
				{
					sourceEntryId: "successor-entry",
					timestamp: 3000,
					kind: "message" as const,
					role: "assistant" as const,
					text: "Successor's active work",
				},
			],
		};
		const writer = await activeWriter(t, f.homeDir, resumed);
		try {
			const historyPath = path(f.homeDir, resumed);
			const before = await readFile(historyPath, "utf8");
			const owner = await f.store.readSession(f.projectId, previous.sessionId);
			assert.equal(owner?.runtimeOwner.pid, writer.pid);
			assert.equal(owner?.state, "active");
			assert.equal(owner?.current, true);
			if (ending === "finishSession") {
				await f.store.finishSession(
					previous.projectId,
					previous.sessionId,
					5000,
				);
			} else {
				await publish(f.store, {
					...previous,
					state: "finished",
					current: false,
					updatedAt: 5000,
					finishedAt: 5000,
				});
			}
			assert.equal(await readFile(historyPath, "utf8"), before);
			assert.equal(f.errors.length, 1);
			const competing = input(f.projectId, f.cwd, { updatedAt: 6000 });
			await publish(f.store, competing);
			assert.equal(
				await f.store.readSession(f.projectId, competing.sessionId),
				undefined,
			);
			assert.equal(await readFile(historyPath, "utf8"), before);
			assert.equal(f.errors.length, 2);
			const observerThrows = new CommonHistoryStore({
				homeDir: f.homeDir,
				onError: () => {
					throw new Error("Observer failed");
				},
			});
			await assert.doesNotReject(
				observerThrows.finishSession(f.projectId, previous.sessionId),
			);
			assert.equal(await readFile(historyPath, "utf8"), before);
		} finally {
			await writer.stop();
		}
	});
}

test("active publication cannot take over another live process's session", async (t) => {
	const f = await fixture(t);
	const value = input(f.projectId, f.cwd);
	await publish(f.store, value);
	const before = await readFile(path(f.homeDir, value), "utf8");
	const source = new URL("../src/common-history.ts", import.meta.url).href;
	const contender = { ...value, updatedAt: 3000, entries: [] };
	const script = `const {CommonHistoryStore}=await import(${JSON.stringify(source)}); const errors=[]; const store=new CommonHistoryStore({homeDir:${JSON.stringify(f.homeDir)},onError:e=>errors.push(e.message)}); store.enqueue(${JSON.stringify(contender)}); await store.flush(); process.stdout.write(JSON.stringify(errors));`;
	const result = await run(process.execPath, ["--eval", script], {
		timeout: 15000,
	});
	assert.equal(JSON.parse(result.stdout).length, 1);
	assert.equal(await readFile(path(f.homeDir, value), "utf8"), before);
});

test("active publication can resume a same-host session after the prior process is proven dead", async (t) => {
	const f = await fixture(t);
	const value = input(f.projectId, f.cwd);
	const source = new URL("../src/common-history.ts", import.meta.url).href;
	const script = `const {CommonHistoryStore}=await import(${JSON.stringify(source)}); const errors=[]; const store=new CommonHistoryStore({homeDir:${JSON.stringify(f.homeDir)},onError:e=>errors.push(e.message)}); store.enqueue(${JSON.stringify(value)}); await store.flush(); if(errors.length)throw new Error(errors.join(';')); process.stdout.write(String(process.pid));`;
	const result = await run(process.execPath, ["--eval", script], {
		timeout: 15000,
	});
	const deadPid = Number(result.stdout);
	assert.throws(() => process.kill(deadPid, 0), { code: "ESRCH" });
	assert.equal(
		(await f.store.readSession(f.projectId, value.sessionId))?.runtimeOwner.pid,
		deadPid,
	);
	await publish(f.store, { ...value, updatedAt: 3000 });
	const resumed = await f.store.readSession(f.projectId, value.sessionId);
	assert.equal(resumed?.runtimeOwner.pid, process.pid);
	assert.equal(resumed?.state, "active");
	assert.equal(resumed?.updatedAt, 3000);
	assert.equal(resumed?.entries[0]?.text, "Public work 한글");
	assert.equal(f.errors.length, 0);
});

test("a crashed same-host writer releases active/current history only after its PID is proven dead", async (t) => {
	const f = await fixture(t, { maxProjectSessions: 1 });
	const previous = input(f.projectId, f.cwd);
	const source = new URL("../src/common-history.ts", import.meta.url).href;
	const code = `const {CommonHistoryStore} = await import(${JSON.stringify(source)}); const store=new CommonHistoryStore({homeDir:${JSON.stringify(f.homeDir)},onError:e=>{throw e}}); store.enqueue(${JSON.stringify(previous)}); await store.flush(); process.stdout.write(String(process.pid));`;
	const result = await run(process.execPath, ["--eval", code], {
		timeout: 15000,
	});
	const deadPid = Number(result.stdout);
	assert.throws(() => process.kill(deadPid, 0), { code: "ESRCH" });
	const snapshot = await f.store.readSession(
		previous.projectId,
		previous.sessionId,
	);
	assert.equal(snapshot?.state, "active");
	assert.equal(snapshot?.current, true);
	assert.equal(snapshot?.runtimeOwner.pid, deadPid);
	const next = input(f.projectId, f.cwd);
	await publish(f.store, next);
	assert.equal(
		await f.store.readSession(previous.projectId, previous.sessionId),
		undefined,
	);
	assert.ok(await f.store.readSession(next.projectId, next.sessionId));
	assert.equal(f.errors.length, 0);
});

test("an active history from another hostname is never inferred dead from a local PID", async (t) => {
	const f = await fixture(t, { maxProjectSessions: 1 });
	const previous = input(f.projectId, f.cwd);
	await publish(f.store, previous);
	const historyPath = path(f.homeDir, previous);
	const snapshot = JSON.parse(await readFile(historyPath, "utf8"));
	snapshot.runtimeOwner = { pid: 2147483647, hostname: "another-computer" };
	await writeFile(historyPath, `${JSON.stringify(snapshot)}\n`);
	const before = await readFile(historyPath, "utf8");
	const next = input(f.projectId, f.cwd);
	await publish(f.store, next);
	assert.equal(await readFile(historyPath, "utf8"), before);
	assert.equal(
		await f.store.readSession(next.projectId, next.sessionId),
		undefined,
	);
	assert.equal(f.errors.length, 1);
	await publish(f.store, { ...previous, updatedAt: 3000 });
	assert.equal(await readFile(historyPath, "utf8"), before);
	await f.store.finishSession(previous.projectId, previous.sessionId, 4000);
	assert.equal(await readFile(historyPath, "utf8"), before);
	assert.equal(f.errors.length, 3);
});

test("pending snapshots cannot silently replace another agent's session identity", async (t) => {
	const f = await fixture(t);
	const value = input(f.projectId, f.cwd);
	assert.equal(f.store.enqueue(value), true);
	assert.equal(
		f.store.enqueue({
			...value,
			updatedAt: 3000,
			source: { agent: "another", sourceSessionId: "another-native-session" },
		}),
		false,
	);
	await f.store.flush();
	assert.equal(
		(await f.store.readSession(value.projectId, value.sessionId))?.source.agent,
		"test-agent",
	);
	assert.equal(f.errors.length, 1);
});

test("unchanged history bodies are not re-read for repeated scans or publications and atomic replacements invalidate summaries", async (t) => {
	const f = await fixture(t);
	const value = input(f.projectId, f.cwd);
	await publish(f.store, value);
	class CountingReader extends CommonHistoryStore {
		reads = 0;
		override async readSession(projectId: string, sessionId: string) {
			this.reads++;
			return super.readSession(projectId, sessionId);
		}
	}
	const reader = new CountingReader({ homeDir: f.homeDir });
	const first = await reader.listSessions(f.projectId);
	assert.equal(reader.reads, 1);
	assert.equal(first[0]?.updatedAt, 2000);
	if (first[0]) {
		first[0].state = "finished";
		first[0].source.agent = "mutated by caller";
	}
	assert.equal((await reader.listSessions(f.projectId))[0]?.state, "active");
	assert.equal(reader.reads, 1);
	await publish(f.store, { ...value, updatedAt: 3000 });
	assert.equal((await reader.listSessions(f.projectId))[0]?.updatedAt, 3000);
	assert.equal(reader.reads, 2);
	await reader.listSessions(f.projectId);
	assert.equal(reader.reads, 2);
	await publish(reader, { ...value, updatedAt: 4000 });
	assert.equal(reader.reads, 2);
	assert.equal((await reader.listSessions(f.projectId))[0]?.updatedAt, 4000);
	assert.equal(reader.reads, 2);
	const file = path(f.homeDir, value);
	const text = await readFile(file, "utf8");
	await rm(file);
	assert.deepEqual(await reader.listSessions(f.projectId), []);
	await writeFile(file, text);
	assert.equal((await reader.listSessions(f.projectId))[0]?.updatedAt, 4000);
	assert.equal(reader.reads, 3);
});

test("portable readers treat foreign-platform cwd aliases as provenance without requiring local filesystem paths", async (t) => {
	const f = await fixture(t);
	const value = input(f.projectId, f.cwd);
	await publish(f.store, value);
	const historyPath = path(f.homeDir, value);
	const original = JSON.parse(await readFile(historyPath, "utf8"));
	for (const cwd of [
		"C:\\Users\\dev\\project",
		"/home/dev/project",
		"\\\\machine\\share\\project",
	]) {
		await writeFile(historyPath, `${JSON.stringify({ ...original, cwd })}\n`);
		assert.equal(
			(await f.store.readSession(f.projectId, value.sessionId))?.cwd,
			cwd,
		);
		assert.equal((await f.store.listSessions(f.projectId))[0]?.cwd, cwd);
	}
	const catalogPath = join(f.homeDir, "project-catalog.json");
	const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
	catalog.projects[0].cwdAliases.push("Z:\\other-computer\\project");
	await writeFile(catalogPath, `${JSON.stringify(catalog)}\n`);
	assert.ok(
		(await f.store.listProjects())[0]?.cwdAliases.includes(
			"Z:\\other-computer\\project",
		),
	);
	assert.equal(f.store.enqueue({ ...value, cwd: "relative/path" }), false);
});
