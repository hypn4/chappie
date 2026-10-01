import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import * as z from "zod";
import { deliveryContent, toolResultsContent } from "../src/delivery.ts";
import { historyResult } from "../src/history.ts";
import { operationIdentity } from "../src/operations.ts";
import { questionInput } from "../src/questions.ts";
import { State } from "../src/state.ts";
import { createOmpTransferTool } from "../src/transfer.omp.ts";
import { transferSchema } from "../src/transfer.ts";
import { sessionFixture } from "./helpers/session-fixture.ts";

const transferResult: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "transfer-1",
	toolName: "transfer",
	isError: false,
	timestamp: 1,
	content: [{ type: "text", text: "export registered" }],
	details: {
		resources: [
			{
				uri: "chappie://session/A/file/one/file.txt",
				name: "file.txt",
				mimeType: "text/plain",
				size: 1,
			},
		],
	},
};

test("history does not reactivate attachments when the same export is read repeatedly", () => {
	const branch = [
		{
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: new Date(1).toISOString(),
			message: transferResult,
		},
	] as SessionEntry[];
	for (let index = 0; index < 3; index++) {
		const result = historyResult(branch, "A", { limit: 20 });
		assert.equal(
			result.content.filter((block) => block.type === "resource_link").length,
			0,
		);
		assert.match(JSON.stringify(result.content), /file.txt/);
	}
	assert.equal(
		toolResultsContent([transferResult], "A").filter(
			(block) => block.type === "resource_link",
		).length,
		1,
	);
});

test("deferred results are references, not a new attachment approval", () => {
	const blocks = deliveryContent([
		{
			id: "delivery-1",
			chatId: "chat",
			sessionId: "A",
			cwd: "/fixture",
			toolResults: [transferResult],
		},
	]);
	assert.equal(
		blocks.filter((block) => block.type === "resource_link").length,
		0,
	);
	assert.match(JSON.stringify(blocks), /file.txt/);
});

test("concurrent retries share one native execution and the completed result", async (t) => {
	const f = await sessionFixture(t);
	const first = await f.queue("same-request");
	const repeated = f.broker.call(
		"test-chat",
		"A",
		[{ name: "read", arguments: { path: "test.txt" } }],
		"same-request",
		f.controller.signal,
	);
	const output = await f.dispatch();
	await f.complete(output);
	const original = await first.pending;
	assert.ok("result" in original);
	const duplicate = await repeated;
	assert.equal(duplicate.toolResults.length, 1);
	assert.equal(duplicate.replay, undefined);
	const later = await f.broker.call(
		"test-chat",
		"A",
		[{ name: "read", arguments: { path: "test.txt" } }],
		"same-request",
		f.controller.signal,
	);
	assert.equal(later.toolResults.length, 0);
	assert.equal(later.replay?.status, "completed");
});

test("cancelling one concurrent retry keeps the shared native execution alive", async (t) => {
	const f = await sessionFixture(t);
	const firstController = new AbortController();
	const secondController = new AbortController();
	const calls = [{ name: "read", arguments: { path: "test.txt" } }];
	const first = f.broker.call(
		"test-chat",
		"A",
		calls,
		"shared-cancel",
		firstController.signal,
	);
	const second = f.broker.call(
		"test-chat",
		"A",
		calls,
		"shared-cancel",
		secondController.signal,
	);
	const output = await f.dispatch();
	const reason = new Error("first transport cancelled");
	firstController.abort(reason);
	await assert.rejects(first, (error) => error === reason);
	await f.complete(output);
	const completed = await second;
	assert.equal(completed.toolResults.length, 1);
	const replay = await f.broker.call(
		"test-chat",
		"A",
		calls,
		"shared-cancel",
		f.controller.signal,
	);
	assert.equal(replay.replay?.status, "completed");
});

test("completed request receipts survive a broker restart", async (t) => {
	const f = await sessionFixture(t);
	const first = await f.queue("completed-request");
	const output = await f.dispatch();
	await f.complete(output);
	await first.pending;
	await f.reconnect();
	const duplicate = await f.broker.call(
		"test-chat",
		"A",
		[{ name: "read", arguments: { path: "test.txt" } }],
		"completed-request",
		f.controller.signal,
	);
	assert.ok("replay" in duplicate);
	assert.equal(duplicate.toolResults.length, 0);
});

