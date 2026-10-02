import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	access,
	appendFile,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { releaseMetadata } from "./release-metadata.mjs";

const checkout = fileURLToPath(new URL("../", import.meta.url));
const required = [
	"dist/src/cli.omp.js",
	"dist/src/index.omp.js",
	"dist/src/instructions.md",
	"dist/src/question.html",
	"dist/src/native-calls.js",
	"dist/src/responses.js",
	"src/index.omp.ts",
	"LICENSE",
];
function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		timeout: 10000,
		maxBuffer: 8 * 1024 * 1024,
		...options,
	});
	if (result.error) throw result.error;
	assert.equal(
		result.status,
		0,
		`${command} failed:\n${result.stdout || ""}\n${result.stderr || ""}`,
	);
	return result;
}
export function validateArchivePaths(files) {
	const seen = new Set();
	for (const name of files) {
		assert.match(name, /^package\//, "Unexpected tarball root");
		assert.ok(
			!name.split("/").includes("..") && !name.includes("\\"),
			"Unsafe archive path",
		);
		assert.doesNotMatch(
			name,
			/(^|\/)(\.beads|\.local-tracker|\.npmrc|\.env(?:\.[^/]*)?|\.git)(\/|$)|\.(pem|key)$/i,
		);
		if (name === "package/") continue;
		const top = name.split("/")[1];
		assert.ok(
			["src", "docs", "dist", "package.json", "README.md", "LICENSE"].includes(
				top,
			),
			`Unexpected packaged file: ${name}`,
		);
		assert.ok(!seen.has(name), `Duplicate archive entry: ${name}`);
		seen.add(name);
	}
}
export async function inspectPackage(archive) {
	const expected = JSON.parse(
		await readFile(join(checkout, "package.json"), "utf8"),
	);
	const files = run("tar", ["-tzf", archive]).stdout.trim().split(/\r?\n/);
	validateArchivePaths(files);
	const pkg = JSON.parse(
		run("tar", ["-xOzf", archive, "package/package.json"]).stdout,
	);
	releaseMetadata(pkg, { tag: `v${expected.version}` });
	assert.equal(pkg.name, expected.name);
	assert.equal(
		pkg.pi,
		undefined,
		"Retired Pi package entry must not be published",
	);
	assert.deepEqual(pkg.omp?.extensions, ["./dist/src/index.omp.js"]);
	for (const key of Object.keys({
		...pkg.dependencies,
		...pkg.peerDependencies,
		...pkg.devDependencies,
	}))
		assert.ok(
			!key.startsWith("@earendil-works/") &&
				key !== "typebox" &&
				key !== "standardwebhooks",
			`Retired dependency: ${key}`,
		);
	for (const removed of [
		"src/index.ts",
		"src/provider.ts",
		"src/host-tools.ts",
		"src/event-types.ts",
		"src/events.ts",
		"src/webhook.ts",
		"dist/src/index.js",
		"dist/src/provider.js",
		"dist/src/host-tools.js",
		"dist/src/event-types.js",
		"dist/src/events.js",
		"dist/src/webhook.js",
	])
		assert.ok(
			!files.includes(`package/${removed}`),
			`Retired entry in archive: ${removed}`,
		);
	for (const name of required)
		assert.ok(files.includes(`package/${name}`), `Missing ${name}`);
	const integrity = `sha512-${createHash("sha512")
		.update(await readFile(archive))
		.digest("base64")}`;
	if (process.env.EXPECTED_INTEGRITY)
		assert.equal(
			integrity,
			process.env.EXPECTED_INTEGRITY,
			"Artifact bytes changed between jobs",
		);
	return { pkg, files: files.length, integrity };
}
export async function prepareConsumer(directory) {
	await mkdir(directory, { recursive: true });
	assert.equal(
		(await readdir(directory)).length,
		0,
		"Consumer directory must be empty",
	);
	await writeFile(
		join(directory, "package.json"),
		JSON.stringify({ name: "chappie-package-check", private: true }),
		{ flag: "wx" },
	);
}
export async function verifyInstalled(directory, expected) {
	const installed = join(resolve(directory), "node_modules", expected.name);
	assert.equal(
		(await lstat(installed)).isSymbolicLink(),
		false,
		"Test an extracted package, not a checkout link",
	);
	const pkg = JSON.parse(
		await readFile(join(installed, "package.json"), "utf8"),
	);
	assert.equal(pkg.name, expected.name, "Installed package name differs");
	assert.equal(
		pkg.version,
		expected.version,
		"Installed package version differs",
	);
	assert.deepEqual(pkg.bin, expected.bin, "Installed executable differs");
	for (const name of required) await access(join(installed, name));
	const agent = await mkdtemp(
		join(process.platform === "win32" ? tmpdir() : "/tmp", "chbroker-"),
	);
	try {
		const result = run(
			process.execPath,
			[join(installed, pkg.bin["chappie-omp"])],
			{
				cwd: directory,
				input: "",
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: agent,
					OMP_PROFILE: "",
					PI_PROFILE: "",
				},
			},
		);
		assert.equal(result.stderr, "");
		assert.equal(result.stdout, "");
	} finally {
		await rm(agent, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 200,
		});
	}
	return installed;
}
async function main() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			prepare: { type: "string" },
			installed: { type: "string" },
			omp: { type: "boolean", default: false },
		},
	});
	assert.equal(
		positionals.length,
		1,
		"Usage: bun scripts/verify-package.mjs package.tgz [--prepare DIR | --installed DIR [--omp]]",
	);
	assert.ok(
		!(values.prepare && values.installed),
		"Select preparation or installed verification",
	);
	assert.ok(!values.omp || values.installed, "--omp requires --installed");
	const archive = resolve(positionals[0]);
	const { pkg, files, integrity } = await inspectPackage(archive);
	let stage = "archive";
	if (values.prepare) {
		await prepareConsumer(resolve(values.prepare));
		stage = "prepared";
	}
	if (values.installed) {
		const consumer = resolve(values.installed);
		const installed = await verifyInstalled(consumer, pkg);
		if (values.omp) {
			const ompRoot = join(consumer, "node_modules/@oh-my-pi/pi-coding-agent");
			const ompPackage = JSON.parse(
				await readFile(join(ompRoot, "package.json"), "utf8"),
			);
			assert.equal(
				typeof ompPackage.bin?.omp,
				"string",
				"Installed OMP package exposes no omp executable",
			);
			const ompEntry = join(ompRoot, ompPackage.bin.omp);
			await access(ompEntry);
			const result = run(
				process.execPath,
				[join(checkout, "scripts/verify-omp.mjs")],
				{
					cwd: checkout,
					timeout: 60000,
					env: {
						...process.env,
						CHAPPIE_PACKAGE_ROOT: installed,
						OMP_ENTRY: ompEntry,
					},
				},
			);
			console.log(result.stdout.trim());
		}
		stage = "installed";
	}
	if (process.env.GITHUB_OUTPUT)
		await appendFile(process.env.GITHUB_OUTPUT, `integrity=${integrity}\n`);
	console.log(
		JSON.stringify({
			name: pkg.name,
			version: pkg.version,
			files,
			integrity,
			stage,
		}),
	);
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	await main();
