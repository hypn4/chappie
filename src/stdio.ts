import { Writable } from "node:stream";
import {
	type ServeStdioOptions,
	StdioServerTransport,
	serveStdio,
} from "@modelcontextprotocol/server/stdio";
import { Broker } from "./broker.ts";
import { createServer } from "./server.ts";

/** All callers, including protocol tests, use the same modern-only boundary. */
export function serveMcp(
	broker: Broker,
	options: Pick<ServeStdioOptions, "transport" | "onerror"> = {},
) {
	return serveStdio(() => createServer(broker), {
		...options,
		legacy: "reject",
	});
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
