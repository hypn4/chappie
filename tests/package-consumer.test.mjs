import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const api = import(new URL("../scripts/verify-package.mjs", import.meta.url));
const manifest = JSON.parse(
	await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

async function temporary(t) {
	const root = await mkdtemp(join(tmpdir(), "chappie-consumer-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("archive policy rejects traversal and local secrets", async () => {
	const { validateArchivePaths } = await api;
	for (const path of [
		"package/../secret",
		"/package/src/a",
		"package/src/.env.local",
		"package/src/client.key",
		"package/.local-tracker/a",
		"package/src/a\\b",
	])
		assert.throws(() => validateArchivePaths([path]), undefined, path);
});

test("installed verification rejects a mismatched package version", async (t) => {
	const { verifyInstalled } = await api;
	const root = await temporary(t);
	const installed = join(root, "node_modules", manifest.name);
	await mkdir(installed, { recursive: true });
	await writeFile(
		join(installed, "package.json"),
		JSON.stringify({ ...manifest, version: "0.0.0" }),
	);
	await assert.rejects(verifyInstalled(root, manifest), /version/i);
});
