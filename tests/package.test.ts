import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("installed Node CLI uses JavaScript and includes runtime assets", async (t) => {
	const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	assert.match(pkg.bin["chappie-omp"], /\.js$/);
	const build = spawnSync(process.execPath, [join(root, "scripts/build.mjs")], {
		cwd: root,
		encoding: "utf8",
		timeout: 30000,
	});
	assert.equal(build.status, 0, build.stdout + build.stderr);
	const temporary = await mkdtemp(
		join(process.platform === "win32" ? tmpdir() : "/tmp", "chpkg-"),
	);
	t.after(() => rm(temporary, { recursive: true, force: true }));
	const installed = join(temporary, "node_modules", pkg.name);
	await mkdir(installed, { recursive: true });
	for (const directory of pkg.files)
		await cp(join(root, directory), join(installed, directory), {
			recursive: true,
		});
	await cp(join(root, "package.json"), join(installed, "package.json"));
	await symlink(
		join(root, "node_modules"),
		join(installed, "node_modules"),
		process.platform === "win32" ? "junction" : "dir",
	);
	const agent = join(temporary, "agent");
	await mkdir(agent);
	const cli = join(installed, pkg.bin["chappie-omp"]);
	await readFile(join(dirname(cli), "instructions.md"));
	await readFile(join(dirname(cli), "question.html"));
	const result = spawnSync(process.execPath, [cli], {
		cwd: temporary,
		encoding: "utf8",
		input: "",
		timeout: 10000,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agent,
			OMP_PROFILE: "",
			PI_PROFILE: "",
		},
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
});
