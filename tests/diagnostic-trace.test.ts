import assert from "node:assert/strict";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { Broker } from "../src/broker.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { mcpClient } from "./helpers/mcp-client.ts";
import { sessionFixture } from "./helpers/session-fixture.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "ch-trace-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const broker = new Broker(root);
	t.after(() => broker.close());
	await broker.start();
	return { root, broker };
}

test("wire diagnostics distinguish local write failure from a written response without recording content", async (t) => {
	const f = await fixture(t);
	const client = mcpClient(t, f.broker);
	await client.request("server/discover");
	client.failNextSend(new Error("SECRET-ERROR-TEXT"));
	await assert.rejects(
		client.call("sessions", {}, { chatId: "PRIVATE-CHAT" }),
		/SECRET-ERROR/,
	);
	await client.call("sessions", {}, { chatId: "PRIVATE-CHAT" });
	await client.close();
	await f.broker.close();
	const text = await readFile(
		join(f.root, "chappie.diagnostics.jsonl"),
		"utf8",
	);
	assert.ok(
		!text.includes("PRIVATE-CHAT") && !text.includes("SECRET-ERROR-TEXT"),
	);
	const events = text
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.ok(events.some((e) => e.phase === "rpc.received"));
	assert.ok(events.some((e) => e.phase === "stdio.failed"));
	assert.ok(events.some((e) => e.phase === "stdio.written"));
	const failure = events.find((e) => e.phase === "stdio.failed");
	assert.ok(failure?.rpc);
	assert.ok(
		!events.some((e) => e.rpc === failure.rpc && e.phase === "stdio.written"),
	);
	assert.ok(events.every((e) => !JSON.stringify(e).includes("host_received")));
});

test("diagnostics cannot create files when explicitly disabled", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ch-trace-off-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(
		join(root, "chappie.json"),
		JSON.stringify({ diagnostics: false }),
	);
	const broker = new Broker(root);
	t.after(() => broker.close());
	await broker.start();
	const client = mcpClient(t, broker);
	await client.request("server/discover");
	await client.call("sessions");
	await client.close();
	await broker.close();
	assert.ok(
		!(await readdir(root)).some((name) =>
			name.startsWith("chappie.diagnostics"),
		),
	);
});

test("native completion is correlated with dispatch and not mistaken for host receipt", async (t) => {
	const f = await sessionFixture(t);
	const queued = await f.queue();
	const output = await f.dispatch();
	await f.complete(output);
	await queued.pending;
	await f.broker.saveResponse("private-owner", "PRIVATE-BODY");
	await f.broker.diagnostics.flush();
	const text = await readFile(
		join(f.root, "chappie.diagnostics.jsonl"),
		"utf8",
	);
	const events = text
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const dispatch = events.find(
		(e) => e.phase === "native.dispatch" && e.request,
	);
	assert.ok(dispatch);
	assert.ok(
		events.some(
			(e) => e.phase === "native.result" && e.native === dispatch.native,
		),
	);
	assert.ok(events.some((e) => e.phase === "snapshot.saved"));
	assert.ok(
		!text.includes("request-A") &&
			!text.includes("PRIVATE-BODY") &&
			!text.includes("private-owner"),
	);
});

test("diagnostic queue and disk rotation stay bounded under a burst", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ch-trace-cap-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const trace = new Diagnostics(root, { maxBytes: 1024, maxPending: 2 });
	for (let i = 0; i < 100; i++) trace.record("rpc.received", { rpc: i });
	assert.equal(trace.stats.pending, 2);
	assert.equal(trace.stats.dropped, 98);
	await trace.flush();
	assert.equal(trace.stats.pending, 0);
	for (let i = 0; i < 20; i++) {
		trace.record("stdio.written", { rpc: i });
		await trace.flush();
	}
	const names = await readdir(root);
	assert.equal(names.length, 2);
	for (const name of names) {
		const info = await lstat(join(root, name));
		assert.ok(info.size <= 1024);
		if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o600);
		for (const line of (await readFile(join(root, name), "utf8"))
			.trim()
			.split("\n"))
			JSON.parse(line);
	}
});

test("a broken diagnostic destination does not fail an MCP operation", async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.root, "chappie.diagnostics.jsonl"));
	const client = mcpClient(t, f.broker);
	const reply = await client.call("sessions");
	assert.ok("result" in reply);
	await f.broker.diagnostics.flush();
	assert.equal(f.broker.diagnostics.stats.pending, 0);
	assert.ok(f.broker.diagnostics.stats.dropped > 0);
});
