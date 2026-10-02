import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Broker } from "../src/broker.ts";
import { readConfig } from "../src/config.ts";
import { ipcEndpoint, JsonLinePeer } from "../src/ipc.ts";
import { validateSessionMessage } from "../src/ipc-schema.ts";
import { until } from "./helpers/session-fixture.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(
		join(process.platform === "win32" ? tmpdir() : "/tmp", "chipc-"),
	);
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}
async function peer(t: TestContext, root: string) {
	const socket = createConnection(ipcEndpoint(root));
	const messages: Record<string, unknown>[] = [];
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		for (;;) {
			const end = buffer.indexOf("\n");
			if (end < 0) break;
			messages.push(JSON.parse(buffer.slice(0, end)));
			buffer = buffer.slice(end + 1);
		}
	});
	socket.on("error", () => {});
	t.after(() => {
		socket.destroy();
	});
	await once(socket, "connect");
	return {
		socket,
		messages,
		send(value: unknown) {
			socket.write(`${JSON.stringify(value)}\n`);
		},
	};
}

test("inspection validates optional Skill metadata at the IPC boundary", () => {
	const message = {
		type: "result" as const,
		id: 1,
		inspection: {
			session: {
				id: "A",
				cwd: "/fixture",
				device: "test",
				host: "omp" as const,
				status: "idle" as const,
			},
			tools: [],
			skills: [
				{ name: "skill:ok", source: "skill" as const, description: "ok" },
			],
		},
		inputs: [],
	};
	assert.doesNotThrow(() => validateSessionMessage(message));
	assert.throws(() =>
		validateSessionMessage({
			...message,
			inspection: {
				...message.inspection,
				skills: [{ name: "skill:bad", source: "skill", description: 123 }],
			},
		}),
	);
});

test("new agent directories are created before opening IPC", async (t) => {
	const root = await fixture(t);
	const broker = new Broker(join(root, "new/agent"));
	t.after(() => broker.close());
	await broker.start();
	assert.deepEqual(broker.listSessions(), []);
});

test("a regular file at the socket path is never removed", {
	skip: process.platform === "win32",
}, async (t) => {
	const root = await fixture(t);
	await writeFile(ipcEndpoint(root), "DO NOT REMOVE");
	const broker = new Broker(root);
	t.after(() => broker.close());
	await assert.rejects(broker.start(), /socket|EACCES|ENOTSOCK|ECONNREFUSED/i);
	assert.equal(await readFile(ipcEndpoint(root), "utf8"), "DO NOT REMOVE");
});

test("remote connections require TLS configuration before any socket is opened", async (t) => {
	const root = await fixture(t);
	await writeFile(
		join(root, "chappie.json"),
		JSON.stringify({ connect: "localhost:1" }),
	);
	await assert.rejects(readConfig(root), /tls|certificate/i);
});

test("unregistered peers cannot relay inspect requests", async (t) => {
	const root = await fixture(t);
	const broker = new Broker(root);
	await broker.start();
	t.after(() => broker.close());
	const target = await peer(t, root);
	target.send({
		type: "sync",
		id: 1,
		session: {
			id: "target",
			cwd: root,
			device: "test",
			host: "omp",
			status: "idle",
		},
	});
	await until(() => broker.listSessions().length === 1);
	const stranger = await peer(t, root);
	stranger.send({
		type: "request",
		id: 9,
		request: { type: "inspect", sessionId: "target" },
	});
	await delay(60);
	assert.equal(
		target.messages.some((m) => m.type === "inspect"),
		false,
	);
});

test("registered peers cannot relay tool calls when collaboration is disabled", async (t) => {
	const root = await fixture(t);
	const broker = new Broker(root);
	await broker.start();
	t.after(() => broker.close());
	const target = await peer(t, root);
	target.send({
		type: "sync",
		id: 1,
		session: {
			id: "target",
			cwd: root,
			device: "test",
			status: "idle",
			host: "omp",
		},
	});
	const source = await peer(t, root);
	source.send({
		type: "sync",
		id: 1,
		session: {
			id: "source",
			cwd: root,
			device: "test",
			status: "idle",
			host: "omp",
		},
	});
	await until(() => broker.listSessions().length === 2);
	source.send({
		type: "request",
		id: 9,
		request: {
			type: "call",
			sessionId: "target",
			chatId: "source",
			requestId: "operation",
			calls: [
				{
					type: "toolCall",
					id: "tool",
					name: "read",
					arguments: { path: "file.txt" },
				},
			],
		},
	});
	await delay(60);
	assert.equal(
		target.messages.some((message) => message.type === "call"),
		false,
	);
});

test("collaboration relay binds the operation identity to the source session", async (t) => {
	const root = await fixture(t);
	await writeFile(
		join(root, "chappie.json"),
		JSON.stringify({ localTools: true }),
	);
	const broker = new Broker(root);
	await broker.start();
	t.after(() => broker.close());
	const target = await peer(t, root);
	target.send({
		type: "sync",
		id: 1,
		session: {
			id: "target",
			cwd: root,
			device: "test",
			status: "idle",
			host: "omp",
		},
	});
	const source = await peer(t, root);
	source.send({
		type: "sync",
		id: 1,
		session: {
			id: "source",
			cwd: root,
			device: "test",
			status: "idle",
			host: "omp",
		},
	});
	await until(() => broker.listSessions().length === 2);
	source.send({
		type: "request",
		id: 10,
		request: {
			type: "call",
			sessionId: "target",
			chatId: "forged",
			requestId: "operation",
			calls: [
				{
					type: "toolCall",
					id: "tool",
					name: "read",
					arguments: { path: "file.txt" },
				},
			],
		},
	});
	await delay(60);
	assert.equal(
		target.messages.some((message) => message.type === "call"),
		false,
	);
});

test("a second connection cannot replace an online session owner", async (t) => {
	const root = await fixture(t);
	const broker = new Broker(root);
	await broker.start();
	t.after(() => broker.close());
	const original = await peer(t, root);
	original.send({
		type: "sync",
		id: 1,
		session: {
			id: "target",
			cwd: root,
			device: "original",
			host: "omp",
			status: "idle",
		},
	});
	await until(() => broker.listSessions().length === 1);
	const impostor = await peer(t, root);
	impostor.send({
		type: "sync",
		id: 1,
		session: {
			id: "target",
			cwd: root,
			device: "replacement",
			host: "omp",
			status: "idle",
		},
	});
	await delay(60);
	assert.equal(broker.listSessions()[0]?.device, "original");
});

test("invalid session metadata cannot enter the broker registry", async (t) => {
	const root = await fixture(t);
	const broker = new Broker(root);
	await broker.start();
	t.after(() => broker.close());
	const invalid = await peer(t, root);
	invalid.send({
		type: "sync",
		id: -1,
		session: { id: "bad", cwd: 123, device: "test", status: "not-a-state" },
	});
	await delay(50);
	assert.deepEqual(broker.listSessions(), []);
});

test("oversized frames are rejected before invoking handlers", async (t) => {
	const root = await fixture(t);
	let received = 0;
	let serverPeer: JsonLinePeer<unknown, unknown> | undefined;
	const server = createServer((socket) => {
		serverPeer = new JsonLinePeer(
			socket,
			() => {
				received++;
			},
			() => {},
			{ maxFrameBytes: 64 },
		);
	});
	server.listen(ipcEndpoint(root));
	await once(server, "listening");
	t.after(async () => {
		serverPeer?.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const client = await peer(t, root);
	client.send({ data: "x".repeat(100) });
	await delay(50);
	assert.equal(received, 0);
});
