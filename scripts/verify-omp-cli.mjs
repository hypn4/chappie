import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: { home: { type: "string" }, cli: { type: "string" } },
});
assert.ok(
	values.home,
	"Provide an isolated home with Chappie installed in .omp/plugins",
);
const home = resolve(values.home);
const manifest = JSON.parse(
	await readFile(
		join(home, ".omp/plugins/node_modules/@hypn4/chappie/package.json"),
		"utf8",
	),
);
assert.equal(manifest.omp?.cli?.chappie, "./dist/src/cli.omp.js");
const cwd = await mkdtemp(join(tmpdir(), "chappie-cli-work-"));
const agentDir = join(home, ".omp/agent");
await mkdir(agentDir, { recursive: true });
const env = {
	...process.env,
	HOME: home,
	USERPROFILE: home,
	PI_CONFIG_DIR: ".omp",
	PI_CODING_AGENT_DIR: agentDir,
	OMP_PROFILE: "",
	PI_PROFILE: "",
	PI_TELEMETRY: "0",
	PI_NO_TITLE: "1",
};
for (const key of [
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"PI_CONFIG_FILES",
])
	delete env[key];
const command = values.cli
	? process.env.BUN_BINARY || "bun"
	: process.env.OMP_BINARY || "omp";
const args = values.cli ? [resolve(values.cli), "--chappie"] : ["--chappie"];
const child = spawn(command, args, {
	cwd,
	env,
	stdio: ["pipe", "pipe", "pipe"],
});
const exit = Promise.withResolvers();
let stderr = "";
let protocolError;
let id = 0;
const pending = new Map();
child.once("error", exit.reject);
child.once("exit", (code, signal) => {
	for (const completion of pending.values())
		completion.reject(new Error(`Broker ended: ${code}/${signal}: ${stderr}`));
	pending.clear();
	exit.resolve({ code, signal });
});
child.stderr.on("data", (bytes) => {
	stderr = (stderr + bytes.toString()).slice(-10000);
});
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
	try {
		const message = JSON.parse(line);
		assert.equal(message.jsonrpc, "2.0");
		if (message.id !== undefined) {
			const completion = pending.get(message.id);
			if (completion) {
				pending.delete(message.id);
				if (message.error)
					completion.reject(new Error(JSON.stringify(message.error)));
				else completion.resolve(message.result);
			}
		}
	} catch (error) {
		protocolError = error;
		for (const completion of pending.values()) completion.reject(error);
		pending.clear();
		child.kill();
	}
});
async function request(method, params) {
	const next = ++id;
	const completion = Promise.withResolvers();
	pending.set(next, completion);
	const deadline = setTimeout(
		() =>
			completion.reject(
				new Error(`No ${method} reply while stdin remained open: ${stderr}`),
			),
		15000,
	);
	child.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: next, method, params })}\n`,
	);
	try {
		return await completion.promise;
	} finally {
		clearTimeout(deadline);
		pending.delete(next);
	}
}
try {
	await request("initialize", {
		protocolVersion: "2025-11-25",
		capabilities: {},
		clientInfo: { name: "chappie-cli-test", version: "1" },
	});
	child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
	const catalog = await request("tools/list", {});
	for (const name of ["init", "sessions", "transfer"])
		assert.ok(
			catalog.tools.some((tool) => tool.name === name),
			name,
		);
	assert.equal(
		child.stdin.writableEnded,
		false,
		"Handshake must succeed before EOF",
	);
	child.stdin.end();
	const deadline = setTimeout(() => child.kill("SIGKILL"), 10000);
	try {
		assert.deepEqual(await exit.promise, { code: 0, signal: null });
	} finally {
		clearTimeout(deadline);
	}
	assert.equal(protocolError, undefined);
	assert.equal(stderr, "");
	console.log(
		JSON.stringify({
			version: manifest.version,
			ompCli: "passed",
			openStdin: "passed",
			cleanStdout: "passed",
			eof: "passed",
		}),
	);
} finally {
	lines.close();
	if (child.exitCode === null && child.signalCode === null)
		child.kill("SIGKILL");
	await exit.promise.catch(() => {});
	await rm(cwd, { recursive: true, force: true });
}
