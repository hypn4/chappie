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

// Application byte budget, not a promise about a particular ChatGPT token limit.
export const MAX_RESULT_BYTES = 32 * 1024;
export const RESULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const MAX_STORE_BYTES = 256 * 1024 * 1024;
const MAX_SNAPSHOTS = 128;
const filePattern = /^[a-f0-9]{64}\.json$/;

interface Snapshot {
	chatId: string;
	text: string;
	createdAt: number;
}

/** Immutable response snapshots, independent of native execution and retries. */
export class ResponseStore {
	readonly #directory: string;
	#writes = Promise.resolve();
	constructor(agentDir: string) {
		this.#directory = join(agentDir, "chappie.results");
	}

	save(chatId: string, text: string): Promise<string> {
		const result = this.#writes.then(() => this.#save(chatId, text));
		this.#writes = result.then(
			() => {},
			() => {},
		);
		return result;
	}
	async read(chatId: string, id: string): Promise<string> {
		if (!/^[a-f0-9]{64}$/.test(id))
			throw new Error("Invalid result identifier");
		let record: Snapshot;
		try {
			const file = join(this.#directory, `${id}.json`);
			const info = await lstat(file);
			if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES)
				throw new Error("Invalid response snapshot");
			record = JSON.parse(await readFile(file, "utf8")) as Snapshot;
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
	#id(chatId: string, text: string): string {
		return createHash("sha256")
			.update(JSON.stringify([chatId, text]))
			.digest("hex");
	}
	async #save(chatId: string, text: string): Promise<string> {
		const id = this.#id(chatId, text);
		const contents = JSON.stringify({
			chatId,
			text,
			createdAt: Date.now(),
		} satisfies Snapshot);
		const bytes = Buffer.byteLength(contents);
		if (bytes > MAX_SNAPSHOT_BYTES)
			throw new Error(
				"Response snapshot exceeds the 128 MiB limit; pending data was not acknowledged",
			);
		await mkdir(this.#directory, { recursive: true, mode: 0o700 });
		let used = 0,
			count = 0;
		const cutoff = Date.now() - RESULT_RETENTION_MS;
		for (const name of await readdir(this.#directory)) {
			if (!filePattern.test(name)) continue;
			const file = join(this.#directory, name);
			const info = await lstat(file);
			if (!info.isFile()) throw new Error("Invalid response snapshot file");
			if (info.mtimeMs <= cutoff) {
				await unlink(file);
				continue;
			}
			if (name === `${id}.json`) {
				await this.read(chatId, id);
				return id;
			}
			used += info.size;
			count++;
		}
		if (count >= MAX_SNAPSHOTS || used + bytes > MAX_STORE_BYTES)
			throw new Error(
				"Response snapshot storage limit reached; pending data was not acknowledged",
			);
		const destination = join(this.#directory, `${id}.json`);
		const temporary = `${destination}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
			await rename(temporary, destination);
		} finally {
			await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
		return id;
	}
}
