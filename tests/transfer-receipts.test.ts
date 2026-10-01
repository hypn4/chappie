import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { operationIdentity } from "../src/operations.ts";
import { type ResourceDescriptor, registerFile } from "../src/resources.ts";
import { State } from "../src/state.ts";
import { toolResult } from "../src/tools.ts";
import {
	multiSessionFixture,
	sessionFixture,
} from "./helpers/session-fixture.ts";

async function exportedFixture(t: TestContext) {
	const f = await sessionFixture(t);
	const path = join(f.root, "export.txt");
	await writeFile(path, "original bytes");
	const resource = await registerFile("A", path);
	const calls = [
		{
			name: "transfer",
			arguments: { operationId: "export-once", paths: [path] },
		},
	];
	const pending = f.broker.call(
		"test-chat",
		"A",
		calls,
		"original",
		f.controller.signal,
	);
	const output = await f.dispatch();
	const call = output.message.content.find(
		(block) => block.type === "toolCall",
	);
	if (!call) throw new Error("Expected native export");
	await f.emit("turn_end", {
		message: structuredClone(output.message),
		toolResults: [
			{
				role: "toolResult",
				toolCallId: call.id,
				toolName: "transfer",
				isError: false,
				timestamp: Date.now(),
				content: [{ type: "text", text: "exported" }],
				details: { resources: [resource] },
			},
		],
	});
	await f.emit("agent_end", { willContinue: false });
	await pending;
	const replay = () =>
		f.broker.call(
			"test-chat",
			"A",
			calls,
			"approval-resumed",
			f.controller.signal,
		);
	return {
		...f,
		get broker() {
			return f.broker;
		},
		path,
		resource,
		calls,
		replay,
	};
}

test("completed export replay re-exposes the unread original resource without re-executing", async (t) => {
	const f = await exportedFixture(t);
	const repeated = await f.replay();
	assert.equal(repeated.replay?.status, "completed");
	assert.deepEqual(repeated.toolResults, []);
	assert.deepEqual(repeated.replay?.delivery?.resources, [f.resource]);
	const wire = toolResult([], "A", f.root, [], undefined, repeated.replay);
	const links = wire.content.filter((block) => block.type === "resource_link");
	assert.equal(links.length, 1);
	assert.equal(links[0]?.uri, f.resource.uri);
	assert.equal(repeated.replay?.replayed, true);
});

test("unread export resources survive a broker restart and replay the same link", async (t) => {
	const f = await exportedFixture(t);
	await f.reconnect();
	const repeated = await f.replay();
	assert.deepEqual(repeated.replay?.delivery?.resources, [f.resource]);
	assert.equal(repeated.toolResults.length, 0);
	const wire = toolResult([], "A", f.root, [], undefined, repeated.replay);
	const links = wire.content.filter((block) => block.type === "resource_link");
	assert.equal(links.length, 1);
	assert.equal(links[0]?.uri, f.resource.uri);
	assert.equal("instructions" in (repeated.replay ?? {}), false);
});

test("resource reads stop automatic replay attachment without suppressing completion", async (t) => {
	const f = await exportedFixture(t);
	const before = Date.now();
	const bytes = await f.broker.readResource(
		`${f.resource.uri}?chatId=test-chat`,
		f.controller.signal,
	);
	assert.equal(Buffer.from(bytes.blob, "base64").toString(), "original bytes");
	const repeated = await f.replay();
	const resource = repeated.replay?.delivery?.resources[0];
	assert.equal(resource?.uri, f.resource.uri);
	assert.ok(
		resource?.sourceReadAt !== undefined && resource.sourceReadAt >= before,
	);
	const wire = toolResult([], "A", f.root, [], undefined, repeated.replay);
	assert.equal(
		wire.content.filter((block) => block.type === "resource_link").length,
		0,
	);
	assert.equal(repeated.replay?.replayed, true);
	await f.reconnect();
	const afterRestart = await f.replay();
	assert.equal(
		afterRestart.replay?.delivery?.resources[0]?.sourceReadAt,
		resource.sourceReadAt,
	);
	const replayWire = toolResult(
		[],
		"A",
		f.root,
		[],
		undefined,
		afterRestart.replay,
	);
	assert.equal(
		replayWire.content.filter((block) => block.type === "resource_link").length,
		0,
	);
});

