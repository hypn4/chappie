import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/server";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { Broker } from "../src/broker.ts";
import type { DeliveryRecord } from "../src/delivery.ts";
import { historyResult } from "../src/history.ts";
import { assertRpcError, mcpClient } from "./helpers/mcp-client.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "ch-page-"));
	// Cleanup below explicitly closes transport before removing stored responses.
	const broker = new Broker(root);
	let pending: DeliveryRecord[] = [];
	let ackCount = 0;
	t.mock.method(broker, "listSessions", () => []);
	t.mock.method(broker, "binding", () => undefined);
	t.mock.method(broker, "deliveries", () => pending);
	t.mock.method(broker, "answers", () => []);
	t.mock.method(broker, "acknowledge", async () => {
		ackCount++;
		pending = [];
	});
	const client = mcpClient(t, broker);
	t.after(async () => {
		try {
			await client.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	await client.request("server/discover", {}, { chatId: "owner" });
	return {
		broker,
		root,
		request: (
			name: string,
			args: Record<string, unknown> = {},
			chatId = "owner",
		) => client.call(name, args, { chatId }),
		setPending: (delivery: DeliveryRecord) => {
			pending = [delivery];
		},
		get pending() {
			return pending;
		},
		get acks() {
			return ackCount;
		},
		failNext: client.failNextSend,
	};
}

async function recoverText(
	f: Awaited<ReturnType<typeof fixture>>,
	resultId: string,
): Promise<string> {
	let offset = 0;
	let full = "";
	let total: number | undefined;
	for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
		const response = await f.request("get_operation", { resultId, offset });
		assert.ok(
			Buffer.byteLength(JSON.stringify(response)) <= 32 * 1024,
			"Each wire page must fit the bridge budget",
		);
		const page = textData(response);
		assert.equal(page.resultId, resultId);
		assert.equal(page.offset, offset);
		assert.equal(typeof page.text, "string");
		assert.equal(typeof page.hasMore, "boolean");
		assert.ok(Number.isSafeInteger(page.totalCharacters));
		total ??= page.totalCharacters;
		assert.equal(
			page.totalCharacters,
			total,
			"Snapshot length must not change between reads",
		);
		full += page.text;
		if (!page.hasMore) {
			assert.equal(page.nextOffset, undefined);
			assert.equal(
				full.length,
				total,
				"No characters may be dropped or repeated",
			);
			return full;
		}
		assert.equal(page.nextOffset, offset + page.text.length);
		assert.ok(page.nextOffset > offset);
		offset = page.nextOffset;
	}
	throw new Error("Result continuation did not terminate");
}

async function recover(
	f: Awaited<ReturnType<typeof fixture>>,
	response: JSONRPCMessage,
) {
	const ref = textData(response);
	if (!ref.resultId) return result(response);
	return JSON.parse(await recoverText(f, ref.resultId));
}
test("all tools and Skills remain reachable through the same bounded continuation", async (t) => {
	const f = await fixture(t);
	const skills = Array.from({ length: 101 }, (_, i) => ({
		name: `skill-${i}`,
		description: "y".repeat(512),
		uri: `skill://skill-${i}`,
	}));
	t.mock.method(f.broker, "initialize", async () => ({
		selection: "explicit",
		session: {
			id: "A",
			cwd: f.root,
			device: "test",
			host: "omp",
			status: "idle",
		},
		inputs: [],
		tools: [],
		skills,
	}));
	const m = await f.request("init");
	assert.ok(Buffer.byteLength(JSON.stringify(m)) <= 32 * 1024);
	const full = await recover(f, m);
	assert.deepEqual(JSON.parse(full.content[0].text).skills, skills);
});
test("a whole oversized history entry remains losslessly readable without false hasMore", async (t) => {
	const f = await fixture(t);
	const body = "entry-tail\u0001🙂".repeat(12000);
	const entry = {
		type: "custom",
		id: "huge",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		customType: "chappie.notice",
		data: { message: body, type: "info" },
	} as SessionEntry;
	const history = historyResult([entry], "A", { limit: 1 });
	assert.equal(history.hasMore, false);
	assert.equal(history.count, 1);
	t.mock.method(f.broker, "history", async () => ({
		sessionId: "A",
		cwd: f.root,
		history,
	}));
	const m = await f.request("history", { limit: 1 });
	assert.ok(Buffer.byteLength(JSON.stringify(m)) <= 32 * 1024);
	const full = await recover(f, m);
	assert.equal(JSON.parse(full.content[1].text).data.message, body);
});

function result(m: JSONRPCMessage) {
	assert.ok("result" in m);
	return m.result as {
		content: { type: string; text?: string }[];
		structuredContent?: { text: string };
	};
}
function textData(m: JSONRPCMessage) {
	return JSON.parse(result(m).content[0]?.text ?? "");
}

test("oversized pending output is recoverable after bounded reference send and restart", async (t) => {
	const f = await fixture(t);
	const raw = "한글🙂\u0001".repeat(50000);
	f.setPending({
		id: "large",
		chatId: "owner",
		sessionId: "A",
		cwd: f.root,
		complete: true,
		toolResults: [
			{
				role: "toolResult",
				toolCallId: "t",
				toolName: "read",
				content: [{ type: "text", text: raw }],
				isError: false,
				timestamp: 1,
			},
		],
	});
	const response = await f.request("sessions");
	assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 32 * 1024);
	const ref = textData(response);
	assert.equal(typeof ref.resultId, "string");
	assert.equal(f.acks, 1);
	const joined = await recoverText(f, ref.resultId);
	const reconstructed = JSON.parse(joined) as {
		content: Array<{ type: string; text?: string }>;
	};
	assert.ok(
		reconstructed.content.some(
			(block) => block.type === "text" && block.text === raw,
		),
		"Retained output must match the complete original text",
	);
	const other = await f.request(
		"get_operation",
		{ resultId: ref.resultId, offset: 0 },
		"other",
	);
	assertRpcError(other, /not found|expired/i);
	const restored = new Broker(f.root);
	const saved = await restored.readResponse("owner", ref.resultId);
	assert.equal(saved, joined);
});

