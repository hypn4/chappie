import { lookup } from "node:dns/promises";
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
import { BlockList, isIP } from "node:net";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import * as z from "zod";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import {
	describeResource,
	type ResourceDescriptor,
	registerFile,
} from "./resources.ts";

const MAX_HOST_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_TRANSFER_BATCH_BYTES = 2 * 1024 * 1024 * 1024;
const blockedHostAddressesV4 = new BlockList();
const blockedHostAddressesV6 = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const)
	blockedHostAddressesV4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
	["::", 128],
	["::1", 128],
	["::ffff:0:0", 96],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const)
	blockedHostAddressesV6.addSubnet(network, prefix, "ipv6");

async function assertSafeHostDownload(url: URL): Promise<void> {
	if (url.protocol !== "https:")
		throw new Error("Host file downloads require HTTPS");
	if (url.username || url.password)
		throw new Error("Host file download URLs cannot contain credentials");
	const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".internal") ||
		hostname.endsWith(".home.arpa")
	)
		throw new Error("Host file download URL cannot target a local address");
	const literalFamily = isIP(hostname);
	const addresses = literalFamily
		? [{ address: hostname, family: literalFamily }]
		: await lookup(hostname, { all: true, verbatim: true });
	if (
		addresses.length === 0 ||
		addresses.some(({ address, family }) =>
			family === 6
				? blockedHostAddressesV6.check(address, "ipv6")
				: blockedHostAddressesV4.check(address, "ipv4"),
		)
	)
		throw new Error("Host file download URL cannot target a local address");
}

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

export const operationIdSchema = z.string().trim().min(1).max(128);
export const transferFile = z.strictObject({
	file_id: z.string(),
	download_url: z.url(),
	file_name: z.string().optional(),
	mime_type: z.string().optional(),
});
const sessionPathsSchema = z.strictObject({
	sessionId: z.string().min(1),
	paths: z.array(z.string()).min(1).max(128),
});
/** One schema is used for both native OMP execution and the MCP boundary. */
export const transferSchema = z.strictObject({
	operationId: operationIdSchema
		.optional()
		.describe("Stable transfer ID; reuse for the same intent only."),
	paths: z
		.array(z.string())
		.min(1)
		.max(128)
		.describe("Source or destination paths paired in order"),
	files: z
		.array(transferFile)
		.min(1)
		.max(128)
		.optional()
		.describe("Host-injected files; not model-authored download URLs"),
	from: sessionPathsSchema.optional(),
	to: sessionPathsSchema.optional(),
	overwrite: z.boolean().optional(),
});
export type TransferArgs = z.infer<typeof transferSchema>;

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
	const files: TransferDetails["files"] = [];
	const budget = { remaining: MAX_TRANSFER_BATCH_BYTES };
	for (const [index, requested] of args.paths.entries()) {
		const path = localPath(requested, cwd);
		const source = args.files[index];
		if (!source) throw new Error("files and paths must correspond by index");
		try {
			if (budget.remaining <= 0)
				throw new Error("Host file batch exceeds the 2 GiB size limit");
			const bytes = await importFile(
				path,
				source.download_url,
				args.overwrite === true,
				signal,
				undefined,
				Math.min(MAX_HOST_DOWNLOAD_BYTES, budget.remaining),
				budget,
			);
			files.push({ path, bytes });
		} catch (error) {
			files.push({
				path: requested,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return transferResult({ device, files, resources: [] });
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
	const totalBytes = resources.reduce(
		(total, resource) => total + resource.size,
		0,
	);
	if (
		!Number.isSafeInteger(totalBytes) ||
		totalBytes > MAX_TRANSFER_BATCH_BYTES
	)
		throw new Error("Session copy exceeds the 2 GiB size limit");
	const files: TransferDetails["files"] = [];
	for (const [index, requested] of paths.entries()) {
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
			files.push({ path, bytes });
		} catch (error) {
			files.push({
				path: requested,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return files;
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
	maxHostBytes = MAX_HOST_DOWNLOAD_BYTES,
	budget?: { remaining: number },
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
			await assertSafeHostDownload(url);
			const response = await fetch(url, {
				...(signal ? { signal } : {}),
				redirect: "error",
			});
			if (!response.ok || !response.body) {
				await response.body?.cancel();
				throw new Error(`Download failed with HTTP ${response.status}`);
			}
			const declared = Number(response.headers.get("content-length"));
			if (Number.isFinite(declared) && declared > maxHostBytes) {
				await response.body.cancel();
				throw new Error("Host file exceeds the transfer size limit");
			}
			const sourceStream = Readable.fromWeb(
				response.body as unknown as NodeReadableStream<Uint8Array>,
			);
			readable = Readable.from(
				(async function* () {
					let received = 0;
					for await (const chunk of sourceStream) {
						const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
						received += bytes.length;
						if (budget) {
							if (bytes.length > budget.remaining) {
								budget.remaining = 0;
								throw new Error("Host file batch exceeds the 2 GiB size limit");
							}
							budget.remaining -= bytes.length;
						}
						if (received > maxHostBytes)
							throw new Error("Host file exceeds the transfer size limit");
						yield bytes;
					}
				})(),
				{ objectMode: false },
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
