import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";
import type { Broker } from "../src/broker.ts";
import { serveMcp } from "../src/stdio.ts";

async function fixture(t: TestContext) {
	let pendingDelivery = [
		{
			id: "deferred-1",
			chatId: "review-chat",
			sessionId: "A",
			cwd: "/fixture",
			toolResults: [
				{
					role: "toolResult" as const,
					toolCallId: "tool-1",
					toolName: "read",
					content: [{ type: "text" as const, text: "PENDING_REVIEW_RESULT" }],
					isError: false,
					timestamp: 1,
				},
			],
		},
	];
	let deliveryAcks = 0;
	let inputAcks = 0;
	let failToolResponse = true;
	const broker = {
		askEnabled: false,
		binding: () => "A",
		listSessions: () => [
			{
				id: "A",
				cwd: "/fixture",
				device: "test",
				host: "omp",
				status: "idle",
				bindingCount: 1,
			},
		],
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
			inputs: [
				{
					id: "input-1",
					sessionId: "A",
					message: { role: "user", content: "INPUT", timestamp: 1 },
				},
			],
		}),
		deliveries: () => [...pendingDelivery],
		answers: () => [],
		acknowledge: async (deliveries: unknown[]) => {
			deliveryAcks++;
			if (deliveries.length) pendingDelivery = [];
		},
		acknowledgeInputs: async () => {
			inputAcks++;
		},
	} as unknown as Broker;

	const responses = new Map<number, JSONRPCMessage>();
	const transport: Transport = {
		async start() {},
		async close() {
			transport.onclose?.();
		},
		async send(message) {
			if ("id" in message && message.id === 2 && failToolResponse) {
				failToolResponse = false;
				throw new Error("simulated send failure");
			}
			if ("id" in message && typeof message.id === "number")
				responses.set(message.id, message);
		},
	};
	const errors: Error[] = [];
	const handle = serveMcp(broker, {
		transport,
		onerror: (error) => errors.push(error),
	});
	t.after(() => handle.close());
	const send = async (
		id: number,
		method: string,
		params: Record<string, unknown>,
	) => {
		transport.onmessage?.({
			jsonrpc: "2.0",
			id,
			method,
			params: {
				...params,
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientCapabilities": {},
					"openai/session": "review-chat",
					"otunnel/requestId": `transport-${id}`,
				},
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
	};
	await send(1, "server/discover", {});
	return {
		send,
		responses,
		errors,
		get deliveryAcks() {
			return deliveryAcks;
		},
		get inputAcks() {
			return inputAcks;
		},
		get pendingCount() {
			return pendingDelivery.length;
		},
	};
}

test("response-scoped state is committed only after the MCP response is sent", async (t) => {
	const f = await fixture(t);
	await f.send(2, "tools/call", {
		name: "init",
		arguments: { sessionId: "A" },
	});
	assert.equal(f.deliveryAcks, 0);
	assert.equal(f.inputAcks, 0);
	assert.equal(f.pendingCount, 1);

	await f.send(3, "tools/call", {
		name: "init",
		arguments: { sessionId: "A" },
	});
	assert.ok(f.responses.has(3));
	assert.equal(f.deliveryAcks, 1);
	assert.equal(f.inputAcks, 1);
	assert.equal(f.pendingCount, 0);
});
