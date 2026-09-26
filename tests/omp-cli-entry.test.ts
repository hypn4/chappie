import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const entry = new URL("../src/cli.omp.ts", import.meta.url).href;

test("importing the OMP CLI entry registers no broker and exposes a callable handler", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-cli-import-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const agent = join(root, "agent");
	await mkdir(agent);
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`const module = await import(${JSON.stringify(entry)}); if (typeof module.default !== 'function') throw new Error('Missing CLI handler'); process.stdout.write('IMPORTED_WITHOUT_STARTUP');`,
		],
		{
			cwd: root,
			input: "",
			encoding: "utf8",
			timeout: 10000,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agent,
				OMP_PROFILE: "",
				PI_PROFILE: "",
			},
		},
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "IMPORTED_WITHOUT_STARTUP");
	assert.equal(result.stderr, "");
});
