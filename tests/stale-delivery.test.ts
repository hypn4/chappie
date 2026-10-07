import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Broker } from "../src/broker.ts";
import {
	type BrokerMessage,
	ipcEndpoint,
	JsonLinePeer,
	type SessionMessage,
} from "../src/ipc.ts";

test("discarding a retired execution acknowledges the stale packet without disconnecting its owner", {
	timeout: 3000,
}, async (t) => {
	const root = await mkdtemp(
		join(process.platform === "win32" ? tmpdir() : "/tmp", "ch-stale-"),
	);
	const broker = new Broker(root);
	await broker.start();
	const synced = Promise.withResolvers<void>();
	const delivered = Promise.withResolvers<string>();
	const peer = new JsonLinePeer<BrokerMessage, SessionMessage>(
		createConnection(ipcEndpoint(root)),
		(message) => {
			if (message.type === "synced") synced.resolve();
			if (message.type === "stored") delivered.resolve("stored");
		},
		() => delivered.resolve("disconnected"),
	);
	t.after(async () => {
		peer.close();
		await broker.close();
		await rm(root, { recursive: true, force: true });
	});
	await peer.send({
		type: "sync",
		id: 1,
		session: {
			id: "owner",
			cwd: root,
			device: "test",
			host: "omp",
			status: "idle",
		},
	});
	await synced.promise;
	await peer.send({
		type: "delivery",
		delivery: {
			id: "old-packet",
			chatId: "chat",
			sessionId: "owner",
			cwd: root,
			operationKey: "retired",
			executionId: "01990b72-71c0-7000-8000-000000000001",
			toolResults: [],
			complete: true,
		},
	});
	assert.equal(await delivered.promise, "stored");
	assert.equal(broker.listSessions("owner").length, 1);
	assert.deepEqual(broker.deliveries("chat"), []);
});
