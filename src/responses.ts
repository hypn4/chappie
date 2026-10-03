import { createHash, randomUUID } from "node:crypto";
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

// Application byte budget, not a promise about a particular ChatGPT token limit.
export const MAX_RESULT_BYTES = 32 * 1024;
export const RESULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;

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
}

/** Immutable response snapshots, independent of native execution and retries. */
export class ResponseStore {
	readonly #directory: string;
	readonly #limits: Readonly<ResponseLimits>;
	// Only small metadata is cached; response bodies are never pinned in memory.
	readonly #index = new Map<string, SnapshotIndex>();
	constructor(agentDir: string, limits: Partial<ResponseLimits> = {}) {
		this.#directory = join(agentDir, "chappie.results");
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

	save(chatId: string, text: string): Promise<string> {
		// Serialize admission as well as commit, including separate store instances.
		return withFileMutationQueue(this.#directory, () =>
			this.#save(chatId, text),
		);
	}
	async read(chatId: string, id: string): Promise<string> {
		if (!/^[a-f0-9]{64}$/.test(id))
			throw new Error("Invalid result identifier");
		let record: Snapshot;
		try {
			record = await this.#readRecord(id);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				throw new Error("Result not found or expired");
			throw error;
		}
		if (
			record.chatId !== chatId ||
			typeof record.text !== "string" ||
			!Number.isFinite(record.createdAt) ||
			record.createdAt <= Date.now() - RESULT_RETENTION_MS
		)
			throw new Error("Result not found or expired");
		if (this.#id(chatId, record.text) !== id)
			throw new Error("Response snapshot changed");
		return record.text;
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

	async #refreshIndex(now: number): Promise<void> {
		const names = new Set(
			(await readdir(this.#directory)).filter((name) => filePattern.test(name)),
		);
		for (const id of this.#index.keys()) {
			if (!names.has(`${id}.json`)) this.#index.delete(id);
		}
		for (const name of names) {
			const id = name.slice(0, -5);
			let entry = this.#index.get(id);
			if (!entry) {
				const record = await this.#readRecord(id);
				if (this.#id(record.chatId, record.text) !== id)
					throw new Error("Response snapshot changed");
				entry = {
					chatId: record.chatId,
					createdAt: record.createdAt,
					bytes: (await lstat(join(this.#directory, name))).size,
				};
			}
			if (entry.createdAt <= now - RESULT_RETENTION_MS) {
				await unlink(join(this.#directory, name));
				this.#index.delete(id);
			} else {
				this.#index.set(id, entry);
			}
		}
	}

	#checkCapacity(chatId: string, bytes: number): void {
		let used = 0,
			owned = 0,
			count = 0;
		for (const entry of this.#index.values()) {
			used += entry.bytes;
			if (entry.chatId === chatId) {
				owned += entry.bytes;
				count++;
			}
		}
		const scope =
			count >= this.#limits.maxConversationSnapshots ||
			owned + bytes > this.#limits.maxConversationBytes
				? "conversation"
				: this.#index.size >= this.#limits.maxSnapshots ||
						used + bytes > this.#limits.maxBytes
					? "broker"
					: undefined;
		if (scope)
			throw new Error(
				`Response snapshot ${scope} capacity reached (storage limit); existing result IDs remain readable. Native work may already have executed; do not replay it. Pending data was not acknowledged.`,
			);
	}
	#id(chatId: string, text: string): string {
		return createHash("sha256")
			.update(JSON.stringify([chatId, text]))
			.digest("hex");
	}
	async #save(chatId: string, text: string): Promise<string> {
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
			await this.read(chatId, id);
			return id;
		}
		this.#checkCapacity(chatId, bytes);
		const destination = join(this.#directory, `${id}.json`);
		const temporary = `${destination}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
			await rename(temporary, destination);
			this.#index.set(id, { chatId, createdAt, bytes });
		} finally {
			await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
		return id;
	}
}
