import assert from "node:assert/strict";
import { test } from "node:test";
import { IpcClient, JsonLinePeer, type SessionMessage } from "../src/ipc.ts";
import { until, within } from "./helpers/async.ts";
import { sessionFixture } from "./helpers/session-fixture.ts";

test("a failed broker snapshot is retransmitted after reconnect with its original owner", async (t) => {
	const f = await sessionFixture(t);
	const original = f.current;
	const resent =
		Promise.withResolvers<Extract<SessionMessage, { type: "delivery" }>>();
	const sendSession = IpcClient.prototype.send;
	t.mock.method(
		IpcClient.prototype,
		"send",
		function (this: IpcClient, message: SessionMessage) {
			if (message.type === "delivery") resent.resolve(message);
			return sendSession.call(this, message);
		},
	);
	const failedSave = t.mock.method(f.broker, "saveResponse", async () => {
		throw new Error("fixture result storage unavailable");
	});
	const { pending } = await f.queue("snapshot-failure");
	await f.complete(await f.dispatch());
	assert.ok("error" in (await pending));
	failedSave.mock.restore();
	await f.switchTo("B");
	await f.reconnect();
	const { delivery } = await within(
		resent.promise,
		1500,
		"The completed native result was lost after broker storage failed",
	);
	await until(() => f.broker.deliveries("test-chat").length === 1);
	assert.equal(delivery.sessionId, "A");
	assert.equal(delivery.cwd, original.cwd);
	assert.equal(delivery.requestId, "snapshot-failure");
	assert.equal(delivery.id, `operation:${delivery.executionId}`);
	assert.deepEqual(delivery.toolResults[0]?.content, [
		{ type: "text", text: "completed" },
	]);
	assert.equal(f.broker.deliveries("another-chat").length, 0);
});

test("a lost storage acknowledgement resends the result without repeating execution", {
	timeout: 8500,
}, async (t) => {
	const f = await sessionFixture(t);
	let dropStored = true;
	let resultSends = 0;
	const resent =
		Promise.withResolvers<Extract<SessionMessage, { type: "delivery" }>>();
	const acknowledged = Promise.withResolvers<void>();
	const send = JsonLinePeer.prototype.send;
	t.mock.method(
		JsonLinePeer.prototype,
		"send",
		function (this: JsonLinePeer<unknown, unknown>, message: unknown) {
			if (
				message &&
				typeof message === "object" &&
				"type" in message &&
				message.type === "stored"
			) {
				if (dropStored) return Promise.resolve();
				acknowledged.resolve();
			}
			return send.call(this, message);
		},
	);
	const sendSession = IpcClient.prototype.send;
	t.mock.method(
		IpcClient.prototype,
		"send",
		function (this: IpcClient, message: SessionMessage) {
			if (message.type === "result" && "toolResults" in message) resultSends++;
			if (message.type === "delivery") {
				dropStored = false;
				resent.resolve(message);
			}
			return sendSession.call(this, message);
		},
	);
	const { pending } = await f.queue("lost-storage-ack");
	await f.complete(await f.dispatch());
	assert.ok("result" in (await pending));
	const { delivery } = await within(
		resent.promise,
		6500,
		"The unacknowledged native result was not retransmitted",
	);
	assert.equal(delivery.id, `operation:${delivery.executionId}`);
	assert.equal(delivery.requestId, "lost-storage-ack");
	assert.deepEqual(delivery.toolResults[0]?.content, [
		{ type: "text", text: "completed" },
	]);
	await within(
		acknowledged.promise,
		1000,
		"The retransmitted result was not acknowledged",
	);
	assert.equal(resultSends, 1);
});

