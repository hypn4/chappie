import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { OPERATION_FINISHED_EVENT } from "../src/event-types.ts";
import {
	EventService,
	HttpsWebhookTransport,
	type WebhookResponse,
	type WebhookTransport,
} from "../src/events.ts";
import { State } from "../src/state.ts";

const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;

class FakeWebhookTransport implements WebhookTransport {
	readonly posts: Array<{
		webhookId: string;
		body: string;
		subscriptionId: string;
	}> = [];
	readonly validations: string[] = [];
	eventStatus = 200;

	async validate(url: string): Promise<void> {
		this.validations.push(url);
	}

	async post(
		subscription: {
			id: string;
			url: string;
			secret: string;
			previousSecret?: string;
			previousSecretUntil?: number;
		},
		webhookId: string,
		body: string,
	): Promise<WebhookResponse> {
		this.posts.push({
			webhookId,
			body,
			subscriptionId: subscription.id,
		});
		const parsed = JSON.parse(body) as { type?: string; challenge?: string };
		if (parsed.type === "verification")
			return {
				status: 200,
				body: JSON.stringify({ challenge: parsed.challenge }),
			};
		return { status: this.eventStatus, body: "" };
	}
}

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "chappie-events-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = new State(root);
	await state.load();
	await state.reserveOperation({
		key: "operation-key",
		operationId: "long-op",
		signature: "signature",
		chatId: "chat",
		sessionId: "A",
		cwd: root,
		status: "running",
		updatedAt: Date.now(),
	});
	return { root, state };
}

async function until(predicate: () => boolean, timeout = 1500) {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("event subscriptions verify once, are idempotent, and persist", async (t) => {
	const { root, state } = await fixture(t);
	const transport = new FakeWebhookTransport();
	const events = new EventService(state, transport);
	const first = await events.subscribe({
		chatId: "chat",
		name: OPERATION_FINISHED_EVENT,
		operationId: "long-op",
		url: "https://events.example.test/callback",
		secret,
	});
	const second = await events.subscribe({
		chatId: "chat",
		name: OPERATION_FINISHED_EVENT,
		operationId: "long-op",
		url: "https://events.example.test/callback",
		secret,
	});
	assert.equal(first.id, second.id);
	assert.equal(
		transport.posts.filter(
			(post) =>
				(JSON.parse(post.body) as { type?: string }).type === "verification",
		).length,
		1,
	);
	assert.deepEqual(transport.validations, [
		"https://events.example.test/callback",
		"https://events.example.test/callback",
	]);

	const resumed = new State(root);
	await resumed.load();
	assert.equal(resumed.eventSubscription(first.id)?.operationId, "long-op");
});

test("terminal operations emit one durable webhook event", async (t) => {
	const { state } = await fixture(t);
	const transport = new FakeWebhookTransport();
	const events = new EventService(state, transport);
	const subscription = await events.subscribe({
		chatId: "chat",
		name: OPERATION_FINISHED_EVENT,
		operationId: "long-op",
		url: "https://events.example.test/callback",
		secret,
	});
	events.start();
	await state.finishOperation("operation-key", "completed");
	await until(
		() =>
			transport.posts.filter(
				(post) =>
					(JSON.parse(post.body) as { name?: string }).name ===
					OPERATION_FINISHED_EVENT,
			).length === 1,
	);
	const delivered = transport.posts.find(
		(post) =>
			(JSON.parse(post.body) as { name?: string }).name ===
			OPERATION_FINISHED_EVENT,
	);
	assert.ok(delivered);
	assert.equal(delivered.subscriptionId, subscription.id);
	const body = JSON.parse(delivered.body) as {
		eventId: string;
		name: string;
		data: { operation_id: string; status: string };
		cursor: null;
	};
	assert.match(body.eventId, /^evt_/);
	assert.equal(body.name, OPERATION_FINISHED_EVENT);
	assert.equal(body.data.operation_id, "long-op");
	assert.equal(body.data.status, "completed");
	assert.equal(body.cursor, null);
	await events.close();
});

test("pending event outbox survives restart", async (t) => {
	const { root, state } = await fixture(t);
	const transport = new FakeWebhookTransport();
	transport.eventStatus = 503;
	const events = new EventService(state, transport);
	await events.subscribe({
		chatId: "chat",
		name: OPERATION_FINISHED_EVENT,
		operationId: "long-op",
		url: "https://events.example.test/callback",
		secret,
	});
	await state.finishOperation("operation-key", "completed");
	await events.close();

	const resumed = new State(root);
	await resumed.load();
	assert.ok(resumed.nextEvent(Date.now() + 10 * 60 * 1000));
});

test("callback verification mismatch is rejected without saving subscription", async (t) => {
	const { state } = await fixture(t);
	const transport: WebhookTransport = {
		async validate() {},
		async post() {
			return { status: 200, body: JSON.stringify({ challenge: "wrong" }) };
		},
	};
	const events = new EventService(state, transport);
	await assert.rejects(
		events.subscribe({
			chatId: "chat",
			name: OPERATION_FINISHED_EVENT,
			operationId: "long-op",
			url: "https://events.example.test/callback",
			secret,
		}),
		/challenge/i,
	);
});

test("production webhook transport rejects loopback destinations before connecting", async () => {
	const transport = new HttpsWebhookTransport();
	await assert.rejects(
		transport.validate("https://127.0.0.1/callback"),
		/non-public/i,
	);
	await assert.rejects(
		transport.validate("http://example.com/callback"),
		/HTTPS/i,
	);
});
