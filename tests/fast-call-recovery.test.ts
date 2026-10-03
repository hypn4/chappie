import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { mcpClient, record, resultOf } from "./helpers/mcp-client.ts";
import { sessionFixture } from "./helpers/session-fixture.ts";

function metadata(response: Record<string, unknown>) {
	assert.notEqual(
		response.isError,
		true,
		`Expected a successful recovery response: ${JSON.stringify(response.content)}`,
	);
	assert.ok(Array.isArray(response.content));
	const block = record(response.content[0]);
	assert.equal(typeof block.text, "string");
	return record(JSON.parse(block.text as string));
}

const calls = [{ name: "read", arguments: { path: "test.txt" } }];

test("a fast native result has a durable disk snapshot without a duplicate pending delivery", async (t) => {
	const f = await sessionFixture(t);
	const queued = await f.queue("fast-recovery");
	await f.complete(await f.dispatch());
	const returned = await queued.pending;
	assert.ok("result" in returned);
	const operation = returned.result.operation;
	assert.ok(
		operation?.resultId,
		"fast completion must expose a recoverable result, not only transient output",
	);
	assert.equal(operation.status, "completed");
	assert.equal(returned.result.toolResults.length, 1);
	assert.equal(f.broker.deliveries("test-chat").length, 0);
	const snapshot = JSON.parse(
		await f.broker.readResponse("test-chat", operation.resultId),
	);
	assert.match(JSON.stringify(snapshot.content), /completed/);
	assert.equal(snapshot.isError, false);
	const state = JSON.parse(
		await readFile(join(f.root, "chappie.state.json"), "utf8"),
	);
	assert.equal(
		state.operationResults?.length ?? 0,
		0,
		"fast bodies must not enter the hot state ledger",
	);
	await f.reconnect();
	assert.equal(
		f.broker.operation("test-chat", operation.operationId).operation.resultId,
		operation.resultId,
	);
	assert.deepEqual(
		JSON.parse(await f.broker.readResponse("test-chat", operation.resultId)),
		snapshot,
	);
	await assert.rejects(
		f.broker.readResponse("another-chat", operation.resultId),
		/not found|expired/,
	);
});

test("after a successful response is lost, a new connection discovers the owned receipt without executing again", async (t) => {
	const f = await sessionFixture(t);
	const first = mcpClient(t, f.broker);
	const pending = first.call(
		"call",
		{ sessionId: "A", calls },
		{ chatId: "test-chat" },
	);
	const output = await f.dispatch();
	await f.complete(output);
	await pending; // Local send succeeds, but the controller loses this response and its IDs.
	await first.close();
	await f.reconnect();
	const next = mcpClient(t, f.broker);
	const listing = metadata(
		resultOf(
			await next.call(
				"get_operation",
				{ sessionId: "A" },
				{ chatId: "test-chat" },
			),
		),
	);
	assert.ok(
		Array.isArray(listing.operations),
		"recovery must not require the ID in the lost response",
	);
	assert.equal(listing.operations.length, 1);
	const discovered = record(listing.operations[0]);
	assert.equal(discovered.status, "completed");
	assert.equal(typeof discovered.operationId, "string");
	const recovered = metadata(
		resultOf(
			await next.call(
				"get_operation",
				{ operationId: discovered.operationId },
				{ chatId: "test-chat" },
			),
		),
	);
	const operation = record(recovered.operation);
	assert.equal(typeof operation.resultId, "string");
	const page = metadata(
		resultOf(
			await next.call(
				"get_operation",
				{ resultId: operation.resultId, offset: 0 },
				{ chatId: "test-chat" },
			),
		),
	);
	assert.equal(page.hasMore, false);
	assert.match(String(page.text), /completed/);
	const foreign = metadata(
		resultOf(
			await next.call(
				"get_operation",
				{ sessionId: "A" },
				{ chatId: "another-chat" },
			),
		),
	);
	assert.deepEqual(foreign.operations, []);
	assert.equal(f.aborts, 0);
	assert.equal(f.broker.deliveries("test-chat").length, 0);
});