test("failed response write preserves pending output and does not acknowledge", async (t) => {
	const f = await fixture(t);
	f.setPending({
		id: "large",
		chatId: "owner",
		sessionId: "A",
		cwd: f.root,
		toolResults: [
			{
				role: "toolResult",
				toolCallId: "t",
				toolName: "read",
				content: [{ type: "text", text: "x".repeat(100000) }],
				isError: false,
				timestamp: 1,
			},
		],
	});
	f.failNext();
	await assert.rejects(f.request("sessions"), /simulated send failure/);
	assert.equal(f.acks, 0);
	assert.equal(f.pending.length, 1);
	const retry = await f.request("sessions");
	assert.equal(typeof textData(retry).resultId, "string");
	assert.equal(f.acks, 1);
});

test("snapshot persistence failure cannot acknowledge pending output", async (t) => {
	const f = await fixture(t);
	t.mock.method(f.broker, "saveResponse", async () => {
		throw new Error("disk failure");
	});
	f.setPending({
		id: "large",
		chatId: "owner",
		sessionId: "A",
		cwd: f.root,
		toolResults: [
			{
				role: "toolResult",
				toolCallId: "t",
				toolName: "read",
				content: [{ type: "text", text: "x".repeat(100000) }],
				isError: false,
				timestamp: 1,
			},
		],
	});
	const response = await f.request("sessions");
	assert.match(JSON.stringify(response), /disk failure/);
	assert.equal(f.acks, 0);
	assert.equal(f.pending.length, 1);
});

test("oversized tool errors are bounded without consuming pending data", async (t) => {
	const f = await fixture(t);
	t.mock.method(f.broker, "listSessions", () => {
		throw new Error("x".repeat(100000));
	});
	const m = await f.request("sessions");
	assert.ok(Buffer.byteLength(JSON.stringify(m)) <= 32 * 1024);
	assert.equal(f.acks, 0);
});

