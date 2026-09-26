import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sameSource, source } from "../src/activity.ts";

describe("sameSource", () => {
	test("matches cloned responses from the same Chappie request", () => {
		const original = source("chat-1234", "request-1");
		const cloned = { ...original };

		assert.notStrictEqual(cloned, original);
		assert.equal(sameSource(original, cloned), true);
	});

	test("matches a request when both sides omit requestId", () => {
		assert.equal(
			sameSource(
				source("chat-1234", undefined),
				source("chat-1234", undefined),
			),
			true,
		);
	});

	test("rejects responses from a different request", () => {
		assert.equal(
			sameSource(
				source("chat-1234", "request-1"),
				source("chat-1234", "request-2"),
			),
			false,
		);
	});
});