test("a call without a transport request ID is durably acknowledged before reconnect", async (t) => {
	const f = await sessionFixture(t);
	let deliveries = 0;
	const stored = Promise.withResolvers<string>();
	const send = JsonLinePeer.prototype.send;
	t.mock.method(
		JsonLinePeer.prototype,
		"send",
		function (this: JsonLinePeer<unknown, unknown>, message: unknown) {
			if (message && typeof message === "object" && "type" in message) {
				if (
					message.type === "stored" &&
					"id" in message &&
					typeof message.id === "string"
				)
					stored.resolve(message.id);
				if (message.type === "delivery") deliveries++;
			}
			return send.call(this, message);
		},
	);
	const pending = f.broker.call(
		"test-chat",
		"A",
		[{ name: "read", arguments: { path: "test.txt" } }],
		undefined,
		f.controller.signal,
	);
	const output = await f.dispatch();
	await until(() => output.closed);
	await f.complete(output);
	assert.equal((await pending).toolResults.length, 1);
	const storedId = await within(
		stored.promise,
		1000,
		"Broker did not acknowledge durable storage",
	);
	assert.match(
		storedId,
		/^operation:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
	// Inspect crosses the same ordered IPC connection after the stored frame.
	await f.broker.tools(
		"test-chat",
		"A",
		["read"],
		"ack-barrier",
		f.controller.signal,
	);
	await f.reconnect();
	await f.broker.tools(
		"test-chat",
		"A",
		["read"],
		"reconnect-barrier",
		f.controller.signal,
	);
	assert.equal(deliveries, 0);
	assert.equal(f.broker.deliveries("test-chat").length, 0);
});

test("waiting for storage acknowledgement does not block the next native batch", async (t) => {
	const f = await sessionFixture(t);
	const gate = Promise.withResolvers<void>();
	const saving = Promise.withResolvers<void>();
	const saveResponse = f.broker.saveResponse.bind(f.broker);
	let first = true;
	t.mock.method(
		f.broker,
		"saveResponse",
		async (chatId: string, text: string) => {
			if (first) {
				first = false;
				saving.resolve();
				await gate.promise;
			}
			return saveResponse(chatId, text);
		},
	);
	try {
		const slow = await f.queue("slow-storage");
		await within(
			f.complete(await f.dispatch()),
			500,
			"OMP waited for broker storage",
		);
		await saving.promise;
		const next = await f.queue("next-during-storage");
		await f.complete(await f.dispatch());
		assert.ok("result" in (await next.pending));
		gate.resolve();
		assert.ok("result" in (await slow.pending));
	} finally {
		gate.resolve();
	}
});

test("an error-only result keeps partial native output for delivery recovery", async (t) => {
	const f = await sessionFixture(t);
	const resent =
		Promise.withResolvers<Extract<SessionMessage, { type: "delivery" }>>();
	const sendSession = IpcClient.prototype.send;
	t.mock.method(
		IpcClient.prototype,
		"send",
		function (this: IpcClient, message: SessionMessage) {
			if (message.type === "delivery") resent.resolve(message);
			return sendSession.call(this, message);
		},
	);
	const { pending } = await f.queue("partial-result", [
		{ name: "read", arguments: { path: "first.txt" } },
		{ name: "read", arguments: { path: "second.txt" } },
	]);
	const output = await f.dispatch();
	const call = output.message.content.find(
		(block) => block.type === "toolCall",
	);
	assert.ok(call?.type === "toolCall");
	await f.emit("turn_end", {
		message: structuredClone(output.message),
		toolResults: [
			{
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: "completed first call" }],
				isError: false,
				timestamp: Date.now(),
			},
		],
	});
	assert.ok("error" in (await pending));
	await f.reconnect();
	const { delivery } = await within(
		resent.promise,
		1500,
		"The error response discarded the native batch's partial output",
	);
	assert.equal(delivery.complete, true);
	assert.match(delivery.error ?? "", /No results for calls 2/);
	assert.deepEqual(delivery.toolResults[0]?.content, [
		{ type: "text", text: "completed first call" },
	]);
	await until(() => f.broker.deliveries("test-chat").length === 1);
});
