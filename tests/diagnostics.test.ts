import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Broker } from "../src/broker.ts";
import { ipcEndpoint } from "../src/ipc.ts";
import { State } from "../src/state.ts";
import { until } from "./helpers/session-fixture.ts";

test("offline selection returns a targeted bounded diagnostic", async (t) => {
	const root = await mkdtemp(
		join(process.platform === "win32" ? tmpdir() : "/tmp", "chdiag-"),
	);
	const broker = new Broker(root, {
		sessionWaitMs: 20,
		inspectionTimeoutMs: 20,
	});
	t.after(async () => {
		await broker.close();
		await rm(root, { recursive: true, force: true });
	});
	await broker.start();
	await assert.rejects(
		broker.initialize("chat", "missing", "init", AbortSignal.timeout(500)),
		/missing.*offline|offline.*missing/i,
	);
});

test("registered but nonresponsive sessions have a bounded inspect error", async (t) => {
	const root = await mkdtemp(
		join(process.platform === "win32" ? tmpdir() : "/tmp", "chdiag-"),
	);
	const broker = new Broker(root, {
		sessionWaitMs: 20,
		inspectionTimeoutMs: 20,
	});
	await broker.start();
	const socket = createConnection(ipcEndpoint(root));
	socket.on("error", () => {});
	socket.on("data", () => {});
	t.after(async () => {
		socket.destroy();
		await broker.close();
		await rm(root, { recursive: true, force: true });
	});
	await once(socket, "connect");
	socket.write(
		`${JSON.stringify({ type: "sync", id: 1, session: { id: "stalled", cwd: root, device: "test", status: "idle" } })}\n`,
	);
	await until(() => broker.listSessions().length === 1);
	await assert.rejects(
		broker.tools(
			"chat",
			"stalled",
			undefined,
			"inspect",
			AbortSignal.timeout(500),
		),
		/stalled.*respond|inspection.*stalled/i,
	);
});

test("invalid persisted state is rejected instead of entering live maps", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chstate-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(
		join(root, "chappie.state.json"),
		JSON.stringify({ deliveries: [{ id: "bad" }] }),
	);
	await assert.rejects(new State(root).load(), /state|invalid|expected/i);
});