test("failed or unscoped resource reads cannot acknowledge a chat's exported bytes", async (t) => {
	const f = await exportedFixture(t);
	await f.broker.readResource(f.resource.uri, f.controller.signal);
	await f.broker.readResource(
		`${f.resource.uri}?chatId=other-chat`,
		f.controller.signal,
	);
	const first = await f.replay();
	assert.deepEqual(first.replay?.delivery?.resources, [f.resource]);
	await writeFile(f.path, "changed");
	await assert.rejects(
		f.broker.readResource(
			`${f.resource.uri}?chatId=test-chat`,
			f.controller.signal,
		),
		/changed/,
	);
	assert.deepEqual((await f.replay()).replay?.delivery?.resources, [
		f.resource,
	]);
});

test("late export results retain references even after their delivery record is acknowledged", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ch-recovery-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = new State(root);
	const identity = operationIdentity("chat", "A", "call", "request", [
		{ name: "transfer", arguments: { operationId: "late", paths: ["a"] } },
	]);
	assert.ok(identity);
	const receipt = {
		...identity,
		chatId: "chat",
		sessionId: "A",
		cwd: root,
		status: "running" as const,
		updatedAt: Date.now(),
	};
	await state.reserveOperation(receipt);
	const resource: ResourceDescriptor = {
		uri: "chappie://session/A/file/late/a",
		name: "a",
		mimeType: "text/plain",
		size: 1,
	};
	const delivery = {
		id: "late-result",
		operationKey: identity.key,
		chatId: "chat",
		sessionId: "A",
		cwd: root,
		complete: true,
		toolResults: [
			{
				role: "toolResult" as const,
				toolCallId: "t",
				toolName: "transfer",
				timestamp: 1,
				isError: false,
				content: [{ type: "text" as const, text: "done" }],
				details: { resources: [resource] },
			},
		],
	};
	await state.addDelivery(delivery);
	await state.acknowledge([delivery], [], new AbortController().signal);
	const loaded = new State(root);
	await loaded.load();
	const restored = await loaded.reserveOperation(receipt);
	assert.deepEqual(restored?.resources, [resource]);
	assert.deepEqual(loaded.deliveries("chat"), []);
});

test("a failed acknowledgement cannot revive a delivery consumed by another response", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ch-ack-race-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const delivery = {
		id: "delivery-race",
		chatId: "chat",
		sessionId: "A",
		cwd: root,
		complete: true,
		toolResults: [],
	};
	await writeFile(
		join(root, "chappie.state.json"),
		JSON.stringify({ deliveries: [delivery] }),
	);
	const state = new State(root);
	await state.load();
	const cancelled = new AbortController();
	const first = state.acknowledge([delivery], [], cancelled.signal);
	const second = state.acknowledge(
		[delivery],
		[],
		new AbortController().signal,
	);
	queueMicrotask(() => cancelled.abort(new Error("first response cancelled")));
	const [firstResult, secondResult] = await Promise.allSettled([first, second]);
	assert.equal(firstResult.status, "rejected");
	assert.equal(secondResult.status, "fulfilled");
	assert.deepEqual(state.deliveries("chat"), []);
	const restored = new State(root);
	await restored.load();
	assert.deepEqual(restored.deliveries("chat"), []);
});