test("snapshot storage failure leaves a completed receipt to reconcile instead of inviting replay", async (t) => {
	const f = await sessionFixture(t);
	await writeFile(join(f.root, "chappie.results"), "not a directory");
	const queued = await f.queue("disk-failure");
	await f.complete(await f.dispatch());
	const returned = await queued.pending;
	assert.ok(
		"error" in returned,
		"a missing recovery snapshot must be reported",
	);
	assert.match(returned.error, /completed|already executed/i);
	assert.match(returned.error, /Recovery operation: call-/);
	const client = mcpClient(t, f.broker);
	const listing = metadata(
		resultOf(
			await client.call(
				"get_operation",
				{ sessionId: "A" },
				{ chatId: "test-chat" },
			),
		),
	);
	assert.ok(Array.isArray(listing.operations));
	assert.equal(record(listing.operations[0]).status, "completed");
	assert.equal(record(listing.operations[0]).resultId, undefined);
});

test("a failed stdio write can be recovered without replay and unrelated requests do not consume the snapshot", async (t) => {
	const f = await sessionFixture(t);
	const client = mcpClient(t, f.broker);
	client.failNextSend();
	const pending = client.call(
		"call",
		{ sessionId: "A", calls },
		{ chatId: "test-chat" },
	);
	const failed = assert.rejects(pending, /simulated send failure/);
	await f.complete(await f.dispatch());
	await failed;
	const wakes = t.mock.method(f.api, "sendMessage", () => {});
	const recent = f.broker.recentOperations("test-chat", "A");
	assert.equal(recent.operations.length, 1);
	const operation = recent.operations[0];
	assert.ok(operation?.resultId);
	const text = await f.broker.readResponse("test-chat", operation.resultId);
	await client.call("sessions", {}, { chatId: "test-chat" });
	assert.equal(
		await f.broker.readResponse("test-chat", operation.resultId),
		text,
	);
	const replay = await f.broker.call(
		"test-chat",
		"A",
		calls,
		"test-1",
		f.controller.signal,
	);
	assert.equal(replay.replay?.status, "completed");
	assert.equal(replay.operation?.resultId, operation.resultId);
	const initialized = await f.broker.initialize(
		"test-chat",
		"A",
		"reconnect-discovery",
		f.controller.signal,
	);
	assert.equal(
		initialized.recovery?.operations[0]?.operationId,
		operation.operationId,
	);
	assert.equal(
		wakes.mock.callCount(),
		0,
		"recovery is read-only, not another native invocation",
	);
});

test("failed native output is preserved without raw private tool details", async (t) => {
	const f = await sessionFixture(t);
	const queued = await f.queue("native-error-snapshot");
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
				toolName: "read",
				timestamp: Date.now(),
				isError: true,
				content: [{ type: "text", text: "검증 실패: expected error" }],
				details: { oldText: "PRIVATE_OLD_CONTENT" },
			},
		],
	});
	const returned = await queued.pending;
	assert.ok("result" in returned);
	assert.equal(returned.result.operation?.status, "completed");
	assert.ok(returned.result.operation?.resultId);
	const saved = await f.broker.readResponse(
		"test-chat",
		returned.result.operation.resultId,
	);
	const snapshot = JSON.parse(saved);
	assert.equal(snapshot.isError, true);
	assert.match(saved, /검증 실패/);
	assert.doesNotMatch(saved, /PRIVATE_OLD_CONTENT/);
});

test("recent receipt discovery validates selectors and never changes the default session", async (t) => {
	const f = await sessionFixture(t);
	const client = mcpClient(t, f.broker);
	const invalid = [
		{},
		{ sessionId: "A", operationId: "x" },
		{ sessionId: "A", offset: 0 },
		{ operationId: "x", limit: 1 },
		{ sessionId: "A", limit: 0 },
		{ sessionId: "A", limit: 21 },
	];
	for (const args of invalid) {
		const response = await client.call("get_operation", args, {
			chatId: "test-chat",
		});
		assert.ok("error" in response || resultOf(response).isError === true);
	}
	const response = metadata(
		resultOf(
			await client.call(
				"get_operation",
				{ sessionId: "offline-session" },
				{ chatId: "test-chat" },
			),
		),
	);
	assert.deepEqual(response.operations, []);
	assert.equal(response.scope, "recent");
	assert.equal(response.hasOlder, false);
	assert.equal(f.broker.binding("test-chat"), "A");
});
