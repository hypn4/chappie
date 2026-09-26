import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(
	readFileSync(new URL("package.json", root), "utf8"),
);
const helper = new URL("scripts/release-metadata.mjs", root);
const fixture = {
	name: "@hypn4/chappie",
	version: "0.6.0-rc.1",
	license: "MIT",
	repository: { url: "git+https://github.com/hypn4/chappie.git" },
	publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
};
async function metadata(...args) {
	assert.ok(
		existsSync(helper),
		"A release identity validator is required before publishing",
	);
	return (await import(helper.href)).releaseMetadata(...args);
}
test("the fork has its own public package identity without changing upstream attribution", () => {
	assert.equal(manifest.name, fixture.name);
	assert.equal(manifest.repository.url, fixture.repository.url);
	assert.equal(manifest.publishConfig.access, "public");
	assert.equal(manifest.publishConfig.registry, fixture.publishConfig.registry);
	assert.equal(manifest.author, "zetaloop");
	assert.match(
		readFileSync(new URL("LICENSE", root), "utf8"),
		/Copyright \(c\) 2026 zetaloop/,
	);
	assert.equal(manifest.bin["chappie-omp"], "./dist/src/cli.omp.js");
});
test("release candidates select next rather than latest", async () => {
	const value = await metadata(fixture, {
		tag: "v0.6.0-rc.1",
		repository: "hypn4/chappie",
	});
	assert.equal(value.distTag, "next");
	assert.equal(value.prerelease, true);
});
test("stable versions select latest", async () => {
	const value = await metadata(
		{ ...fixture, version: "0.6.0" },
		{ tag: "v0.6.0", repository: "hypn4/chappie" },
	);
	assert.equal(value.distTag, "latest");
	assert.equal(value.prerelease, false);
});
test("publishing refuses the upstream package or another repository", async () => {
	await assert.rejects(
		metadata({ ...fixture, name: "@zetaloop/chappie" }, {}),
		/package/i,
	);
	await assert.rejects(
		metadata(fixture, { repository: "zetaloop/chappie" }),
		/repository/i,
	);
	await assert.rejects(
		metadata(
			{
				...fixture,
				repository: { url: "git+https://github.com/zetaloop/chappie.git" },
			},
			{},
		),
		/repository/i,
	);
});
test("release tag must exactly match the package version", async () => {
	await assert.rejects(metadata(fixture, { tag: "v0.6.0" }), /tag/i);
	await assert.rejects(metadata(fixture, { tag: "main" }), /tag/i);
});
test("release policy rejects ambiguous versions and nonpublic registries", async () => {
	for (const version of [
		"0.6.0;echo bad",
		"0.6.0-rc.01",
		"0.6.0+local",
		"00.6.0",
	]) {
		await assert.rejects(metadata({ ...fixture, version }, {}), /version/i);
	}
	await assert.rejects(
		metadata(
			{
				...fixture,
				publishConfig: {
					access: "restricted",
					registry: fixture.publishConfig.registry,
				},
			},
			{},
		),
		/public/i,
	);
	await assert.rejects(
		metadata(
			{
				...fixture,
				publishConfig: { access: "public", registry: "https://other.invalid" },
			},
			{},
		),
		/registry/i,
	);
});

test("workflow action pins include the repository and full commit SHA", () => {
	for (const file of ["check.yml", "release.yml", "publish.yml"]) {
		const text = readFileSync(
			new URL(`.github/workflows/${file}`, root),
			"utf8",
		);
		const actions = [...text.matchAll(/uses:\s*(\S+)/g)];
		assert.ok(actions.length > 0);
		for (const [, action] of actions)
			assert.match(
				action,
				/^(?:[\w-]+\/[\w-]+@[a-f0-9]{40}|\.\/\.github\/workflows\/check\.yml)$/,
				file,
			);
	}
});

test("release checkout keeps source files LF even with core.autocrlf enabled", async () => {
	const { spawnSync } = await import("node:child_process");
	const files = [
		"src/server.ts",
		"scripts/verify-package.mjs",
		"package.json",
		".github/workflows/check.yml",
	];
	const result = spawnSync(
		"git",
		["-c", "core.autocrlf=true", "check-attr", "eol", "--", ...files],
		{ cwd: root, encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(
		result.stdout.trim().split(/\r?\n/),
		files.map((file) => `${file}: eol: lf`),
	);
});