test("an operation ID reused with different arguments is rejected", async (t) => {
	const f = await sessionFixture(t);
	const first = await f.queue("immutable-request");
	const output = await f.dispatch();
	await f.complete(output);
	await first.pending;
	await assert.rejects(
		f.broker.call(
			"test-chat",
			"A",
			[{ name: "read", arguments: { path: "other.txt" } }],
			"immutable-request",
			AbortSignal.timeout(200),
		),
		/different|conflict|reuse/i,
	);
});

test("new request IDs keep intentional repeated work independent", async (t) => {
	const f = await sessionFixture(t);
	for (const id of ["intent-one", "intent-two"]) {
		const first = await f.queue(id);
		const output = await f.dispatch();
		await f.complete(output);
		const outcome = await first.pending;
		assert.ok("result" in outcome);
		assert.equal(outcome.result.toolResults.length, 1);
	}
});

test("native transfer uses the single stable operation schema", async (t) => {
	const f = await sessionFixture(t);
	assert.deepEqual(
		createOmpTransferTool(f.local).parameters,
		z.toJSONSchema(transferSchema, { io: "input" }),
	);
	assert.ok(transferSchema.shape.operationId);
});

test("logical transfer identity survives changing transport request IDs and signed URLs", () => {
	const calls = (url: string) => [
		{
			name: "transfer",
			arguments: {
				operationId: "logical-export",
				paths: ["target"],
				files: [{ file_id: "file-a", download_url: url }],
			},
		},
	];
	assert.deepEqual(
		operationIdentity(
			"chat",
			"A",
			"call",
			"request-1",
			calls("https://host.invalid/one"),
		),
		operationIdentity(
			"chat",
			"A",
			"call",
			"request-2",
			calls("https://host.invalid/two"),
		),
	);
	assert.notDeepEqual(
		operationIdentity(
			"chat",
			"A",
			"call",
			"request-1",
			calls("https://host.invalid/one"),
		),
		operationIdentity(
			"other-chat",
			"A",
			"call",
			"request-1",
			calls("https://host.invalid/one"),
		),
	);
});

test("explicit detached operation identity is stable across transport request IDs", () => {
	const calls = [{ name: "read", arguments: { path: "file.txt" } }];
	const first = operationIdentity(
		"chat",
		"A",
		"call",
		"request-one",
		calls,
		"long-read",
	);
	const second = operationIdentity(
		"chat",
		"A",
		"call",
		"request-two",
		calls,
		"long-read",
	);
	assert.deepEqual(first, second);
	assert.equal(first?.operationId, "long-read");
	assert.equal(
		operationIdentity(
			"chat",
			"A",
			"call",
			"request-three",
			[{ name: "read", arguments: { path: "other.txt" } }],
			"long-read",
		)?.key,
		first?.key,
	);
	assert.notEqual(
		operationIdentity("chat", "B", "call", "request-four", calls, "long-read")
			?.key,
		first?.key,
	);
});

test("unfinished operations remain uncertain after restart rather than being retried", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-receipt-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = new State(root);
	const receipt = {
		key: "key",
		signature: "signature",
		chatId: "chat",
		sessionId: "A",
		cwd: root,
		status: "running" as const,
		updatedAt: Date.now(),
	};
	assert.equal(await state.reserveOperation(receipt), undefined);
	const resumed = new State(root);
	await resumed.load();
	assert.equal((await resumed.reserveOperation(receipt))?.status, "uncertain");
});

test("detached operation failures persist and late delivery cannot overwrite them", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-operation-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = new State(root);
	const receipt = {
		key: "detached-key",
		operationId: "detached-op",
		signature: "signature",
		chatId: "chat",
		sessionId: "A",
		cwd: root,
		status: "running" as const,
		updatedAt: Date.now(),
	};
	assert.equal(await state.reserveOperation(receipt), undefined);
	await state.finishOperation("detached-key", "failed", [], "native failure");
	await state.addDelivery({
		id: "detached-result",
		chatId: "chat",
		operationKey: "detached-key",
		sessionId: "A",
		cwd: root,
		toolResults: [],
		complete: true,
	});
	assert.equal(state.operation("chat", "detached-op").status, "failed");
	assert.equal(state.operation("chat", "detached-op").error, "native failure");

	const resumed = new State(root);
	await resumed.load();
	assert.equal(resumed.operation("chat", "detached-op").status, "failed");
	assert.equal(
		resumed.deliveriesForOperation("chat", "detached-key").length,
		1,
	);
});

