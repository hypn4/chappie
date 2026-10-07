import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Broker } from "../src/broker.ts";
import { CommonHistoryStore } from "../src/common-history.ts";
import { toolResultsContent } from "../src/delivery.ts";
import { resolveChappieStorage } from "../src/storage.ts";
import { createOmpProcessHarness } from "./omp-process-harness.mjs";

// These are synthetic tool requests, not a second model/agent doing inference.
const checkout = fileURLToPath(new URL("../", import.meta.url));
const soakIterations = Number(process.env.CHAPPIE_VERIFY_SOAK_ITERATIONS ?? 0);
assert.ok(
	Number.isSafeInteger(soakIterations) &&
		soakIterations >= 0 &&
		soakIterations <= 2000,
);
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
const chappieHome = join(root, "chappie");
const { storeDir } = await resolveChappieStorage({ CHAPPIE_HOME: chappieHome });
const work = join(root, "work");
await mkdir(agent);
await mkdir(work);
await writeFile(join(work, "fixture.txt"), "Alpha\nBeta\nGamma\n");
await writeFile(join(work, "bounded.txt"), "BOUNDED_NATIVE_OK\n");
const boundedRelease = join(root, "bounded-release");
const boundedStarted = join(root, "bounded-started");
const probeExtension = join(root, "provider-probe.ts");
const reminderFile = join(root, "todo-reminder.txt");
const collaborationFile = join(root, "collaboration-tools.txt");
const settingsFile = join(root, "settings.yml");
await writeFile(
	settingsFile,
	JSON.stringify({
		todo: { reminders: true, remindersMax: 1 },
		...(soakIterations ? { tools: { artifactMaxBytes: 1 } } : {}),
	}),
);
await writeFile(
	join(storeDir, "chappie.json"),
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
import { appendFileSync, existsSync, watch, writeFileSync } from "node:fs";
import chappie from ${JSON.stringify(candidateEntry)};
import { createOmpChappieProvider } from ${JSON.stringify(candidateProviderEntry)};
export default async function probe(api) {
  await chappie(api);
  api.on("tool_call", async (event) => {
    if (event.toolName !== "read" || event.input.path !== "bounded.txt") return;
    appendFileSync(${JSON.stringify(boundedStarted)}, "started\\n");
    await new Promise((resolve) => {
      const released = () => {
        if (!existsSync(${JSON.stringify(boundedRelease)})) return;
        watcher.close();
        resolve();
      };
      const watcher = watch(${JSON.stringify(root)}, released);
      released();
    });
  });
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
const brokerOptions = {
	callWaitMs: Number(process.env.CHAPPIE_VERIFY_CALL_WAIT_MS ?? 1000),
};
let broker = new Broker(storeDir, brokerOptions);
const controller = new AbortController();
const timer = setTimeout(
	() => controller.abort(new Error("OMP integration test timed out")),
	25000 + soakIterations * 500,
);
const signal = controller.signal;

async function readNativeOutput(chatId, resultId, expected, calls) {
	const text = await broker.readResponse(chatId, resultId);
	const saved = JSON.parse(text);
	assert.ok(Array.isArray(saved.content));
	assert.equal(saved.content[0]?.type, "text");
	const metadata = JSON.parse(saved.content[0].text);
	assert.equal(metadata.sessionId, expected.sessionId);
	assert.equal(metadata.cwd, expected.cwd);
	assert.deepEqual(metadata.work, expected.work);
	const content = saved.content.slice(1);
	const toolHeaders = content.flatMap((block) => {
		if (block.type !== "text") return [];
		let value;
		try {
			value = JSON.parse(block.text);
		} catch {
			return [];
		}
		if (!value || typeof value !== "object" || !("toolCallId" in value))
			return [];
		assert.deepEqual(Object.keys(value).sort(), [
			"isError",
			"toolCallId",
			"toolName",
		]);
		assert.equal(typeof value.toolCallId, "string");
		assert.ok(value.toolCallId.length > 0);
		assert.equal(typeof value.isError, "boolean");
		return [value];
	});
	assert.equal(toolHeaders.length, calls.length);
	assert.equal(
		new Set(toolHeaders.map((item) => item.toolCallId)).size,
		calls.length,
	);
	assert.deepEqual(
		toolHeaders.map((item) => item.toolName),
		calls.map((call) => call.name),
	);
	assert.equal(
		saved.isError,
		Boolean(expected.error) || toolHeaders.some((item) => item.isError),
	);
	assert.deepEqual(metadata.continuation, {
		scope: "native_batch",
		userGoal: "not_evaluated",
		nextAction: saved.isError
			? "inspect_failure"
			: metadata.work?.state === "actionable"
				? "continue_requested_work"
				: metadata.work?.state === "blocked"
					? "review_blockers"
					: "verify_requested_scope",
	});
	return {
		content,
		toolHeaders,
		isError: saved.isError,
		work: metadata.work,
		continuation: metadata.continuation,
		bytes: Buffer.byteLength(text),
	};
}

async function readRetainedNativeOutput(chatId, observed, calls) {
	const reference = observed.result;
	assert.ok(reference, "Completed native work must have a retained result");
	assert.equal(reference.chatId, chatId);
	assert.equal(reference.sessionId, observed.operation.sessionId);
	assert.equal(reference.cwd, observed.operation.cwd);
	assert.equal(reference.resultId, observed.operation.resultId);
	const output = await readNativeOutput(
		chatId,
		reference.resultId,
		reference,
		calls,
	);
	assert.equal(output.bytes, reference.bytes);
	assert.equal(output.isError, reference.failed);
	return output;
}

// Assertions that require effects must follow a yielded call to its result.
// Keep the dedicated bounded-call probe below unwrapped to test the early return.
async function completedCall(...args) {
	const response = await broker.call(...args);
	if (response.replay) return response;
	if (!response.operation || response.toolResults.length > 0) {
		assert.equal(response.toolResults.length, args[2].length);
		// Direct host file transfers retain their separate delivery contract.
		if (args[5] === true) {
			assert.equal(response.operation, undefined);
			return response;
		}
		assert.ok(
			response.operation?.resultId,
			"Fast native output needs a disk recovery snapshot",
		);
		const output = await readNativeOutput(
			args[0],
			response.operation.resultId,
			response,
			args[2],
		);
		assert.deepEqual(
			output.toolHeaders.map((item) => item.toolCallId),
			response.toolResults.map((item) => item.toolCallId),
		);
		assert.deepEqual(
			output.content,
			toolResultsContent(response.toolResults, response.sessionId),
		);
		assert.ok(
			broker
				.recentOperations(args[0], response.sessionId)
				.operations.some(
					(item) => item.operationId === response.operation.operationId,
				),
		);
		await broker.markResponseRead(args[0], response.operation.resultId);
		return { ...response, output };
	}
	const [chatId] = args;
	const id = response.operation.operationId;
	let observed = broker.operation(chatId, id);
	while (
		observed.operation.status === "running" ||
		(observed.operation.status === "completed" && !observed.result)
	) {
		signal.throwIfAborted();
		await delay(20);
		observed = broker.operation(chatId, id);
	}
	assert.equal(
		observed.operation.status,
		"completed",
		JSON.stringify(observed.operation),
	);
	const output = await readRetainedNativeOutput(chatId, observed, args[2]);
	await broker.acknowledge(observed.deliveries, [], signal);
	await broker.markResponseRead(chatId, observed.result.resultId);
	return {
		...response,
		output,
		...(output.work ? { work: output.work } : {}),
	};
}
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
	CHAPPIE_HOME: chappieHome,
	CHAPPIE_STORE_ID: undefined,
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
	const read = await completedCall(
		"integration-chat",
		session.id,
		[{ name: "read", arguments: { path: "fixture.txt:2+1" } }],
		"read-line",
		signal,
	);
	const text = read.output.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n");
	assert.match(text, /Beta/);
	// Native OMP may include surrounding lines to provide an anchored preview.
	const anchor = text.match(/\[([^\]]+#\w{4})\]/)?.[1];
	assert.ok(anchor, "Native read must return a file snapshot anchor");
	const edit = await completedCall(
		"integration-chat",
		session.id,
		[
			{
				name: "edit",
				arguments: { input: `[${anchor}]\nPUT 2.=2:\n+Beta edited` },
			},
		],
		"edit-line",
		signal,
	);
	assert.equal(edit.output.isError, false);
	assert.equal(
		await readFile(join(work, "fixture.txt"), "utf8"),
		"Alpha\nBeta edited\nGamma\n",
	);
	const detached = await broker.startCall(
		"integration-chat",
		session.id,
		[{ name: "read", arguments: { path: "fixture.txt" } }],
		"integration-detached-read",
		"detached-transport-request",
		signal,
	);
	assert.equal(
		detached.operation.status,
		"running",
		"detached native work must return before completion",
	);
	let detachedResult = broker.operation(
		"integration-chat",
		"integration-detached-read",
	);
	while (detachedResult.operation.status === "running") {
		signal.throwIfAborted();
		await delay(20);
		detachedResult = broker.operation(
			"integration-chat",
			"integration-detached-read",
		);
	}
	assert.equal(detachedResult.operation.status, "completed");
	assert.equal(detachedResult.deliveries.length, 1);
	const detachedOutput = await readRetainedNativeOutput(
		"integration-chat",
		detachedResult,
		[{ name: "read", arguments: { path: "fixture.txt" } }],
	);
	assert.equal(
		detachedResult.deliveries[0]?.resultId,
		detachedResult.result.resultId,
	);
	assert.equal(detachedOutput.isError, false);
	assert.match(JSON.stringify(detachedOutput.content), /Beta edited/);
	await broker.acknowledge(detachedResult.deliveries, [], signal);
	await broker.markResponseRead(
		"integration-chat",
		detachedResult.result.resultId,
	);
	// The read is held by a real OMP hook until after the caller receives its
	// operation reference; no sleep is used to guess native completion.
	const boundedCaller = new AbortController();
	const bounded = await broker.call(
		"integration-chat",
		session.id,
		[{ name: "read", arguments: { path: "bounded.txt" } }],
		"bounded-native-read",
		boundedCaller.signal,
	);
	assert.ok(
		bounded.operation,
		"slow native call must yield before the hook is released",
	);
	assert.equal(bounded.operation.status, "running");
	boundedCaller.abort(new Error("Transport response ended after soft detach"));
	const pendingProgress = await broker.chat(
		"integration-chat",
		session.id,
		"Native read still pending.",
		"bounded-progress",
		signal,
		undefined,
		"progress",
	);
	assert.equal(pendingProgress.progress, true);
	await writeFile(boundedRelease, "release");
	let boundedResult = broker.operation(
		"integration-chat",
		bounded.operation.operationId,
	);
	while (!boundedResult.result) {
		signal.throwIfAborted();
		await delay(20);
		boundedResult = broker.operation(
			"integration-chat",
			bounded.operation.operationId,
		);
	}
	assert.equal(boundedResult.operation.status, "completed");
	const boundedOutput = await readRetainedNativeOutput(
		"integration-chat",
		boundedResult,
		[{ name: "read", arguments: { path: "bounded.txt" } }],
	);
	assert.equal(boundedOutput.isError, false);
	assert.match(JSON.stringify(boundedOutput.content), /BOUNDED_NATIVE_OK/);
	assert.equal(await readFile(boundedStarted, "utf8"), "started\n");
	await broker.acknowledge(boundedResult.deliveries, [], signal);
	await broker.markResponseRead(
		"integration-chat",
		boundedResult.result.resultId,
	);
	const calls = [
		{
			name: "transfer",
			arguments: { operationId: "integration-export", paths: ["fixture.txt"] },
		},
	];
	const exported = await completedCall(
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
		const replay = await completedCall(
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
	const recovered = await completedCall(
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
	const recoveredReplay = await completedCall(
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
	const nextTodoName = "Verify continuing the authorized scope";
	for (const [label, call] of [
		[
			"todo-init",
			{
				name: "todo",
				arguments: { op: "init", items: [todoName, nextTodoName] },
			},
		],
		["todo-read", { name: "read", arguments: { path: "fixture.txt" } }],
	]) {
		const result = await completedCall(
			"integration-chat",
			session.id,
			[call],
			label,
			signal,
		);
		assert.equal(result.output.isError, false);
	}
	const progress = await broker.chat(
		"integration-chat",
		session.id,
		"Continuing both tasks.",
		"todo-progress",
		signal,
		undefined,
		"progress",
	);
	assert.equal(progress.progress, true);
	assert.equal(progress.work?.state, "actionable");
	assert.equal(progress.work.counts?.pending, 1);
	assert.equal(progress.work.counts?.inProgress, 1);
	await assert.rejects(
		readFile(reminderFile, "utf8"),
		(error) => error.code === "ENOENT",
	);
	await broker.chat(
		"integration-chat",
		session.id,
		"Pause with an unfinished TODO.",
		"todo-stop",
		signal,
	);
	// Read-after-stop exercises the real automatic continuation, not a fake task.
	const resumed = await completedCall(
		"integration-chat",
		session.id,
		[{ name: "read", arguments: { path: "fixture.txt" } }],
		"after-reminder",
		signal,
	);
	assert.equal(resumed.output.isError, false);
	assert.equal(await readFile(reminderFile, "utf8"), "seen");
	const completedTodo = await completedCall(
		"integration-chat",
		session.id,
		[{ name: "todo", arguments: { op: "done", task: todoName } }],
		"todo-done",
		signal,
	);
	assert.equal(completedTodo.output.isError, false);
	assert.equal(completedTodo.work?.state, "actionable");
	assert.equal(completedTodo.work.counts?.completed, 1);
	const nextReport = await broker.chat(
		"integration-chat",
		session.id,
		"First task done, continuing the second.",
		"second-progress",
		signal,
		undefined,
		"progress",
	);
	assert.equal(nextReport.progress, true);
	const finalTodo = await completedCall(
		"integration-chat",
		session.id,
		[{ name: "todo", arguments: { op: "done", task: nextTodoName } }],
		"second-todo-done",
		signal,
	);
	assert.equal(finalTodo.output.isError, false);
	assert.equal(finalTodo.work?.state, "settled");
	assert.equal(finalTodo.work.counts?.completed, 2);
	// Keep OMP alive while restarting only the broker. The first remote request
	// after the session reconnects must take the normal Chappie provider path;
	// this is the lifecycle that previously misclassified the primary turn as
	// auxiliary because OMP's live model context was transient during resume.
	await broker.close();
	await delay(30);
	broker = new Broker(storeDir, brokerOptions);
	await broker.start();
	while (broker.listSessions().length === 0) {
		signal.throwIfAborted();
		omp.assertHealthy();
		await delay(20);
	}
	const reconnected = broker.listSessions()[0];
	assert.equal(reconnected.id, session.id);
	const firstAfterReconnect = await completedCall(
		"integration-chat",
		reconnected.id,
		[{ name: "read", arguments: { path: "fixture.txt" } }],
		"first-after-broker-reconnect",
		signal,
	);
	assert.equal(
		firstAfterReconnect.output.isError,
		false,
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
	const primed = await completedCall(
		"resume-integration-chat",
		persisted.id,
		[{ name: "read", arguments: { path: "fixture.txt" } }],
		"prime-resumable-session",
		signal,
	);
	assert.equal(primed.output.isError, false);
	await omp.stop();
	await omp.waitForNoSessions(() => broker.listSessions(), signal);

	omp.launch(["--session-dir", resumeDir, "--resume", persisted.id]);
	const restored = await omp.waitForSession(
		() => broker.listSessions(),
		signal,
		persisted.id,
	);
	const firstAfterSessionResume = await completedCall(
		"resume-integration-chat",
		restored.id,
		[{ name: "read", arguments: { path: "fixture.txt" } }],
		"first-after-omp-session-resume",
		signal,
	);
	assert.equal(
		firstAfterSessionResume.output.isError,
		false,
		"first Chappie request after OMP session resume must complete normally",
	);
	if (soakIterations) {
		Bun.gc(true);
		const beforeMemory = process.memoryUsage();
		const durations = [];
		for (let i = 0; i < soakIterations; i++) {
			const started = performance.now();
			const result = await completedCall(
				"resume-integration-chat",
				restored.id,
				[{ name: "read", arguments: { path: "fixture.txt:1-3" } }],
				`soak-${i}`,
				signal,
			);
			assert.equal(result.output.toolHeaders.length, 1);
			assert.equal(result.output.isError, false);
			durations.push(performance.now() - started);
		}
		const large = await completedCall(
			"resume-integration-chat",
			restored.id,
			[
				{
					name: "bash",
					arguments: {
						command: `bun -e 'process.stdout.write("X".repeat(2 * 1024 * 1024))'`,
					},
				},
			],
			"soak-large-output",
			signal,
		);
		assert.equal(large.output.toolHeaders.length, 1);
		assert.equal(large.output.isError, false);
		const files = [];
		async function collect(directory) {
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);
				if (entry.isDirectory()) await collect(path);
				else if (entry.isFile())
					files.push({ path, bytes: (await stat(path)).size });
			}
		}
		await collect(resumeDir);
		const artifacts = files.filter((file) => file.path.endsWith(".log"));
		assert.ok(artifacts.length > 0, "Native overflow must retain an artifact");
		assert.ok(
			artifacts.every((file) => file.bytes <= 1024 * 1024 + 4096),
			"Native artifact cap must bound stored output",
		);
		await broker.diagnostics.flush();
		assert.equal(broker.diagnostics.stats.pending, 0);
		const trace = (
			await readFile(join(storeDir, "chappie.diagnostics.jsonl"), "utf8")
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const settled = trace.filter((event) => event.phase === "native.result");
		assert.ok(settled.length > 0);
		assert.equal(settled.at(-1).pending, 0);
		durations.sort((a, b) => a - b);
		const afterMemory = process.memoryUsage();
		Bun.gc(true);
		const afterGcMemory = process.memoryUsage();
		console.log(
			JSON.stringify({
				stage: "native-soak",
				iterations: soakIterations,
				p50Ms: durations[Math.floor(durations.length * 0.5)],
				p95Ms: durations[Math.floor(durations.length * 0.95)],
				beforeMemory,
				afterMemory,
				afterGcMemory,
				transcriptBytes: files
					.filter((f) => f.path.endsWith(".jsonl"))
					.reduce((sum, f) => sum + f.bytes, 0),
				artifactBytes: artifacts.reduce((sum, f) => sum + f.bytes, 0),
				diagnostics: broker.diagnostics.stats,
			}),
		);
	}
	await broker.chat(
		"resume-integration-chat",
		restored.id,
		"Integration test complete.",
		"done",
		signal,
	);
	const sharedHistory = new CommonHistoryStore({ homeDir: chappieHome });
	let savedHistory;
	while (
		!savedHistory?.entries.some((entry) =>
			entry.text.includes("Integration test complete."),
		)
	) {
		signal.throwIfAborted();
		omp.assertHealthy();
		const projects = await sharedHistory.listProjects();
		assert.ok(
			projects.length <= 1,
			"Native resume must retain the project identity",
		);
		if (projects[0])
			savedHistory = await sharedHistory.readSession(
				projects[0].projectId,
				restored.id,
			);
		if (
			!savedHistory?.entries.some((entry) =>
				entry.text.includes("Integration test complete."),
			)
		)
			await delay(25);
	}
	assert.equal(savedHistory.source.agent, "omp");
	assert.equal(savedHistory.sessionId, restored.id);
	assert.equal(savedHistory.schemaVersion, 1);
	assert.equal(
		savedHistory.coverage.retainedEntries,
		savedHistory.entries.length,
	);
	assert.ok(
		Buffer.byteLength(JSON.stringify(savedHistory)) <= 16 * 1024 * 1024,
	);
	assert.equal(
		(await readdir(agent)).some((name) => name.startsWith("chappie.")),
		false,
		"Chappie must not write storage into the native agent directory",
	);
	console.log(
		"OMP integration passed: native tool discovery and batch execution, provider ownership after replacement/disposal, auxiliary rejection, detached operation completion, bounded synchronous call recovery through a gated native read, broker reconnect first-turn routing, saved-session resume first-turn routing, local collaboration registration, nonterminating progress and two-step TODO continuation, exact read, native edit, resource bytes, replay and original-URI recovery.",
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
	await writeFile(boundedRelease, "cleanup");
	controller.abort(new Error("Integration cleanup"));
	await omp.stop();
	await broker.close();
	await rm(root, { recursive: true, force: true });
}
