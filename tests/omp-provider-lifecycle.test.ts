import assert from "node:assert/strict";
import { test } from "node:test";
import { IpcClient, type SessionMessage } from "../src/ipc.ts";
import { hasOmpPrimaryContext } from "../src/omp-primary-context.ts";
import { ProviderOutput } from "../src/provider-core.ts";
import {
	multiSessionFixture,
	sessionFixture,
	until,
} from "./helpers/session-fixture.ts";

const model = { api: "chappie", provider: "chappie", id: "chatgpt" };

test("a mismatched provider identity cannot acquire a local session", async (t) => {
	const f = await sessionFixture(t);
	const output = new ProviderOutput(model, f.controller.signal);
	await assert.rejects(() => {
		const pending = f.local.start(output, "not-A");
		output.done();
		return pending;
	}, /session.*identity|identity.*session/i);
});

test("OMP remote wake survives transient resume context until the actual provider request", async (t) => {
	const f = await multiSessionFixture(t, ["A"]);
	const s = f.session("A");
	void f.broker
		.call(
			"test-chat",
			"A",
			[{ name: "read", arguments: { path: "test.txt" } }],
			"resume-first-call",
			f.controller.signal,
		)
		.catch(() => {});
	await until(() => s.wakes() === 1);
	const transientContext = {
		...s.context,
		model: undefined,
	} as typeof s.context;
	await s.emit("before_agent_start", {}, transientContext);
	const user = {
		role: "user" as const,
		content: "preserve native context",
		timestamp: Date.now(),
	};
	const transformed = (await s.emit(
		"context",
		{
			messages: [
				user,
				{
					role: "custom",
					customType: "chappie.request",
					content: "",
					display: false,
					attribution: "agent",
					timestamp: Date.now(),
				},
			],
		},
		transientContext,
	)) as { messages: unknown[] };
	assert.equal(JSON.stringify(transformed.messages), JSON.stringify([user]));
	assert.equal(hasOmpPrimaryContext(transformed, "A"), true);

	// before_provider_request is scoped to the model OMP will actually dispatch.
	s.local.observeOmpProviderRequest(s.context);
	const output = new ProviderOutput(model, f.controller.signal);
	await s.local.start(output, "A");
	assert.equal(output.message.stopReason, "toolUse");
});

test("an actual provider switch wins over a pending Chappie wake and stale controls", async (t) => {
	const f = await multiSessionFixture(t, ["A"]);
	const s = f.session("A");
	const pending = f.broker
		.call(
			"test-chat",
			"A",
			[{ name: "read", arguments: { path: "test.txt" } }],
			"switch-during-wake",
			f.controller.signal,
		)
		.then(
			(result) => ({ result }),
			(error) => ({ error: String(error) }),
		);
	await until(() => s.wakes() === 1);
	const otherContext = {
		...s.context,
		model: { provider: "other" },
	} as typeof s.context;
	const user = {
		role: "user" as const,
		content: "keep this for the other provider",
		timestamp: Date.now(),
	};
	const control = {
		role: "custom" as const,
		customType: "chappie.request",
		content: "",
		display: false,
		attribution: "agent" as const,
		timestamp: Date.now(),
	};
	const duringRace = (await s.emit(
		"context",
		{ messages: [user, control] },
		otherContext,
	)) as { messages: unknown[] };
	assert.equal(JSON.stringify(duringRace.messages), JSON.stringify([user]));

	await s.emit("before_agent_start", {}, otherContext);
	await until(() => f.broker.listSessions("A").length === 0);
	assert.ok("error" in (await pending));

	const staleControl = (await s.emit(
		"context",
		{ messages: [user, control] },
		otherContext,
	)) as { messages: unknown[] };
	assert.equal(JSON.stringify(staleControl.messages), JSON.stringify([user]));
	assert.equal(hasOmpPrimaryContext(staleControl, "A"), false);
});

test("auxiliary generation replies without replacing the open primary provider", async (t) => {
	const f = await sessionFixture(t);
	const primary = new ProviderOutput(model, f.controller.signal);
	const primaryRun = f.local.start(primary, "A");
	await until(() => f.broker.listSessions("A")[0]?.status === "ready");

	const auxiliary = new ProviderOutput(model, f.controller.signal);
	const generationRun = f.local.generate(
		auxiliary,
		{ kind: "compaction", input: { messages: ["compact"] } },
		"A",
	);
	let generationId: string | undefined;
	await until(async () => {
		const inputs = await f.broker.inputs("test-chat", "A", f.controller.signal);
		const request = inputs.find((input) => "request" in input);
		generationId = request?.id;
		return generationId !== undefined;
	});
	assert.ok(generationId);
	await f.broker.chat(
		"test-chat",
		"A",
		"compacted summary",
		"generation-reply",
		f.controller.signal,
		generationId,
	);
	await generationRun;
	assert.equal(auxiliary.message.stopReason, "stop");
	assert.match(JSON.stringify(auxiliary.message.content), /compacted summary/);
	assert.equal(primary.closed, false);
	primary.done();
	await primaryRun;
});

