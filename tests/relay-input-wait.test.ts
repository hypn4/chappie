import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { operationIdentity } from "../src/operations.ts";
import { ProviderOutput } from "../src/provider-core.ts";
import { multiSessionFixture, until } from "./helpers/session-fixture.ts";

const model = { api: "chappie", provider: "chappie", id: "chatgpt" };
const calls = [{ name: "read", arguments: { path: "test.txt" } }];

for (const kind of ["call", "chat"] as const) {
	test(`remote_${kind} preserves a model-input wait and resumes the same identity once`, async (t) => {
		const f = await multiSessionFixture(t, ["A", "B"], true);
		const target = f.session("B");
		const source = f.session("A").local;
		const output = new ProviderOutput(model, f.controller.signal);
		const generation = target.local.generate(
			output,
			{ kind: "compaction", input: {} },
			"B",
		);
		let requestId: string | undefined;
		await until(async () => {
			requestId = (
				await f.broker.inputs("test-chat", "B", f.controller.signal)
			).find((input) => "request" in input)?.id;
			return requestId !== undefined;
		});
		assert.ok(requestId);
		const operationId = `relay-wait-${kind}`;
		const invoke = () =>
			kind === "call"
				? source.remoteCall("B", operationId, calls, f.controller.signal)
				: source.remoteChat(
						"B",
						operationId,
						"progress",
						undefined,
						f.controller.signal,
					);
		const waiting = await invoke();
		assert.ok("execution" in waiting);
		assert.equal(waiting.execution?.executed, false);
		assert.ok(waiting.inputs.some((input) => input.id === requestId));
		const saved = JSON.parse(
			await readFile(join(f.root, "chappie.state.json"), "utf8"),
		);
		const key = operationIdentity(
			"A",
			"B",
			kind,
			operationId,
			kind === "call" ? calls : "progress",
		)?.key;
		assert.equal(
			saved.operations.find((receipt: { key: string }) => receipt.key === key)
				?.status,
			"waiting_input",
		);
		await source.remoteChat(
			"B",
			`reply-${kind}`,
			"summary",
			requestId,
			f.controller.signal,
		);
		await generation;
		const resumed = invoke();
		const native = new ProviderOutput(model, f.controller.signal);
		await target.local.start(native);
		const call = native.message.content.find(
			(item) => item.type === "toolCall",
		);
		const results =
			call?.type === "toolCall"
				? [
						{
							role: "toolResult",
							toolCallId: call.id,
							toolName: call.name,
							content: [{ type: "text", text: "done" }],
							isError: false,
							timestamp: Date.now(),
						},
					]
				: [];
		await target.emit("turn_end", {
			message: native.message,
			toolResults: results,
		});
		await target.emit("agent_end", { willContinue: false });
		assert.equal("execution" in (await resumed), false);
		await assert.rejects(invoke(), /Already accepted.*completed/);
	});
}
