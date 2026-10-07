import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Broker } from "../src/broker.ts";
import type { DeliveryReference } from "../src/delivery.ts";
import { IpcServer, type SessionInput } from "../src/ipc.ts";
import { ResponseStore } from "../src/responses.ts";
import { State } from "../src/state.ts";
import { mcpClient, resultOf } from "./helpers/mcp-client.ts";
import { quietDiagnostics } from "./helpers/mcp-fixture.ts";

test("failed response send preserves pending output and input until a successful retry", async (t) => {
	const snapshot = JSON.stringify({
		content: [{ type: "text", text: "PENDING_REVIEW_RESULT" }],
	});
	const delivery: DeliveryReference = {
		id: "deferred-1",
		chatId: "review-chat",
		sessionId: "A",
		cwd: "/fixture",
		resultId: "d".repeat(64),
		bytes: Buffer.byteLength(snapshot),
		failed: false,
	};
	const input: SessionInput = {
		id: "input-1",
		sessionId: "A",
		message: { role: "user", content: "INPUT", timestamp: 1 },
	};
	let pending = [delivery];
	const acknowledged: string[] = [];
	const acknowledgedInputs: string[] = [];
	const readResults: string[] = [];
	const broker: Partial<Broker> = {
		askEnabled: false,
		diagnostics: quietDiagnostics(),
		initialize: async () => ({
			selection: "explicit",
			session: {
				id: "A",
				cwd: "/fixture",
				device: "test",
				host: "omp",
				status: "idle",
			},
			tools: [],
			skills: [],
			inputs: [input],
		}),
		deliveries: () => pending,
		answers: () => [],
		readResponse: async (chatId, resultId) => {
			assert.equal(chatId, "review-chat");
			assert.equal(resultId, delivery.resultId);
			return snapshot;
		},
		markResponseRead: async (_chatId, resultId) => {
			readResults.push(resultId);
		},
		acknowledge: async (deliveries) => {
			acknowledged.push(...deliveries.map((item) => item.id));
			pending = [];
		},
		acknowledgeInputs: async (sessionId, inputs) => {
			assert.equal(sessionId, "A");
			acknowledgedInputs.push(...inputs.map((item) => item.id));
		},
	};
	const client = mcpClient(t, broker as Broker);
	await client.request("server/discover");
	client.failNextSend();
	await assert.rejects(
		client.call("init", { sessionId: "A" }, { chatId: "review-chat" }),
		/simulated send failure/,
	);
	assert.deepEqual(acknowledged, []);
	assert.deepEqual(acknowledgedInputs, []);
	assert.deepEqual(readResults, []);
	assert.deepEqual(pending, [delivery]);

	const response = resultOf(
		await client.call("init", { sessionId: "A" }, { chatId: "review-chat" }),
	);
	assert.match(JSON.stringify(response.content), /PENDING_REVIEW_RESULT/);
	assert.match(JSON.stringify(response.content), /input-1/);
	assert.deepEqual(acknowledged, ["deferred-1"]);
	assert.deepEqual(acknowledgedInputs, ["input-1"]);
	assert.deepEqual(readResults, [delivery.resultId]);
	assert.deepEqual(pending, []);
});

