import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { Broker } from "../src/broker.ts";
import { IpcServer } from "../src/ipc.ts";
import { ResponseStore } from "../src/responses.ts";
import { State } from "../src/state.ts";
import { StorageLockedError } from "../src/storage-lock.ts";
import { mcpClient, resultOf } from "./helpers/mcp-client.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "ch-broker-storage-"));
	const brokers: Broker[] = [];
	const clients: ReturnType<typeof mcpClient>[] = [];
	t.after(async () => {
		try {
			for (const client of clients) await client.close();
			for (const broker of [...brokers].reverse()) await broker.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	// This checks real storage ownership and startup mutations. Native socket
	// listening is a separate boundary covered by the native integration suite.
	t.mock.method(IpcServer.prototype, "start", async () => {});
	return {
		root,
		broker() {
			const broker = new Broker(root);
			brokers.push(broker);
			return broker;
		},
		client(broker: Broker) {
			const client = mcpClient(t, broker);
			clients.push(client);
			return client;
		},
	};
}

test("a contender is rejected before State.load can repair another writer's pending data", async (t) => {
	const f = await fixture(t);
	const state = new State(f.root);
	await state.addDelivery({
		id: "pending-result",
		chatId: "owner",
		sessionId: "A",
		cwd: f.root,
		complete: true,
		toolResults: [
			{
				role: "toolResult",
				toolCallId: "native-result",
				toolName: "read",
				content: [{ type: "text", text: "OWNER_PENDING_BODY" }],
				isError: false,
				timestamp: 1,
			},
		],
	});
	const owner = f.broker();
	await owner.start();
	const pending = owner.deliveries("owner");
	const reference = pending[0];
	assert.ok(reference);
	const store = new ResponseStore(f.root);
	// A second State.load would reconcile this out-of-state pin away. Leaving
	// it untouched proves the rejected contender never reached that repair.
	await store.pin("owner", reference.resultId, "delivery:uncommitted-owner");
	const metadataPath = join(
		f.root,
		"chappie.results",
		`${reference.resultId}.meta.json`,
	);
	const statePath = join(f.root, "chappie.state.json");
	const beforeState = await readFile(statePath, "utf8");
	const beforeMetadata = await readFile(metadataPath, "utf8");
	const lockEntries = await readdir(join(f.root, "writer.lock"));
	let loads = 0;
	const load = State.prototype.load;
	t.mock.method(State.prototype, "load", async function (this: State) {
		loads++;
		await load.call(this);
	});

	const contender = f.broker();
	await assert.rejects(contender.start(), StorageLockedError);
	await contender.close();
	assert.equal(loads, 0);
	assert.deepEqual(owner.deliveries("owner"), pending);
	assert.equal(await readFile(statePath, "utf8"), beforeState);
	assert.equal(await readFile(metadataPath, "utf8"), beforeMetadata);
	assert.deepEqual(await readdir(join(f.root, "writer.lock")), lockEntries);

	const response = resultOf(
		await f.client(owner).call("sessions", {}, { chatId: "owner" }),
	);
	assert.match(JSON.stringify(response.content), /OWNER_PENDING_BODY/);
	assert.deepEqual(owner.deliveries("owner"), []);
	assert.equal(loads, 0);
	const next = await owner.saveResponse("owner", "AFTER_CONTENDER");
	assert.equal(await owner.readResponse("owner", next), "AFTER_CONTENDER");
});

test("invalid initial state releases ownership and the same broker can retry after correction", async (t) => {
	const f = await fixture(t);
	const path = join(f.root, "chappie.state.json");
	const invalid = "{broken-state";
	await writeFile(path, invalid);
	const broker = f.broker();
	await assert.rejects(broker.start(), SyntaxError);
	assert.equal(await readFile(path, "utf8"), invalid);
	assert.equal((await readdir(f.root)).includes("writer.lock"), false);

	await writeFile(path, '{"schemaVersion":1}');
	await broker.start();
	assert.equal((await readdir(f.root)).includes("writer.lock"), true);
	const id = await broker.saveResponse("owner", "RETRY_RESULT");
	assert.equal(await broker.readResponse("owner", id), "RETRY_RESULT");
	await assert.rejects(f.broker().start(), StorageLockedError);
});

test("invalid initial config releases ownership for a corrected replacement broker", async (t) => {
	const f = await fixture(t);
	const path = join(f.root, "chappie.json");
	const invalid = '{"ask":"invalid"}';
	await writeFile(path, invalid);
	const failed = f.broker();
	await assert.rejects(failed.start(), /boolean/);
	assert.equal(await readFile(path, "utf8"), invalid);
	assert.equal((await readdir(f.root)).includes("writer.lock"), false);

	await writeFile(path, '{"ask":false,"diagnostics":false}');
	const replacement = f.broker();
	await replacement.start();
	const ownerToken = await readdir(join(f.root, "writer.lock"));
	await failed.close();
	assert.deepEqual(await readdir(join(f.root, "writer.lock")), ownerToken);
	assert.equal(replacement.askEnabled, false);
	const id = await replacement.saveResponse("owner", "REPLACEMENT_RESULT");
	assert.equal(
		await replacement.readResponse("owner", id),
		"REPLACEMENT_RESULT",
	);
});
