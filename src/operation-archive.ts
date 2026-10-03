import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import {
	lstat,
	mkdir,
	readdir,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { operationReceiptSchema } from "./operation-schema.ts";
import type { OperationReceipt } from "./operations.ts";

const MAX_RECORD_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 131_072;
const archiveFile = /^(?:key|alias)-[a-f0-9]{64}\.json$/;

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function recoveryOperationId(
	receipt: Pick<OperationReceipt, "key" | "operationId">,
): string {
	return receipt.operationId ?? `receipt-${digest(receipt.key)}`;
}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * Cold, owner-checked replay protection. No response bodies or resident handles.
 * Queries read one bounded record; admission is serialized with atomic writes.
 * The broker is the only process writing its agent directory.
 */
export class OperationArchive {
	readonly #directory: string;
	#usage: { bytes: number; files: number; stamp: string } | undefined;
	constructor(agentDir: string) {
		this.#directory = join(agentDir, "chappie.uncertain");
	}

	#keyPath(key: string): string {
		return join(this.#directory, `key-${digest(key)}.json`);
	}
	#aliasPath(chatId: string, operationId: string): string {
		return join(
			this.#directory,
			`alias-${digest(JSON.stringify([chatId, operationId]))}.json`,
		);
	}
	#read(path: string, maxBytes = MAX_RECORD_BYTES): unknown {
		try {
			const info = lstatSync(path);
			if (!info.isFile() || info.size > maxBytes)
				throw new Error("Invalid archived operation file");
			return JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			if (missing(error)) return undefined;
			throw error;
		}
	}
	get(key: string): OperationReceipt | undefined {
		const value = this.#read(this.#keyPath(key));
		if (value === undefined) return undefined;
		const receipt = operationReceiptSchema.parse(value);
		if (receipt.key !== key)
			throw new Error("Archived operation identity changed");
		return receipt;
	}
	find(chatId: string, operationId: string): OperationReceipt | undefined {
		let receipt = this.get(operationId); // Old replay.id is also a recovery key.
		if (!receipt) {
			const value = this.#read(this.#aliasPath(chatId, operationId), 16 * 1024);
			if (value !== undefined) {
				if (
					typeof value !== "object" ||
					value === null ||
					!("key" in value) ||
					typeof value.key !== "string"
				)
					throw new Error("Invalid archived operation alias");
				receipt = this.get(value.key);
			}
		}
		if (
			!receipt ||
			receipt.chatId !== chatId ||
			(receipt.key !== operationId &&
				recoveryOperationId(receipt) !== operationId)
		)
			return undefined;
		return receipt;
	}

	async #stamp(): Promise<string> {
		const info = await lstat(this.#directory, { bigint: true });
		if (!info.isDirectory())
			throw new Error("Invalid operation archive directory");
		return `${info.ino}:${info.mtimeNs}:${info.ctimeNs}`;
	}
	async #refreshUsage(): Promise<void> {
		const stamp = await this.#stamp();
		if (this.#usage?.stamp === stamp) return;
		let bytes = 0,
			files = 0;
		for (const name of await readdir(this.#directory)) {
			if (!archiveFile.test(name)) continue;
			const info = await lstat(join(this.#directory, name));
			if (!info.isFile()) throw new Error("Invalid archived operation file");
			bytes += info.size;
			files++;
		}
		this.#usage = { bytes, files, stamp };
	}
	async #size(path: string): Promise<number | undefined> {
		try {
			const info = await lstat(path);
			if (!info.isFile()) throw new Error("Invalid archived operation file");
			return info.size;
		} catch (error) {
			if (missing(error)) return undefined;
			throw error;
		}
	}
	async #write(path: string, contents: string): Promise<void> {
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
			await rename(temporary, path);
		} finally {
			await unlink(temporary).catch((error: unknown) => {
				if (!missing(error)) throw error;
			});
		}
	}

	save(input: OperationReceipt): Promise<void> {
		return withFileMutationQueue(this.#directory, async () => {
			const receipt = operationReceiptSchema.parse({
				...input,
				operationId: recoveryOperationId(input),
			});
			const body = JSON.stringify(receipt);
			const alias = JSON.stringify({ key: receipt.key });
			if (
				Buffer.byteLength(body) > MAX_RECORD_BYTES ||
				Buffer.byteLength(alias) > 16 * 1024
			)
				throw new Error(
					"Operation archive record exceeds its byte limit; receipt remains live",
				);
			await mkdir(this.#directory, { recursive: true, mode: 0o700 });
			await this.#refreshUsage();
			const keyPath = this.#keyPath(receipt.key);
			const aliasPath = this.#aliasPath(
				receipt.chatId,
				recoveryOperationId(receipt),
			);
			const old = this.get(receipt.key);
			if (
				old &&
				(old.signature !== receipt.signature ||
					old.executionId !== receipt.executionId ||
					old.chatId !== receipt.chatId ||
					old.sessionId !== receipt.sessionId)
			)
				throw new Error("Archived acceptance cannot be replaced");
			const sizes = [await this.#size(keyPath), await this.#size(aliasPath)];
			const usage = this.#usage;
			if (!usage) throw new Error("Operation archive accounting unavailable");
			const bytes =
				usage.bytes -
				sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0) +
				Buffer.byteLength(body) +
				Buffer.byteLength(alias);
			const files =
				usage.files + sizes.filter((size) => size === undefined).length;
			if (bytes > MAX_ARCHIVE_BYTES || files > MAX_ARCHIVE_FILES)
				throw new Error(
					"Operation archive capacity reached; unresolved receipts remain live and must be reconciled",
				);
			try {
				await this.#write(keyPath, body);
				await this.#write(aliasPath, alias);
				this.#usage = { bytes, files, stamp: await this.#stamp() };
			} catch (error) {
				this.#usage = undefined;
				throw error;
			}
		});
	}

	/** Only after the identical acceptance and any late output are durable in hot state. */
	remove(receipt: OperationReceipt): Promise<void> {
		return withFileMutationQueue(this.#directory, async () => {
			const old = this.get(receipt.key);
			if (!old) return;
			if (
				old.executionId !== receipt.executionId ||
				old.signature !== receipt.signature
			)
				throw new Error("Archived acceptance changed during restoration");
			await unlink(this.#keyPath(receipt.key));
			await unlink(this.#aliasPath(old.chatId, recoveryOperationId(old))).catch(
				(error: unknown) => {
					if (!missing(error)) throw error;
				},
			);
			this.#usage = undefined;
		});
	}
}
