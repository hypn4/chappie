import { Writable } from "node:stream";
import {
	type ServeStdioOptions,
	StdioServerTransport,
	serveStdio,
} from "@modelcontextprotocol/server/stdio";
import { Broker } from "./broker.ts";
import { uuidV7 } from "./ids.ts";
import { MAX_RESULT_BYTES } from "./responses.ts";
import { createServer, type ResponseCommit } from "./server.ts";

/** All callers, including protocol tests, use the same modern-only boundary. */
export function serveMcp(
	broker: Broker,
	options: Pick<ServeStdioOptions, "transport" | "onerror"> = {},
) {
	const transport = options.transport ?? new StdioServerTransport();
	const traceScope = uuidV7();
	const traceRpc = (id: string | number) => ({ rpc: `${traceScope}:${id}` });
	const commits = new Map<
		string | number,
		{
			callbacks: ResponseCommit[];
			signal: AbortSignal;
			dispose(): void;
		}
	>();
	const stageResponseCommit = (
		requestId: string | number,
		commit: ResponseCommit,
		signal: AbortSignal,
	) => {
		signal.throwIfAborted();
		let pending = commits.get(requestId);
		if (pending && pending.signal !== signal)
			throw new Error("Response identifier already has a pending owner");
		if (!pending) {
			if (commits.size >= 512)
				throw new Error("Too many pending response acknowledgements");
			const entry = {
				callbacks: [] as ResponseCommit[],
				signal,
				dispose() {
					if (commits.get(requestId) === entry) commits.delete(requestId);
					signal.removeEventListener("abort", onAbort);
				},
			};
			commits.set(requestId, entry);
			const onAbort = () => {
				broker.diagnostics.record("ack.cancelled", traceRpc(requestId));
				entry.dispose();
			};
			signal.addEventListener("abort", onAbort, { once: true });
			pending = entry;
		}
		if (pending.callbacks.length >= 16)
			throw new Error("Too many response acknowledgement callbacks");
		pending.callbacks.push(commit);
		broker.diagnostics.record("ack.staged", {
			...traceRpc(requestId),
			pending: commits.size,
		});
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
		const pending =
			responseId === undefined ? undefined : commits.get(responseId);
		let sent = false;
		try {
			await originalSend.call(transport, message, sendOptions);
			sent = true;
			if (responseId !== undefined)
				broker.diagnostics.record("stdio.written", {
					...traceRpc(responseId),
					bytes: Buffer.byteLength(JSON.stringify(message)),
				});
		} catch (error) {
			if (responseId !== undefined)
				broker.diagnostics.record("stdio.failed", traceRpc(responseId));
			throw error;
		} finally {
			if (responseId !== undefined) {
				pending?.dispose();
				// Native tool failures are delivered result bodies too. The server
				// stages only complete responses; callback throws never stage commits.
				if (sent && !pending?.signal.aborted && "result" in message) {
					for (const commit of pending?.callbacks ?? []) {
						try {
							await commit();
							broker.diagnostics.record("ack.committed", traceRpc(responseId));
						} catch (error) {
							broker.diagnostics.record("ack.failed", traceRpc(responseId));
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
	const handle = serveStdio(
		() => createServer(broker, stageResponseCommit, traceScope),
		{
			...options,
			transport,
			legacy: "reject",
		},
	);
	return {
		async close() {
			for (const pending of commits.values()) pending.dispose();
			broker.diagnostics.record("transport.closed", { pending: commits.size });
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

export async function serveChappie(storageDir: string): Promise<never> {
	const broker = new Broker(storageDir);
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
