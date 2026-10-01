import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import mime from "mime";

export interface ResourceDescriptor {
	uri: string;
	name: string;
	mimeType: string;
	size: number;
}

export interface ResourceData extends ResourceDescriptor {
	blob: string;
}

type ResourceEntry =
	| {
			type: "file";
			path: string;
			fingerprint: string;
			descriptor: ResourceDescriptor;
	  }
	| { type: "image"; data: string; descriptor: ResourceDescriptor };

const MAX_FULL_RESOURCE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_RESOURCE_ENTRIES = 512;
const RESOURCE_TTL_MS = 60 * 60 * 1000;
const stores = new Map<
	string,
	ResourceEntry & { sessionId: string; expires: number }
>();

export async function registerFile(
	sessionId: string,
	path: string,
): Promise<ResourceDescriptor> {
	const info = await stat(path, { bigint: true });
	if (!info.isFile()) throw new Error(`${path} is not a file`);
	if (info.size > BigInt(Number.MAX_SAFE_INTEGER))
		throw new Error("File size exceeds the supported limit");
	const name = basename(path);
	const descriptor = resourceDescriptor(
		sessionId,
		"file",
		randomUUID(),
		name,
		mime.getType(path) ?? "application/octet-stream",
		Number(info.size),
	);
	saveResource(sessionId, {
		type: "file",
		path,
		fingerprint: fingerprint(info),
		descriptor,
	});
	return descriptor;
}

export function rememberImages(
	sessionId: string,
	content: readonly (TextContent | ImageContent)[],
): void {
	for (const block of content) {
		if (block.type !== "image") continue;
		const descriptor = imageDescriptor(sessionId, block);
		saveResource(sessionId, {
			type: "image",
			data: block.data,
			descriptor,
		});
	}
}

export function imageDescriptor(
	sessionId: string,
	image: ImageContent,
): ResourceDescriptor {
	const digest = createHash("sha256")
		.update(image.data, "base64")
		.digest("hex");
	const extension = mime.getExtension(image.mimeType) ?? "bin";
	return resourceDescriptor(
		sessionId,
		"image",
		digest,
		`image.${extension}`,
		image.mimeType,
		Buffer.byteLength(image.data, "base64"),
	);
}

export function contentWithImageReferences(
	sessionId: string,
	content: readonly (TextContent | ImageContent)[],
): (TextContent | ImageContent)[] {
	return content.flatMap((block) =>
		block.type === "image"
			? [
					block,
					{
						type: "text" as const,
						text: JSON.stringify({
							piImage: imageDescriptor(sessionId, block).uri,
						}),
					},
				]
			: [block],
	);
}

export function resourceDescriptors(details: unknown): ResourceDescriptor[] {
	if (!details || typeof details !== "object") return [];
	const resources = (details as { resources?: unknown }).resources;
	if (!Array.isArray(resources)) return [];
	return resources.filter((resource): resource is ResourceDescriptor => {
		if (!resource || typeof resource !== "object") return false;
		const value = resource as Partial<ResourceDescriptor>;
		return (
			typeof value.uri === "string" &&
			typeof value.name === "string" &&
			typeof value.mimeType === "string" &&
			typeof value.size === "number"
		);
	});
}

export function describeResource(
	sessionId: string,
	uri: string,
): ResourceDescriptor {
	const parsed = parseResourceUri(uri);
	if (parsed.sessionId !== sessionId) {
		throw new Error("The resource belongs to another Pi session");
	}
	const entry = getResource(canonicalResourceUri(uri));
	if (!entry) throw new Error(`Unknown Chappie resource: ${uri}`);
	return entry.descriptor;
}

