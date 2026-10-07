import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const api = import(new URL("../scripts/verify-package.mjs", import.meta.url));
const manifest = JSON.parse(
	await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

async function temporary(t) {
	const root = await mkdtemp(join(tmpdir(), "chappie-consumer-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("archive policy rejects unsafe paths for the intended reason", async () => {
	const { validateArchivePaths } = await api;
	assert.doesNotThrow(() =>
		validateArchivePaths([
			"package/",
			"package/src/a.ts",
			"package/package.json",
		]),
	);
	for (const [path, error] of [
		["package/../secret", /Unsafe archive path/],
		["/package/src/a", /Unexpected tarball root/],
		["package/src/.env.local", /must not match|not match/i],
		["package/src/client.key", /must not match|not match/i],
		["package/.local-tracker/a", /must not match|not match/i],
		["package/src/a\\b", /Unsafe archive path/],
	])
		assert.throws(() => validateArchivePaths([path]), error, path);
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

for (const retired of ["src/omp-agent-dir.ts", "dist/src/omp-agent-dir.js"]) {
	test(`package inspection rejects the retired storage resolver ${retired}`, async (t) => {
		const { inspectPackage } = await api;
		const root = await temporary(t);
		const destination = join(root, "package", retired);
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, "export {};\n");
		await writeFile(
			join(root, "package", "package.json"),
			JSON.stringify(manifest),
		);
		const archive = join(root, "retired.tgz");
		await promisify(execFile)("tar", ["-czf", archive, "-C", root, "package"]);
		await assert.rejects(inspectPackage(archive), (error) => {
			assert.equal(error.message, `Retired entry in archive: ${retired}`);
			return true;
		});
	});
}
