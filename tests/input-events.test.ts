import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OPERATION_FINISHED_EVENT } from "../src/event-types.ts";
import { HttpsWebhookTransport } from "../src/events.ts";
import { ProviderOutput } from "../src/provider-core.ts";
import { State } from "../src/state.ts";
import { sessionFixture, until } from "./helpers/session-fixture.ts";

const inputEvent = "operation.input_required";
const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const subscription = {
	id: "input-sub",
	chatId: "owner",
	name: inputEvent,
	operationId: "op",
	url: "https://callback.example.test/events",
	secret,
	expiresAt: null,
	updatedAt: 1,
} as const;
const receipt = {
	key: "key",
	chatId: "owner",
	sessionId: "A",
	cwd: "/fixture",
	operationId: "op",
	signature: "sig",
	status: "running",
	createdAt: 1,
	updatedAt: 1,
} as const;
const modelInput = (id: string) => ({
	id,
	sessionId: "A",
	request: {
		kind: "compaction" as const,
		input: { privatePrompt: "DO_NOT_SEND" },
	},
});

test("input-required events persist atomically, deduplicate retries and rearm for a new model request", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-input-events-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = new State(root);
	await state.reserveOperation({ ...receipt });
	await state.upsertEventSubscription(subscription);
	await state.upsertEventSubscription({
		...subscription,
		id: "finished-sub",
		name: OPERATION_FINISHED_EVENT,
	});
	await state.waitForInput("key", [modelInput("model-one")]);
	const first = state.nextEvent(Date.now());
	assert.equal(first?.name, inputEvent);
	assert.ok(first);
	assert.equal(first.data.status, "waiting_input");
	assert.doesNotMatch(JSON.stringify(first), /DO_NOT_SEND|privatePrompt/);
	const restored = new State(root);
	await restored.load();
	assert.equal(restored.operation("owner", "op").status, "waiting_input");
	assert.equal(restored.nextEvent(Date.now())?.eventId, first.eventId);
	await restored.removeEvent(first.eventId);
	await restored.upsertEventSubscription(subscription);
	assert.equal(restored.nextEventTime(), undefined);
	await restored.reserveOperation({ ...receipt });
	await restored.waitForInput("key", [modelInput("model-one")]);
	assert.equal(
		restored.nextEventTime(),
		undefined,
		"retrying the same unanswered model input must not notify again",
	);
	await restored.reserveOperation({ ...receipt });
	await restored.waitForInput("key", [modelInput("model-two")]);
	const second = restored.nextEvent(Date.now());
	assert.equal(second?.name, inputEvent);
	assert.ok(second && second.eventId !== first.eventId);
	await restored.removeEvent(second.eventId);
	await restored.finishOperation("key", "completed");
	assert.equal(restored.nextEvent(Date.now())?.name, OPERATION_FINISHED_EVENT);
});

test("late input subscriptions observe the current wait, not a terminal or foreign operation", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-input-events-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = new State(root);
	await state.reserveOperation({ ...receipt });
	await state.waitForInput("key", [modelInput("model")]);
	await state.upsertEventSubscription({
		...subscription,
		id: "foreign",
		chatId: "other",
	});
	assert.equal(state.nextEventTime(), undefined);
	await state.upsertEventSubscription(subscription);
	const event = state.nextEvent(Date.now());
	assert.equal(event?.name, inputEvent);
	assert.ok(event);
	await state.removeEvent(event.eventId);
	await state.finishOperation("key", "cancelled");
	await state.upsertEventSubscription({
		...subscription,
		id: "after-terminal",
	});
	assert.equal(state.nextEventTime(), undefined);
});

test("detached input wait delivers an authorized nonterminal webhook and can then finish", async (t) => {
	const posted: Array<{ name?: string; data?: { status: string } }> = [];
	t.mock.method(HttpsWebhookTransport.prototype, "validate", async () => {});
	t.mock.method(
		HttpsWebhookTransport.prototype,
		"post",
		async (_sub: unknown, _id: string, body: string) => {
			const value = JSON.parse(body);
			if (value.type === "verification")
				return {
					status: 200,
					body: JSON.stringify({ challenge: value.challenge }),
				};
			posted.push(value);
			return { status: 200, body: "" };
		},
	);
	const f = await sessionFixture(t);
	const calls = [{ name: "read", arguments: { path: "test.txt" } }];
	await f.broker.startCall(
		"test-chat",
		"A",
		calls,
		"event-wait",
		"first",
		f.controller.signal,
	);
	for (const name of [inputEvent, OPERATION_FINISHED_EVENT] as const)
		await f.broker.subscribeOperationEvent(
			"test-chat",
			name,
			"event-wait",
			subscription.url,
			secret,
		);
	const output = new ProviderOutput(
		{ api: "chappie", provider: "chappie", id: "chatgpt" },
		f.controller.signal,
	);
	const generation = f.local.generate(
		output,
		{ kind: "compaction", input: {} },
		"A",
	);
	await until(() => posted.some((event) => event.name === inputEvent));
	assert.equal(
		posted.some((event) => event.name === OPERATION_FINISHED_EVENT),
		false,
	);
	const waiting = f.broker.operation("test-chat", "event-wait");
	assert.equal(waiting.operation.status, "waiting_input");
	assert.ok(waiting.inputs[0]);
	await f.broker.chat(
		"test-chat",
		"A",
		"summary",
		"reply",
		f.controller.signal,
		waiting.inputs[0].id,
	);
	await generation;
	await f.broker.startCall(
		"test-chat",
		"A",
		calls,
		"event-wait",
		"resume",
		f.controller.signal,
	);
	await f.complete(await f.dispatch());
	await until(() =>
		posted.some((event) => event.name === OPERATION_FINISHED_EVENT),
	);
	assert.deepEqual(
		posted.map((event) => event.name),
		[inputEvent, OPERATION_FINISHED_EVENT],
	);
});

test("a newer input obligation does not discard an older durable delivery awaiting acknowledgement", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-input-events-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = new State(root);
	await state.reserveOperation({ ...receipt });
	await state.upsertEventSubscription(subscription);
	await state.waitForInput("key", [modelInput("one")]);
	const first = state.nextEvent(Date.now());
	assert.ok(first);
	await state.rescheduleEvent(first.eventId, 1, 0);
	await state.reserveOperation({ ...receipt });
	await state.waitForInput("key", [modelInput("two")]);
	assert.equal(state.nextEvent(Date.now())?.eventId, first.eventId);
	await state.removeEvent(first.eventId);
	const second = state.nextEvent(Date.now());
	assert.ok(second && second.eventId !== first.eventId);
	assert.equal(
		state.eventSubscription(subscription.id)?.deliveryStatus,
		"pending",
	);
});
