import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyReleaseRun } from "../scripts/verify-release-run.mjs";

const commit = "a".repeat(40);
const fixture = {
	id: 1234,
	name: "release",
	path: ".github/workflows/release.yml",
	event: "push",
	status: "completed",
	conclusion: "success",
	head_sha: commit,
	repository: { full_name: "hypn4/chappie" },
	head_repository: { full_name: "hypn4/chappie" },
};

test("automatic CD accepts only the exact successful release run", () => {
	assert.equal(
		verifyReleaseRun(fixture, { commit, expectedRunId: "1234" }),
		1234,
	);
});

test("explicit recovery can use a successful manually prepared release", () => {
	assert.equal(
		verifyReleaseRun({ ...fixture, event: "workflow_dispatch" }, { commit }),
		1234,
	);
});

for (const [name, change] of [
	["failed", { conclusion: "failure" }],
	["cancelled", { conclusion: "cancelled" }],
	["still running", { status: "in_progress" }],
	["other commit", { head_sha: "b".repeat(40) }],
	["other workflow", { path: ".github/workflows/check.yml" }],
	["renamed workflow", { name: "check" }],
	["pull request", { event: "pull_request" }],
	["fork", { head_repository: { full_name: "someone/chappie" } }],
	["other repository", { repository: { full_name: "someone/chappie" } }],
	["other run", { id: 1235 }],
	["manual run", { event: "workflow_dispatch" }],
]) {
	test(`automatic CD refuses ${name} upstream artifacts`, () => {
		assert.throws(() =>
			verifyReleaseRun(
				{ ...fixture, ...change },
				{ commit, expectedRunId: "1234" },
			),
		);
	});
}

test("invalid run identity cannot become a command argument", () => {
	for (const id of [
		"1234\nother=value",
		"1234;echo",
		"0",
		"",
		"9007199254740992",
	]) {
		assert.throws(() =>
			verifyReleaseRun(fixture, { commit, expectedRunId: id }),
		);
	}
	assert.throws(() => verifyReleaseRun({ ...fixture, id: "1234" }, { commit }));
	assert.throws(() => verifyReleaseRun(fixture, { commit: "HEAD" }));
});
