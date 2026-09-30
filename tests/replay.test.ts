import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { deliveryContent, toolResultsContent } from "../src/delivery.ts";
import { historyResult } from "../src/history.ts";
import { operationIdentity } from "../src/operations.ts";
import { State } from "../src/state.ts";
import { createOmpTransferTool } from "../src/transfer.omp.ts";
import { transfer } from "../src/transfer.ts";
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

test("duplicate request IDs execute once and return a receipt instead of the result again", async (t) => {
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
	assert.ok("result" in (await first.pending));
	const duplicate = await repeated;
	assert.equal(duplicate.toolResults.length, 0);
	assert.ok("replay" in duplicate);
	const later = await f.broker.call(
		"test-chat",
		"A",
		[{ name: "read", arguments: { path: "test.txt" } }],
		"same-request",
		f.controller.signal,
	);
	assert.ok("replay" in later);
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

test("both host transfer definitions expose a stable approval-resumption operationId", async (t) => {
	const f = await sessionFixture(t);
	const piProperties = transfer.parameters.properties as Record<
		string,
		unknown
	>;
	assert.ok(piProperties.operationId);
	const ompParameters = createOmpTransferTool(f.local).parameters;
	assert.ok("properties" in ompParameters);
	const ompProperties = ompParameters.properties;
	assert.ok(
		ompProperties &&
			typeof ompProperties === "object" &&
			!Array.isArray(ompProperties),
	);
	assert.ok("operationId" in ompProperties);
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
