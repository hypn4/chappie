#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function parseOtunnelVersion(output) {
	const match = /^otunnel\s+(\d+)\.(\d+)\.(\d+)(?:[-+][^\s]+)?\s*$/m.exec(
		output.trim(),
	);
	if (!match)
		throw new Error(`Could not parse otunnel version from: ${output.trim()}`);
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
	};
}

export function assertSupportedOtunnelVersion(output) {
	const version = parseOtunnelVersion(output);
	if (version.major !== 0 || version.minor !== 2) {
		throw new Error(
			`Chappie compatibility verification requires otunnel 0.2.x; found ${version.major}.${version.minor}.${version.patch}`,
		);
	}
	return version;
}

export function verifyOtunnelBinary(
	command = process.env.OTUNNEL ?? "otunnel",
) {
	const result = spawnSync(command, ["--version"], { encoding: "utf8" });
	if (result.error?.code === "ENOENT") {
		return { skipped: true, command };
	}
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`${command} --version failed with exit ${result.status}: ${result.stderr.trim()}`,
		);
	}
	return {
		skipped: false,
		command,
		version: assertSupportedOtunnelVersion(result.stdout),
	};
}

function verifyProtocolContracts() {
	const bun = process.execPath;
	const result = spawnSync(
		bun,
		[
			"test",
			"--test-name-pattern=otunnel|duplicate request IDs",
			"tests/server.test.ts",
			"tests/replay.test.ts",
		],
		{ encoding: "utf8", stdio: "pipe" },
	);
	if (result.status !== 0) {
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
		throw new Error("otunnel/Chappie protocol contract tests failed");
	}
	process.stdout.write(result.stdout);
}

function main() {
	const runtime = verifyOtunnelBinary();
	if (runtime.skipped) {
		console.log(
			`SKIP otunnel runtime check: ${runtime.command} is not installed; protocol contract tests still run`,
		);
	} else {
		const { major, minor, patch } = runtime.version;
		console.log(`PASS otunnel runtime ${major}.${minor}.${patch}`);
	}
	if (!process.argv.includes("--version-only")) verifyProtocolContracts();
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main();
}
