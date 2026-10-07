import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type {
	SessionEntry,
	SessionHeader,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { CommonHistoryStore } from "../src/common-history.ts";
import { commonOmpHistory, OmpHistoryRecorder } from "../src/history.omp.ts";
import { uuidV7 } from "../src/ids.ts";

const MiB = 1024 * 1024;
const epoch = 1_700_000_000_000;
function base(id: string, parentId: string | null = null) {
	return { id, parentId, timestamp: new Date(epoch).toISOString() };
}
function user(
	id: string,
	text: string,
	parentId: string | null = null,
): SessionEntry {
	return {
		...base(id, parentId),
		type: "message",
		message: { role: "user", content: text, timestamp: epoch },
	};
}
function assistant(
	id: string,
	content: AssistantMessage["content"],
): SessionEntry {
	return {
		...base(id),
		type: "message",
		message: {
			role: "assistant",
			content,
			api: "openai-responses",
			provider: "openai",
			model: "fixture-model",
			timestamp: epoch,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			credentialId: 12345,
			responseId: "private-response-id",
		},
	};
}
function publicAndPrivateBranch(): SessionEntry[] {
	return [
		user("user", "Public user request 한글"),
		assistant("assistant", [
			{
				type: "thinking",
				thinking: "PRIVATE_THINKING",
				thinkingSignature: "PRIVATE_THINKING_SIGNATURE",
			},
			{ type: "redactedThinking", data: "PRIVATE_REDACTED" },
			{
				type: "text",
				text: "Public assistant answer",
				textSignature: "PRIVATE_TEXT_SIGNATURE",
			},
			{
				type: "toolCall",
				id: "read-1",
				name: "read",
				arguments: { path: "notes.md" },
				thoughtSignature: "PRIVATE_TOOL_SIGNATURE",
				rawBlock: "PRIVATE_RAW_BLOCK",
			},
		]),
		{
			...base("tool"),
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "read-1",
				toolName: "read",
				content: [
					{ type: "text", text: "Public tool result" },
					{ type: "image", data: "PRIVATE_IMAGE_DATA", mimeType: "image/png" },
				],
				details: { token: "PRIVATE_TOOL_DETAILS" },
				isError: true,
				timestamp: epoch,
			},
		},
		{
			...base("compact"),
			type: "compaction",
			summary: "Public compact summary",
			firstKeptEntryId: "user",
			tokensBefore: 100,
			details: { token: "PRIVATE_COMPACTION_DETAILS" },
			preserveData: { token: "PRIVATE_PRESERVED_DATA" },
		},
		{
			...base("branch"),
			type: "branch_summary",
			fromId: "user",
			summary: "Public branch summary",
			details: { token: "PRIVATE_BRANCH_DETAILS" },
		},
		{
			...base("displayed"),
			type: "custom_message",
			customType: "fixture.visible",
			content: "Public extension text",
			display: true,
			details: { token: "PRIVATE_CUSTOM_DETAILS" },
		},
		{
			...base("notice"),
			type: "custom",
			customType: "chappie.notice",
			data: {
				message: "Public notice",
				event: "progress",
				token: "PRIVATE_NOTICE_DATA",
			},
		},
		{
			...base("hidden"),
			type: "custom_message",
			customType: "fixture.hidden",
			content: "PRIVATE_HIDDEN_MESSAGE",
			display: false,
		},
		{
			...base("request"),
			type: "custom_message",
			customType: "chappie.request",
			content: "PRIVATE_REQUEST_PAYLOAD",
			display: true,
		},
		{
			...base("history-notice"),
			type: "custom",
			customType: "chappie.notice",
			data: { message: "PRIVATE_HISTORY_REEXPORT", event: "history" },
		},
		{
			...base("internal"),
			type: "custom",
			customType: "fixture.internal",
			data: { token: "PRIVATE_INTERNAL_STATE" },
		},
		{
			...base("credential"),
			type: "credential_pin",
			provider: "openai",
			hash: "PRIVATE_CREDENTIAL_HASH",
		},
		{
			...base("init"),
			type: "session_init",
			systemPrompt: "PRIVATE_SYSTEM_PROMPT",
			task: "PRIVATE_INIT_TASK",
			tools: ["private-tool"],
		},
		{
			...base("developer"),
			type: "message",
			message: {
				role: "developer",
				content: "PRIVATE_DEVELOPER_MESSAGE",
				timestamp: epoch,
			},
		},
	];
}
function manager(id: string, cwd: string, branch: SessionEntry[]) {
	const value = { id, cwd, branch };
	const sessionManager = {
		getSessionId: () => value.id,
		getHeader: (): SessionHeader => ({
			type: "session",
			version: 3,
			id: value.id,
			cwd: value.cwd,
			timestamp: new Date(epoch).toISOString(),
		}),
		getBranch: () => value.branch,
	};
	return { value, sessionManager };
}
async function fixture(t: TestContext) {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "ch-history-projection-")),
	);
	const cwd = join(root, "first-project");
	const otherCwd = join(root, "second-project");
	await mkdir(cwd);
	await mkdir(otherCwd);
	const homeDir = join(root, ".chappie");
	const errors: Error[] = [];
	const recorder = new OmpHistoryRecorder(homeDir, {
		onError: (error) => errors.push(error),
	});
	const recorders = [recorder];
	t.after(async () => {
		try {
			for (const item of recorders) {
				item.finish();
				await item.flush();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	const reader = new CommonHistoryStore({ homeDir });
	return { root, homeDir, cwd, otherCwd, reader, recorder, recorders, errors };
}

test("OMP projection preserves public identity/order and readable text while excluding thinking and private native fields", async (t) => {
	const f = await fixture(t);
	const branch = publicAndPrivateBranch();
	const projection = commonOmpHistory(branch);
	assert.equal(projection.sourceEntryCount, 7);
	assert.equal(projection.sourceNewestEntryId, "notice");
	assert.equal(projection.sourceOversizedEntries, 0);
	assert.deepEqual(
		projection.entries.map((entry) => entry.sourceEntryId),
		["user", "assistant", "tool", "compact", "branch", "displayed", "notice"],
	);
	assert.equal(projection.entries[0]?.text, "Public user request 한글");
	assert.match(projection.entries[1]?.text ?? "", /Public assistant answer/);
	assert.match(projection.entries[1]?.text ?? "", /read-1/);
	assert.match(projection.entries[1]?.text ?? "", /notes\.md/);
	assert.equal(projection.entries[2]?.kind, "tool");
	assert.equal(projection.entries[2]?.isError, true);
	assert.match(projection.entries[2]?.text ?? "", /Public tool result/);
	assert.equal(projection.entries[3]?.kind, "summary");
	assert.equal(JSON.stringify(projection).includes("PRIVATE_"), false);
	const native = manager(uuidV7(), f.cwd, branch);
	f.recorder.observe({ cwd: f.cwd, sessionManager: native.sessionManager });
	await f.recorder.flush();
	const projects = await f.reader.listProjects();
	assert.equal(projects.length, 1);
	const project = projects[0];
	assert.ok(project);
	const snapshot = await f.reader.readSession(
		project.projectId,
		native.value.id,
	);
	assert.ok(snapshot);
	assert.deepEqual(snapshot.entries, projection.entries);
	assert.equal(snapshot.source.agent, "omp");
	assert.equal(snapshot.source.sourceSessionId, native.value.id);
	assert.equal(snapshot.coverage.complete, true);
	const raw = await readFile(
		join(
			f.homeDir,
			"projects",
			project.projectId,
			"sessions",
			`${native.value.id}.json`,
		),
		"utf8",
	);
	assert.equal(raw.includes("PRIVATE_"), false);
	assert.equal(raw.includes("private-response-id"), false);
	assert.equal(f.errors.length, 0);
});

test("projection retains newest 2048 whole entries while counting all visible source entries", () => {
	const branch = Array.from({ length: 2051 }, (_, index) =>
		user(
			`entry-${index}`,
			`Complete public record ${index}`,
			index ? `entry-${index - 1}` : null,
		),
	);
	const projection = commonOmpHistory(branch);
	assert.equal(projection.sourceEntryCount, 2051);
	assert.equal(projection.sourceNewestEntryId, "entry-2050");
	assert.equal(projection.sourceOversizedEntries, 0);
	assert.equal(projection.entries.length, 2048);
	assert.equal(projection.entries[0]?.sourceEntryId, "entry-3");
	assert.equal(projection.entries.at(-1)?.sourceEntryId, "entry-2050");
	assert.equal(projection.entries.at(-1)?.text, "Complete public record 2050");
});

test("projection bounds UTF-8 encoded whole-entry bytes while retaining the newest fitting records", () => {
	const text = "한".repeat(Math.floor((5 * MiB) / 3));
	const projection = commonOmpHistory(
		Array.from({ length: 4 }, (_, index) =>
			user(`large-${index}`, `${index}:${text}`),
		),
	);
	assert.equal(projection.sourceEntryCount, 4);
	assert.equal(projection.sourceNewestEntryId, "large-3");
	assert.ok(Buffer.byteLength(JSON.stringify(projection.entries)) <= 16 * MiB);
	assert.ok(projection.entries.length > 0 && projection.entries.length < 4);
	assert.equal(projection.entries.at(-1)?.sourceEntryId, "large-3");
	for (const entry of projection.entries)
		assert.equal(entry.text, `${entry.sourceEntryId.slice(-1)}:${text}`);
});

test("oversized newest public output stays omitted with honest persisted newest-entry coverage", async (t) => {
	const f = await fixture(t);
	// JSON escaping makes this whole entry exceed the encoded budget despite its smaller source string.
	const branch = [
		user("older-readable", "Readable previous record"),
		user("oversized-latest", "\u0001".repeat(3 * MiB)),
	];
	const projection = commonOmpHistory(branch);
	assert.equal(projection.sourceEntryCount, 2);
	assert.equal(projection.sourceNewestEntryId, "oversized-latest");
	assert.equal(projection.sourceOversizedEntries, 1);
	assert.deepEqual(
		projection.entries.map((entry) => entry.sourceEntryId),
		["older-readable"],
	);
	const native = manager(uuidV7(), f.cwd, branch);
	f.recorder.observe({ cwd: f.cwd, sessionManager: native.sessionManager });
	await f.recorder.flush();
	const project = (await f.reader.listProjects())[0];
	assert.ok(project);
	const snapshot = await f.reader.readSession(
		project.projectId,
		native.value.id,
	);
	assert.ok(snapshot);
	assert.equal(snapshot.entries[0]?.text, "Readable previous record");
	assert.equal(snapshot.coverage.sourceEntryCount, 2);
	assert.equal(snapshot.coverage.omittedEntries, 1);
	assert.equal(snapshot.coverage.oversizedEntries, 1);
	assert.equal(snapshot.coverage.complete, false);
	assert.equal(snapshot.coverage.newestEntryRetained, false);
	assert.equal(f.errors.length, 0);
});

test("capture preserves the departing native branch across an immediate mutable-manager switch", async (t) => {
	const f = await fixture(t);
	const firstId = uuidV7();
	const secondId = uuidV7();
	const native = manager(firstId, f.cwd, [
		user("first-message", "Departing session text"),
	]);
	const context = { cwd: f.cwd, sessionManager: native.sessionManager };
	f.recorder.observe(context);
	f.recorder.capture(context);
	native.value.id = secondId;
	native.value.branch = [user("second-message", "Arriving session text")];
	f.recorder.observe(context);
	await f.recorder.flush();
	const project = (await f.reader.listProjects())[0];
	assert.ok(project);
	const first = await f.reader.readSession(project.projectId, firstId);
	const second = await f.reader.readSession(project.projectId, secondId);
	assert.equal(first?.entries[0]?.text, "Departing session text");
	assert.equal(first?.state, "finished");
	assert.equal(first?.current, false);
	assert.equal(second?.entries[0]?.text, "Arriving session text");
	assert.equal(second?.state, "active");
	assert.equal(second?.current, true);
	assert.equal(f.errors.length, 0);
});

test("the same native UUID in a different project finishes the old project and keeps the new one active", async (t) => {
	const f = await fixture(t);
	const id = uuidV7();
	const native = manager(id, f.cwd, [
		user("old-project", "Old project content"),
	]);
	const oldContext = {
		get cwd() {
			return native.value.cwd;
		},
		sessionManager: native.sessionManager,
	};
	f.recorder.observe(oldContext);
	f.recorder.capture(oldContext);
	native.value.cwd = f.otherCwd;
	native.value.branch = [user("new-project", "New project content")];
	f.recorder.observe(oldContext);
	await f.recorder.flush();
	const projects = await f.reader.listProjects();
	assert.equal(projects.length, 2);
	const oldProject = projects.find((project) =>
		project.cwdAliases.includes(f.cwd),
	);
	const newProject = projects.find((project) =>
		project.cwdAliases.includes(f.otherCwd),
	);
	assert.ok(oldProject);
	assert.ok(newProject);
	assert.notEqual(oldProject.projectId, newProject.projectId);
	const old = await f.reader.readSession(oldProject.projectId, id);
	const current = await f.reader.readSession(newProject.projectId, id);
	assert.equal(old?.entries[0]?.text, "Old project content");
	assert.equal(old?.state, "finished");
	assert.equal(old?.current, false);
	assert.equal(current?.entries[0]?.text, "New project content");
	assert.equal(current?.state, "active");
	assert.equal(current?.current, true);
	assert.equal(f.errors.length, 0);
});

test("an explicit project alias switch retains one active shared session under the same native UUID", async (t) => {
	const f = await fixture(t);
	const project = await f.reader.resolveProject({ cwd: f.cwd });
	assert.ok(project);
	const recorder = new OmpHistoryRecorder(f.homeDir, {
		projectId: project.projectId,
		onError: (error) => f.errors.push(error),
	});
	f.recorders.push(recorder);
	const id = uuidV7();
	const native = manager(id, f.cwd, [
		user("before-alias", "Before alias switch"),
	]);
	const oldContext = { cwd: f.cwd, sessionManager: native.sessionManager };
	recorder.observe(oldContext);
	recorder.capture(oldContext);
	native.value.cwd = f.otherCwd;
	native.value.branch = [user("after-alias", "After alias switch")];
	recorder.observe({ cwd: f.otherCwd, sessionManager: native.sessionManager });
	await recorder.flush();
	assert.equal((await f.reader.listProjects()).length, 1);
	assert.deepEqual((await f.reader.listProjects())[0]?.cwdAliases, [
		f.cwd,
		f.otherCwd,
	]);
	const sessions = await f.reader.listSessions(project.projectId);
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0]?.sessionId, id);
	assert.equal(sessions[0]?.state, "active");
	assert.equal(sessions[0]?.current, true);
	assert.equal(
		(await f.reader.readSession(project.projectId, id))?.entries[0]?.text,
		"After alias switch",
	);
	assert.equal(f.errors.length, 0);
});

test("native-read and filesystem errors stay isolated even when the history error callback throws", async (t) => {
	const f = await fixture(t);
	let reports = 0;
	const recorder = new OmpHistoryRecorder(f.homeDir, {
		onError: () => {
			reports++;
			throw new Error("Observer error");
		},
	});
	f.recorders.push(recorder);
	const native = manager(uuidV7(), f.cwd, [user("entry", "Native work")]);
	const failingManager = {
		...native.sessionManager,
		getBranch: (): SessionEntry[] => {
			throw new Error("Native branch unavailable");
		},
	};
	assert.doesNotThrow(() =>
		recorder.observe({ cwd: f.cwd, sessionManager: failingManager }),
	);
	assert.doesNotThrow(() =>
		recorder.capture({ cwd: f.cwd, sessionManager: failingManager }),
	);
	await assert.doesNotReject(recorder.flush());
	assert.ok(reports > 0);
	const fileRoot = join(f.root, "not-a-directory");
	await writeFile(fileRoot, "Existing unrelated file");
	const brokenDisk = new OmpHistoryRecorder(fileRoot, {
		onError: () => {
			reports++;
			throw new Error("Observer disk error");
		},
	});
	const before = reports;
	assert.doesNotThrow(() =>
		brokenDisk.observe({ cwd: f.cwd, sessionManager: native.sessionManager }),
	);
	await assert.doesNotReject(brokenDisk.flush());
	assert.ok(reports > before);
	assert.equal(await readFile(fileRoot, "utf8"), "Existing unrelated file");
	assert.doesNotThrow(() => brokenDisk.finish());
	await assert.doesNotReject(brokenDisk.flush());
});
