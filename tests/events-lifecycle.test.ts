import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { OPERATION_FINISHED_EVENT } from "../src/event-types.ts";
import { EventService, type WebhookTransport } from "../src/events.ts";
import { State } from "../src/state.ts";

const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const replacement = `whsec_${Buffer.alloc(32, 8).toString("base64")}`;
const input = {
	chatId: "owner",
	name: OPERATION_FINISHED_EVENT,
	operationId: "op",
	url: "https://events.example.test/callback",
	secret,
} as const;
async function fixture(t: TestContext, send?: WebhookTransport["post"]) {
	const root = await mkdtemp(join(tmpdir(), "chappie-event-life-"));
	const state = new State(root);
	await state.reserveOperation({
		key: "key",
		operationId: "op",
		signature: "sig",
		chatId: "owner",
		sessionId: "A",
		cwd: root,
		status: "running",
		updatedAt: Date.now(),
	});
	const posts: string[] = [];
	const transport: WebhookTransport = {
		async validate() {},
		async post(subscription, id, body, signal) {
			posts.push(body);
			const parsed = JSON.parse(body);
			if (parsed.type === "verification")
				return {
					status: 200,
					body: JSON.stringify({ challenge: parsed.challenge }),
				};
			return send
				? send(subscription, id, body, signal)
				: { status: 200, body: "" };
		},
	};
	const service = new EventService(state, transport);
	t.after(async () => {
		await service.close();
		await rm(root, { recursive: true, force: true });
	});
	return { root, state, service, posts };
}
async function until(check: () => boolean, timeout = 2500) {
	const deadline = Date.now() + timeout;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("malformed base64 signing secrets are rejected before callback verification", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		f.service.subscribe({ ...input, secret: `${secret}#invalid` }),
		/secret/i,
	);
	assert.equal(f.posts.length, 0);
});

test("refreshing the replacement key preserves the active rotation window", async (t) => {
	const f = await fixture(t);
	const first = await f.service.subscribe(input);
	await f.service.subscribe({ ...input, secret: replacement });
	await f.service.subscribe({ ...input, secret: replacement });
	const stored = f.state.eventSubscription(first.id);
	assert.equal(stored?.secret, replacement);
	assert.equal(stored?.previousSecret, secret);
	assert.ok((stored?.previousSecretUntil ?? 0) > Date.now());
});

test("committed completion wakes the delivery pump without a separate publish call", async (t) => {
	const f = await fixture(t);
	await f.service.subscribe(input);
	f.service.start();
	await new Promise((resolve) => setTimeout(resolve, 10));
	await f.state.finishOperation("key", "completed");
	await until(() =>
		f.posts.some((body) => JSON.parse(body).name === OPERATION_FINISHED_EVENT),
	);
});

test("service shutdown cancels in-flight delivery and retains the pending event", async (t) => {
	let active: AbortSignal | undefined;
	let called = false;
	const f = await fixture(t, async (_sub, _id, _body, signal) => {
		called = true;
		active = signal;
		if (!signal) return { status: 503, body: "" };
		await new Promise<void>((_resolve, reject) => {
			if (signal.aborted) reject(signal.reason);
			else
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
		});
		return { status: 200, body: "" };
	});
	await f.service.subscribe(input);
	await f.state.finishOperation("key", "completed");
	f.service.start();
	await until(() => called);
	await f.service.close();
	assert.equal(active?.aborted, true);
	assert.ok(f.state.nextEvent(Date.now() + 600000));
});

test("410 stops the subscription without retrying the event", async (t) => {
	const f = await fixture(t, async () => ({ status: 410, body: "" }));
	const sub = await f.service.subscribe(input);
	await f.state.finishOperation("key", "completed");
	f.service.start();
	await until(() => f.state.eventSubscription(sub.id) === undefined);
	assert.equal(
		f.posts.filter((body) => JSON.parse(body).name === OPERATION_FINISHED_EVENT)
			.length,
		1,
	);
});

test("413 retains an observable failed-delivery receipt", async (t) => {
	const f = await fixture(t, async () => ({ status: 413, body: "" }));
	const sub = await f.service.subscribe(input);
	await f.state.finishOperation("key", "completed");
	f.service.start();
	await until(() => f.state.nextEventTime() === undefined);
	assert.equal(f.state.eventSubscription(sub.id)?.deliveryStatus, "failed");
});

test("transient retries preserve the event ID and serialized payload", async (t) => {
	const received: Array<{ id: string; body: string }> = [];
	const f = await fixture(t, async (_sub, id, body) => {
		received.push({ id, body });
		return { status: received.length === 1 ? 503 : 200, body: "" };
	});
	await f.service.subscribe(input);
	await f.state.finishOperation("key", "completed");
	f.service.start();
	await until(() => received.length === 2);
	assert.deepEqual(received[0], received[1]);
});
