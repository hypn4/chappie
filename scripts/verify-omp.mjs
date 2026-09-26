import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Broker } from "../src/broker.ts";
import { toolResultsContent } from "../src/delivery.ts";

// These are synthetic tool requests, not a second model/agent doing inference.
const checkout = fileURLToPath(new URL("../", import.meta.url));
const extensionRoot = process.env.CHAPPIE_PACKAGE_ROOT || checkout;
const root = await mkdtemp(
	join(process.platform === "win32" ? tmpdir() : "/tmp", "chomp-"),
);
const agent = join(root, "agent");
const work = join(root, "work");
await mkdir(agent);
await mkdir(work);
await writeFile(join(work, "fixture.txt"), "Alpha\nBeta\nGamma\n");
const probeExtension = join(root, "provider-probe.ts");
const reminderFile = join(root, "todo-reminder.txt");
const settingsFile = join(root, "settings.yml");
await writeFile(
	settingsFile,
	JSON.stringify({ todo: { reminders: true, remindersMax: 1 } }),
);
// Relative imports keep the candidate in OMP's dependency-rewrite graph.
await symlink(
	extensionRoot,
	join(root, "candidate"),
	process.platform === "win32" ? "junction" : "dir",
);
// Replace the global provider as another extension instance would, but never
// spawn a task or subagent. Its disposed owner must not receive root requests.
await writeFile(
	probeExtension,
	`
import { writeFileSync } from "node:fs";
import chappie from "./candidate/src/index.omp.ts";
import { createOmpChappieProvider } from "./candidate/src/provider.omp.ts";
export default async function probe(api) {
  await chappie(api);
  let dispose;
  const foreign = createOmpChappieProvider(async () => {
    throw new Error("Provider request was routed to the wrong owner");
  }, { on(event, handler) { if (event === "session_shutdown") dispose = handler; } });
  api.registerProvider("chappie", foreign);
  dispose?.({}, {});
  api.on("todo_reminder", () => writeFileSync(${JSON.stringify(reminderFile)}, "seen"));
  const unsupported = foreign.streamSimple(
    { api: "chappie", provider: "chappie", id: "chatgpt" },
    { messages: [{ role: "user", content: "Auxiliary probe" }] },
    { sessionId: "auxiliary-probe" }
  );
  const reply = await unsupported.result();
  if (reply.stopReason !== "error" || !reply.errorMessage?.includes("request hook"))
    throw new Error("Auxiliary requests must fail before acquiring any owner");
}
`,
);
const broker = new Broker(agent);
const controller = new AbortController();
const timer = setTimeout(
	() => controller.abort(new Error("OMP integration test timed out")),
	25000,
);
let child;
let logs = "";
let processError;
const signal = controller.signal;
try {
	await broker.start();
	const args = [
		"--mode",
		"rpc",
		"--no-ui",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-rules",
		"--no-lsp",
		"--no-title",
		"--no-prewalk",
		"--approval-mode",
		"yolo",
		"--config",
		settingsFile,
		"-e",
		probeExtension,
		"--model",
		"chappie/chatgpt",
	];
	const command = process.env.OMP_BINARY || "omp";
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: ".chappie-integration",
		OMP_PROFILE: "",
		PI_PROFILE: "",
	};
	// npm .cmd shims need cmd.exe. Quote every fixed/test-generated argument and
	// reject expansion characters rather than interpolating arbitrary shell text.
	if (process.platform === "win32") {
		const quote = (value) => {
			if (/["%\r\n]/.test(value))
				throw new Error("Unsafe Windows launcher argument");
			return `"${value}"`;
		};
		child = spawn(
			process.env.ComSpec || "cmd.exe",
			[
				"/d",
				"/s",
				"/v:off",
				"/c",
				`"${[command, ...args].map(quote).join(" ")}"`,
			],
			{
				cwd: work,
				env,
				windowsVerbatimArguments: true,
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
	} else {
		child = spawn(command, args, {
			cwd: work,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
	}
	child.on("error", (error) => {
		processError = error;
	});
	for (const stream of [child.stdout, child.stderr])
		stream.on("data", (bytes) => {
			logs = (logs + bytes.toString()).slice(-10000);
		});
	while (broker.listSessions().length === 0) {
		signal.throwIfAborted();
		if (processError) throw processError;
		if (child.exitCode !== null)
			throw new Error(`OMP exited with status ${child.exitCode}`);
		await delay(20);
	}
	const session = broker.listSessions()[0];
	await broker.initialize("integration-chat", session.id, "init", signal);
	const definitions = await broker.tools(
		"integration-chat",
		session.id,
		["read", "edit"],
		"schema",
		signal,
	);
	assert.equal(definitions.tools.length, 2);
	assert.ok(
		definitions.tools.every((tool) => tool.parameters && !tool.schemaError),
	);
	const read = await broker.call(
		"integration-chat",
		session.id,
		[{ name: "read", arguments: { path: "fixture.txt", offset: 2, limit: 1 } }],
		"read-line",
		signal,
		true,
	);
	const text = read.toolResults
		.flatMap((result) =>
			result.content.flatMap((block) =>
				block.type === "text" ? [block.text] : [],
			),
		)
		.join("\n");
	assert.match(text, /Beta/);
	assert.doesNotMatch(text, /Alpha|Gamma/);
	const anchor = text.match(/\[([^\]]+#\w{4})\]/)?.[1];
	assert.ok(anchor, "Native read must return a file snapshot anchor");
	const edit = await broker.call(
		"integration-chat",
		session.id,
		[
			{
				name: "edit",
				arguments: { patch: `[${anchor}]\nPUT 2.=2:\n+Beta edited` },
			},
		],
		"edit-line",
		signal,
		true,
	);
	assert.ok(edit.toolResults.every((result) => !result.isError));
	assert.equal(
		await readFile(join(work, "fixture.txt"), "utf8"),
		"Alpha\nBeta edited\nGamma\n",
	);
	const calls = [
		{
			name: "transfer",
			arguments: { operationId: "integration-export", paths: ["fixture.txt"] },
		},
	];
	const exported = await broker.call(
		"integration-chat",
		session.id,
		calls,
		"export-1",
		signal,
		true,
	);
	const links = toolResultsContent(exported.toolResults, session.id).filter(
		(block) => block.type === "resource_link",
	);
	assert.equal(links.length, 1);
	const bytes = await broker.readResource(
		`${links[0].uri}?chatId=integration-chat`,
		signal,
	);
	assert.equal(
		Buffer.from(bytes.blob, "base64").toString(),
		"Alpha\nBeta edited\nGamma\n",
	);
	for (let index = 0; index < 3; index++) {
		const replay = await broker.call(
			"integration-chat",
			session.id,
			calls,
			`resume-${index}`,
			signal,
			true,
		);
		assert.equal(replay.replay?.status, "completed");
		assert.equal(replay.toolResults.length, 0);
		assert.equal(replay.replay?.delivery?.hostReceipt, "unconfirmed");
		assert.equal(replay.replay?.delivery?.resources[0]?.uri, links[0].uri);
		assert.ok(replay.replay?.delivery?.resources[0]?.sourceReadAt);

		const history = await broker.history(
			"integration-chat",
			session.id,
			{ limit: 100 },
			`history-${index}`,
			signal,
		);
		assert.equal(
			history.history.content.some((block) => block.type === "resource_link"),
			false,
		);
	}
	// Simulate a separate, explicit request to recover the original attachment.
	// This uses its URI, so no source command or resource registration is repeated.
	const recoveryCalls = [
		{
			name: "transfer",
			arguments: {
				operationId: "explicit-resource-recovery",
				paths: [links[0].uri],
			},
		},
	];
	const recovered = await broker.call(
		"integration-chat",
		session.id,
		recoveryCalls,
		"recover-delivery",
		signal,
		true,
	);
	const recoveredLinks = toolResultsContent(
		recovered.toolResults,
		session.id,
	).filter((block) => block.type === "resource_link");
	assert.equal(recoveredLinks.length, 1);
	assert.equal(recoveredLinks[0].uri, links[0].uri);
	assert.equal(
		Buffer.from(
			(await broker.readResource(recoveredLinks[0].uri, signal)).blob,
			"base64",
		).toString(),
		"Alpha\nBeta edited\nGamma\n",
	);
	const recoveredReplay = await broker.call(
		"integration-chat",
		session.id,
		recoveryCalls,
		"recover-delivery-resume",
		signal,
		true,
	);
	assert.equal(recoveredReplay.toolResults.length, 0);
	assert.equal(
		recoveredReplay.replay?.delivery?.resources[0]?.uri,
		links[0].uri,
	);
	const todoName = "Verify OMP provider ownership";
	for (const [label, call] of [
		[
			"todo-init",
			{ name: "todo", arguments: { op: "init", items: [todoName] } },
		],
		["todo-read", { name: "read", arguments: { path: "fixture.txt" } }],
	]) {
		const result = await broker.call(
			"integration-chat",
			session.id,
			[call],
			label,
			signal,
		);
		assert.ok(result.toolResults.every((item) => !item.isError));
	}
	await broker.chat(
		"integration-chat",
		session.id,
		"Pause with an unfinished TODO.",
		"todo-stop",
		signal,
	);
	// Read-after-stop exercises the real automatic continuation, not a fake task.
	const resumed = await broker.call(
		"integration-chat",
		session.id,
		[{ name: "read", arguments: { path: "fixture.txt" } }],
		"after-reminder",
		signal,
	);
	assert.ok(resumed.toolResults.every((item) => !item.isError));
	assert.equal(await readFile(reminderFile, "utf8"), "seen");
	const completedTodo = await broker.call(
		"integration-chat",
		session.id,
		[{ name: "todo", arguments: { op: "done", task: todoName } }],
		"todo-done",
		signal,
	);
	assert.ok(completedTodo.toolResults.every((item) => !item.isError));
	await broker.chat(
		"integration-chat",
		session.id,
		"Integration test complete.",
		"done",
		signal,
	);
	console.log(
		"OMP integration passed: provider ownership after replacement/disposal, auxiliary rejection, TODO continuation, exact read, native edit, resource bytes, replay and original-URI recovery.",
	);
	console.log(
		"No subagents, external model inference or live broker changes were used. ChatGPT approval UI and final response rendering are not covered.",
	);
} catch (error) {
	console.error(error);
	console.error(logs);
	process.exitCode = 1;
} finally {
	clearTimeout(timer);
	controller.abort(new Error("Integration cleanup"));
	if (child && child.exitCode === null && !processError) {
		if (process.platform === "win32" && child.pid) {
			spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
				timeout: 5000,
			});
		} else child.kill("SIGTERM");
		await Promise.race([
			new Promise((resolve) => child.once("exit", resolve)),
			delay(1000),
		]);
		if (child.exitCode === null) child.kill("SIGKILL");
	}
	await broker.close();
	await rm(root, { recursive: true, force: true });
}
