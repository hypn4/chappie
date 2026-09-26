import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("source checkouts preserve LF even when Git enables autocrlf", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-eol-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const git = (...args) => {
		const result = spawnSync(
			"git",
			["-c", "core.autocrlf=true", "-c", "core.safecrlf=false", ...args],
			{ cwd: root, encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr);
	};
	git("init", "--quiet");
	const attributes = await readFile(
		new URL("../.gitattributes", import.meta.url),
		"utf8",
	);
	await writeFile(join(root, ".gitattributes"), attributes);
	const expected = 'console.log("fixture");\n';
	await writeFile(join(root, "fixture.ts"), expected);
	git("add", ".");
	await rm(join(root, "fixture.ts"));
	git("checkout-index", "--all");
	assert.equal(await readFile(join(root, "fixture.ts"), "utf8"), expected);
});
