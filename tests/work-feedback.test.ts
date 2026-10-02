import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { toolResult } from "../src/tools.ts";
import { observeSessionWork } from "../src/work.omp.ts";
import { continuationFor, type SessionWork } from "../src/work.ts";

function header(result: ReturnType<typeof toolResult>) {
	const block = result.content[0];
	assert.ok(block?.type === "text");
	return JSON.parse(block.text);
}

for (const [state, nextAction] of [
	["actionable", "continue_requested_work"],
	["blocked", "review_blockers"],
	["settled", "verify_requested_scope"],
	["untracked", "verify_requested_scope"],
	["unknown", "verify_requested_scope"],
] as const) {
	test(`batch result ${state} never claims user-scope completion`, () => {
		const work: SessionWork = {
			source: "omp_todo",
			scope: "session",
			observedAt: 1,
			state,
		};
		const result = toolResult(
			[],
			"A",
			"/fixture",
			[],
			undefined,
			undefined,
			undefined,
			{ work },
		);
		assert.deepEqual(header(result).continuation, {
			scope: "native_batch",
			userGoal: "not_evaluated",
			nextAction,
		});
		assert.deepEqual(header(result).work, work);
	});
}

test("model-input wait is explicit nonterminal feedback, not a failed native call", () => {
	const result = toolResult([], "A", "/fixture", [], undefined, undefined, {
		status: "needs_input",
		executed: false,
		reason: "model_request_pending",
	});
	assert.equal(result.isError, false);
	assert.equal(header(result).execution.executed, false);
	assert.equal(header(result).continuation.nextAction, "answer_model_request");
});

test("native failures take precedence over actionable TODOs", () => {
	const result = toolResult(
		[
			{
				role: "toolResult",
				toolCallId: "x",
				toolName: "read",
				content: [],
				isError: true,
				timestamp: 1,
			},
		],
		"A",
		"/fixture",
		[],
		undefined,
		undefined,
		undefined,
		{
			work: {
				source: "omp_todo",
				scope: "session",
				observedAt: 1,
				state: "actionable",
			},
		},
	);
	assert.equal(result.isError, true);
	assert.equal(header(result).continuation.nextAction, "inspect_failure");
});

test("malformed optional native TODO data is unknown rather than a failed batch or completed goal", () => {
	const bad: SessionEntry = {
		type: "custom",
		id: "bad",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		customType: "user_todo_edit",
		data: { phases: [{ name: "bad", tasks: null }] },
	};
	assert.equal(observeSessionWork([bad]).state, "unknown");
	assert.equal(observeSessionWork([]).state, "untracked");
});

for (const [status, state, counter] of [
	["pending", "actionable", "pending"],
	["in_progress", "actionable", "inProgress"],
	["blocked", "blocked", "blocked"],
	["completed", "settled", "completed"],
	["abandoned", "settled", "abandoned"],
] as const) {
	test(`native ${status} is an observation, never verified goal completion`, () => {
		const entry: SessionEntry = {
			type: "custom",
			id: "native-status",
			parentId: null,
			timestamp: new Date(1).toISOString(),
			customType: "user_todo_edit",
			data: {
				phases: [{ name: "Work", tasks: [{ content: "Step", status }] }],
			},
		};
		const work = observeSessionWork([entry]);
		assert.equal(work.state, state);
		assert.equal(work.source, "omp_todo");
		assert.equal(work.scope, "session");
		assert.deepEqual(work.counts, {
			pending: 0,
			inProgress: 0,
			blocked: 0,
			completed: 0,
			abandoned: 0,
			[counter]: 1,
		});
		assert.equal(continuationFor({ work }).userGoal, "not_evaluated");
	});
}

test("clearing the native board removes previous actionable observations", () => {
	const first: SessionEntry = {
		type: "custom",
		id: "first-board",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		customType: "user_todo_edit",
		data: {
			phases: [
				{ name: "Work", tasks: [{ content: "Step", status: "pending" }] },
			],
		},
	};
	const cleared: SessionEntry = {
		...first,
		id: "cleared-board",
		parentId: first.id,
		data: { phases: [] },
	};
	const earlier = observeSessionWork([first]);
	const current = observeSessionWork([first, cleared]);
	assert.equal(earlier.state, "actionable");
	assert.equal(current.state, "untracked");
	assert.equal(current.counts?.pending, 0);
	assert.equal(earlier.counts?.pending, 1);
	assert.equal(
		continuationFor({ work: current }).nextAction,
		"verify_requested_scope",
	);
});
