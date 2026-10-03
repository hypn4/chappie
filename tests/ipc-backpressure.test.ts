import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { type TestContext, test } from "node:test";
import { JsonLinePeer, type PeerLimits } from "../src/ipc.ts";
import { until, within } from "./helpers/async.ts";

async function fixture(t: TestContext, limits: PeerLimits) {
	const accepted = Promise.withResolvers<Socket>();
	const server = createServer((socket) => accepted.resolve(socket));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const client = createConnection(address.port, "127.0.0.1");
	client.on("error", () => {});
	const socket = await accepted.promise;
	const messages: unknown[] = [];
	const receiver = new JsonLinePeer<unknown, unknown>(
		client,
		(message) => {
			messages.push(message);
		},
		() => {},
	);
	const sender = new JsonLinePeer<unknown, unknown>(
		socket,
		() => {},
		() => {},
		limits,
	);
	t.after(async () => {
		sender.close();
		receiver.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return { sender, socket, messages };
}

for (const mode of ["count", "bytes"] as const) {
	test(`outbound ${mode} admission is bounded while a real socket cannot flush`, async (t) => {
		const f = await fixture(t, {
			maxFrameBytes: 128,
			maxQueuedMessages: mode === "count" ? 1 : 16,
			maxQueuedBytes: mode === "bytes" ? 32 : 1024,
		});
		f.socket.cork();
		const first = f.sender.send({ text: "한글" });
		void first.catch(() => {});
		let rejected = false;
		const overflow = f.sender.send({ text: "다음" }).then(
			() => undefined,
			(error: unknown) => {
				rejected = true;
				return error;
			},
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(
			rejected,
			true,
			"overflow must reject before the blocked socket is released",
		);
		const error = await overflow;
		assert.ok(error instanceof Error);
		assert.match(error.message, /outbound.*limit/i);
		assert.equal(
			f.sender.closed,
			false,
			"overflow must not discard previously admitted messages",
		);
		f.socket.uncork();
		await within(first, 1000, "admitted write did not drain");
		await f.sender.send({ text: "완료" });
		await until(() => f.messages.length === 2);
		assert.deepEqual(f.messages, [{ text: "한글" }, { text: "완료" }]);
	});
}

test("closing a backpressured peer settles all admitted writes and rejects new writes", async (t) => {
	const f = await fixture(t, { maxQueuedMessages: 4 });
	f.socket.cork();
	const writes = Promise.allSettled([
		f.sender.send({ sequence: 1 }),
		f.sender.send({ sequence: 2 }),
		f.sender.send({ sequence: 3 }),
	]);
	await new Promise<void>((resolve) => setImmediate(resolve));
	f.sender.close();
	const results = await within(
		writes,
		1000,
		"closed peer retained queued writes",
	);
	assert.ok(results.every((result) => result.status === "rejected"));
	await assert.rejects(f.sender.send({ sequence: 4 }), /closed/i);
});

test("repeated send bursts release capacity and preserve frame order", async (t) => {
	const f = await fixture(t, { maxQueuedMessages: 4, maxQueuedBytes: 128 });
	for (let batch = 0; batch < 64; batch++) {
		await Promise.all(
			Array.from({ length: 4 }, (_, index) =>
				f.sender.send({ sequence: batch * 4 + index }),
			),
		);
	}
	await until(() => f.messages.length === 256);
	assert.deepEqual(
		f.messages,
		Array.from({ length: 256 }, (_, sequence) => ({ sequence })),
	);
});
