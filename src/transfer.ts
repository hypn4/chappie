import { createWriteStream } from "node:fs";
import {
	chmod,
	link,
	lstat,
	mkdir,
	mkdtempDisposable,
	rename,
	stat,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
	formatSize,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import {
	describeResource,
	type ResourceDescriptor,
	registerFile,
} from "./resources.ts";

export interface TransferDetails {
	failed?: boolean;
	device: string;
	files: ({ path: string; bytes: number } | { path: string; error: string })[];
	resources: ResourceDescriptor[];
	to?: { sessionId: string; device: string };
	from?: { sessionId: string; device: string };
}

export interface TransferResult {
	content: { type: "text"; text: string }[];
	details: TransferDetails;
	isError?: boolean;
}

export const transferFile = Type.Object({
	file_id: Type.String({ description: "Host file identifier" }),
	download_url: Type.String({ description: "Host-provided download URL" }),
	file_name: Type.Optional(Type.String()),
	mime_type: Type.Optional(Type.String()),
});

const parameters = Type.Object({
	operationId: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 128,
			description:
				"Stable ID for this user-requested transfer. Reuse after approval or transport retries; choose a new ID only for a new user request.",
		}),
	),
	paths: Type.Array(Type.String(), {
		minItems: 1,
		description:
			"Pi destinations for import; Pi source paths or chappie:// image references for export or session copies",
	}),
	files: Type.Optional(
		Type.Array(transferFile, {
			minItems: 1,
			description:
				"ChatGPT files paired with paths in order; omit for Pi sources",
		}),
	),
	from: Type.Optional(
		Type.Object({
			sessionId: Type.String({ description: "Source agent session" }),
			paths: Type.Array(Type.String(), {
				minItems: 1,
				description: "Source paths paired with local destinations",
			}),
		}),
	),
	to: Type.Optional(
		Type.Object({
			sessionId: Type.String({ description: "Destination Pi session" }),
			paths: Type.Array(Type.String(), {
				minItems: 1,
				description: "Destinations paired with source paths in order",
			}),
		}),
	),
	overwrite: Type.Optional(
		Type.Boolean({ description: "Overwrite existing target files" }),
	),
});

export type TransferArgs = Static<typeof parameters>;

export interface TransferExecutionContext {
	sessionId: string;
	cwd: string;
}

export type TransferUpdate = (result: {
	content: { type: "text"; text: string }[];
	details: TransferDetails;
}) => void;

