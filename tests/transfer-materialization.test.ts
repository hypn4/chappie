import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { Broker } from "../src/broker.ts";
import type { DeliveryReference } from "../src/delivery.ts";
import type { TransferArgs } from "../src/transfer.ts";
import { mcpClient, record, resultOf } from "./helpers/mcp-client.ts";
import { quietDiagnostics } from "./helpers/mcp-fixture.ts";
import { sessionFixture } from "./helpers/session-fixture.ts";

function links(result: Record<string, unknown>) {
	assert.ok(Array.isArray(result.content));
	return result.content
		.map(record)
		.filter((block) => block.type === "resource_link");
}

async function exportedOverMcp(t: TestContext) {
	const f = await sessionFixture(t);
	const path = join(f.root, "approval.txt");
	await writeFile(path, "original attachment bytes");
	const client = mcpClient(t, f.broker);
	await client.request("server/discover");
	let nativeExecutions = 0;
	const args = { sessionId: "A", operationId: "export-once", paths: [path] };
	async function exportFile(input: typeof args) {
		const pending = client.call("transfer", input, { chatId: "test-chat" });
		const output = await f.dispatch();
		const call = output.message.content.find(
			(block) => block.type === "toolCall",
		);
		assert.ok(call?.type === "toolCall");
		assert.equal(call.name, "transfer");
		nativeExecutions++;
		const result = await f.local.transfer(
			call.arguments as TransferArgs,
			f.controller.signal,
			undefined,
			{ sessionId: "A", cwd: f.root },
		);
		await f.emit("turn_end", {
			message: structuredClone(output.message),
			toolResults: [
				{
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: result.content,
					details: result.details,
					isError: result.isError === true,
					timestamp: Date.now(),
				},
			],
		});
		await f.emit("agent_end", { willContinue: false });
		return resultOf(await pending);
	}
	const initial = await exportFile(args);
	assert.equal(links(initial).length, 1);
	const uri = links(initial)[0]?.uri;
	assert.ok(typeof uri === "string");
	return {
		...f,
		client,
		args,
		initial,
		uri,
		exportFile,
		get nativeExecutions() {
			return nativeExecutions;
		},
	};
}

test("one native export does not offer the attachment again on completed approval resumes", async (t) => {
	const f = await exportedOverMcp(t);
	for (let resume = 0; resume < 3; resume++) {
		const response = resultOf(
			await f.client.call("transfer", f.args, { chatId: "test-chat" }),
		);
		assert.equal(
			links(response).length,
			0,
			"a completed retry is a receipt, not another attachment offer",
		);
		assert.ok(Array.isArray(response.content));
		const header = JSON.parse(String(record(response.content[0]).text));
		assert.equal(header.replay.status, "completed");
		assert.equal(header.replay.delivery.hostReceipt, "unconfirmed");
		assert.equal(header.replay.delivery.resources.length, 1);
		assert.equal(header.replay.delivery.resources[0].sourceReadAt, undefined);
	}
	assert.equal(f.nativeExecutions, 1);
	const original = await f.broker.readResource(f.uri, f.controller.signal);
	assert.equal(
		Buffer.from(original.blob, "base64").toString(),
		"original attachment bytes",
	);
	assert.equal(
		await readFile(join(f.root, "approval.txt"), "utf8"),
		"original attachment bytes",
	);
});

test("explicit missing-file recovery offers the original resource once without regenerating it", async (t) => {
	const f = await exportedOverMcp(t);
	const recovery = {
		...f.args,
		operationId: "explicit-delivery",
		paths: [f.uri],
	};
	const delivered = await f.exportFile(recovery);
	assert.equal(links(delivered).length, 1);
	assert.equal(links(delivered)[0]?.uri, f.uri);
	const response = resultOf(
		await f.client.call("transfer", recovery, { chatId: "test-chat" }),
	);
	assert.equal(links(response).length, 0);
	const original = await f.broker.readResource(f.uri, f.controller.signal);
	assert.equal(
		Buffer.from(original.blob, "base64").toString(),
		"original attachment bytes",
	);
	assert.equal(
		f.nativeExecutions,
		2,
		"only the export and explicit recovery execute",
	);
});

test("retained operation output preserves references without offering old attachments on unrelated calls", async (t) => {
	const resource = {
		uri: "chappie://session/A/file/export/approval.txt",
		name: "approval.txt",
		mimeType: "text/plain",
		size: 25,
	};
	const snapshot = JSON.stringify({
		content: [
			{ type: "text", text: "original completed output" },
			{ type: "resource_link", ...resource },
		],
	});
	const reference: DeliveryReference = {
		id: "original-delivery",
		chatId: "test-chat",
		sessionId: "A",
		cwd: "/fixture",
		resultId: "a".repeat(64),
		bytes: Buffer.byteLength(snapshot),
		failed: false,
	};
	const broker: Partial<Broker> = {
		askEnabled: false,
		diagnostics: quietDiagnostics(),
		binding: () => "A",
		listSessions: () => [],
		deliveries: () => [reference],
		answers: () => [],
		readResponse: async () => snapshot,
		markResponseRead: async () => {},
		acknowledge: async () => {},
	};
	const client = mcpClient(t, broker as Broker);
	await client.request("server/discover");
	const response = resultOf(
		await client.call("sessions", {}, { chatId: "test-chat" }),
	);
	assert.equal(links(response).length, 0);
	assert.ok(Array.isArray(response.content));
	const references = response.content
		.map(record)
		.filter((block) => block.type === "text")
		.flatMap((block) => {
			try {
				return [JSON.parse(String(block.text)).resourceReference];
			} catch {
				return [];
			}
		})
		.filter(Boolean);
	assert.deepEqual(references, [resource]);
});