test("failed native results commit only after their complete MCP response is successfully written", async (t) => {
	const snapshot = JSON.stringify({
		content: [{ type: "text", text: "EARLIER_PENDING_RESULT" }],
	});
	const delivery: DeliveryReference = {
		id: "earlier-delivery",
		chatId: "failed-native-chat",
		sessionId: "A",
		cwd: "/fixture",
		resultId: "d".repeat(64),
		bytes: Buffer.byteLength(snapshot),
		failed: false,
	};
	const input: SessionInput = {
		id: "input-after-failure",
		sessionId: "A",
		message: { role: "user", content: "INPUT", timestamp: 1 },
	};
	const nativeResultId = "f".repeat(64);
	let pending = [delivery];
	let snapshotUnavailable = true;
	const acknowledged: string[] = [];
	const acknowledgedInputs: string[] = [];
	const readResults: string[] = [];
	const broker: Partial<Broker> = {
		askEnabled: false,
		diagnostics: quietDiagnostics(),
		call: async () => ({
			sessionId: "A",
			cwd: "/fixture",
			inputs: [input],
			toolResults: [
				{
					role: "toolResult",
					toolCallId: "native-failure-call",
					toolName: "bash",
					content: [{ type: "text", text: "NATIVE_EXIT_1_DETAILS" }],
					isError: true,
					timestamp: 1,
				},
			],
			operation: {
				operationId: "failed-native-batch",
				status: "failed",
				sessionId: "A",
				cwd: "/fixture",
				updatedAt: 1,
				resultId: nativeResultId,
			},
		}),
		deliveries: () => pending,
		answers: () => [],
		readResponse: async (chatId, resultId) => {
			assert.equal(chatId, "failed-native-chat");
			assert.equal(resultId, delivery.resultId);
			if (snapshotUnavailable)
				throw new Error("snapshot temporarily unreadable");
			return snapshot;
		},
		markResponseRead: async (_chatId, resultId) => {
			readResults.push(resultId);
		},
		acknowledge: async (deliveries) => {
			acknowledged.push(...deliveries.map((item) => item.id));
			pending = [];
		},
		acknowledgeInputs: async (_sessionId, inputs) => {
			acknowledgedInputs.push(...inputs.map((item) => item.id));
		},
	};
	const client = mcpClient(t, broker as Broker);
	const call = () =>
		client.call(
			"call",
			{ calls: [{ name: "bash", arguments: { command: "exit 1" } }] },
			{ chatId: "failed-native-chat" },
		);
	const assertUncommitted = () => {
		assert.deepEqual(readResults, []);
		assert.deepEqual(acknowledged, []);
		assert.deepEqual(acknowledgedInputs, []);
		assert.deepEqual(pending, [delivery]);
	};

	// A callback throw becomes an SDK tool error, after the native inline read
	// was deferred locally. Its incomplete body must not register any commit.
	const callbackError = resultOf(await call());
	assert.equal(callbackError.isError, true);
	assert.match(
		JSON.stringify(callbackError.content),
		/snapshot temporarily unreadable/,
	);
	assertUncommitted();

	snapshotUnavailable = false;
	client.failNextSend();
	await assert.rejects(call(), /simulated send failure/);
	assertUncommitted();

	const response = resultOf(await call());
	assert.equal(response.isError, true);
	assert.match(JSON.stringify(response.content), /NATIVE_EXIT_1_DETAILS/);
	assert.match(JSON.stringify(response.content), /EARLIER_PENDING_RESULT/);
	assert.match(JSON.stringify(response.content), /input-after-failure/);
	assert.deepEqual(readResults, [nativeResultId, delivery.resultId]);
	assert.deepEqual(acknowledged, [delivery.id]);
	assert.deepEqual(acknowledgedInputs, [input.id]);
	assert.deepEqual(pending, []);
});

