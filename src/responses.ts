import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { uuidV7 } from "./ids.ts";

// Application byte budget, not a promise about a particular ChatGPT token limit.
export const MAX_RESULT_BYTES = 32 * 1024;
export const RESULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_PINS = 4096;

export interface ResponseLimits {
	maxBytes: number;
	maxConversationBytes: number;
	maxSnapshots: number;
	maxConversationSnapshots: number;
	maxSnapshotBytes: number;
}

const defaultLimits: Readonly<ResponseLimits> = {
	maxBytes: 256 * 1024 * 1024,
	maxConversationBytes: 128 * 1024 * 1024,
	maxSnapshots: 4096,
	maxConversationSnapshots: 2048,
	maxSnapshotBytes: MAX_SNAPSHOT_BYTES,
};
const filePattern = /^[a-f0-9]{64}\.json$/;

interface Snapshot {
	chatId: string;
	text: string;
	createdAt: number;
}

interface SnapshotIndex {
	chatId: string;
	createdAt: number;
	bytes: number;
	length: number;
	stamp: string;
	metadata: SnapshotMetadata;
	metadataStamp?: string;
}

interface SnapshotMetadata {
	pins: string[];
	readAt?: number;
	readThrough?: number;
}

function stamp(info: BigIntStats): string {
	return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function validateId(id: string): void {
	if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid result identifier");
}

function validatePin(pin: string): void {
	if (typeof pin !== "string" || !pin || pin.length > 4096)
		throw new Error("Invalid response snapshot pin");
}

/** Immutable bodies with separate delivery confirmation and pending references. */
export class ResponseStore {
	readonly #directory: string;
	readonly #limits: Readonly<ResponseLimits>;
	// Only small metadata is cached; response bodies are never pinned in memory.
	readonly #index = new Map<string, SnapshotIndex>();
	constructor(storageDir: string, limits: Partial<ResponseLimits> = {}) {
		this.#directory = join(storageDir, "chappie.results");
		this.#limits = { ...defaultLimits, ...limits };
		if (
			Object.values(this.#limits).some(
				(value) => !Number.isSafeInteger(value) || value <= 0,
			) ||
			this.#limits.maxConversationBytes > this.#limits.maxBytes ||
			this.#limits.maxConversationSnapshots > this.#limits.maxSnapshots ||
			this.#limits.maxSnapshotBytes > MAX_SNAPSHOT_BYTES
		)
			throw new Error("Invalid response storage limits");
	}

	save(
		chatId: string,
		text: string,
		options: { pin?: string } = {},
	): Promise<string> {
		// Serialize admission as well as commit, including separate store instances.
		return withFileMutationQueue(this.#directory, () =>
			this.#save(chatId, text, options),
		);
	}
	read(chatId: string, id: string): Promise<string> {
		return withFileMutationQueue(this.#directory, async () => {
			const entry = await this.#ownedEntry(chatId, id);
			if (!entry || this.#expired(entry))
				throw new Error("Result not found or expired");
			const record = await this.#readRecord(id);
			if (record.chatId !== chatId || this.#id(chatId, record.text) !== id)
				throw new Error("Response snapshot changed");
			// Reading a page is not confirmation that the response was transmitted.
			return record.text;
		});
	}

	/** Inspect protection only; false is not evidence that a body was consumed. */
	isUnread(chatId: string, id: string): Promise<boolean> {
		return withFileMutationQueue(this.#directory, async () => {
			const entry = await this.#ownedEntry(chatId, id);
			return Boolean(
				entry &&
					!this.#expired(entry) &&
					entry.metadata.pins.includes("unread"),
			);
		});
	}

	pin(chatId: string, id: string, pinKey: string): Promise<void> {
		return withFileMutationQueue(this.#directory, () =>
			this.#pin(chatId, id, pinKey),
		);
	}

	unpin(chatId: string, id: string, pinKey: string): Promise<void> {
		return withFileMutationQueue(this.#directory, async () => {
			validatePin(pinKey);
			const entry = await this.#ownedEntry(chatId, id);
			if (!entry?.metadata.pins.includes(pinKey)) return;
			await this.#writeMetadata(id, entry, {
				...entry.metadata,
				pins: entry.metadata.pins.filter((pin) => pin !== pinKey),
			});
		});
	}

	/** Called only after the original body, or every continuation page, was sent. */
	markRead(chatId: string, id: string): Promise<void> {
		return withFileMutationQueue(this.#directory, async () => {
			const entry = await this.#ownedEntry(chatId, id);
			if (!entry || entry.metadata.readAt !== undefined) return;
			await this.#writeMetadata(id, entry, {
				...entry.metadata,
				readAt: Date.now(),
			});
		});
	}

	/** Startup recovery only, after authoritative pending state was validated. */
	reconcileDeliveryPins(
		live: readonly { chatId: string; resultId: string; pin: string }[],
	): Promise<void> {
		return withFileMutationQueue(this.#directory, async () => {
			const expected = new Map<string, Set<string>>();
			for (const reference of live) {
				validateId(reference.resultId);
				validatePin(reference.pin);
				if (!reference.pin.startsWith("delivery:"))
					throw new Error("Delivery reconciliation requires a delivery pin");
				const entry = await this.#ownedEntry(
					reference.chatId,
					reference.resultId,
				);
				if (!entry) throw new Error("Pending response snapshot is missing");
				const pins = expected.get(reference.resultId) ?? new Set<string>();
				pins.add(reference.pin);
				expected.set(reference.resultId, pins);
			}
			let names: string[];
			try {
				names = await readdir(this.#directory);
			} catch (error) {
				if (missing(error) && live.length === 0) return;
				throw error;
			}
			for (const name of names) {
				if (!filePattern.test(name)) continue;
				const id = name.slice(0, -5);
				const entry = await this.#entry(id);
				await this.#readMetadata(id, entry);
				const pins = [
					...entry.metadata.pins.filter((pin) => !pin.startsWith("delivery:")),
					...(expected.get(id) ?? []),
				];
				if (
					pins.length === entry.metadata.pins.length &&
					pins.every((pin) => entry.metadata.pins.includes(pin))
				)
					continue;
				await this.#writeMetadata(id, entry, { ...entry.metadata, pins });
			}
		});
	}

	/** Track only contiguous pages whose response writes actually completed. */
	recordRead(
		chatId: string,
		id: string,
		offset: number,
		nextOffset: number,
		total: number,
		options: { preserveUnreadPin?: boolean } = {},
	): Promise<boolean> {
		return withFileMutationQueue(this.#directory, async () => {
			if (
				![offset, nextOffset, total].every(Number.isSafeInteger) ||
				offset < 0 ||
				nextOffset < offset ||
				nextOffset > total
			)
				throw new Error("Invalid response snapshot read range");
			const entry = await this.#ownedEntry(chatId, id);
			if (!entry || this.#expired(entry))
				throw new Error("Result not found or expired");
			if (total !== entry.length)
				throw new Error(
					"Response snapshot read length does not match its body",
				);
			const previous = entry.metadata.readThrough ?? 0;
			if (offset > previous) return false;
			const through = Math.max(previous, nextOffset);
			const complete = through === total;
			const metadata: SnapshotMetadata = {
				...entry.metadata,
				readThrough: through,
				...(complete
					? {
							readAt: entry.metadata.readAt ?? Date.now(),
							pins: options.preserveUnreadPin
								? entry.metadata.pins
								: entry.metadata.pins.filter((pin) => pin !== "unread"),
						}
					: {}),
			};
			if (
				through !== previous ||
				(complete &&
					(entry.metadata.readAt === undefined ||
						(!options.preserveUnreadPin &&
							entry.metadata.pins.includes("unread"))))
			)
				await this.#writeMetadata(id, entry, metadata);
			return complete;
		});
	}

	async #pin(chatId: string, id: string, pinKey: string): Promise<void> {
		validatePin(pinKey);
		const entry = await this.#ownedEntry(chatId, id);
		if (!entry || this.#expired(entry))
			throw new Error("Result not found or expired");
		if (entry.metadata.pins.includes(pinKey)) return;
		await this.#writeMetadata(id, entry, {
			...entry.metadata,
			pins: [...entry.metadata.pins, pinKey],
		});
	}

	#expired(entry: SnapshotIndex, now = Date.now()): boolean {
		return (
			entry.metadata.pins.length === 0 &&
			entry.createdAt <= now - RESULT_RETENTION_MS
		);
	}

	async #ownedEntry(
		chatId: string,
		id: string,
	): Promise<SnapshotIndex | undefined> {
		validateId(id);
		let entry: SnapshotIndex;
		try {
			entry = await this.#entry(id);
		} catch (error) {
			if (missing(error)) {
				this.#index.delete(id);
				return undefined;
			}
			throw error;
		}
		if (entry.chatId !== chatId) throw new Error("Result not found or expired");
		await this.#readMetadata(id, entry);
		return entry;
	}
	async #readRecord(id: string): Promise<Snapshot> {
		const file = join(this.#directory, `${id}.json`);
		const info = await lstat(file);
		if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES)
			throw new Error("Invalid response snapshot");
		const record: unknown = JSON.parse(await readFile(file, "utf8"));
		if (
			typeof record !== "object" ||
			record === null ||
			!("chatId" in record) ||
			typeof record.chatId !== "string" ||
			!("text" in record) ||
			typeof record.text !== "string" ||
			!("createdAt" in record) ||
			typeof record.createdAt !== "number" ||
			!Number.isFinite(record.createdAt) ||
			record.createdAt < 0
		)
			throw new Error("Invalid response snapshot");
		return record as Snapshot;
	}

	async #entry(id: string): Promise<SnapshotIndex> {
		const info = await lstat(join(this.#directory, `${id}.json`), {
			bigint: true,
		});
		if (!info.isFile() || info.size > BigInt(MAX_SNAPSHOT_BYTES))
			throw new Error("Invalid response snapshot");
		const currentStamp = stamp(info);
		let entry = this.#index.get(id);
		if (!entry || entry.stamp !== currentStamp) {
			const record = await this.#readRecord(id);
			if (this.#id(record.chatId, record.text) !== id)
				throw new Error("Response snapshot changed");
			entry = {
				chatId: record.chatId,
				createdAt: record.createdAt,
				bytes: Number(info.size),
				length: record.text.length,
				stamp: currentStamp,
				metadata: { pins: [] },
			};
			this.#index.set(id, entry);
		}
		return entry;
	}

	async #readMetadata(id: string, entry: SnapshotIndex): Promise<void> {
		const file = join(this.#directory, `${id}.meta.json`);
		let info: BigIntStats;
		try {
			info = await lstat(file, { bigint: true });
		} catch (error) {
			if (!missing(error)) throw error;
			entry.metadata = { pins: [] };
			delete entry.metadataStamp;
			return;
		}
		if (!info.isFile() || info.size > BigInt(MAX_METADATA_BYTES))
			throw new Error("Invalid response snapshot metadata");
		const currentStamp = stamp(info);
		if (entry.metadataStamp === currentStamp) return;
		const value: unknown = JSON.parse(await readFile(file, "utf8"));
		if (
			typeof value !== "object" ||
			value === null ||
			!("version" in value) ||
			value.version !== 1 ||
			!("pins" in value) ||
			!Array.isArray(value.pins) ||
			value.pins.length > MAX_PINS ||
			value.pins.some(
				(pin: unknown) => typeof pin !== "string" || !pin || pin.length > 4096,
			) ||
			("readAt" in value &&
				(typeof value.readAt !== "number" ||
					!Number.isFinite(value.readAt) ||
					value.readAt < 0)) ||
			("readThrough" in value &&
				(typeof value.readThrough !== "number" ||
					!Number.isSafeInteger(value.readThrough) ||
					value.readThrough < 0 ||
					value.readThrough > entry.length))
		)
			throw new Error("Invalid response snapshot metadata");
		entry.metadata = {
			pins: [...new Set(value.pins as string[])],
			...("readAt" in value ? { readAt: value.readAt as number } : {}),
			...("readThrough" in value
				? { readThrough: value.readThrough as number }
				: {}),
		};
		entry.metadataStamp = currentStamp;
	}

	async #atomicWrite(destination: string, contents: string): Promise<void> {
		const temporary = `${destination}.${uuidV7()}.tmp`;
		try {
			await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
			await rename(temporary, destination);
		} finally {
			await unlink(temporary).catch((error: unknown) => {
				if (!missing(error)) throw error;
			});
		}
	}

	async #writeMetadata(
		id: string,
		entry: SnapshotIndex | undefined,
		metadata: SnapshotMetadata,
	): Promise<void> {
		const contents = JSON.stringify({ version: 1, ...metadata });
		if (
			metadata.pins.length > MAX_PINS ||
			Buffer.byteLength(contents) > MAX_METADATA_BYTES
		)
			throw new Error("Response snapshot metadata exceeds its storage limit");
		const file = join(this.#directory, `${id}.meta.json`);
		await this.#atomicWrite(file, contents);
		if (entry) {
			entry.metadata = metadata;
			entry.metadataStamp = stamp(await lstat(file, { bigint: true }));
		}
	}

	async #removeMetadata(id: string): Promise<void> {
		await unlink(join(this.#directory, `${id}.meta.json`)).catch(
			(error: unknown) => {
				if (!missing(error)) throw error;
			},
		);
	}

	async #removeSnapshot(id: string): Promise<void> {
		await unlink(join(this.#directory, `${id}.json`));
		this.#index.delete(id);
		await this.#removeMetadata(id);
	}

	async #refreshIndex(now: number): Promise<void> {
		const names = new Set(await readdir(this.#directory));
		for (const id of this.#index.keys()) {
			if (!names.has(`${id}.json`)) this.#index.delete(id);
		}
		for (const name of names) {
			if (!filePattern.test(name)) continue;
			const id = name.slice(0, -5);
			const entry = await this.#entry(id);
			if (names.has(`${id}.meta.json`)) {
				await this.#readMetadata(id, entry);
			} else {
				entry.metadata = { pins: [] };
				delete entry.metadataStamp;
			}
			if (this.#expired(entry, now)) await this.#removeSnapshot(id);
		}
	}

	#reclamationPlan(chatId: string, bytes: number): string[] {
		let used = 0,
			owned = 0,
			count = 0,
			total = this.#index.size;
		for (const entry of this.#index.values()) {
			used += entry.bytes;
			if (entry.chatId === chatId) {
				owned += entry.bytes;
				count++;
			}
		}
		const ownerFull = () =>
			count + 1 > this.#limits.maxConversationSnapshots ||
			owned + bytes > this.#limits.maxConversationBytes;
		const brokerFull = () =>
			total + 1 > this.#limits.maxSnapshots ||
			used + bytes > this.#limits.maxBytes;
		const candidates = [...this.#index]
			.filter(
				([, entry]) =>
					entry.metadata.pins.length === 0 &&
					entry.metadata.readAt !== undefined,
			)
			.sort(
				([leftId, left], [rightId, right]) =>
					left.createdAt - right.createdAt || leftId.localeCompare(rightId),
			);
		const selected = new Set<string>();
		const reclaim = (id: string, entry: SnapshotIndex) => {
			selected.add(id);
			used -= entry.bytes;
			total--;
			if (entry.chatId === chatId) {
				owned -= entry.bytes;
				count--;
			}
		};
		// Satisfy the caller's own budget before considering another owner's cache.
		for (const [id, entry] of candidates) {
			if (!ownerFull()) break;
			if (entry.chatId === chatId) reclaim(id, entry);
		}
		for (const [id, entry] of candidates) {
			if (!brokerFull()) break;
			if (!selected.has(id)) reclaim(id, entry);
		}
		const scope = ownerFull()
			? "conversation"
			: brokerFull()
				? "broker"
				: undefined;
		if (scope) {
			// Planning is read-only: an insufficient candidate set must delete nothing.
			throw new Error(
				`Response snapshot ${scope} capacity reached (storage limit); existing result IDs remain readable. Native work may already have executed; do not replay it. Pending data was not acknowledged.`,
			);
		}
		return [...selected];
	}
	#id(chatId: string, text: string): string {
		return createHash("sha256")
			.update(JSON.stringify([chatId, text]))
			.digest("hex");
	}
	async #save(
		chatId: string,
		text: string,
		options: { pin?: string },
	): Promise<string> {
		if (options.pin !== undefined) validatePin(options.pin);
		const id = this.#id(chatId, text);
		const createdAt = Date.now();
		const contents = JSON.stringify({
			chatId,
			text,
			createdAt,
		} satisfies Snapshot);
		const bytes = Buffer.byteLength(contents);
		if (bytes > this.#limits.maxSnapshotBytes)
			throw new Error(
				"Response snapshot exceeds its byte limit; native work may already have executed; pending data was not acknowledged",
			);
		await mkdir(this.#directory, { recursive: true, mode: 0o700 });
		await this.#refreshIndex(createdAt);
		if (this.#index.has(id)) {
			if (options.pin !== undefined) await this.#pin(chatId, id, options.pin);
			return id;
		}
		const reclaimed = this.#reclamationPlan(chatId, bytes);
		const destination = join(this.#directory, `${id}.json`);
		const metadata: SnapshotMetadata = {
			pins: options.pin === undefined ? [] : [options.pin],
		};
		// Publish protection before the body. A failed body write leaves no readable
		// unprotected result, and does not discard any confirmed cache candidates.
		if (options.pin !== undefined)
			await this.#writeMetadata(id, undefined, metadata);
		else await this.#removeMetadata(id);
		try {
			await this.#atomicWrite(destination, contents);
		} catch (error) {
			await this.#removeMetadata(id);
			throw error;
		}
		this.#index.set(id, {
			chatId,
			createdAt,
			bytes,
			length: text.length,
			stamp: stamp(await lstat(destination, { bigint: true })),
			metadata,
		});
		// Admission is already checked for the complete plan. Commit the replacement
		// before deleting confirmed bodies so a failed new write preserves the cache.
		for (const candidate of reclaimed) await this.#removeSnapshot(candidate);
		return id;
	}
}
