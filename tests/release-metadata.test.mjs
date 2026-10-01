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
for (const version of ["0.6.0-rc.1", "0.6.0"]) {
	test(`publication requires an explicit channel for ${version}`, async () => {
		await assert.rejects(
			metadata({ ...fixture, version }, { tag: `v${version}` }),
			/publishConfig\.tag|channel/i,
		);
	});
}

test("the maintained fork declares its channel before publishing", async () => {
	const channel = manifest.publishConfig.tag;
	assert.ok(["latest", "next"].includes(channel));
	assert.equal((await metadata(manifest)).distTag, channel);
});

test("the committed channel is independent of prerelease classification", async () => {
	for (const version of ["0.6.0-rc.3", "0.6.0"]) {
		for (const tag of ["latest", "next"]) {
			const value = await metadata({
				...fixture,
				version,
				publishConfig: { ...fixture.publishConfig, tag },
			});
			assert.equal(value.distTag, tag);
			assert.equal(value.prerelease, version.includes("-"));
		}
	}
});

test("invalid explicit publish channels fail rather than falling back", async () => {
	for (const tag of ["", "beta", "latest; echo invalid", null, 1, ["latest"]]) {
		await assert.rejects(
			metadata({
				...fixture,
				publishConfig: { ...fixture.publishConfig, tag },
			}),
			/publishConfig\.tag|channel/i,
		);
	}
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
