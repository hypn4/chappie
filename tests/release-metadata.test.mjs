import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { releaseMetadata as metadata } from "../scripts/release-metadata.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(
	readFileSync(new URL("package.json", root), "utf8"),
);
const fixture = {
	name: "@hypn4/chappie",
	version: "0.6.0-rc.1",
	license: "MIT",
	repository: { url: "git+https://github.com/hypn4/chappie.git" },
	publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
};
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
	test(`publication requires an explicit channel for ${version}`, () => {
		assert.throws(
			() => metadata({ ...fixture, version }, { tag: `v${version}` }),
			/publishConfig\.tag|channel/i,
		);
	});
}

test("the maintained fork declares its channel before publishing", () => {
	const channel = manifest.publishConfig.tag;
	assert.ok(["latest", "next"].includes(channel));
	assert.equal(metadata(manifest).distTag, channel);
});

test("the committed channel is independent of prerelease classification", () => {
	for (const { version, prerelease } of [
		{ version: "0.6.0-rc.3", prerelease: true },
		{ version: "0.6.0", prerelease: false },
	]) {
		for (const tag of ["latest", "next"]) {
			const value = metadata({
				...fixture,
				version,
				publishConfig: { ...fixture.publishConfig, tag },
			});
			assert.equal(value.distTag, tag);
			assert.equal(value.prerelease, prerelease);
		}
	}
});

test("invalid explicit publish channels fail rather than falling back", () => {
	for (const tag of ["", "beta", "latest; echo invalid", null, 1, ["latest"]]) {
		assert.throws(
			() =>
				metadata({
					...fixture,
					publishConfig: { ...fixture.publishConfig, tag },
				}),
			/publishConfig\.tag|channel/i,
		);
	}
});
test("publishing refuses the upstream package or another repository", () => {
	assert.throws(
		() => metadata({ ...fixture, name: "@zetaloop/chappie" }, {}),
		/package/i,
	);
	assert.throws(
		() => metadata(fixture, { repository: "zetaloop/chappie" }),
		/repository/i,
	);
	assert.throws(
		() =>
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
test("release tag must exactly match the package version", () => {
	assert.throws(() => metadata(fixture, { tag: "v0.6.0" }), /tag/i);
	assert.throws(() => metadata(fixture, { tag: "main" }), /tag/i);
});
test("release policy rejects ambiguous versions and nonpublic registries", () => {
	for (const version of [
		"0.6.0;echo bad",
		"0.6.0-rc.01",
		"0.6.0+local",
		"00.6.0",
	]) {
		assert.throws(() => metadata({ ...fixture, version }, {}), /version/i);
	}
	assert.throws(
		() =>
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
	assert.throws(
		() =>
			metadata(
				{
					...fixture,
					publishConfig: {
						access: "public",
						registry: "https://other.invalid",
					},
				},
				{},
			),
		/registry/i,
	);
});
