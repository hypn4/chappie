import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderOutput } from "../src/provider-core.ts";
import { State } from "../src/state.ts";
import { until, within } from "./helpers/async.ts";
import { sessionFixture } from "./helpers/session-fixture.ts";

const calls = [{ name: "read", arguments: { path: "test.txt" } }];
const model = { api: "chappie", provider: "chappie", id: "chatgpt" };

async function modelRequest(f: Awaited<ReturnType<typeof sessionFixture>>) {
	const output = new ProviderOutput(model, f.controller.signal);
	const finished = f.local.generate(
		output,
		{ kind: "compaction", input: { messages: ["summarize"] } },
		"A",
	);
	let requestId: string | undefined;
	await until(async () => {
		requestId = (
			await f.broker.inputs("test-chat", "A", f.controller.signal)
		).find((input) => "request" in input)?.id;
		return requestId !== undefined;
	});
	assert.ok(requestId);
	return { output, finished, requestId };
}

test("a pending model request returns unexecuted feedback and the same call can resume", async (t) => {
	const f = await sessionFixture(t);
	const generation = await modelRequest(f);
	const signal = AbortSignal.any([
		f.controller.signal,
		AbortSignal.timeout(300),
	]);
	const blocked = await f.broker.call(
		"test-chat",
		"A",
		calls,
		"needs-input",
		signal,
	);
	assert.ok("execution" in blocked);
	assert.deepEqual(blocked.execution, {
		status: "needs_input",
		executed: false,
		reason: "model_request_pending",
	});
	assert.equal(blocked.toolResults.length, 0);
	assert.ok(blocked.inputs.some((input) => input.id === generation.requestId));
	assert.equal(generation.output.closed, false);
	await f.broker.chat(
		"test-chat",
		"A",
		"summary",
		"model-reply",
		f.controller.signal,
		generation.requestId,
	);
	await generation.finished;
	const resumed = f.broker.call(
		"test-chat",
		"A",
		calls,
		"needs-input",
		f.controller.signal,
	);
	const output = await f.dispatch();
	await f.complete(output);
	assert.equal((await resumed).toolResults.length, 1);
});

test("detached input waits preserve identity and resume without repeating accepted work", async (t) => {
	const f = await sessionFixture(t);
	const generation = await modelRequest(f);
	await f.broker.startCall(
		"test-chat",
		"A",
		calls,
		"waiting-operation",
		"start-one",
		f.controller.signal,
	);
	await until(
		() =>
			f.broker.operation("test-chat", "waiting-operation").operation.status ===
			"waiting_input",
	);
	const blocked = f.broker.operation("test-chat", "waiting-operation");
	assert.ok("inputs" in blocked);
	assert.ok(
		Array.isArray(blocked.inputs) &&
			blocked.inputs.some((input) => input.id === generation.requestId),
	);
	assert.equal(blocked.deliveries.length, 0);
	await assert.rejects(
		f.broker.startCall(
			"test-chat",
			"A",
			[{ name: "read", arguments: { path: "changed.txt" } }],
			"waiting-operation",
			"changed",
			f.controller.signal,
		),
		/different arguments/,
	);
	await f.broker.chat(
		"test-chat",
		"A",
		"summary",
		"reply",
		f.controller.signal,
		generation.requestId,
	);
	await generation.finished;
	await Promise.all([
		f.broker.startCall(
			"test-chat",
			"A",
			calls,
			"waiting-operation",
			"retry-one",
			f.controller.signal,
		),
		f.broker.startCall(
			"test-chat",
			"A",
			calls,
			"waiting-operation",
			"retry-two",
			f.controller.signal,
		),
	]);
	const output = await f.dispatch();
	await f.complete(output);
	await until(
		() =>
			f.broker.operation("test-chat", "waiting-operation").operation.status ===
			"completed",
	);
	const completed = f.broker.operation("test-chat", "waiting-operation");
	assert.ok(completed.result);
	const saved = JSON.parse(
		await f.broker.readResponse("test-chat", completed.result.resultId),
	);
	assert.deepEqual(
		saved.content.filter(
			(block: { type: string; text?: string }) =>
				block.type === "text" && block.text === "completed",
		),
		[{ type: "text", text: "completed" }],
	);
	assert.equal(
		(
			await f.broker.startCall(
				"test-chat",
				"A",
				calls,
				"waiting-operation",
				"completed-retry",
				f.controller.signal,
			)
		).operation.status,
		"completed",
	);
});