test("detached operation IDs cannot be reused across sessions in one conversation", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-operation-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = new State(root);
	await state.reserveOperation({
		key: "key-a",
		operationId: "same-id",
		signature: "sig-a",
		chatId: "chat",
		sessionId: "A",
		cwd: root,
		status: "running",
		updatedAt: Date.now(),
	});
	await assert.rejects(
		state.reserveOperation({
			key: "key-b",
			operationId: "same-id",
			signature: "sig-b",
			chatId: "chat",
			sessionId: "B",
			cwd: root,
			status: "running",
			updatedAt: Date.now(),
		}),
		/another session|identifier/i,
	);
});

test("acknowledged deferred results are not resurrected by delivery retries", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-receipt-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = new State(root);
	const delivery = {
		id: "stable-delivery",
		chatId: "chat",
		sessionId: "A",
		cwd: root,
		toolResults: [transferResult],
	};
	await state.addDelivery(delivery);
	await state.acknowledge([delivery], [], new AbortController().signal);
	const resumed = new State(root);
	await resumed.load();
	await resumed.addDelivery(delivery);
	assert.deepEqual(resumed.deliveries("chat"), []);
});

test("failed persistence rolls back bindings and saved questions", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-state-failure-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const parent = join(root, "not-a-directory");
	await writeFile(parent, "fixture");
	const state = new State(join(parent, "agent"));

	await assert.rejects(state.bind("chat", "A"));
	assert.equal(state.binding("chat"), undefined);
	await assert.rejects(
		state.addQuestion({
			id: "q",
			sessionId: "A",
			cwd: root,
			chatId: "chat",
			question: "Question?",
			options: [],
			allowMultiple: false,
			delivered: false,
		}),
	);
	assert.throws(() => state.question("chat", "q"), /not found/i);
});

test("question input is bounded and old delivered questions are pruned", async (t) => {
	assert.throws(
		() => questionInput.parse({ question: "x".repeat(4097) }),
		/too big|4096/i,
	);
	const root = await mkdtemp(join(tmpdir(), "chappie-question-retention-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const questions = Array.from({ length: 1024 }, (_, i) => ({
		id: `q-${i}`,
		sessionId: "A",
		cwd: root,
		chatId: "chat",
		question: "Question?",
		options: [],
		allowMultiple: false,
		delivered: true,
	}));
	await writeFile(
		join(root, "chappie.state.json"),
		JSON.stringify({ questions }),
	);
	const state = new State(root);
	await state.load();
	await state.addQuestion({
		id: "new-question",
		sessionId: "A",
		cwd: root,
		chatId: "chat",
		question: "New question?",
		options: [],
		allowMultiple: false,
		delivered: false,
	});
	assert.equal(state.question("chat", "new-question").id, "new-question");
});

test("current bindings persist active touches and prune after 30 idle days", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-binding-retention-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const day = 24 * 60 * 60 * 1000;
	let now = 2_000_000_000_000;
	t.mock.method(Date, "now", () => now);
	await writeFile(
		join(root, "chappie.state.json"),
		JSON.stringify({
			bindings: {
				recent: { sessionId: "recent-session", lastUsedAt: now },
				stale: {
					sessionId: "stale-session",
					lastUsedAt: now - 31 * day,
				},
				fresh: {
					sessionId: "fresh-session",
					lastUsedAt: now - 29 * day,
				},
			},
		}),
	);
	const state = new State(root);
	await state.load();
	let saved = JSON.parse(
		await readFile(join(root, "chappie.state.json"), "utf8"),
	);
	assert.equal(saved.bindings.stale, undefined);
	assert.equal(saved.bindings.recent.sessionId, "recent-session");

	assert.equal(state.binding("fresh"), "fresh-session");
	await state.confirmBindingUse("fresh", "fresh-session");
	saved = JSON.parse(await readFile(join(root, "chappie.state.json"), "utf8"));
	assert.equal(saved.bindings.fresh.lastUsedAt, now);

	now += 2 * day;
	const restarted = new State(root);
	await restarted.load();
	assert.equal(restarted.binding("fresh"), "fresh-session");
	await restarted.bind("new", "new-session");
	saved = JSON.parse(await readFile(join(root, "chappie.state.json"), "utf8"));
	assert.equal(saved.bindings.new.sessionId, "new-session");
});

test("using a binding prevents an older initialization rollback from clearing it", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-binding-adoption-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = new State(root);
	const mutation = await state.bind("chat", "A");
	await state.confirmBindingUse("chat", "A");
	await state.restoreBinding("chat", mutation);
	assert.equal(state.binding("chat"), "A");
});
