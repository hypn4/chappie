import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createOmpPrimaryContextMessage,
	hasOmpPrimaryContext,
	markOmpPrimaryContext,
} from "../src/omp-primary-context.ts";

test("OMP primary provenance survives in-process message copies without changing serialized content", () => {
	const original = [
		{
			role: "user" as const,
			content: "hello",
			timestamp: 1,
		},
	];
	const marked = markOmpPrimaryContext(original, "session-A");

	assert.equal(
		hasOmpPrimaryContext({ messages: original }, "session-A"),
		false,
	);
	assert.equal(hasOmpPrimaryContext({ messages: marked }, "session-A"), true);
	assert.equal(hasOmpPrimaryContext({ messages: marked }, "session-B"), false);
	assert.equal(JSON.stringify(marked), JSON.stringify(original));

	const copied = marked.map((message) => ({ ...message }));
	assert.equal(hasOmpPrimaryContext({ messages: copied }, "session-A"), true);

	const serialized = JSON.parse(JSON.stringify(marked));
	assert.equal(
		hasOmpPrimaryContext({ messages: serialized }, "session-A"),
		false,
	);
});

test("OMP primary provenance uses an inert carrier when no provider message can carry it", () => {
	const customOnly = [
		{
			role: "custom" as const,
			customType: "fixture",
			content: "",
			display: false,
			timestamp: 1,
		},
	];
	const marked = markOmpPrimaryContext(customOnly, "session-A");

	assert.equal(marked.length, 2);
	assert.deepEqual(marked[0], customOnly[0]);
	assert.equal(hasOmpPrimaryContext({ messages: marked }, "session-A"), true);
	assert.equal(hasOmpPrimaryContext({ messages: marked }, "session-B"), false);

	const fallback = createOmpPrimaryContextMessage("session-A");
	assert.equal(
		hasOmpPrimaryContext({ messages: [fallback] }, "session-A"),
		true,
	);
	assert.equal(JSON.stringify(fallback).includes("session-A"), false);
});