test("legacy completion receipts never claim host delivery or fabricate resource references", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ch-recovery-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const legacy = {
		key: "legacy",
		signature: "sig",
		chatId: "chat",
		sessionId: "A",
		cwd: root,
		status: "completed" as const,
		updatedAt: Date.now(),
	};
	await writeFile(
		join(root, "chappie.state.json"),
		JSON.stringify({ operations: [legacy] }),
	);
	const state = new State(root);
	await state.load();
	assert.deepEqual(await state.reserveOperation(legacy), legacy);
	const stored = JSON.parse(
		await readFile(join(root, "chappie.state.json"), "utf8"),
	);
	assert.equal(stored.operations[0].resources, undefined);
});

test("replay metadata is an independent snapshot, not a mutable state handle", async (t) => {
	const f = await exportedFixture(t);
	const first = await f.replay();
	const entry = first.replay?.delivery?.resources[0];
	assert.ok(entry);
	entry.uri = "chappie://session/A/file/forged/forged.txt";
	assert.deepEqual((await f.replay()).replay?.delivery?.resources, [
		f.resource,
	]);
});

test("transfer.from retrieves a source session file into the selected session", async (t) => {
	const f = await multiSessionFixture(t);
	const source = f.session("A");
	const destination = f.session("B");
	await writeFile(join(source.cwd, "source.txt"), "source bytes");
	const result = await destination.local.transfer(
		{
			operationId: "pull-one",
			paths: ["copied.txt"],
			from: { sessionId: "A", paths: ["source.txt"] },
		},
		f.controller.signal,
		undefined,
		{ sessionId: "B", cwd: destination.cwd },
	);
	assert.equal(
		await readFile(join(destination.cwd, "copied.txt"), "utf8"),
		"source bytes",
	);
	assert.equal(result.isError, false);
	assert.equal(result.details.from?.sessionId, "A");
});

test("transfer.from preserves partial successes and existing destinations", async (t) => {
	const f = await multiSessionFixture(t);
	const source = f.session("A");
	const destination = f.session("B");
	await writeFile(join(source.cwd, "first.txt"), "FIRST");
	await writeFile(join(source.cwd, "second.txt"), "SECOND");
	await writeFile(join(destination.cwd, "blocked.txt"), "ORIGINAL");
	const result = await destination.local.transfer(
		{
			operationId: "pull-partial",
			paths: ["blocked.txt", "copied.txt"],
			from: {
				sessionId: "A",
				paths: ["first.txt", "second.txt"],
			},
		},
		f.controller.signal,
		undefined,
		{ sessionId: "B", cwd: destination.cwd },
	);
	assert.equal(result.isError, true);
	assert.equal(
		await readFile(join(destination.cwd, "blocked.txt"), "utf8"),
		"ORIGINAL",
	);
	assert.equal(
		await readFile(join(destination.cwd, "copied.txt"), "utf8"),
		"SECOND",
	);
});

test("transfer.from overwrite replaces only completed destinations", async (t) => {
	const f = await multiSessionFixture(t);
	const source = f.session("A");
	const destination = f.session("B");
	await writeFile(join(source.cwd, "source.txt"), "NEW");
	await writeFile(join(destination.cwd, "target.txt"), "OLD");
	const result = await destination.local.transfer(
		{
			operationId: "pull-overwrite",
			paths: ["target.txt"],
			from: { sessionId: "A", paths: ["source.txt"] },
			overwrite: true,
		},
		f.controller.signal,
		undefined,
		{ sessionId: "B", cwd: destination.cwd },
	);
	assert.equal(result.isError, false);
	assert.equal(
		await readFile(join(destination.cwd, "target.txt"), "utf8"),
		"NEW",
	);
});

