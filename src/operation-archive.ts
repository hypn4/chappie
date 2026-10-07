import { createHash } from "node:crypto";
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
import { uuidV7 } from "./ids.ts";
import { operationReceiptSchema } from "./operation-schema.ts";
import type { OperationReceipt } from "./operations.ts";

const MAX_RECORD_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 131_072;
export const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
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

function terminalExpiry(receipt: OperationReceipt): number | undefined {
	return receipt.status === "completed" ||
		receipt.status === "failed" ||
		receipt.status === "cancelled"
		? receipt.updatedAt + TERMINAL_RETENTION_MS
		: undefined;
}

/**
 * Cold, owner-checked replay protection. No response bodies or resident handles.
 * Queries read one bounded record; admission is serialized with atomic writes.
 * The broker is the only process writing its neutral storage directory.
 */
export class OperationArchive {
	readonly #directory: string;
	#usage:
		| { bytes: number; files: number; stamp: string; nextExpiry?: number }
		| undefined;
	constructor(storageDir: string) {
		this.#directory = join(storageDir, "chappie.uncertain");
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
	#stored(key: string): OperationReceipt | undefined {
		const value = this.#read(this.#keyPath(key));
		if (value === undefined) return undefined;
		const receipt = operationReceiptSchema.parse(value);
		if (receipt.key !== key)
			throw new Error("Archived operation identity changed");
		return receipt;
	}
	get(key: string): OperationReceipt | undefined {
		const receipt = this.#stored(key);
		if (!receipt) return undefined;
		const expiresAt = terminalExpiry(receipt);
		return expiresAt !== undefined && expiresAt < Date.now()
			? undefined
			: receipt;
	}
	#aliasKey(path: string): string | undefined {
		const value = this.#read(path, 16 * 1024);
		if (value === undefined) return undefined;
		if (
			typeof value !== "object" ||
			value === null ||
			!("key" in value) ||
			typeof value.key !== "string"
		)
			throw new Error("Invalid archived operation alias");
		return value.key;
	}
	find(chatId: string, operationId: string): OperationReceipt | undefined {
		const key = this.#aliasKey(this.#aliasPath(chatId, operationId));
		const receipt = key === undefined ? undefined : this.get(key);
		if (
			!receipt ||
			receipt.chatId !== chatId ||
			recoveryOperationId(receipt) !== operationId
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
	async #removeFiles(receipt: OperationReceipt): Promise<void> {
		// An alias can already point at a successor after an interrupted update.
		// Remove only this record's pointer, never another acceptance's alias.
		await unlink(this.#keyPath(receipt.key)).catch((error: unknown) => {
			if (!missing(error)) throw error;
		});
		const aliasPath = this.#aliasPath(
			receipt.chatId,
			recoveryOperationId(receipt),
		);
		if (this.#aliasKey(aliasPath) === receipt.key)
			await unlink(aliasPath).catch((error: unknown) => {
				if (!missing(error)) throw error;
			});
	}
	async #refreshUsage(now: number): Promise<void> {
		const stamp = await this.#stamp();
		if (
			this.#usage?.stamp === stamp &&
			(this.#usage.nextExpiry === undefined || this.#usage.nextExpiry >= now)
		)
			return;
		// All callers hold the directory mutation queue. A partial cleanup must
		// force the next admission to recount, including other store instances.
		this.#usage = undefined;
		const names = (await readdir(this.#directory)).filter((name) =>
			archiveFile.test(name),
		);
		let bytes = 0,
			files = 0;
		let nextExpiry: number | undefined;
		for (const name of names) {
			if (!name.startsWith("key-")) continue;
			const path = join(this.#directory, name);
			const receipt = operationReceiptSchema.parse(this.#read(path));
			if (this.#keyPath(receipt.key) !== path)
				throw new Error("Archived operation identity changed");
			const expiresAt = terminalExpiry(receipt);
			if (expiresAt !== undefined && expiresAt < now) {
				await this.#removeFiles(receipt);
				continue;
			}
			if (expiresAt !== undefined)
				nextExpiry = Math.min(nextExpiry ?? expiresAt, expiresAt);
			bytes += (await this.#size(path)) ?? 0;
			files++;
		}
		for (const name of names) {
			if (!name.startsWith("alias-")) continue;
			const path = join(this.#directory, name);
			const key = this.#aliasKey(path);
			if (key === undefined) continue;
			const receipt = this.#stored(key);
			if (
				!receipt ||
				this.#aliasPath(receipt.chatId, recoveryOperationId(receipt)) !== path
			) {
				// Finish alias cleanup if a previous process stopped after key removal.
				await unlink(path);
				continue;
			}
			bytes += (await this.#size(path)) ?? 0;
			files++;
		}
		this.#usage = {
			bytes,
			files,
			stamp: await this.#stamp(),
			...(nextExpiry !== undefined ? { nextExpiry } : {}),
		};
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
		const temporary = `${path}.${uuidV7()}.tmp`;
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
			const now = Date.now();
			await this.#refreshUsage(now);
			const keyPath = this.#keyPath(receipt.key);
			const aliasPath = this.#aliasPath(
				receipt.chatId,
				recoveryOperationId(receipt),
			);
			const old = this.#stored(receipt.key);
			if (
				old &&
				(old.signature !== receipt.signature ||
					old.executionId !== receipt.executionId ||
					old.chatId !== receipt.chatId ||
					old.sessionId !== receipt.sessionId ||
					recoveryOperationId(old) !== recoveryOperationId(receipt))
			)
				throw new Error("Archived acceptance cannot be replaced");
			const conflict = this.find(receipt.chatId, recoveryOperationId(receipt));
			if (conflict && conflict.key !== receipt.key)
				throw new Error(
					"Archived operation identifier already belongs to another acceptance",
				);
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
				const expiresAt = terminalExpiry(receipt);
				const nextExpiry =
					expiresAt === undefined
						? usage.nextExpiry
						: Math.min(usage.nextExpiry ?? expiresAt, expiresAt);
				this.#usage = {
					bytes,
					files,
					stamp: await this.#stamp(),
					...(nextExpiry !== undefined ? { nextExpiry } : {}),
				};
			} catch (error) {
				this.#usage = undefined;
				throw error;
			}
		});
	}

	/** Only after the identical acceptance and any late output are durable in hot state. */
	remove(receipt: OperationReceipt): Promise<void> {
		return withFileMutationQueue(this.#directory, async () => {
			const old = this.#stored(receipt.key);
			if (!old) return;
			if (
				old.executionId !== receipt.executionId ||
				old.signature !== receipt.signature ||
				old.chatId !== receipt.chatId ||
				old.sessionId !== receipt.sessionId
			)
				throw new Error("Archived acceptance changed during restoration");
			this.#usage = undefined;
			await this.#removeFiles(old);
		});
	}
}
