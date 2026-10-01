import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { State } from "../src/state.ts";

test("obsolete string bindings are rejected without rewriting saved state", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "chappie-state-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "chappie.state.json");
	const source = JSON.stringify({ bindings: { chat: "A" } });
	await writeFile(path, source);
	await assert.rejects(new State(root).load());
	assert.equal(await readFile(path, "utf8"), source);
});
