import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	readlink,
	writeFile,
} from "node:fs/promises";
import { release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hash = (value) => createHash("sha256").update(value).digest("hex");
function git(root, args, optional = false) {
	const result = spawnSync("git", args, {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		timeout: 10000,
	});
	if (optional && result.status !== 0 && !result.error) return null;
	if (result.error) throw result.error;
	assert.equal(result.status, 0, result.stderr || "Git inspection failed");
	return result.stdout;
}

/** Hash the actual checkout, not just HEAD: staged, unstaged and untracked source all count. */
export async function snapshot(directory) {
	const root = git(directory, ["rev-parse", "--show-toplevel"]).trim();
	const names = [
		...new Set(
			git(root, [
				"ls-files",
				"-z",
				"--cached",
				"--others",
				"--exclude-standard",
			])
				.split("\0")
				.filter(Boolean),
		),
	].sort();
	const entries = [];
	for (const name of names) {
		if (name.startsWith(".quality/")) continue;
		const path = join(root, name);
		try {
			const info = await lstat(path);
			if (info.isSymbolicLink()) {
				// Include both link identity and file contents; unresolved/external directory links fail closed.
				entries.push([
					name,
					"symlink",
					await readlink(path),
					hash(await readFile(path)),
				]);
			} else {
				assert.ok(info.isFile(), `Unsupported source entry: ${name}`);
				entries.push([
					name,
					"file",
					info.mode & 0o111,
					hash(await readFile(path)),
				]);
			}
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			entries.push([name, "missing"]);
		}
	}
	const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	const installed = {};
	for (const name of Object.keys({
		...pkg.dependencies,
		...pkg.devDependencies,
		...pkg.peerDependencies,
	}).sort()) {
		try {
			installed[name] = JSON.parse(
				await readFile(
					join(root, "node_modules", name, "package.json"),
					"utf8",
				),
			).version;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			installed[name] = "not-installed";
		}
	}
	return {
		revision:
			git(root, ["rev-parse", "--verify", "HEAD"], true)?.trim() ?? null,
		sourceDigest: hash(JSON.stringify(entries)),
		fileCount: entries.length,
		environment: {
			platform: process.platform,
			arch: process.arch,
			osRelease: release(),
			node: process.versions.node,
			bun: process.versions.bun ?? null,
			timezone: process.env.TZ ?? null,
			installed,
		},
	};
}

function difference(before, after) {
	if (
		before.revision !== after.revision ||
		before.sourceDigest !== after.sourceDigest
	)
		return "source changed";
	if (JSON.stringify(before.environment) !== JSON.stringify(after.environment))
		return "environment changed";
	return null;
}

/** Execute only the command explicitly supplied now; never execute commands loaded from evidence. */
export async function runEvidence(directory, command) {
	assert.ok(
		command.length &&
			command.every((arg) => typeof arg === "string" && arg.length > 0),
		"Provide a command after --",
	);
	const root = git(directory, ["rev-parse", "--show-toplevel"]).trim();
	const before = await snapshot(root);
	await mkdir(join(root, ".quality"), { recursive: true, mode: 0o700 });
	const output = await mkdtemp(join(root, ".quality", "run-"));
	const logPath = join(output, "output.log");
	const reportPath = join(output, "report.json");
	const log = await open(logPath, "wx", 0o600);
	const startedAt = new Date().toISOString();
	let execution;
	try {
		execution = spawnSync(command[0], command.slice(1), {
			cwd: root,
			stdio: ["ignore", log.fd, log.fd],
			timeout: 20 * 60 * 1000,
			windowsHide: true,
		});
	} finally {
		await log.close();
	}
	const after = await snapshot(root);
	const drift = difference(before, after);
	const report = {
		version: 1,
		command,
		cwd: root,
		startedAt,
		finishedAt: new Date().toISOString(),
		exitCode: execution.status,
		signal: execution.signal,
		...(execution.error ? { error: execution.error.message } : {}),
		status:
			execution.status !== 0 || execution.error
				? "fail"
				: drift
					? "stale"
					: "pass",
		...(drift ? { reason: drift } : {}),
		before,
		after,
		logDigest: hash(await readFile(logPath)),
	};
	await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
		flag: "wx",
		mode: 0o600,
	});
	return { reportPath, logPath, report };
}

/** A reusable PASS is evidence for this exact command and subject, not a global completion verdict. */
export async function inspectEvidence(directory, reportPath) {
	let report;
	try {
		report = JSON.parse(await readFile(reportPath, "utf8"));
		assert.equal(report.version, 1, "Unsupported evidence format");
		assert.ok(
			Array.isArray(report.command) && report.command.length > 0,
			"Missing command",
		);
		assert.ok(
			["pass", "fail", "stale"].includes(report.status),
			"Invalid evidence status",
		);
		for (const subject of [report.before, report.after]) {
			assert.match(subject.sourceDigest, /^[a-f0-9]{64}$/);
			assert.ok(subject.environment && typeof subject.environment === "object");
		}
		const bytes = await readFile(join(dirname(reportPath), "output.log"));
		assert.equal(hash(bytes), report.logDigest, "Evidence log changed");
	} catch (error) {
		return { status: "invalid", reason: error.message };
	}
	const current = await snapshot(directory);
	const drift =
		difference(report.before, report.after) ||
		difference(report.after, current);
	const status =
		report.status === "fail" || report.exitCode !== 0
			? "fail"
			: drift || report.status === "stale"
				? "stale"
				: "pass";
	return {
		status,
		reason:
			drift ??
			(status === "pass"
				? "Matching source, environment and log"
				: (report.reason ?? "Recorded check failed")),
		command: report.command,
		reportPath: resolve(reportPath),
		subject: current,
	};
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		const [action, ...args] = process.argv.slice(2);
		let result;
		if (action === "snapshot" && args.length === 0)
			result = await snapshot(process.cwd());
		else if (action === "run" && args[0] === "--")
			result = await runEvidence(process.cwd(), args.slice(1));
		else if (action === "inspect" && args.length === 1)
			result = await inspectEvidence(process.cwd(), args[0]);
		else
			throw new Error(
				"Usage: quality-evidence.mjs snapshot | run -- <command> [args] | inspect <report.json>",
			);
		console.log(JSON.stringify(result, null, 2));
		const status = result.report?.status ?? result.status;
		if (status && status !== "pass") process.exitCode = 1;
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