export async function executeTransfer(
	args: TransferArgs,
	signal: AbortSignal | undefined,
	update: TransferUpdate | undefined,
	context: TransferExecutionContext,
): Promise<TransferResult> {
	if (args.paths.length < 1 || args.paths.length > 128)
		throw new Error("Transfers require between 1 and 128 paths");
	const { sessionId, cwd } = context;
	const device = hostname();
	update?.({ content: [], details: { device, files: [], resources: [] } });
	if (!args.files) {
		const resources = await Promise.all(
			args.paths.map((requested) =>
				requested.startsWith("chappie://")
					? describeResource(sessionId, requested)
					: registerFile(sessionId, localPath(requested, cwd)),
			),
		);
		return {
			content: [{ type: "text" as const, text: JSON.stringify({ resources }) }],
			details: { device, files: [], resources },
		};
	}

	if (args.files.length !== args.paths.length) {
		throw new Error("files and paths must contain the same number of entries");
	}
	const files = await Promise.all(
		args.paths.map(async (requested, index) => {
			const path = localPath(requested, cwd);
			const source = args.files?.[index];
			if (!source) throw new Error("files and paths must correspond by index");
			try {
				const bytes = await importFile(
					path,
					source.download_url,
					args.overwrite === true,
					signal,
				);
				return { path, bytes };
			} catch (error) {
				return {
					path: requested,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}),
	);
	return transferResult({ device, files, resources: [] });
}

export const transfer = {
	name: "transfer",
	label: "transfer",
	description:
		"Import ChatGPT files with files, send local paths to a session with to, retrieve session files with from, or export local paths and images.",
	parameters,
	async execute(_id, args, signal, update, context) {
		return executeTransfer(args, signal, update, {
			sessionId: context.sessionManager.getSessionId(),
			cwd: context.cwd,
		});
	},
	renderCall(args, theme, context) {
		const device = context.state.device ?? hostname();
		const from = args.files
			? "ChatGPT"
			: args.from
				? (context.state.from ?? "Agent")
				: device;
		const to = args.files
			? device
			: args.from
				? device
				: (context.state.to ?? (args.to ? "Agent" : "ChatGPT"));
		const header =
			context.lastComponent instanceof Text
				? context.lastComponent
				: new Text("", 0, 0);
		header.setText(theme.fg("toolTitle", theme.bold(`${from} → ${to}`)));
		context.state.header = header;
		return header;
	},
	renderResult(result, _options, theme, context) {
		const details = result.details;
		if (!details) {
			const text = result.content
				.flatMap((block) => (block.type === "text" ? [block.text] : []))
				.join("\n");
			return new Text(
				theme.fg(context.isError ? "error" : "toolOutput", text),
				0,
				0,
			);
		}
		const args = context.args;
		context.state.device = details.device;
		context.state.to = details.to?.device ?? "ChatGPT";
		if (details.from) context.state.from = details.from.device;
		else delete context.state.from;
		const from = args.files
			? "ChatGPT"
			: args.from
				? (details.from?.device ?? "Agent")
				: details.device;
		const to = args.files
			? details.device
			: args.from
				? details.device
				: (details.to?.device ?? "ChatGPT");
		context.state.header?.setText(
			theme.fg("toolTitle", theme.bold(`${from} → ${to}`)),
		);
		const lines =
			details.resources.length > 0
				? details.resources.map((resource, index) => {
						const source = displayPath(args.paths?.[index] ?? resource.name);
						const destination = args.to?.paths[index];
						return `${destination ? `${source} → ${destination}` : source}  ${theme.fg("dim", formatSize(resource.size))}`;
					})
				: details.files.length > 0
					? details.files.map((file, index) => {
							const source = args.to
								? args.paths?.[index]
								: args.from
									? args.from.paths[index]
									: args.files?.[index]?.file_name;
							const path = source
								? `${displayPath(source)} → ${file.path}`
								: file.path;
							return "error" in file
								? theme.fg("error", `${path}\n${file.error}`)
								: `${path}  ${theme.fg("dim", formatSize(file.bytes))}`;
						})
					: (args.paths ?? []).map((path, index) =>
							args.to?.paths[index]
								? `${displayPath(path)} → ${args.to.paths[index]}`
								: displayPath(path),
						);
		return new Text(lines.join("\n"), 0, 0);
	},
} satisfies ToolDefinition<
	typeof parameters,
	TransferDetails,
	{ header?: Text; device?: string; to?: string; from?: string }
>;

function displayPath(path: string): string {
	return path.startsWith("chappie://")
		? decodeURIComponent(basename(new URL(path).pathname))
		: path;
}

export function transferResult(details: TransferDetails): TransferResult {
	const failed = details.files.some((file) => "error" in file);
	const result = { ...details, ...(failed ? { failed: true } : {}) };
	return {
		content: [{ type: "text", text: JSON.stringify(result) }],
		details: result,
		isError: failed,
	};
}

export async function copyFiles(
	paths: string[],
	resources: ResourceDescriptor[],
	cwd: string,
	overwrite: boolean,
	read: (resource: ResourceDescriptor) => AsyncIterable<Uint8Array>,
	signal: AbortSignal,
): Promise<TransferDetails["files"]> {
	if (paths.length !== resources.length)
		throw new Error("Source and destination counts must match");
	return Promise.all(
		paths.map(async (requested, index) => {
			const path = localPath(requested, cwd);
			try {
				const resource = resources[index];
				if (!resource) throw new Error("Missing source resource");
				const bytes = await importFile(
					path,
					read(resource),
					overwrite,
					signal,
					resource.size,
				);
				return { path, bytes };
			} catch (error) {
				return {
					path: requested,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}),
	);
}

function localPath(path: string, cwd: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) {
		return resolve(homedir(), path.slice(2));
	}
	return resolve(cwd, path);
}

async function importFile(
	path: string,
	source: string | AsyncIterable<Uint8Array>,
	overwrite: boolean,
	signal?: AbortSignal,
	expectedBytes?: number,
): Promise<number> {
	return withFileMutationQueue(path, async () => {
		signal?.throwIfAborted();
		await mkdir(dirname(path), { recursive: true });
		const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return undefined;
		});
		if (!overwrite && existing)
			throw new Error(`Destination already exists: ${path}`);
		await using temporary = await mkdtempDisposable(
			join(dirname(path), ".chappie-"),
		);
		const staged = join(temporary.path, "file");
		let readable: Readable;
		if (typeof source === "string") {
			const url = new URL(source);
			if (url.protocol !== "https:" && url.protocol !== "http:") {
				throw new Error("File downloads require an HTTP(S) URL from the host");
			}
			const response = await fetch(url, signal ? { signal } : {});
			if (!response.ok || !response.body) {
				await response.body?.cancel();
				throw new Error(`Download failed with HTTP ${response.status}`);
			}
			// Node fetch uses a native web stream; DOM and Node declarations differ.
			readable = Readable.fromWeb(
				response.body as unknown as NodeReadableStream<Uint8Array>,
			);
		} else {
			readable = Readable.from(source, { objectMode: false });
		}
		const writable = createWriteStream(staged, { flags: "wx", mode: 0o600 });
		if (signal) await pipeline(readable, writable, { signal });
		else await pipeline(readable, writable);
		const bytes = (await stat(staged)).size;
		if (expectedBytes !== undefined && bytes !== expectedBytes) {
			throw new Error(
				`Incomplete transfer: expected ${expectedBytes} bytes, received ${bytes}`,
			);
		}
		if (overwrite && existing?.isFile())
			await chmod(staged, existing.mode & 0o777);
		signal?.throwIfAborted();
		// link is an atomic no-clobber commit; rename replaces only after success.
		if (overwrite) await rename(staged, path);
		else await link(staged, path);
		return bytes;
	});
}
