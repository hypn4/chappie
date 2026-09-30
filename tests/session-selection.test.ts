import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Broker } from "../src/broker.ts";
import {
	type BrokerMessage,
	ipcEndpoint,
	JsonLinePeer,
	type SessionDescription,
	type SessionMessage,
} from "../src/ipc.ts";
import { State } from "../src/state.ts";

// Real IPC peers share a cwd; session identity, not a path, must select the peer.
async function selectionFixture(
	t: TestContext,
	ids = ["A", "B"],
	config?: Record<string, unknown>,
) {
	const root = await mkdtemp(
		join(process.platform === "win32" ? tmpdir() : "/tmp", "chselect-"),
	);
	if (config)
		await writeFile(join(root, "chappie.json"), JSON.stringify(config), "utf8");
	const broker = new Broker(root);
	const sockets = new Map<string, Socket>();
	t.after(async () => {
		for (const socket of sockets.values()) socket.destroy();
		await broker.close();
		await rm(root, { recursive: true, force: true });
	});
	await broker.start();
	async function register(id: string) {
		const session: SessionDescription = {
			id,
			cwd: root,
			device: "fixture",
			host: "omp",
			status: "idle",
		};
		const registered = Promise.withResolvers<void>();
		const socket = createConnection(ipcEndpoint(root));
		sockets.set(id, socket);
		const connected = once(socket, "connect", { signal: t.signal });
		const peer = new JsonLinePeer<BrokerMessage, SessionMessage>(
			socket,
			async (message) => {
				if (message.type === "synced") registered.resolve();
				if (message.type === "inspect") {
					await peer.send({
						type: "result",
						id: message.id,
						inspection: { session, tools: [], skills: [] },
						inputs: [],
					});
				}
			},
			() => {},
		);
		await connected;
		await peer.send({ type: "sync", id: 1, session });
		await registered.promise;
	}
	for (const id of ids) await register(id);
	return {
		broker,
		root,
		register,
		async disconnect(id: string) {
			sockets.get(id)?.destroy();
			while (broker.listSessions(id).length) {
				t.signal.throwIfAborted();
				await setImmediate();
			}
		},
		init(chat: string, sessionId?: string, signal = t.signal) {
			return broker.initialize(chat, sessionId, `init-${chat}`, signal);
		},
	};
}

function pauseFirstBinding(t: TestContext, chat = "first") {
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const original = State.prototype.bind;
	t.mock.method(
		State.prototype,
		"bind",
		async function (this: State, chatId: string, sessionId: string) {
			if (chatId === chat) {
				entered.resolve();
				await gate.promise;
			}
			await original.call(this, chatId, sessionId);
		},
	);
	void gate.promise.catch(() => {});
	t.after(() => gate.resolve());
	return {
		entered: entered.promise,
		release: gate.resolve,
		reject: gate.reject,
	};
}

