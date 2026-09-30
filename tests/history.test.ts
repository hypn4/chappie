import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { historyResult } from "../src/history.ts";

test("re-reading the same history range reflects an updated native entry", () => {
	const entry = {
		type: "custom",
		id: "live-entry",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		customType: "chappie.notice",
		data: { message: "running", type: "info" },
	};
	const branch = [entry as SessionEntry];

	const running = historyResult(branch, "A", { limit: 20 });
	assert.match(JSON.stringify(running.content), /running/);

	entry.data = { message: "completed", type: "info" };
	const completed = historyResult(branch, "A", { limit: 20 });
	assert.match(JSON.stringify(completed.content), /completed/);
	assert.doesNotMatch(JSON.stringify(completed.content), /running/);
	assert.equal(completed.count, running.count);
});

test("history pagination keeps native entry IDs stable across refreshed reads", () => {
	const first = {
		type: "custom",
		id: "first",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		customType: "chappie.notice",
		data: { message: "one", type: "info" },
	};
	const second = {
		type: "custom",
		id: "second",
		parentId: "first",
		timestamp: new Date(2).toISOString(),
		customType: "chappie.notice",
		data: { message: "two", type: "info" },
	};
	const branch = [first as SessionEntry, second as SessionEntry];

	assert.equal(
		historyResult(branch, "A", { limit: 20, after: "first" }).count,
		1,
	);
	second.data = { message: "two updated", type: "info" };
	const refreshed = historyResult(branch, "A", { limit: 20, after: "first" });
	assert.equal(refreshed.count, 1);
	assert.match(JSON.stringify(refreshed.content), /two updated/);
});
