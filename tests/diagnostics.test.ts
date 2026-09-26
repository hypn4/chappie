import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { Broker } from "../src/broker.ts";
import {
	type BrokerMessage,
	ipcEndpoint,
	JsonLinePeer,
	type SessionMessage,
} from "../src/ipc.ts";
import { State } from "../src/state.ts";

const sessionWaitMs = 20;
const inspectionTimeoutMs = 30;

// Control only deadline signals. Real IPC and state-file I/O must still finish;
// a competing wall-clock caller timeout cannot decide which behavior is tested.
function controlledTimeouts(t: TestContext) {
	const deadlines: { milliseconds: number; controller: AbortController }[] = [];
	t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
		const controller = new AbortController();
		deadlines.push({ milliseconds, controller });
		return controller.signal;
	});
	return {
		count(milliseconds: number) {
			return deadlines.filter((item) => item.milliseconds === milliseconds)
				.length;
		},
		expire(milliseconds: number) {
			const pending = deadlines.filter(
				(item) =>
					item.milliseconds === milliseconds && !item.controller.signal.aborted,
			);
			assert.ok(pending.length, `No pending ${milliseconds}ms deadline`);
			for (const { controller } of pending)
				controller.abort(
					new DOMException("Test deadline expired", "TimeoutError"),
				);
		},
	};
}

async function diagnosticFixture(t: TestContext) {
	const root = await mkdtemp(
		join(process.platform === "win32" ? tmpdir() : "/tmp", "chdiag-"),
	);
	const broker = new Broker(root, { sessionWaitMs, inspectionTimeoutMs });
	let socket: Socket | undefined;
	t.after(async () => {
		socket?.destroy();
		await broker.close();
		await rm(root, { recursive: true, force: true });
	});
	await broker.start();
	const clock = controlledTimeouts(t);
	return {
		broker,
		clock,
		async register() {
			const registered = Promise.withResolvers<void>();
			const inspecting =
				Promise.withResolvers<Extract<BrokerMessage, { type: "inspect" }>>();
			const cancelled =
				Promise.withResolvers<Extract<BrokerMessage, { type: "cancel" }>>();
			socket = createConnection(ipcEndpoint(root));
			const connected = once(socket, "connect", { signal: t.signal });
			const peer = new JsonLinePeer<BrokerMessage, SessionMessage>(
				socket,
				(message) => {
					if (message.type === "synced") registered.resolve();
					if (message.type === "inspect") inspecting.resolve(message);
					if (message.type === "cancel") cancelled.resolve(message);
				},
				() => {},
			);
			await connected;
			await peer.send({
				type: "sync",
				id: 1,
				session: { id: "stalled", cwd: root, device: "test", status: "idle" },
			});
			await registered.promise;
			return { inspecting: inspecting.promise, cancelled: cancelled.promise };
		},
	};
}

function pauseBinding(t: TestContext) {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const bind = State.prototype.bind;
	t.mock.method(
		State.prototype,
		"bind",
		async function (this: State, chatId: string, sessionId: string) {
			entered.resolve();
			await release.promise;
			await bind.call(this, chatId, sessionId);
		},
	);
	t.after(() => release.resolve());
	return { entered: entered.promise, release: release.resolve };
}

// This is a test-runner hang guard, not a deadline competing with the broker.
// No production timeout, platform exclusion or CI retry is needed for these tests.
describe("session diagnostic deadlines", { timeout: 10000 }, () => {
	for (const selection of [
		{
			name: "offline",
			id: "missing",
			error: /missing.*offline|offline.*missing/i,
		},
		{ name: "unbound", id: undefined, error: /No available unbound session/ },
	]) {
		test(`${selection.name} selection expires with its targeted diagnostic`, async (t) => {
			const f = await diagnosticFixture(t);
			const pending = assert.rejects(
				f.broker.initialize("chat", selection.id, "init", t.signal),
				selection.error,
			);
			f.clock.expire(sessionWaitMs);
			await pending;
		});

		for (const first of ["deadline", "caller"] as const) {
			test(`${selection.name} selection preserves ${first} as the first abort`, async (t) => {
				const f = await diagnosticFixture(t);
				const caller = new AbortController();
				const reason = new Error("Caller cancelled selection");
				const pending = assert.rejects(
					f.broker.initialize("chat", selection.id, "init", caller.signal),
					first === "deadline"
						? selection.error
						: (error: unknown) => error === reason,
				);
				if (first === "deadline") {
					f.clock.expire(sessionWaitMs);
					caller.abort(reason);
				} else {
					caller.abort(reason);
					f.clock.expire(sessionWaitMs);
				}
				await pending;
			});
		}
	}

	test("slow binding completes before the independent inspection deadline starts", async (t) => {
		const f = await diagnosticFixture(t);
		const peer = await f.register();
		const binding = pauseBinding(t);
		const pending = assert.rejects(
			f.broker.tools("chat", "stalled", undefined, "inspect", t.signal),
			/stalled.*respond|inspection.*stalled/i,
		);
		await binding.entered;
		assert.equal(f.clock.count(inspectionTimeoutMs), 0);
		// Selection has finished. Expiring its unused budget during disk I/O must
		// neither start nor consume the later inspection budget.
		f.clock.expire(sessionWaitMs);
		binding.release();
		const request = await peer.inspecting;
		assert.equal(f.clock.count(inspectionTimeoutMs), 1);
		f.clock.expire(inspectionTimeoutMs);
		await pending;
		assert.equal((await peer.cancelled).id, request.id);
	});

	test("caller cancellation during binding is not reported as an inspection failure", async (t) => {
		const f = await diagnosticFixture(t);
		await f.register();
		const binding = pauseBinding(t);
		const caller = new AbortController();
		const reason = new Error("Caller cancelled before inspection");
		const pending = assert.rejects(
			f.broker.tools("chat", "stalled", undefined, "inspect", caller.signal),
			(error: unknown) => error === reason,
		);
		await binding.entered;
		caller.abort(reason);
		binding.release();
		await pending;
		assert.equal(f.clock.count(inspectionTimeoutMs), 0);
	});

	for (const first of ["deadline", "caller"] as const) {
		test(`inspection preserves ${first} as the first abort and cancels the request`, async (t) => {
			const f = await diagnosticFixture(t);
			const peer = await f.register();
			const caller = new AbortController();
			const reason = new Error("Caller cancelled inspection");
			const pending = assert.rejects(
				f.broker.tools("chat", "stalled", undefined, "inspect", caller.signal),
				first === "deadline"
					? /stalled.*respond|inspection.*stalled/i
					: (error: unknown) => error === reason,
			);
			const request = await peer.inspecting;
			// Both events fire before promise rejection handling resumes. The first
			// cause must win, not whichever signal catch happens to inspect first.
			if (first === "deadline") {
				f.clock.expire(inspectionTimeoutMs);
				caller.abort(reason);
			} else {
				caller.abort(reason);
				f.clock.expire(inspectionTimeoutMs);
			}
			await pending;
			assert.equal((await peer.cancelled).id, request.id);
		});
	}
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
