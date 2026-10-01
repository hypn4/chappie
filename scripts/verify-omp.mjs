import assert from "node:assert/strict";
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
import { createOmpProcessHarness } from "./omp-process-harness.mjs";

// These are synthetic tool requests, not a second model/agent doing inference.
const checkout = fileURLToPath(new URL("../", import.meta.url));
const extensionRoot = process.env.CHAPPIE_PACKAGE_ROOT || checkout;
const extensionManifest = JSON.parse(
	await readFile(join(extensionRoot, "package.json"), "utf8"),
);
const extensionEntry = extensionManifest.omp?.extensions?.[0];
assert.equal(
	typeof extensionEntry,
	"string",
	"Package must declare an OMP extension entry",
);
assert.match(
	extensionEntry,
	/^\.\/dist\/src\/index\.omp\.js$/,
	"OMP verification requires the published compiled extension",
);
const candidateEntry = `./candidate/${extensionEntry.slice(2)}`;
const candidateProviderEntry = candidateEntry.replace(
	/index\.omp\.js$/,
	"provider.omp.js",
);
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
const collaborationFile = join(root, "collaboration-tools.txt");
const settingsFile = join(root, "settings.yml");
await writeFile(
	settingsFile,
	JSON.stringify({ todo: { reminders: true, remindersMax: 1 } }),
);
await writeFile(
	join(agent, "chappie.json"),
	JSON.stringify({ localTools: true }),
	"utf8",
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
import chappie from ${JSON.stringify(candidateEntry)};
import { createOmpChappieProvider } from ${JSON.stringify(candidateProviderEntry)};
export default async function probe(api) {
  await chappie(api);
  let dispose;
  const foreign = createOmpChappieProvider(
    async () => {
      throw new Error("Provider request was routed to the wrong owner");
    },
    async () => {
      throw new Error("Generation request was routed to the wrong owner");
    },
    { on(event, handler) { if (event === "session_shutdown") dispose = handler; } }
  );
  api.registerProvider("chappie", foreign);
  dispose?.({}, {});
  api.on("todo_reminder", () => writeFileSync(${JSON.stringify(reminderFile)}, "seen"));
  api.on("session_start", async () => {
    const names = new Set(["sessions", "remote_tools", "remote_call", "remote_chat", "history"]);
    const configured = api.getAllTools().filter((tool) => names.has(tool.name)).map((tool) => tool.name).sort();
    const active = api.getActiveTools().filter((name) => names.has(name)).sort();
    writeFileSync(
      ${JSON.stringify(collaborationFile)},
      JSON.stringify({ configured, active })
    );
  });
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
let broker = new Broker(agent);
const controller = new AbortController();
const timer = setTimeout(
	() => controller.abort(new Error("OMP integration test timed out")),
	25000,
);
const signal = controller.signal;
const commonArgs = [
	"--mode",
	"rpc",
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
const env = {
	...process.env,
	PI_CODING_AGENT_DIR: agent,
	PI_CONFIG_DIR: ".chappie-integration",
	OMP_PROFILE: "",
	PI_PROFILE: "",
};
const omp = createOmpProcessHarness({
	work,
	env,
	baseArgs: commonArgs,
});
try {
	await broker.start();
	omp.launch(["--no-session"]);
	await omp.waitForSession(() => broker.listSessions(), signal);
	while (true) {
		signal.throwIfAborted();
		try {
			const collaboration = JSON.parse(
				await readFile(collaborationFile, "utf8"),
			);
			assert.deepEqual(collaboration.configured, [
				"history",
				"remote_call",
				"remote_chat",
				"remote_tools",
				"sessions",
			]);
			assert.deepEqual(
				collaboration.active,
				[],
				"Chappie model must keep local collaboration tools inactive",
			);
			break;
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			await delay(20);
		}
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
	// Keep OMP alive while restarting only the broker. The first remote request
	// after the session reconnects must take the normal Chappie provider path;
	// this is the lifecycle that previously misclassified the primary turn as
	// auxiliary because OMP's live model context was transient during resume.
	await broker.close();
	await delay(30);
	broker = new Broker(agent);
	await broker.start();
	while (broker.listSessions().length === 0) {
		signal.throwIfAborted();
		omp.assertHealthy();
		await delay(20);
	}
	const reconnected = broker.listSessions()[0];
	assert.equal(reconnected.id, session.id);
	const firstAfterReconnect = await broker.call(
		"integration-chat",
		reconnected.id,
		[{ name: "read", arguments: { path: "fixture.txt" } }],
		"first-after-broker-reconnect",
		signal,
	);
	assert.ok(
		firstAfterReconnect.toolResults.every((item) => !item.isError),
		"first Chappie request after broker reconnect must complete normally",
	);
	// Reproduce the real failure mode: stop OMP itself, restore the same saved
	// session, then make the first Chappie provider call after plugin startup.
	await omp.stop();
	await omp.waitForNoSessions(() => broker.listSessions(), signal);
	const resumeDir = join(root, "resume-sessions");
	await mkdir(resumeDir);
	omp.launch(["--session-dir", resumeDir]);
	const persisted = await omp.waitForSession(
		() => broker.listSessions(),
		signal,
	);
	const primed = await broker.call(
		"resume-integration-chat",
		persisted.id,
		[{ name: "read", arguments: { path: "fixture.txt" } }],
		"prime-resumable-session",
		signal,
	);
	assert.ok(primed.toolResults.every((item) => !item.isError));
	await omp.stop();
	await omp.waitForNoSessions(() => broker.listSessions(), signal);

	omp.launch(["--session-dir", resumeDir, "--resume", persisted.id]);
	const restored = await omp.waitForSession(
		() => broker.listSessions(),
		signal,
		persisted.id,
	);
	const firstAfterSessionResume = await broker.call(
		"resume-integration-chat",
		restored.id,
		[{ name: "read", arguments: { path: "fixture.txt" } }],
		"first-after-omp-session-resume",
		signal,
	);
	assert.ok(
		firstAfterSessionResume.toolResults.every((item) => !item.isError),
		"first Chappie request after OMP session resume must complete normally",
	);
	await broker.chat(
		"resume-integration-chat",
		restored.id,
		"Integration test complete.",
		"done",
		signal,
	);
	console.log(
		"OMP integration passed: provider ownership after replacement/disposal, auxiliary rejection, broker reconnect first-turn routing, saved-session resume first-turn routing, local collaboration registration, TODO continuation, exact read, native edit, resource bytes, replay and original-URI recovery.",
	);
	console.log(
		"No subagents, external model inference or live broker changes were used. ChatGPT approval UI and final response rendering are not covered.",
	);
} catch (error) {
	console.error(error);
	console.error(omp.logs);
	process.exitCode = 1;
} finally {
	clearTimeout(timer);
	controller.abort(new Error("Integration cleanup"));
	await omp.stop();
	await broker.close();
	await rm(root, { recursive: true, force: true });
}