test("OMP tree summarization is relayed as a branch summary generation", async (t) => {
	const f = await sessionFixture(t);
	const event = {
		type: "session_before_tree",
		preparation: {
			targetId: "target",
			oldLeafId: "old",
			commonAncestorId: null,
			entriesToSummarize: [
				{
					type: "custom",
					id: "entry",
					parentId: null,
					timestamp: new Date(1).toISOString(),
					customType: "fixture",
					data: { progress: "done" },
				},
			],
			userWantsSummary: true,
		},
		signal: f.controller.signal,
	};
	const summaryPending = f.emit("session_before_tree", event);
	let generationId: string | undefined;
	await until(async () => {
		const inputs = await f.broker.inputs("test-chat", "A", f.controller.signal);
		const request = inputs.find(
			(input) => "request" in input && input.request.kind === "branch_summary",
		);
		generationId = request?.id;
		return generationId !== undefined;
	});
	assert.ok(generationId);
	await f.broker.chat(
		"test-chat",
		"A",
		"branch summary text",
		"branch-reply",
		f.controller.signal,
		generationId,
	);
	assert.deepEqual(await summaryPending, {
		summary: { summary: "branch summary text" },
	});
});

for (const continuation of [true, false]) {
	test(`OMP turn_end delivers completed tools without a next provider (willContinue=${continuation})`, async (t) => {
		const f = await sessionFixture(t);
		const queued = await f.queue("completed-call");
		const output = await f.dispatch();
		const call = output.message.content.find(
			(block) => block.type === "toolCall",
		);
		assert.ok(call);
		let sent = 0;
		const send = IpcClient.prototype.send;
		t.mock.method(
			IpcClient.prototype,
			"send",
			function (this: IpcClient, message: SessionMessage) {
				if (message.type === "result" && "toolResults" in message) sent++;
				return send.call(this, message);
			},
		);
		const event = {
			message: structuredClone(output.message),
			toolResults: [
				{
					role: "toolResult" as const,
					toolName: call.name,
					toolCallId: call.id,
					content: [{ type: "text" as const, text: "completed once" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		};
		await f.emit("turn_end", event);
		if (continuation) await f.emit("agent_end", { willContinue: true });
		// Sending the result and persisting its broker receipt are separate steps.
		assert.equal(sent, 1, "turn_end must deliver before a follow-up stream");
		const outcome = await queued.pending;
		assert.ok("result" in outcome);
		assert.equal(outcome.result.toolResults.length, 1);
		await f.emit("turn_end", event);
		await f.emit("agent_end", { willContinue: false });
		assert.equal(sent, 1);
		assert.equal(f.broker.deliveries("test-chat").length, 0);
	});
}

test("OMP rejects partial native tool result batches", async (t) => {
	const f = await sessionFixture(t);
	const queued = await f.queue("partial-call", [
		{ name: "read", arguments: { path: "first.txt" } },
		{ name: "read", arguments: { path: "second.txt" } },
	]);
	const output = await f.dispatch();
	const calls = output.message.content.filter(
		(block) => block.type === "toolCall",
	);
	assert.equal(calls.length, 2);
	const first = calls[0];
	assert.ok(first?.type === "toolCall");
	await f.emit("turn_end", {
		message: structuredClone(output.message),
		toolResults: [
			{
				role: "toolResult" as const,
				toolName: first.name,
				toolCallId: first.id,
				content: [{ type: "text" as const, text: "first only" }],
				isError: false,
				timestamp: Date.now(),
			},
		],
	});
	const outcome = await queued.pending;
	assert.ok(
		"error" in outcome &&
			/no results for calls 2 \(read\)/i.test(outcome.error),
	);
});

test("OMP preserves provider errors even when the failed message has no Chappie source", async (t) => {
	const f = await sessionFixture(t);
	const queued = await f.queue("provider-error");
	const output = await f.dispatch();
	const failed = structuredClone(output.message);
	delete failed.chappie;
	failed.content = [];
	failed.errorMessage = "native provider failed";
	await f.emit("turn_end", { message: failed, toolResults: [] });
	const outcome = await queued.pending;
	assert.ok(
		"error" in outcome && /native provider failed/i.test(outcome.error),
	);
});
