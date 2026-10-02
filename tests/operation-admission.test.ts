import assert from "node:assert/strict";
import { test } from "node:test";
import { State } from "../src/state.ts";
import { sessionFixture } from "./helpers/session-fixture.ts";

test("concurrent fresh submissions still reject different arguments before reusing an acceptance owner", async (t) => {
	const f = await sessionFixture(t);
	const gate = Promise.withResolvers<void>();
	let entered = 0;
	const confirm = State.prototype.confirmBindingUse;
	t.mock.method(
		State.prototype,
		"confirmBindingUse",
		async function (
			this: State,
			...args: Parameters<State["confirmBindingUse"]>
		) {
			await confirm.apply(this, args);
			if (++entered === 2) gate.resolve();
			await gate.promise;
		},
	);
	const results = await Promise.allSettled(
		["one", "two"].map((path) =>
			f.broker.startCall(
				"test-chat",
				"A",
				[{ name: "read", arguments: { path } }],
				"concurrent",
				path,
				f.controller.signal,
			),
		),
	);
	await f.complete(await f.dispatch());
	assert.equal(
		results.filter((result) => result.status === "fulfilled").length,
		1,
	);
	const rejected = results.find((result) => result.status === "rejected");
	assert.ok(rejected?.status === "rejected");
	assert.match(String(rejected.reason), /different arguments/);
});
