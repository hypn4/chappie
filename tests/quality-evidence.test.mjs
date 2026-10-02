import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	inspectEvidence,
	runEvidence,
	snapshot,
} from "../scripts/quality-evidence.mjs";

const cli = fileURLToPath(
	new URL("../scripts/quality-evidence.mjs", import.meta.url),
);
async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "ch-quality-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const init = spawnSync("git", ["init", "--quiet", root], {
		encoding: "utf8",
	});
	assert.equal(init.status, 0, init.stderr);
	await writeFile(join(root, ".gitignore"), ".quality/\nnode_modules/\n");
	await writeFile(
		join(root, "package.json"),
		'{"name":"fixture","dependencies":{}}\n',
	);
	await writeFile(join(root, "input.txt"), "original");
	return root;
}

test("evidence source identity includes untracked inputs and deletions but excludes local reports", async (t) => {
	const root = await fixture(t);
	const before = await snapshot(root);
	await mkdir(join(root, ".quality"));
	await writeFile(join(root, ".quality", "log"), "not a source input");
	assert.equal((await snapshot(root)).sourceDigest, before.sourceDigest);
	await writeFile(join(root, "untracked.txt"), "new input");
	const added = await snapshot(root);
	assert.notEqual(added.sourceDigest, before.sourceDigest);
	await rm(join(root, "input.txt"));
	assert.notEqual((await snapshot(root)).sourceDigest, added.sourceDigest);
});

test("fresh evidence is reusable in a new process and becomes stale after a source edit", async (t) => {
	const root = await fixture(t);
	const run = await runEvidence(root, [
		process.execPath,
		"-e",
		'console.log("CHECK_OK")',
	]);
	assert.equal(run.report.status, "pass");
	assert.match(await readFile(run.logPath, "utf8"), /CHECK_OK/);
	assert.equal((await inspectEvidence(root, run.reportPath)).status, "pass");
	const cold = spawnSync(process.execPath, [cli, "inspect", run.reportPath], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(cold.status, 0, cold.stderr);
	assert.equal(JSON.parse(cold.stdout).status, "pass");
	await writeFile(join(root, "input.txt"), "changed after verification");
	const stale = spawnSync(process.execPath, [cli, "inspect", run.reportPath], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(stale.status, 1);
	assert.equal(JSON.parse(stale.stdout).status, "stale");
});

test("failed checks and source changes during a check never produce reusable PASS", async (t) => {
	const root = await fixture(t);
	const failed = await runEvidence(root, [
		process.execPath,
		"-e",
		"process.exit(7)",
	]);
	assert.equal(failed.report.exitCode, 7);
	assert.equal((await inspectEvidence(root, failed.reportPath)).status, "fail");
	const changed = await runEvidence(root, [
		process.execPath,
		"-e",
		'require("node:fs").writeFileSync("input.txt", "during-run")',
	]);
	assert.equal(changed.report.exitCode, 0);
	assert.equal(changed.report.status, "stale");
	assert.equal(
		(await inspectEvidence(root, changed.reportPath)).status,
		"stale",
	);
});

test("missing or changed evidence logs are invalid rather than silently trusted", async (t) => {
	const root = await fixture(t);
	const run = await runEvidence(root, [
		process.execPath,
		"-e",
		'console.log("proof")',
	]);
	await writeFile(run.logPath, "tampered");
	assert.equal((await inspectEvidence(root, run.reportPath)).status, "invalid");
	await rm(run.logPath);
	assert.equal((await inspectEvidence(root, run.reportPath)).status, "invalid");
});

test("runtime changes invalidate old evidence without running the recorded command", async (t) => {
	const root = await fixture(t);
	const run = await runEvidence(root, [
		process.execPath,
		"-e",
		'console.log("proof")',
	]);
	const report = JSON.parse(await readFile(run.reportPath, "utf8"));
	report.after.environment.platform = "other-platform";
	await writeFile(run.reportPath, JSON.stringify(report));
	const checked = await inspectEvidence(root, run.reportPath);
	assert.equal(checked.status, "stale");
	assert.match(checked.reason, /environment/i);
});

test("inspecting evidence never repeats the recorded command", async (t) => {
	const root = await fixture(t);
	const run = await runEvidence(root, [
		process.execPath,
		"-e",
		'const fs=require("node:fs"); const p=".quality/effects"; fs.writeFileSync(p,String(Number(fs.existsSync(p)?fs.readFileSync(p,"utf8"):0)+1))',
	]);
	assert.equal(run.report.status, "pass");
	for (let attempt = 0; attempt < 2; attempt++)
		assert.equal((await inspectEvidence(root, run.reportPath)).status, "pass");
	assert.equal(await readFile(join(root, ".quality/effects"), "utf8"), "1");
});

test("source identity detects executable-permission changes", {
	skip: process.platform === "win32",
}, async (t) => {
	const root = await fixture(t);
	const path = join(root, "input.txt");
	await chmod(path, 0o644);
	const before = await snapshot(root);
	await chmod(path, 0o755);
	assert.notEqual((await snapshot(root)).sourceDigest, before.sourceDigest);
});
