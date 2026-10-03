import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packages = [
	"@oh-my-pi/pi-ai",
	"@oh-my-pi/pi-coding-agent",
	"@oh-my-pi/pi-utils",
];

/** Select the tested baseline, not the supported peer floor or a global CLI. */
export async function readOmpVerificationVersion(root) {
	const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	const version = pkg.devDependencies?.["@oh-my-pi/pi-coding-agent"];
	assert.ok(
		typeof version === "string" &&
			/^18\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version),
		"Development dependencies must select an exact stable OMP version in the supported 18.x line",
	);
	for (const name of packages) {
		assert.equal(
			pkg.devDependencies[name],
			version,
			`${name} must use the same OMP verification version`,
		);
		const installed = JSON.parse(
			await readFile(join(root, "node_modules", name, "package.json"), "utf8"),
		);
		assert.equal(
			installed.name,
			name,
			`Unexpected installed package for ${name}`,
		);
		assert.equal(
			installed.version,
			version,
			`${name} installed version does not match package.json; run bun ci`,
		);
	}
	return version;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		const version = await readOmpVerificationVersion(
			fileURLToPath(new URL("../", import.meta.url)),
		);
		if (process.env.GITHUB_OUTPUT)
			await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
		console.log(version);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