test("response snapshots preserve image data and original resource references", async (t) => {
	const f = await fixture(t);
	const image = {
		type: "image" as const,
		data: Buffer.alloc(48000, 7).toString("base64"),
		mimeType: "image/png",
	};
	const uri = "chappie://session/A/image/hash/image.png";
	t.mock.method(f.broker, "history", async () => ({
		sessionId: "A",
		cwd: f.root,
		history: {
			count: 1,
			hasMore: false,
			content: [
				image,
				{ type: "text", text: JSON.stringify({ piImage: uri }) },
			],
		},
	}));
	const m = await f.request("history", { limit: 1 });
	assert.ok(Buffer.byteLength(JSON.stringify(m)) <= 32 * 1024);
	const full = await recover(f, m);
	assert.deepEqual(full.content[1], image);
	assert.equal(JSON.parse(full.content[2].text).piImage, uri);
});

test("a small question widget survives paging a large unrelated pending result", async (t) => {
	const f = await fixture(t);
	t.mock.getter(f.broker, "askEnabled", () => true);
	// Each modern request constructs its current MCP server, so the enabled widget is discovered now.
	const question = {
		id: "question",
		question: "Proceed?",
		options: [],
		allowMultiple: false,
		sessionId: "A",
		cwd: f.root,
	};
	t.mock.method(f.broker, "ask", async () => question);
	f.setPending({
		id: "large",
		chatId: "owner",
		sessionId: "A",
		cwd: f.root,
		toolResults: [
			{
				role: "toolResult",
				toolCallId: "t",
				toolName: "read",
				isError: false,
				timestamp: 1,
				content: [{ type: "text", text: "x".repeat(100000) }],
			},
		],
	});
	const m = await f.request("ask", { question: "Proceed?" });
	assert.ok(Buffer.byteLength(JSON.stringify(m)) <= 32 * 1024);
	const r = result(m) as { structuredContent?: { question?: typeof question } };
	assert.deepEqual(r.structuredContent?.question, question);
	assert.equal(typeof textData(m).resultId, "string");
});

test("oversized model input is retained before its delivery acknowledgement", async (t) => {
	const f = await fixture(t);
	let acknowledgements = 0;
	const input = {
		id: "model-request",
		sessionId: "A",
		request: {
			kind: "compaction" as const,
			input: { text: "x".repeat(100000) },
		},
	};
	t.mock.method(f.broker, "initialize", async () => ({
		selection: "explicit",
		session: {
			id: "A",
			cwd: f.root,
			device: "test",
			host: "omp",
			status: "idle",
		},
		inputs: [input],
		tools: [],
		skills: [],
	}));
	t.mock.method(f.broker, "acknowledgeInputs", async () => {
		acknowledgements++;
	});
	const m = await f.request("init");
	assert.ok(Buffer.byteLength(JSON.stringify(m)) <= 32 * 1024);
	assert.equal(acknowledgements, 1);
	const full = await recover(f, m);
	assert.match(JSON.stringify(full), /model-request/);
	assert.ok(JSON.stringify(full).includes("x".repeat(100000)));
});

test("result pages validate offsets and never advance on malformed selectors", async (t) => {
	const f = await fixture(t);
	const id = await f.broker.saveResponse("owner", "small");
	const eof = textData(
		await f.request("get_operation", { resultId: id, offset: 5 }),
	);
	assert.equal(eof.hasMore, false);
	assert.equal(eof.text, "");
	for (const args of [
		{ resultId: id, offset: 6 },
		{ resultId: id, offset: -1 },
		{ resultId: id, operationId: "both" },
		{ operationId: "only", offset: 1 },
	]) {
		const response = await f.request("get_operation", args);
		assert.ok(
			"error" in response ||
				("result" in response &&
					(response.result as { isError?: boolean }).isError),
		);
	}
	assert.equal(f.acks, 0);
});