test("transfer.from operation identity survives transport retries but binds the source", () => {
	const call = (source: string, path: string) => [
		{
			name: "transfer",
			arguments: {
				operationId: "pull-stable",
				paths: ["target.txt"],
				from: { sessionId: source, paths: [path] },
			},
		},
	];
	const first = operationIdentity(
		"chat",
		"B",
		"call",
		"transport-one",
		call("A", "source.txt"),
	);
	const retry = operationIdentity(
		"chat",
		"B",
		"call",
		"transport-two",
		call("A", "source.txt"),
	);
	const changedPath = operationIdentity(
		"chat",
		"B",
		"call",
		"transport-three",
		call("A", "other.txt"),
	);
	const changedSource = operationIdentity(
		"chat",
		"B",
		"call",
		"transport-four",
		call("C", "source.txt"),
	);
	assert.ok(first && retry && changedPath && changedSource);
	assert.equal(first.key, retry.key);
	assert.equal(first.signature, retry.signature);
	assert.equal(first.key, changedPath.key);
	assert.notEqual(first.signature, changedPath.signature);
	assert.equal(first.key, changedSource.key);
	assert.notEqual(first.signature, changedSource.signature);
});

test("transfer.from cancellation does not create a destination", async (t) => {
	const f = await multiSessionFixture(t);
	const source = f.session("A");
	const destination = f.session("B");
	await writeFile(join(source.cwd, "source.txt"), "source bytes");
	const cancelled = new AbortController();
	const reason = new Error("cancel pull");
	cancelled.abort(reason);
	await assert.rejects(
		destination.local.transfer(
			{
				operationId: "pull-cancelled",
				paths: ["cancelled.txt"],
				from: { sessionId: "A", paths: ["source.txt"] },
			},
			cancelled.signal,
			undefined,
			{ sessionId: "B", cwd: destination.cwd },
		),
		(error) => error === reason,
	);
	await assert.rejects(
		readFile(join(destination.cwd, "cancelled.txt"), "utf8"),
		/ENOENT/,
	);
});

test("native transfer rejects host file URLs outside a direct Chappie request", async (t) => {
	const f = await multiSessionFixture(t);
	const destination = f.session("B");
	await assert.rejects(
		destination.local.transfer(
			{
				operationId: "untrusted-host-file",
				paths: ["blocked.txt"],
				files: [
					{
						file_id: "file",
						download_url: "https://93.184.216.34/file",
					},
				],
			},
			f.controller.signal,
			undefined,
			{ sessionId: "B", cwd: destination.cwd },
		),
		/direct transfer tool/i,
	);
});

test("direct Chappie transfer may import the host files it requested", async (t) => {
	const f = await sessionFixture(t);
	t.mock.method(globalThis, "fetch", async () => new Response("HOST"));
	const calls = [
		{
			name: "transfer",
			arguments: {
				operationId: "trusted-host-file",
				paths: ["host.txt"],
				files: [
					{
						file_id: "file",
						download_url: "https://93.184.216.34/file",
					},
				],
			},
		},
	];
	const pending = f.broker.call(
		"test-chat",
		"A",
		calls,
		"trusted-host-file",
		f.controller.signal,
		true,
	);
	const output = await f.dispatch();
	const call = output.message.content.find(
		(block) => block.type === "toolCall",
	);
	assert.ok(call?.type === "toolCall");
	const transfer = await f.local.transfer(
		call.arguments as (typeof calls)[0]["arguments"],
		f.controller.signal,
		undefined,
		{ sessionId: "A", cwd: join(f.root, "A") },
	);
	await f.emit("turn_end", {
		message: structuredClone(output.message),
		toolResults: [
			{
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: transfer.content,
				details: transfer.details,
				isError: transfer.isError === true,
				timestamp: Date.now(),
			},
		],
	});
	await f.emit("agent_end", { willContinue: false });
	await pending;
	assert.equal(await readFile(join(f.root, "A", "host.txt"), "utf8"), "HOST");
});

test("transfer direction selectors are mutually exclusive", async (t) => {
	const f = await multiSessionFixture(t);
	const destination = f.session("B");
	await assert.rejects(
		destination.local.transfer(
			{
				operationId: "invalid-directions",
				paths: ["target.txt"],
				from: { sessionId: "A", paths: ["source.txt"] },
				to: { sessionId: "A", paths: ["other.txt"] },
			},
			f.controller.signal,
			undefined,
			{ sessionId: "B", cwd: destination.cwd },
		),
		/files|from|to|one of/i,
	);
});