test("inline delivery confirmation follows durable ACK so only unread pointers stay pinned", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ch-commit-order-"));
	const broker = new Broker(root);
	let client: ReturnType<typeof mcpClient> | undefined;
	t.after(async () => {
		try {
			await client?.close();
			await broker.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	const persisted = new State(root);
	for (const [id, text] of [
		["inline", "ACTUALLY_DELIVERED_INLINE"],
		["pointer", "UNREAD_LARGE_BODY".repeat(4000)],
	] as const) {
		await persisted.addDelivery({
			id,
			chatId: "owner",
			sessionId: "A",
			cwd: root,
			complete: true,
			toolResults: [
				{
					role: "toolResult",
					toolCallId: id,
					toolName: "read",
					content: [{ type: "text", text }],
					isError: false,
					timestamp: 1,
				},
			],
		});
	}
	await persisted.flush();
	// Native session IPC is unrelated to this real Broker/State/ResponseStore
	// transport path. Load persisted state without opening a native socket.
	t.mock.method(IpcServer.prototype, "start", async () => {});
	await broker.start();
	client = mcpClient(t, broker);
	const references = broker.deliveries("owner");
	const inline = references.find((item) => item.id === "inline");
	const pointer = references.find((item) => item.id === "pointer");
	assert.ok(inline && pointer);
	const metadata = async (id: string) =>
		JSON.parse(
			await readFile(join(root, "chappie.results", `${id}.meta.json`), "utf8"),
		) as { pins: string[]; readAt?: number };
	const pointerText = await broker.readResponse("owner", pointer.resultId);

	client.failNextSend();
	await assert.rejects(
		client.call("sessions", {}, { chatId: "owner" }),
		/simulated send failure/,
	);
	assert.deepEqual(broker.deliveries("owner"), references);
	for (const reference of references) {
		const saved = await metadata(reference.resultId);
		assert.equal(saved.readAt, undefined);
		assert.ok(saved.pins.includes(`delivery:${reference.id}`));
	}

	const response = resultOf(
		await client.call("sessions", {}, { chatId: "owner" }),
	);
	assert.match(JSON.stringify(response.content), /ACTUALLY_DELIVERED_INLINE/);
	assert.doesNotMatch(JSON.stringify(response.content), /UNREAD_LARGE_BODY/);
	assert.deepEqual(broker.deliveries("owner"), []);
	assert.equal(typeof (await metadata(inline.resultId)).readAt, "number");
	assert.deepEqual((await metadata(inline.resultId)).pins, []);
	assert.equal((await metadata(pointer.resultId)).readAt, undefined);
	assert.deepEqual((await metadata(pointer.resultId)).pins, ["unread"]);

	const limited = new ResponseStore(root, {
		maxSnapshots: 2,
		maxConversationSnapshots: 2,
	});
	const next = await limited.save("owner", "NEXT_WORK_RESULT", {
		pin: "unread",
	});
	await assert.rejects(
		limited.read("owner", inline.resultId),
		/not found or expired/,
	);
	assert.equal(await limited.read("owner", pointer.resultId), pointerText);
	assert.equal(await limited.read("owner", next), "NEXT_WORK_RESULT");
});

for (const mode of ["inline", "pages"] as const) {
	test(`${mode} consumption keeps unread protection until receipt persistence succeeds`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "ch-consume-commit-"));
		const broker = new Broker(root);
		let client: ReturnType<typeof mcpClient> | undefined;
		t.after(async () => {
			try {
				await client?.close();
				await broker.close();
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
		const state = new State(root);
		const operationId = `consume-${mode}`;
		await state.reserveOperation({
			key: operationId,
			operationId,
			signature: `signature-${mode}`,
			chatId: "owner",
			sessionId: "A",
			cwd: root,
			status: "running",
			updatedAt: Date.now(),
		});
		const execution = state.executionSource(operationId);
		await state.addDelivery({
			id: `operation:${execution.executionId}`,
			...execution,
			chatId: "owner",
			sessionId: "A",
			cwd: root,
			complete: true,
			toolResults: [
				{
					role: "toolResult",
					toolCallId: "consumed-result",
					toolName: "read",
					content: [
						{
							type: "text",
							text: "CONSUMED_BODY".repeat(mode === "pages" ? 3000 : 1),
						},
					],
					isError: false,
					timestamp: 1,
				},
			],
		});
		await state.flush();
		t.mock.method(IpcServer.prototype, "start", async () => {});
		await broker.start();
		client = mcpClient(t, broker);
		const reference = broker.deliveries("owner")[0];
		assert.ok(reference);
		await broker.acknowledge([reference], [], new AbortController().signal);
		const resultId = reference.resultId;
		const store = new ResponseStore(root);
		const original = await store.read("owner", resultId);
		const statePath = join(root, "chappie.state.json");
		const backupPath = join(root, "state-before-consumption.json");
		const metadataPath = join(root, "chappie.results", `${resultId}.meta.json`);
		const storedReceipt = async (path: string) => {
			const persisted = JSON.parse(await readFile(path, "utf8"));
			return persisted.operations.find(
				(receipt: { operationId?: string }) =>
					receipt.operationId === operationId,
			);
		};
		assert.equal((await storedReceipt(statePath)).resultUnread, true);
		let finalArgs: Record<string, unknown> = { operationId };
		await rename(statePath, backupPath);
		await mkdir(statePath);
		try {
			if (mode === "inline") {
				const response = resultOf(
					await client.call("get_operation", finalArgs, { chatId: "owner" }),
				);
				assert.match(JSON.stringify(response.content), /CONSUMED_BODY/);
			} else {
				let offset = 0;
				let received = "";
				let pages = 0;
				while (true) {
					finalArgs = { resultId, offset };
					const response = resultOf(
						await client.call("get_operation", finalArgs, { chatId: "owner" }),
					);
					const content = response.content as { type: string; text: string }[];
					const page = JSON.parse(content[0]?.text ?? "null");
					received += page.text;
					pages++;
					if (!page.hasMore) break;
					assert.ok(page.nextOffset > offset && pages < 20);
					offset = page.nextOffset;
				}
				assert.ok(pages > 1);
				assert.equal(received, original);
			}
			const confirmed = JSON.parse(await readFile(metadataPath, "utf8"));
			assert.equal(typeof confirmed.readAt, "number");
			if (mode === "pages")
				assert.equal(confirmed.readThrough, original.length);
			assert.equal(await store.isUnread("owner", resultId), true);
			assert.equal((await storedReceipt(backupPath)).resultUnread, true);
			assert.equal(
				broker.operation("owner", operationId).operation.resultId,
				resultId,
			);
		} finally {
			await rm(statePath, { recursive: true, force: true });
			await rename(backupPath, statePath);
		}
		await client.call("get_operation", finalArgs, { chatId: "owner" });
		assert.equal((await storedReceipt(statePath)).resultUnread, false);
		assert.equal(await store.isUnread("owner", resultId), false);
		assert.equal(await store.read("owner", resultId), original);
	});
}

test("cancelled response staging cannot acknowledge old data on a reused request id", async (t) => {
	const saving = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	t.after(() => release.resolve());
	let acknowledgements = 0;
	const client = mcpClient(t, {
		askEnabled: false,
		diagnostics: quietDiagnostics(),
		initialize: async (
			_chat: string,
			_session: string | undefined,
			_request: unknown,
			signal: AbortSignal,
		) => {
			signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			return {
				selection: "explicit",
				session: {
					id: "A",
					cwd: "/fixture",
					device: "test",
					host: "omp",
					status: "idle",
				},
				tools: [],
				skills: [],
				inputs: [
					{
						id: "unread",
						sessionId: "A",
						message: {
							role: "user",
							timestamp: 1,
							content: "x".repeat(40_000),
						},
					},
				],
			};
		},
		deliveries: () => [],
		answers: () => [],
		acknowledgeInputs: async () => {
			acknowledgements++;
		},
		saveResponse: async () => {
			saving.resolve();
			await release.promise;
			return "a".repeat(64);
		},
	} as unknown as Broker);
	const request = client.call("init", { sessionId: "A" }, { id: 90 });
	const cancelled = assert.rejects(request, /fixture cancellation/);
	await saving.promise;
	client.cancel(90);
	await aborted.promise;
	await cancelled;
	release.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
	await client.request("server/discover", {}, { id: 90 });
	assert.equal(
		acknowledgements,
		0,
		"a discovery response did not deliver or acknowledge the cancelled input",
	);
});
