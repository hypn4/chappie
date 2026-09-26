import assert from "node:assert/strict";
import { test } from "node:test";
import { IpcClient, type SessionMessage } from "../src/ipc.ts";
import { ProviderOutput } from "../src/provider-core.ts";
import { sessionFixture } from "./helpers/session-fixture.ts";

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
