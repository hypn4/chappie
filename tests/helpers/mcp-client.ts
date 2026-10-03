import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";
import type { Broker } from "../../src/broker.ts";
import { serveMcp } from "../../src/stdio.ts";

interface RequestOptions {
	chatId?: string | null;
	modern?: boolean;
	id?: number;
}

/** In-process wire client; resolves only after send and response commits settle. */
export function mcpClient(t: TestContext, broker: Broker) {
	const pending = new Map<
		number,
		ReturnType<typeof Promise.withResolvers<JSONRPCMessage>> & {
			message?: JSONRPCMessage;
		}
	>();
	const errors: Error[] = [];
	let nextId = 0;
	let sendFailure: Error | undefined;
	let closed = false;
	const transport: Transport = {
		async start() {},
		async close() {
			transport.onclose?.();
		},
		async send(message) {
			if (!("id" in message) || typeof message.id !== "number") return;
			if (sendFailure) {
				const error = sendFailure;
				sendFailure = undefined;
				throw error;
			}
			const request = pending.get(message.id);
			if (request) request.message = message;
		},
	};
	const handle = serveMcp(broker, {
		transport,
		onerror: (error) => errors.push(error),
	});
	const send = transport.send.bind(transport);
	transport.send = async (message, options) => {
		const request =
			"id" in message && typeof message.id === "number"
				? pending.get(message.id)
				: undefined;
		try {
			await send(message, options);
			if (request?.message) request.resolve(request.message);
		} catch (error) {
			request?.reject(error);
			throw error;
		}
	};
	async function close() {
		if (closed) return;
		closed = true;
		for (const request of pending.values())
			request.reject(new Error("MCP fixture closed"));
		pending.clear();
		await handle.close();
	}
	t.after(close);
	async function request(
		method: string,
		params: Record<string, unknown> = {},
		options: RequestOptions = {},
	) {
		assert.equal(closed, false, "MCP fixture is closed");
		const id = options.id ?? ++nextId;
		const completion = Promise.withResolvers<JSONRPCMessage>();
		pending.set(id, completion);
		const timer = setTimeout(
			() =>
				completion.reject(
					new Error(
						`MCP ${method} timed out: ${errors.map((error) => error.message).join("; ")}`,
					),
				),
			5000,
		);
		const chatId =
			options.chatId === undefined ? "server-test" : options.chatId;
		transport.onmessage?.({
			jsonrpc: "2.0",
			id,
			method,
			params: {
				...params,
				_meta: {
					...(options.modern === false
						? {}
						: {
								"io.modelcontextprotocol/protocolVersion": "2026-07-28",
								"io.modelcontextprotocol/clientCapabilities": {},
							}),
					...(chatId === null ? {} : { "openai/session": chatId }),
					"otunnel/requestId": `test-${id}`,
					...(params._meta as Record<string, unknown> | undefined),
				},
			},
		});
		try {
			return await completion.promise;
		} finally {
			clearTimeout(timer);
			pending.delete(id);
		}
	}
	return {
		request,
		close,
		call: (
			name: string,
			args: Record<string, unknown> = {},
			options?: RequestOptions,
		) => request("tools/call", { name, arguments: args }, options),
		cancel: (id: number) => {
			transport.onmessage?.({
				jsonrpc: "2.0",
				method: "notifications/cancelled",
				params: { requestId: id, reason: "fixture cancellation" },
			});
			pending.get(id)?.reject(new Error("fixture cancellation"));
		},
		failNextSend: (error = new Error("simulated send failure")) => {
			sendFailure = error;
		},
	};
}

export function record(value: unknown): Record<string, unknown> {
	assert.ok(
		value !== null && typeof value === "object" && !Array.isArray(value),
		"Expected an object",
	);
	return value as Record<string, unknown>;
}

export function resultOf(message: JSONRPCMessage): Record<string, unknown> {
	assert.ok("result" in message, JSON.stringify(message));
	return record(message.result);
}

export function assertRpcError(message: JSONRPCMessage, pattern: RegExp): void {
	if ("error" in message) {
		assert.match(message.error.message, pattern);
		return;
	}
	const result = resultOf(message);
	assert.equal(result.isError, true, "Expected a tool error");
	assert.match(JSON.stringify(result.content), pattern);
}
