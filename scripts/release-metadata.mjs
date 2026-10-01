import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Validate release identity before packaging or issuing registry writes. */
export function releaseMetadata(
	pkg,
	{ tag, repository = "hypn4/chappie" } = {},
) {
	assert.equal(repository, "hypn4/chappie", "Unexpected publishing repository");
	assert.equal(pkg.name, "@hypn4/chappie", "Unexpected package name");
	assert.equal(
		pkg.repository?.url,
		"git+https://github.com/hypn4/chappie.git",
		"Package repository must identify this fork",
	);
	assert.equal(pkg.publishConfig?.access, "public", "Package must be public");
	assert.equal(
		pkg.publishConfig?.registry,
		"https://registry.npmjs.org",
		"Unexpected registry",
	);
	assert.equal(pkg.license, "MIT", "Preserve the upstream license");
	// This fork releases stable versions or numbered RCs; no ambiguous build tags.
	assert.match(
		pkg.version,
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/,
		"Expected a stable or RC version",
	);
	const expected = `v${pkg.version}`;
	if (tag !== undefined)
		assert.equal(tag, expected, "Release tag must match package version");
	const prerelease = pkg.version.includes("-");
	// The publication channel is part of the committed release identity.
	const distTag = pkg.publishConfig.tag;
	assert.ok(
		distTag === "latest" || distTag === "next",
		"publishConfig.tag must select the latest or next channel",
	);
	return {
		name: pkg.name,
		version: pkg.version,
		tag: expected,
		distTag,
		prerelease,
	};
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const pkg = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	);
	const metadata = releaseMetadata(pkg, {
		tag: process.argv[2],
		repository: process.env.GITHUB_REPOSITORY || "hypn4/chappie",
	});
	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(
			process.env.GITHUB_OUTPUT,
			Object.entries(metadata)
				.map(([key, value]) => `${key}=${value}\n`)
				.join(""),
		);
	}
	console.log(JSON.stringify(metadata));
}