// The timeout is only a test hang guard. Ordering comes from simultaneous calls
// and explicit gates, not timing assumptions about the host or its filesystem.
describe("automatic session selection", { timeout: 10000 }, () => {
	test("simultaneous new chats select different sessions with the same cwd", async (t) => {
		const f = await selectionFixture(t);
		const results = await Promise.all([f.init("first"), f.init("second")]);
		assert.deepEqual(
			results.map((r) => r.session.id),
			["A", "B"],
		);
		assert.ok(
			results.every(
				(r) => r.selection === "automatic" && r.session.cwd === f.root,
			),
		);
		assert.equal(f.broker.binding("first"), "A");
		assert.equal(f.broker.binding("second"), "B");
	});

	test("a burst of new chats persists one distinct session per chat", async (t) => {
		const ids = Array.from({ length: 12 }, (_, i) => `session-${i}`);
		const f = await selectionFixture(t, ids);
		const results = await Promise.all(ids.map((_, i) => f.init(`chat-${i}`)));
		assert.deepEqual(
			results.map((r) => r.session.id),
			ids,
		);
		const persisted = new State(f.root);
		await persisted.load();
		assert.deepEqual(
			ids.map((_, i) => persisted.binding(`chat-${i}`)),
			ids,
		);
		assert.ok(f.broker.listSessions().every((s) => s.bindingCount === 1));
	});

	test("a completed reservation does not prevent reuse after an explicit rebind", async (t) => {
		const f = await selectionFixture(t);
		assert.equal((await f.init("first")).session.id, "A");
		await f.init("first", "B");
		assert.equal((await f.init("second")).session.id, "A");
		assert.equal(f.broker.binding("first"), "B");
	});

	test("simultaneous initialization of one chat preserves a single default", async (t) => {
		const f = await selectionFixture(t);
		const results = await Promise.all([
			f.init("same-chat"),
			f.init("same-chat"),
		]);
		assert.deepEqual(
			results.map((r) => r.session.id),
			["A", "A"],
		);
		assert.equal(f.broker.binding("same-chat"), "A");
		assert.equal((await f.init("other-chat")).session.id, "B");
	});

	test("slow binding does not reserve every session or block another chat", async (t) => {
		const f = await selectionFixture(t);
		const gate = pauseFirstBinding(t);
		const first = f.init("first");
		try {
			await gate.entered;
			assert.equal((await f.init("second")).session.id, "B");
		} finally {
			gate.release();
			await first;
		}
		assert.equal(f.broker.binding("first"), "A");
	});

	test("explicit selection can still share an automatically reserved session", async (t) => {
		const f = await selectionFixture(t, ["A"]);
		const gate = pauseFirstBinding(t);
		const first = f.init("first");
		try {
			await gate.entered;
			const explicit = await f.init("explicit", "A");
			assert.equal(explicit.session.id, "A");
			assert.equal(explicit.selection, "explicit");
		} finally {
			gate.release();
			await first;
		}
		assert.equal(f.broker.listSessions()[0]?.bindingCount, 2);
	});

	test("cancellation before binding releases the reservation and wakes a waiting chat", async (t) => {
		const f = await selectionFixture(t, ["A"]);
		const caller = new AbortController();
		const reason = new Error("Cancelled before binding");
		const first = assert.rejects(
			f.init("first", undefined, caller.signal),
			(e) => e === reason,
		);
		const second = f.init("second");
		caller.abort(reason);
		await first;
		assert.equal((await second).session.id, "A");
		assert.equal(f.broker.binding("first"), undefined);
		assert.equal(f.broker.binding("second"), "A");
	});

	test("a failed bind releases its reservation and wakes a waiting chat", async (t) => {
		const f = await selectionFixture(t, ["A"]);
		const gate = pauseFirstBinding(t);
		const failure = new Error("Binding failed before commit");
		const first = assert.rejects(f.init("first"), (e) => e === failure);
		await gate.entered;
		const second = f.init("second");
		gate.reject(failure);
		await first;
		assert.equal((await second).session.id, "A");
		assert.equal(f.broker.binding("first"), undefined);
		assert.equal(f.broker.listSessions()[0]?.bindingCount, 1);
	});

	test("disconnect and a rejected bind leave no reservation after reconnection", async (t) => {
		const f = await selectionFixture(t, ["A"]);
		const gate = pauseFirstBinding(t);
		const failure = new Error("Binding refused after disconnection");
		const first = assert.rejects(f.init("first"), (e) => e === failure);
		await gate.entered;
		const second = f.init("second");
		await f.disconnect("A");
		gate.reject(failure);
		await first;
		await f.register("A");
		assert.equal((await second).session.id, "A");
		assert.equal(f.broker.binding("first"), undefined);
	});

	test("a waiting selection deadline neither steals nor releases another reservation", async (t) => {
		const f = await selectionFixture(t, ["A"]);
		const gate = pauseFirstBinding(t);
		const first = f.init("first");
		try {
			await gate.entered;
			const deadlines: AbortController[] = [];
			t.mock.method(AbortSignal, "timeout", () => {
				const controller = new AbortController();
				deadlines.push(controller);
				return controller.signal;
			});
			const waiting = assert.rejects(
				f.init("second"),
				/No available unbound session/,
			);
			assert.equal(deadlines.length, 1);
			deadlines[0]?.abort(
				new DOMException("Selection expired", "TimeoutError"),
			);
			await waiting;
			assert.equal(f.broker.binding("second"), undefined);
			await f.register("B");
			assert.equal((await f.init("third")).session.id, "B");
		} finally {
			gate.release();
			await first;
		}
		assert.equal(f.broker.binding("first"), "A");
	});

	test("a cancelled duplicate initialization cannot release its chat's first reservation", async (t) => {
		const f = await selectionFixture(t);
		const gate = pauseFirstBinding(t);
		const first = f.init("first");
		try {
			await gate.entered;
			const duplicate = new AbortController();
			const reason = new Error("Only cancel the duplicate");
			const cancelled = assert.rejects(
				f.init("first", undefined, duplicate.signal),
				(e) => e === reason,
			);
			duplicate.abort(reason);
			await cancelled;
			assert.equal((await f.init("second")).session.id, "B");
		} finally {
			gate.release();
			await first;
		}
		assert.equal(f.broker.binding("first"), "A");
	});

	test("implicit tool inspection uses the same automatic selection reservation", async (t) => {
		const f = await selectionFixture(t);
		const results = await Promise.all([
			f.broker.tools("tools-chat", undefined, undefined, "inspect", t.signal),
			f.init("init-chat"),
		]);
		assert.deepEqual(
			results.map((r) => r.session.id),
			["A", "B"],
		);
	});

	test("an existing binding and explicit shared initialization are unchanged", async (t) => {
		const f = await selectionFixture(t);
		await f.init("existing", "B");
		const results = await Promise.all([
			f.init("existing"),
			f.init("shared", "B"),
			f.init("new"),
		]);
		assert.deepEqual(
			results.map((r) => r.session.id),
			["B", "B", "A"],
		);
		assert.deepEqual(
			results.map((r) => r.selection),
			["existing", "explicit", "automatic"],
		);
	});

	test("default participation cooldown remains ten seconds", async (t) => {
		let now = 100_000;
		t.mock.method(Date, "now", () => now);
		const f = await selectionFixture(t, ["A"]);
		assert.equal(
			(await f.init("cooldown", "A")).initialization?.mode,
			"executor",
		);
		now += 9_999;
		assert.equal(
			(await f.init("cooldown", "A")).initialization?.mode,
			"observer",
		);
		now += 2;
		assert.equal(
			(await f.init("cooldown", "A")).initialization?.mode,
			"executor",
		);
	});

	test("configured participation cooldown controls observer expiry", async (t) => {
		let now = 200_000;
		t.mock.method(Date, "now", () => now);
		const f = await selectionFixture(t, ["A"], { cooldown: 2 });
		assert.equal(
			(await f.init("cooldown", "A")).initialization?.mode,
			"executor",
		);
		now += 1_999;
		assert.equal(
			(await f.init("cooldown", "A")).initialization?.mode,
			"observer",
		);
		now += 2;
		assert.equal(
			(await f.init("cooldown", "A")).initialization?.mode,
			"executor",
		);
	});

	test("zero participation cooldown disables observer reuse", async (t) => {
		const f = await selectionFixture(t, ["A"], { cooldown: 0 });
		assert.equal(
			(await f.init("cooldown", "A")).initialization?.mode,
			"executor",
		);
		assert.equal(
			(await f.init("cooldown", "A")).initialization?.mode,
			"executor",
		);
	});
});
