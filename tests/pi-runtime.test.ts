import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Broker } from "../src/broker.ts";

test("the pinned Pi runtime retains native read, edit, write and bash behavior", async (t) => {
	const checkout = fileURLToPath(new URL("../", import.meta.url));
	const packageRoot = join(
		checkout,
		"node_modules/@earendil-works/pi-coding-agent",
	);
	const pkg = JSON.parse(
		await readFile(join(packageRoot, "package.json"), "utf8"),
	);
	const root = await mkdtemp(
		join(process.platform === "win32" ? tmpdir() : "/tmp", "chpi-"),
	);
	const agent = join(root, "agent");
	const work = join(root, "work");
	await mkdir(agent);
	await mkdir(work);
	await writeFile(join(work, "fixture.txt"), "Alpha\nBeta\nGamma\n");
	const broker = new Broker(agent);
	await broker.start();
	let logs = "";
	let launchError: Error | undefined;
	const child = spawn(
		process.execPath,
		[
			join(packageRoot, pkg.bin.pi),
			"--offline",
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--approve",
			"-e",
			join(checkout, "src/index.ts"),
			"--provider",
			"chappie",
			"--model",
			"chatgpt",
		],
		{
			cwd: work,
			env: {
				...process.env,
				HOME: root,
				USERPROFILE: root,
				PI_CODING_AGENT_DIR: agent,
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	child.on("error", (error) => {
		launchError = error;
	});
	for (const stream of [child.stdout, child.stderr])
		stream.on("data", (data) => {
			logs = (logs + data.toString()).slice(-10000);
		});
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new Error(`Pi runtime timeout: ${logs}`)),
		15000,
	);
	t.after(async () => {
		clearTimeout(timer);
		controller.abort();
		if (child.exitCode === null && !launchError) {
			child.kill("SIGTERM");
			await Promise.race([
				new Promise((resolve) => child.once("exit", resolve)),
				delay(1000),
			]);
			if (child.exitCode === null) child.kill("SIGKILL");
		}
		await broker.close();
		await rm(root, { recursive: true, force: true });
	});
	const signal = controller.signal;
	while (!broker.listSessions().length) {
		signal.throwIfAborted();
		if (launchError) throw launchError;
		if (child.exitCode !== null) throw new Error(`Pi exited: ${logs}`);
		await delay(20);
	}
	const session = broker.listSessions()[0];
	assert.ok(session);
	assert.equal(session.host, "pi");
	await broker.initialize("pi-test", session.id, "init", signal);
	const result = await broker.call(
		"pi-test",
		session.id,
		[{ name: "read", arguments: { path: "fixture.txt", offset: 2, limit: 1 } }],
		"read",
		signal,
		true,
	);
	const text = result.toolResults
		.flatMap((result) =>
			result.content.flatMap((block) =>
				block.type === "text" ? [block.text] : [],
			),
		)
		.join("\n");
	assert.match(text, /Beta/);
	assert.doesNotMatch(text, /Alpha|Gamma/);
	for (const [id, call] of [
		[
			"edit",
			{
				name: "edit",
				arguments: {
					path: "fixture.txt",
					edits: [{ oldText: "Beta", newText: "Beta edited" }],
				},
			},
		],
		[
			"write",
			{ name: "write", arguments: { path: "new.txt", content: "written" } },
		],
		[
			"bash",
			{ name: "bash", arguments: { command: 'bun -e "console.log(12345)"' } },
		],
	] as const) {
		const result = await broker.call(
			"pi-test",
			session.id,
			[call],
			id,
			signal,
			true,
		);
		assert.ok(
			result.toolResults.every((result) => !result.isError),
			JSON.stringify(result),
		);
	}
	assert.equal(
		await readFile(join(work, "fixture.txt"), "utf8"),
		"Alpha\nBeta edited\nGamma\n",
	);
	assert.equal(await readFile(join(work, "new.txt"), "utf8"), "written");
	await broker.chat("pi-test", session.id, "Test completed.", "done", signal);
});
