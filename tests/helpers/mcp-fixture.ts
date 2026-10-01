import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";
import type { Broker } from "../../src/broker.ts";
import { serveMcp } from "../../src/stdio.ts";

export async function mcpFixture(
	t: TestContext,
	overrides: Record<string, unknown> = {},
) {
	let acknowledgements = 0;
	const broker = {
		askEnabled: false,
		binding: () => "A",
		listSessions: () => [
			{ id: "A", cwd: "/fixture", device: "test", status: "idle" },
		],
		inputs: async () => [],
		deliveries: () => [],
		answers: () => [],
		acknowledge: async () => {
			acknowledgements++;
		},
		...overrides,
	} as unknown as Broker;
	const pending = new Map<number, (message: JSONRPCMessage) => void>();
	const transport: Transport = {
		async start() {},
		async close() {
			transport.onclose?.();
		},
		async send(message) {
			if ("id" in message && typeof message.id === "number")
				pending.get(message.id)?.(message);
		},
	};
	const handle = serveMcp(broker, { transport });
	t.after(() => handle.close());
	let id = 0;
	async function request(
		method: string,
		params: Record<string, unknown>,
		timeout = 500,
	) {
		const next = ++id;
		const completion = Promise.withResolvers<JSONRPCMessage>();
		pending.set(next, completion.resolve);
		const timer = setTimeout(
			() => completion.reject(new Error(`MCP ${method} timed out`)),
			timeout,
		);
		transport.onmessage?.({
			jsonrpc: "2.0",
			id: next,
			method,
			params: {
				...params,
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientCapabilities": {},
					...(params._meta as Record<string, unknown> | undefined),
				},
			},
		});
		try {
			const response = await completion.promise;
			assert.ok("result" in response, JSON.stringify(response));
			return response.result as Record<string, unknown>;
		} finally {
			clearTimeout(timer);
			pending.delete(next);
		}
	}
	await request("server/discover", {});
	return {
		request,
		get acknowledgements() {
			return acknowledgements;
		},
		call: (name: string, args: Record<string, unknown> = {}) =>
			request("tools/call", {
				name,
				arguments: args,
				_meta: {
					"openai/session": "server-test",
					"otunnel/requestId": `test-${id + 1}`,
				},
			}),
	};
}
