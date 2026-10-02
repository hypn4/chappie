import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { historyInput, historyResult } from "../src/history.ts";

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

test("history entry limits accept both boundaries and reject invalid counts", () => {
	assert.equal(historyInput.parse({}).limit, 20);
	for (const limit of [1, 200])
		assert.equal(historyInput.parse({ limit }).limit, limit);
	for (const limit of [0, -1, 1.5, 201])
		assert.throws(() => historyInput.parse({ limit }), { name: "ZodError" });
});

test("history output stays within the IPC content budget and keeps newest entries", () => {
	const large = {
		type: "message",
		id: "large-tool-result",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message: {
			role: "toolResult",
			toolCallId: "tool",
			toolName: "read",
			isError: false,
			timestamp: 1,
			content: Array.from({ length: 4096 }, () => ({
				type: "text" as const,
				text: "x",
			})),
		},
	} as SessionEntry;
	const latest = {
		type: "custom",
		id: "latest",
		parentId: "large-tool-result",
		timestamp: new Date(2).toISOString(),
		customType: "chappie.notice",
		data: { message: "latest-entry", type: "info" },
	} as SessionEntry;
	const result = historyResult([large, latest], "A", { limit: 2 });
	assert.ok(result.content.length <= 4096);
	assert.match(JSON.stringify(result.content), /latest-entry/);
	assert.equal(result.hasMore, true);
	assert.equal(result.count, 1);
});

test("history preserves oversized entries for lossless final response paging", () => {
	const large = {
		type: "message",
		id: "large-text",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text" as const, text: "\u0001".repeat(1024 * 1024) }],
			api: "chappie",
			provider: "chappie",
			model: "chatgpt",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: "stop",
			timestamp: 1,
		},
	} as SessionEntry;
	const result = historyResult([large], "A", { limit: 1 });
	assert.equal(result.hasMore, false);
	assert.equal(result.count, 1);
	assert.equal(result.content[1]?.type, "text");
	assert.equal(
		(result.content[1] as { text: string }).text,
		"\u0001".repeat(1024 * 1024),
	);
});