export async function readSessionResource(
	sessionId: string,
	uri: string,
	offset?: number,
): Promise<ResourceData> {
	const descriptor = describeResource(sessionId, uri);
	const entry = getResource(canonicalResourceUri(uri));
	if (!entry) throw new Error(`Unknown Chappie resource: ${uri}`);
	if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0))
		throw new Error("Resource offset must be a nonnegative integer");
	if (offset === undefined && descriptor.size > MAX_FULL_RESOURCE_BYTES)
		throw new Error(
			"Resource too large for a full read (32 MiB limit); use a session copy or a smaller export",
		);
	const start = offset ?? 0;
	const length =
		offset === undefined
			? descriptor.size
			: Math.min(1024 * 1024, Math.max(0, descriptor.size - start));
	let data: Buffer;
	if (entry.type === "file") {
		await using file = await open(entry.path, "r");
		const assertUnchanged = async () => {
			if (fingerprint(await file.stat({ bigint: true })) !== entry.fingerprint)
				throw new Error("Exported file changed; request a new export");
		};
		await assertUnchanged();
		data = Buffer.alloc(length);
		let read = 0;
		while (read < length) {
			const { bytesRead } = await file.read(
				data,
				read,
				length - read,
				start + read,
			);
			if (bytesRead === 0)
				throw new Error("Exported file changed during transfer");
			read += bytesRead;
		}
		await assertUnchanged();
	} else {
		data = Buffer.from(entry.data, "base64").subarray(start, start + length);
	}
	return { ...descriptor, blob: data.toString("base64") };
}

function fingerprint(info: BigIntStats): string {
	return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

export function canonicalResourceUri(uri: string): string {
	const { sessionId, kind, id, name } = parseResourceUri(uri);
	return `chappie://session/${encodeURIComponent(sessionId)}/${kind}/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;
}

export function resourceSessionId(uri: string): string {
	return parseResourceUri(uri).sessionId;
}

function expireResources(): void {
	const now = Date.now();
	for (const [uri, entry] of stores) {
		if (entry.expires <= now) stores.delete(uri);
	}
}

function getResource(uri: string): ResourceEntry | undefined {
	expireResources();
	const entry = stores.get(uri);
	if (entry) {
		stores.delete(uri);
		entry.expires = Date.now() + RESOURCE_TTL_MS;
		stores.set(uri, entry);
	}
	return entry;
}

function saveResource(sessionId: string, entry: ResourceEntry): void {
	expireResources();
	const bytes = entry.type === "image" ? entry.descriptor.size : 0;
	if (bytes > MAX_FULL_RESOURCE_BYTES)
		throw new Error("Image exceeds the 32 MiB resource limit");
	stores.delete(entry.descriptor.uri);
	let retained = [...stores.values()].reduce(
		(total, value) =>
			total + (value.type === "image" ? value.descriptor.size : 0),
		0,
	);
	for (const [uri, value] of stores) {
		if (
			stores.size < MAX_RESOURCE_ENTRIES &&
			retained + bytes <= MAX_IMAGE_CACHE_BYTES
		)
			break;
		stores.delete(uri);
		if (value.type === "image") retained -= value.descriptor.size;
	}
	stores.set(entry.descriptor.uri, {
		...entry,
		sessionId,
		expires: Date.now() + RESOURCE_TTL_MS,
	});
}

export function releaseSessionResources(sessionId: string): void {
	for (const [uri, entry] of stores) {
		if (entry.sessionId === sessionId) stores.delete(uri);
	}
}

function resourceDescriptor(
	sessionId: string,
	kind: "file" | "image",
	id: string,
	name: string,
	mimeType: string,
	size: number,
): ResourceDescriptor {
	return {
		uri: `chappie://session/${encodeURIComponent(sessionId)}/${kind}/${encodeURIComponent(id)}/${encodeURIComponent(name)}`,
		name,
		mimeType,
		size,
	};
}

function parseResourceUri(uri: string): {
	sessionId: string;
	kind: string;
	id: string;
	name: string;
} {
	const parsed = new URL(uri);
	if (parsed.protocol !== "chappie:" || parsed.hostname !== "session") {
		throw new Error(`Unsupported Chappie resource: ${uri}`);
	}
	const parts = parsed.pathname
		.slice(1)
		.split("/")
		.map((part) => decodeURIComponent(part));
	if (parts.length !== 4 || !parts.every(Boolean)) {
		throw new Error(`Invalid Chappie resource: ${uri}`);
	}
	const [sessionId, kind, id, name] = parts;
	if (!sessionId || (kind !== "file" && kind !== "image") || !id || !name) {
		throw new Error(`Invalid Chappie resource: ${uri}`);
	}
	return { sessionId, kind, id, name };
}
