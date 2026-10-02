import { Writable } from "node:stream";
import {
	type ServeStdioOptions,
	StdioServerTransport,
	serveStdio,
} from "@modelcontextprotocol/server/stdio";
import { Broker } from "./broker.ts";
import { MAX_RESULT_BYTES } from "./responses.ts";
import { createServer, type ResponseCommit } from "./server.ts";

/** All callers, including protocol tests, use the same modern-only boundary. */
export function serveMcp(
	broker: Broker,
	options: Pick<ServeStdioOptions, "transport" | "onerror"> = {},
) {
	const transport = options.transport ?? new StdioServerTransport();
	const commits = new Map<string | number, ResponseCommit[]>();
	const stageResponseCommit = (
		requestId: string | number,
		commit: ResponseCommit,
	) => {
		const pending = commits.get(requestId) ?? [];
		pending.push(commit);
		commits.set(requestId, pending);
	};
	const originalSend = transport.send;
	transport.send = async (message, sendOptions) => {
		// Defense at the actual wire boundary, including SDK-generated tool errors.
		if (
			("error" in message ||
				("result" in message &&
					typeof message.result === "object" &&
					message.result !== null &&
					"content" in message.result)) &&
			Buffer.byteLength(JSON.stringify(message)) > MAX_RESULT_BYTES
		) {
			message = {
				jsonrpc: "2.0",
				id: message.id,
				error: {
					code: -32603,
					message:
						"Response exceeds the bridge byte budget; pending data was not acknowledged. Recover the original result instead of repeating execution.",
				},
			};
		}
		const responseId =
			"id" in message &&
			("result" in message || "error" in message) &&
			(typeof message.id === "string" || typeof message.id === "number")
				? message.id
				: undefined;
		let sent = false;
		try {
			await originalSend.call(transport, message, sendOptions);
			sent = true;
		} finally {
			if (responseId !== undefined) {
				const pending = commits.get(responseId) ?? [];
				commits.delete(responseId);
				if (
					sent &&
					"result" in message &&
					!(
						typeof message.result === "object" &&
						message.result !== null &&
						"isError" in message.result &&
						message.result.isError === true
					)
				) {
					for (const commit of pending) {
						try {
							await commit();
						} catch (error) {
							try {
								options.onerror?.(
									error instanceof Error ? error : new Error(String(error)),
								);
							} catch {}
						}
					}
				}
			}
		}
	};
	const handle = serveStdio(() => createServer(broker, stageResponseCommit), {
		...options,
		transport,
		legacy: "reject",
	});
	return {
		async close() {
			commits.clear();
			try {
				await handle.close();
			} finally {
				transport.send = originalSend;
			}
		},
	};
}
const terminationSignals =
	process.platform === "win32"
		? ["SIGINT", "SIGTERM"]
		: ["SIGHUP", "SIGINT", "SIGTERM"];

export async function serveChappie(agentDir: string): Promise<never> {
	const broker = new Broker(agentDir);
	await broker.start();
	const output = new Writable({
		write(chunk, encoding, callback) {
			Writable.prototype.write.call(process.stdout, chunk, encoding, callback);
		},
	});
	const transport = new StdioServerTransport(process.stdin, output);
	const { promise: stopped, resolve: requestStop } =
		Promise.withResolvers<void>();

	output.once("error", requestStop);
	process.stdin.once("end", requestStop);
	process.stdin.once("close", requestStop);
	for (const signal of terminationSignals) {
		process.once(signal, requestStop);
	}

	const handle = serveMcp(broker, {
		transport,
		onerror(error) {
			console.error(error);
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") requestStop();
		},
	});

	try {
		await stopped;
		await handle.close();
	} finally {
		await broker.close();
	}
	await new Promise<void>((resolve) => output.end(resolve));
	process.exit(0);
}