test("cancelling an input-waiting operation does not cancel the model request", async (t) => {
	const f = await sessionFixture(t);
	const generation = await modelRequest(f);
	await f.broker.startCall(
		"test-chat",
		"A",
		calls,
		"cancel-waiting",
		"start",
		f.controller.signal,
	);
	await until(
		() =>
			f.broker.operation("test-chat", "cancel-waiting").operation.status ===
			"waiting_input",
	);
	assert.equal(
		(await f.broker.cancelOperation("test-chat", "cancel-waiting")).operation
			.status,
		"cancelled",
	);
	assert.equal(generation.output.closed, false);
	assert.equal(
		(
			await f.broker.startCall(
				"test-chat",
				"A",
				calls,
				"cancel-waiting",
				"retry",
				f.controller.signal,
			)
		).operation.status,
		"cancelled",
	);
	await f.broker.chat(
		"test-chat",
		"A",
		"summary",
		"finish-model",
		f.controller.signal,
		generation.requestId,
	);
	await generation.finished;
});

test("queued work returns its model request when compaction begins before native dispatch", async (t) => {
	const f = await sessionFixture(t);
	const { pending } = await f.queue("queued-before-model");
	const generation = await modelRequest(f);
	const blocked = await pending;
	assert.ok("result" in blocked);
	assert.equal(blocked.result.execution?.executed, false);
	assert.equal(blocked.result.toolResults.length, 0);
	await f.broker.tools(
		"test-chat",
		"A",
		["read"],
		"inspect-model",
		f.controller.signal,
	);
	const stillPending = await f.broker.inputs(
		"test-chat",
		"A",
		f.controller.signal,
	);
	assert.ok(stillPending.some(({ id }) => id === generation.requestId));
	await f.broker.chat(
		"test-chat",
		"A",
		"summary",
		"release-model",
		f.controller.signal,
		generation.requestId,
	);
	await generation.finished;
});

test("an unexecuted wait survives broker restart and stays bound to its original session", async (t) => {
	const f = await sessionFixture(t);
	const generation = await modelRequest(f);
	await f.broker.startCall(
		"test-chat",
		"A",
		calls,
		"persist-wait",
		"initial",
		f.controller.signal,
	);
	await until(
		() =>
			f.broker.operation("test-chat", "persist-wait").operation.status ===
			"waiting_input",
	);
	await f.reconnect();
	await generation.finished;
	assert.equal(
		f.broker.operation("test-chat", "persist-wait").operation.status,
		"waiting_input",
	);
	await assert.rejects(
		f.broker.startCall(
			"test-chat",
			"B",
			calls,
			"persist-wait",
			"retarget",
			f.controller.signal,
		),
		/another session/,
	);
	await f.broker.startCall(
		"test-chat",
		undefined,
		calls,
		"persist-wait",
		"resume",
		f.controller.signal,
	);
	const output = await f.dispatch();
	await f.complete(output);
	await until(
		() =>
			f.broker.operation("test-chat", "persist-wait").operation.status ===
			"completed",
	);
	assert.equal(
		f.broker.operation("test-chat", "persist-wait").inputs.length,
		0,
	);
});

for (const resuming of [false, true]) {
	test(`cancellation owns ${resuming ? "resumed" : "initial"} acceptance before durable reservation returns`, async (t) => {
		const f = await sessionFixture(t);
		const operationId = "acceptance-race";
		if (resuming) {
			const generation = await modelRequest(f);
			await f.broker.startCall(
				"test-chat",
				"A",
				calls,
				operationId,
				"first",
				f.controller.signal,
			);
			await until(
				() =>
					f.broker.operation("test-chat", operationId).operation.status ===
					"waiting_input",
			);
			await f.broker.chat(
				"test-chat",
				"A",
				"summary",
				"reply",
				f.controller.signal,
				generation.requestId,
			);
			await generation.finished;
		}
		const reserved = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const reserve = State.prototype.reserveOperation;
		t.mock.method(
			State.prototype,
			"reserveOperation",
			async function (
				this: State,
				receipt: Parameters<State["reserveOperation"]>[0],
			) {
				const result = await reserve.call(this, receipt);
				if (receipt.operationId === operationId && !result) {
					reserved.resolve();
					await release.promise;
				}
				return result;
			},
		);
		const started = f.broker.startCall(
			"test-chat",
			"A",
			calls,
			operationId,
			"accept",
			f.controller.signal,
		);
		await reserved.promise;
		let cancelled: Awaited<ReturnType<typeof f.broker.cancelOperation>>;
		try {
			cancelled = await within(
				f.broker.cancelOperation("test-chat", operationId),
				500,
				"Cancellation waited for acceptance instead of owning it",
			);
		} finally {
			release.resolve();
		}
		await started;
		const controller = new AbortController();
		const output = new ProviderOutput(model, controller.signal);
		const pending = f.local.start(output);
		await f.broker.tools(
			"test-chat",
			"A",
			["read"],
			"barrier",
			f.controller.signal,
		);
		const dispatched = output.message.content.some(
			(item) => item.type === "toolCall",
		);
		if (dispatched) await f.complete(output);
		else controller.abort();
		await pending;
		assert.equal(cancelled.operation.status, "cancelled");
		assert.equal(
			dispatched,
			false,
			"cancelled preparation must never dispatch native work",
		);
		assert.equal(
			f.broker.operation("test-chat", operationId).operation.status,
			"cancelled",
		);
	});
}
