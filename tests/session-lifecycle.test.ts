import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { withFileMutationQueue } from "../src/file-mutation-queue.ts";
import { IpcClient } from "../src/ipc.ts";
import { createChappieStream } from "../src/provider-core.ts";
import { sessionFixture, until } from "./helpers/session-fixture.ts";

test("switching sessions rejects queued work and unregisters the old ID", async (t) => {
	const f = await sessionFixture(t);
	const { pending } = await f.queue();
	await f.switchTo("B");
	assert.deepEqual(
		f.broker.listSessions().map((session) => session.id),
		["B"],
	);
	const outcome = await Promise.race([
		pending,
		delay(200).then(() => ({ error: "request not rejected" })),
	]);
	assert.ok(
		"error" in outcome &&
			/session.*chang|no longer active/i.test(outcome.error),
	);
});

test("late completion after a switch retains its original session and cwd", async (t) => {
	const f = await sessionFixture(t);
	const previous = f.current;
	const { pending } = await f.queue();
	const output = await f.dispatch();
	await f.switchTo("B");
	await f.complete(output, previous);
	assert.deepEqual(
		f.broker.listSessions().map((session) => session.id),
		["B"],
	);
	await until(() => f.broker.deliveries("test-chat").length === 1);
	const delivered = f.broker.deliveries("test-chat")[0];
	assert.equal(delivered?.sessionId, "A");
	assert.equal(delivered?.cwd, previous.cwd);
	assert.equal(delivered?.toolResults.length, 1);
	assert.ok("error" in (await pending));
});

test("completion after reconnect is retained exactly once", async (t) => {
	const f = await sessionFixture(t);
	const { pending } = await f.queue();
	const output = await f.dispatch();
	await f.reconnect();
	await f.complete(output);
	await until(() => f.broker.deliveries("test-chat").length === 1);
	const deliveries = f.broker.deliveries("test-chat");
	assert.equal(deliveries[0]?.toolResults.length, 1);
	assert.equal(deliveries[0]?.sessionId, "A");
	await f.complete(output);
	await delay(10);
	assert.equal(f.broker.deliveries("test-chat").length, 1);
	assert.ok("error" in (await pending));
});

test("a cloned result with the same source but different call IDs cannot complete current work", async (t) => {
	const f = await sessionFixture(t);
	const { pending } = await f.queue();
	const output = await f.dispatch();
	const stale = structuredClone(output.message);
	for (const block of stale.content)
		if (block.type === "toolCall") block.id = "old-call";
	let finished = false;
	void pending.then(() => {
		finished = true;
	});
	await f.emit("turn_end", { message: stale, toolResults: [] });
	await f.emit("agent_end", { willContinue: false });
	await delay(10);
	assert.equal(finished, false);
	await f.complete(output);
	assert.ok("result" in (await pending));
});

test("an immediately cancelled provider stream never starts local work", async () => {
	const controller = new AbortController();
	let starts = 0;
	const stream = createChappieStream(async (output) => {
		starts++;
		output.done();
	});
	stream(
		{ api: "chappie", provider: "chappie", id: "chatgpt" },
		{},
		{ signal: controller.signal },
	);
	controller.abort();
	await delay(0);
	assert.equal(starts, 0);
});

test("session switch cancels copies still waiting for a destination lock", async (t) => {
	const f = await sessionFixture(t);
	const destination = join(f.current.cwd, "copy.txt");
	const gate = Promise.withResolvers<void>();
	const locked = Promise.withResolvers<void>();
	const lock = withFileMutationQueue(destination, async () => {
		locked.resolve();
		await gate.promise;
	});
	await locked.promise;
	const descriptor = {
		uri: "chappie://session/source/file/one/data.txt",
		name: "data.txt",
		mimeType: "text/plain",
		size: 4,
	};
	const source = new IpcClient(f.root, undefined, {
		onOpen: () =>
			source.send({
				type: "sync",
				id: 1,
				session: {
					id: "source",
					cwd: f.root,
					device: "fixture",
					status: "idle",
				},
			}),
		async onMessage(message) {
			if (message.type === "readResource")
				await source.send({
					type: "result",
					id: message.id,
					resource: {
						...descriptor,
						blob: Buffer.from("DATA").toString("base64"),
					},
				});
		},
		onClose() {},
	});
	t.after(() => source.close());
	try {
		await source.connect();
		await until(() => f.broker.listSessions().some((s) => s.id === "source"));
		await source.send({
			type: "request",
			id: 2,
			request: {
				type: "copy",
				sessionId: "A",
				resources: [descriptor],
				paths: [destination],
				overwrite: false,
			},
		});
		await delay(30);
		await f.switchTo("B");
	} finally {
		gate.resolve();
		await lock;
	}
	await delay(60);
	await assert.rejects(access(destination), /ENOENT/);
});
