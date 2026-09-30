import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("../scripts/verify-package.mjs", import.meta.url);
const source = await readFile(script, "utf8");
const manifest = JSON.parse(
	await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
async function api() {
	assert.match(
		source,
		/export async function prepareConsumer/,
		"Separate preparation from Bun installation",
	);
	return import(script.href);
}
async function temporary(t) {
	const root = await mkdtemp(join(tmpdir(), "chappie consumer "));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("OMP verification loads the published compiled extension entry", async () => {
	const ompSource = await readFile(
		new URL("../scripts/verify-omp.mjs", import.meta.url),
		"utf8",
	);
	assert.doesNotMatch(ompSource, /candidate\/src\/index\.omp\.ts/);
	assert.match(ompSource, /omp\?\.extensions|omp\.extensions/);
	assert.match(
		ompSource,
		/candidate.*extensionEntry|extensionEntry.*candidate/s,
	);
});

test("package verification never locates or spawns a package manager", () => {
	assert.doesNotMatch(
		source,
		/npm-cli\.js|npm\.cmd|where\.exe|cmd\.exe|ComSpec/,
	);
	assert.doesNotMatch(source, /run\("npm"/);
});
test("consumer preparation preserves existing user files", async (t) => {
	const { prepareConsumer } = await api();
	const root = await temporary(t);
	await writeFile(join(root, "keep.txt"), "original");
	await assert.rejects(prepareConsumer(root), /empty|exists/i);
	assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "original");
});
test("consumer preparation creates an empty private project without checkout dependencies", async (t) => {
	const { prepareConsumer } = await api();
	const root = join(await temporary(t), "isolated");
	await prepareConsumer(root);
	const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	assert.equal(pkg.private, true);
	assert.equal(pkg.dependencies, undefined);
	assert.equal(pkg.devDependencies, undefined);
	await assert.rejects(prepareConsumer(root), /empty|exists/i);
});
test("archive policy rejects traversal and local secrets", async () => {
	const { validateArchivePaths } = await api();
	for (const path of [
		"package/../secret",
		"/package/src/a",
		"package/src/.env.local",
		"package/src/client.key",
		"package/.local-tracker/a",
		"package/src/a\\b",
	]) {
		assert.throws(() => validateArchivePaths([path]), undefined, path);
	}
	assert.doesNotThrow(() =>
		validateArchivePaths([
			"package/",
			"package/src/",
			"package/src/index.ts",
			"package/LICENSE",
		]),
	);
});
test("installed checks use the consumer bytes and reject a mismatched manifest", async (t) => {
	const { verifyInstalled } = await api();
	const root = await temporary(t);
	const installed = join(root, "node_modules", manifest.name);
	await mkdir(installed, { recursive: true });
	await writeFile(
		join(installed, "package.json"),
		JSON.stringify({ ...manifest, version: "0.0.0" }),
	);
	await assert.rejects(verifyInstalled(root, manifest), /version/i);
});
test("the real installed JavaScript broker is checked without package-manager invocation", async (t) => {
	const { verifyInstalled } = await api();
	const root = await temporary(t);
	const installed = join(root, "node_modules", manifest.name);
	await mkdir(join(installed, "dist/src"), { recursive: true });
	await mkdir(join(installed, "src"));
	await mkdir(join(root, "node_modules/.bin"));
	await writeFile(join(installed, "package.json"), JSON.stringify(manifest));
	await writeFile(
		join(installed, "dist/src/cli.omp.js"),
		"// Test fixture exits on stdin EOF.\n",
	);
	for (const file of [
		"dist/src/index.omp.js",
		"dist/src/instructions.md",
		"dist/src/question.html",
		"src/index.ts",
		"LICENSE",
	])
		await writeFile(join(installed, file), "fixture");
	await writeFile(
		join(
			root,
			"node_modules/.bin",
			process.platform === "win32" ? "chappie-omp.cmd" : "chappie-omp",
		),
		"fixture",
	);
	assert.equal(await verifyInstalled(root, manifest), installed);
});
test("consumer CI uses setup-bun and installs the shared artifact with Bun", async () => {
	const text = await readFile(
		new URL("../.github/workflows/check.yml", import.meta.url),
		"utf8",
	);
	assert.match(text, /workflow_call:/);
	const consumer = text.split("\n  install:\n")[1];
	assert.ok(consumer, "A dedicated Bun consumer job must exist");
	assert.match(consumer, /needs: package/);
	assert.match(consumer, /oven-sh\/setup-bun@[a-f0-9]{40}/);
	assert.match(consumer, /actions\/download-artifact@/);
	assert.doesNotMatch(consumer, /pnpm|setup-node|npm install/);
	assert.match(consumer, /bun add --ignore-scripts/);
	assert.match(consumer, /--omp/);
});

test("Node is isolated to the npm OIDC publish boundary", async () => {
	const check = await readFile(
		new URL("../.github/workflows/check.yml", import.meta.url),
		"utf8",
	);
	const release = await readFile(
		new URL("../.github/workflows/release.yml", import.meta.url),
		"utf8",
	);
	const publish = await readFile(
		new URL("../.github/workflows/publish.yml", import.meta.url),
		"utf8",
	);
	assert.doesNotMatch(check, /actions\/setup-node@|npm publish/);
	assert.doesNotMatch(release, /actions\/setup-node@|npm publish/);
	assert.equal((publish.match(/actions\/setup-node@/g) ?? []).length, 1);
	assert.match(publish, /Verify npm Trusted Publishing client/);
	assert.match(publish, /npm publish/);
	assert.doesNotMatch(publish, /npm (?:ci|install|pack|test)\b/);
});
