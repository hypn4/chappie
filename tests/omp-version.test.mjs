import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { YAML } from "bun";

const packages = [
	"@oh-my-pi/pi-ai",
	"@oh-my-pi/pi-coding-agent",
	"@oh-my-pi/pi-utils",
];
const script = new URL("../scripts/omp-version.mjs", import.meta.url);

async function fixture(t, version = "18.7.2") {
	const root = await mkdtemp(join(tmpdir(), "chappie-omp-version-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "scripts"));
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({
			devDependencies: Object.fromEntries(
				packages.map((name) => [name, version]),
			),
			peerDependencies: Object.fromEntries(
				packages.map((name) => [name, "^18.4.8"]),
			),
		}),
	);
	for (const name of packages) {
		const directory = join(root, "node_modules", name);
		await mkdir(directory, { recursive: true });
		await writeFile(
			join(directory, "package.json"),
			JSON.stringify({ name, version }),
		);
	}
	return root;
}

function run(root, extraEnv = {}) {
	return spawnSync(process.execPath, [join(root, "scripts/omp-version.mjs")], {
		cwd: tmpdir(),
		env: { ...process.env, GITHUB_OUTPUT: "", ...extraEnv },
		encoding: "utf8",
		timeout: 10000,
	});
}

test("CI selects the same manifest-owned OMP baseline before runtime and consumer checks", async () => {
	const workflow = YAML.parse(
		await readFile(
			new URL("../.github/workflows/check.yml", import.meta.url),
			"utf8",
		),
	);
	for (const name of ["runtime", "package"]) {
		const selection = workflow.jobs[name].steps.find(
			(step) => step.id === "omp",
		);
		assert.ok(
			selection,
			`${name} must resolve its OMP baseline, not hardcode another version`,
		);
		assert.equal(selection.run.trim(), "bun scripts/omp-version.mjs");
	}
	const consumer = workflow.jobs.package.steps.find(
		(step) => step.env?.OMP_VERSION !== undefined,
	);
	assert.ok(consumer, "The clean consumer must use the resolved OMP version");
	assert.equal(consumer.env.OMP_VERSION, `\${{ steps.omp.outputs.version }}`);
	assert.match(consumer.run, /@oh-my-pi\/pi-coding-agent@\$OMP_VERSION/);
	assert.doesNotMatch(consumer.run, /@oh-my-pi\/pi-coding-agent@\d/);
});

test("the selector reads a changed exact baseline independently of cwd and the peer minimum", async (t) => {
	const root = await fixture(t);
	await copyFile(script, join(root, "scripts/omp-version.mjs"));
	const output = join(root, "github-output");
	await writeFile(output, "existing=value\n");
	const result = run(root, { GITHUB_OUTPUT: output });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "18.7.2\n");
	assert.equal(
		await readFile(output, "utf8"),
		"existing=value\nversion=18.7.2\n",
	);
});

test("the selector works without GitHub-specific environment", async (t) => {
	const root = await fixture(t, "18.6.0");
	await copyFile(script, join(root, "scripts/omp-version.mjs"));
	const result = run(root);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "18.6.0\n");
});

for (const invalid of ["^18.5.0", "latest", "18.5.0\nother=value", "18.05.0"]) {
	test(`the selector rejects a non-exact baseline ${JSON.stringify(invalid)} without publishing output`, async (t) => {
		const root = await fixture(t, invalid);
		await copyFile(script, join(root, "scripts/omp-version.mjs"));
		const output = join(root, "github-output");
		await writeFile(output, "existing=value\n");
		const result = run(root, { GITHUB_OUTPUT: output });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /exact stable OMP version/);
		assert.equal(result.stdout, "");
		assert.equal(await readFile(output, "utf8"), "existing=value\n");
	});
}

test("the selector refuses divergent development pins", async (t) => {
	const root = await fixture(t);
	await copyFile(script, join(root, "scripts/omp-version.mjs"));
	const path = join(root, "package.json");
	const manifest = JSON.parse(await readFile(path, "utf8"));
	manifest.devDependencies["@oh-my-pi/pi-utils"] = "18.6.0";
	await writeFile(path, JSON.stringify(manifest));
	const result = run(root);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /pi-utils.*same OMP verification version/);
	assert.equal(result.stdout, "");
});

test("the selector refuses a stale installed package instead of reporting the manifest alone", async (t) => {
	const root = await fixture(t);
	await copyFile(script, join(root, "scripts/omp-version.mjs"));
	await writeFile(
		join(root, "node_modules/@oh-my-pi/pi-ai/package.json"),
		JSON.stringify({ name: "@oh-my-pi/pi-ai", version: "18.4.8" }),
	);
	const result = run(root);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /pi-ai.*does not match/);
	assert.equal(result.stdout, "");
});

test("CI covers normal and forced-yield native and installed-package checks", async () => {
	const workflow = YAML.parse(
		await readFile(
			new URL("../.github/workflows/check.yml", import.meta.url),
			"utf8",
		),
	);
	for (const name of ["source", "runtime"]) {
		const steps = workflow.jobs[name].steps;
		assert.ok(
			steps.some(
				(step) =>
					step.run === "bun run test:omp" &&
					step.env?.CHAPPIE_VERIFY_CALL_WAIT_MS === undefined,
			),
		);
		const forced = steps.find(
			(step) => step.env?.CHAPPIE_VERIFY_CALL_WAIT_MS === "1",
		);
		assert.ok(forced, `${name} must exercise automatic operation recovery`);
		assert.equal(
			forced.run,
			"bun run test:omp",
			"Use the package script so native OMP resolves from node_modules/.bin",
		);
		if (name === "source")
			assert.equal(forced.if, "matrix.os == 'windows-latest'");
	}
	const consumer = workflow.jobs.package.steps.find(
		(step) => step.env?.OMP_VERSION !== undefined,
	);
	assert.match(
		consumer.run,
		/CHAPPIE_VERIFY_CALL_WAIT_MS=1 bun scripts\/verify-package\.mjs/,
	);
});
