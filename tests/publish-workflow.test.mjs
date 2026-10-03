import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { YAML } from "bun";

const workflow = YAML.parse(
	readFileSync(
		new URL("../.github/workflows/publish.yml", import.meta.url),
		"utf8",
	),
);

test("npm CD follows completed release verification without a manual release event", () => {
	assert.deepEqual(workflow.on.workflow_run, {
		workflows: ["release"],
		types: ["completed"],
	});
	assert.equal(
		workflow.on.release,
		undefined,
		"automatic draft publication must not trigger a duplicate publish",
	);
	assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true);
	const gate = workflow.jobs.npm.if;
	assert.match(gate, /workflow_run\.conclusion == 'success'/);
	assert.match(gate, /workflow_run\.event == 'push'/);
	assert.match(
		gate,
		/workflow_run\.head_repository\.full_name == github\.repository/,
	);
});

test("npm CD checks out and downloads the exact completed upstream run", () => {
	const steps = workflow.jobs.npm.steps;
	const checkout = steps.find((step) =>
		step.uses?.startsWith("actions/checkout@"),
	);
	assert.match(checkout.with.ref, /github\.event\.workflow_run\.head_sha/);
	const recover = steps.find((step) => step.id === "recover");
	assert.ok(recover);
	assert.equal(
		recover.env.SOURCE_RUN_ID,
		`\${{ github.event.workflow_run.id }}`,
	);
	assert.match(recover.run, /verify-release-run\.mjs/);
	assert.ok(
		recover.run.indexOf("verify-release-run.mjs") <
			recover.run.indexOf("gh run download"),
	);
	assert.match(recover.run, /cmp verified\/package\.tgz release\/package\.tgz/);
});

test("publication preserves OIDC identity and exposes the release only after registry verification", () => {
	const job = workflow.jobs.npm;
	assert.equal(job.environment, "release");
	assert.equal(job.permissions["id-token"], "write");
	assert.equal(job.permissions.contents, "write");
	assert.equal(workflow.concurrency["cancel-in-progress"], false);
	const publish = job.steps.findIndex((step) => step.id === "publish");
	const verify = job.steps.findIndex((step) => step.id === "registry");
	const release = job.steps.findIndex((step) => step.id === "release");
	assert.ok(publish >= 0 && verify > publish && release > verify);
	for (const index of [publish, verify, release]) {
		assert.equal(job.steps[index].if, "inputs.dry_run != true");
	}
	assert.match(
		job.steps[publish].run,
		/npm publish \.\/package\.tgz --ignore-scripts/,
	);
	assert.match(job.steps[release].run, /--draft=false/);
	assert.doesNotMatch(
		JSON.stringify(workflow),
		/NPM_TOKEN|NODE_AUTH_TOKEN.*secrets|npm dist-tag add/,
	);
});
