import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A workflow_run notification is not itself proof that its artifact is trusted. */
export function verifyReleaseRun(run, { commit, expectedRunId } = {}) {
	assert.match(
		commit,
		/^[a-f0-9]{40}$/,
		"Expected the checked-out release commit",
	);
	assert.equal(
		run.repository?.full_name,
		"hypn4/chappie",
		"Unexpected run repository",
	);
	assert.equal(
		run.head_repository?.full_name,
		"hypn4/chappie",
		"Fork artifacts cannot be published",
	);
	assert.equal(run.name, "release", "Unexpected verification workflow");
	assert.equal(
		run.path,
		".github/workflows/release.yml",
		"Unexpected verification workflow path",
	);
	assert.equal(run.status, "completed", "Verification has not completed");
	assert.equal(run.conclusion, "success", "Verification did not succeed");
	assert.equal(
		run.head_sha,
		commit,
		"Artifact run must verify the release commit",
	);
	assert.ok(
		Number.isSafeInteger(run.id) && run.id > 0,
		"Invalid run identifier",
	);
	if (expectedRunId !== undefined) {
		assert.match(
			expectedRunId,
			/^[1-9]\d*$/,
			"Invalid triggering run identifier",
		);
		assert.ok(
			Number.isSafeInteger(Number(expectedRunId)),
			"Invalid triggering run identifier",
		);
		assert.equal(
			run.id,
			Number(expectedRunId),
			"Must recover the exact triggering run",
		);
		assert.equal(
			run.event,
			"push",
			"Only release-tag pushes publish automatically",
		);
	} else {
		assert.ok(
			["push", "workflow_dispatch"].includes(run.event),
			"Unexpected verification event",
		);
	}
	return run.id;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const run = JSON.parse(readFileSync(process.argv[2], "utf8"));
	console.log(
		verifyReleaseRun(run, {
			commit: process.argv[3],
			...(process.env.SOURCE_RUN_ID
				? { expectedRunId: process.env.SOURCE_RUN_ID }
				: {}),
		}),
	);
}
