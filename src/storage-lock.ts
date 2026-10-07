import {
	lstat,
	mkdir,
	open,
	readdir,
	rename,
	rm,
	rmdir,
	unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { uuidV7 } from "./ids.ts";

const MAX_OWNER_BYTES = 4096;

const ownerSchema = z.strictObject({
	pid: z.number().int().positive(),
	hostname: z.string().min(1),
	token: z.uuid(),
	createdAt: z.number().int().nonnegative(),
});
type StorageOwner = z.infer<typeof ownerSchema>;

export class StorageLockedError extends Error {
	constructor(
		readonly path: string,
		detail: string,
		readonly owner?: StorageOwner,
	) {
		super(`Storage writer lock at ${path}: ${detail}`);
		this.name = "StorageLockedError";
	}
}

function code(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

function ownerFile(owner: StorageOwner): string {
	return `owner-${owner.token}.json`;
}

async function readMetadata(path: string, name: string): Promise<unknown> {
	const filePath = join(path, name);
	if (!(await lstat(filePath)).isFile()) {
		throw new StorageLockedError(path, "owner metadata is not a regular file");
	}
	const file = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(MAX_OWNER_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await file.read(
				buffer,
				length,
				buffer.length - length,
				length,
			);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > MAX_OWNER_BYTES) {
			throw new StorageLockedError(path, "owner metadata exceeds 4 KiB");
		}
		return JSON.parse(buffer.toString("utf8", 0, length));
	} finally {
		await file.close();
	}
}

/** Missing and empty locks can be concurrent releases; unknown owners stay locked. */
async function readOwner(
	path: string,
): Promise<StorageOwner | null | undefined> {
	try {
		if (!(await lstat(path)).isDirectory()) {
			throw new StorageLockedError(path, "not a lock directory");
		}
		const entries = await readdir(path);
		if (!entries.length) return null;
		const entry = entries[0];
		if (entries.length !== 1 || !entry?.startsWith("owner-")) {
			throw new StorageLockedError(path, "owner metadata is not recognized");
		}
		const parsed = ownerSchema.safeParse(await readMetadata(path, entry));
		if (!parsed.success || ownerFile(parsed.data) !== entry) {
			throw new StorageLockedError(path, "owner metadata is not valid");
		}
		return parsed.data;
	} catch (error) {
		if (code(error) === "ENOENT") return undefined;
		if (error instanceof StorageLockedError) throw error;
		throw new StorageLockedError(path, "owner metadata could not be verified");
	}
}

async function removeEmpty(path: string): Promise<void> {
	try {
		await rmdir(path);
	} catch (error) {
		// A successor may already have published its nonempty lock directory.
		if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(code(error) ?? ""))
			throw error;
	}
}

async function removeOwner(path: string, owner: StorageOwner): Promise<void> {
	try {
		// Never unlink a generic owner file: a concurrent recovery could replace it.
		await unlink(join(path, ownerFile(owner)));
	} catch (error) {
		if (code(error) !== "ENOENT") throw error;
	}
	await removeEmpty(path);
}

/** One live process owns a store until release; no age or heartbeat can steal it. */
export class StorageLock {
	#release: Promise<void> | undefined;

	private constructor(
		readonly path: string,
		private readonly owner: StorageOwner,
	) {}

	static async acquire(directory: string): Promise<StorageLock> {
		const root = resolve(directory);
		await mkdir(root, { recursive: true, mode: 0o700 });
		const path = join(root, "writer.lock");
		const owner: StorageOwner = {
			pid: process.pid,
			hostname: hostname(),
			token: uuidV7(),
			createdAt: Date.now(),
		};
		const prepared = join(root, `.writer-${owner.token}.tmp`);
		await mkdir(prepared, { mode: 0o700 });
		let published = false;
		try {
			const file = await open(join(prepared, ownerFile(owner)), "wx", 0o600);
			try {
				await file.writeFile(JSON.stringify(owner));
				await file.sync();
			} finally {
				await file.close();
			}
			for (let attempt = 0; attempt < 8; attempt++) {
				try {
					// A nonempty directory cannot replace another nonempty directory.
					// Publishing completed metadata avoids an ownerless acquisition window.
					await rename(prepared, path);
					published = true;
					return new StorageLock(path, owner);
				} catch (error) {
					const failure = code(error);
					if (
						!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(failure ?? "")
					)
						throw error;
					const existing = await readOwner(path);
					if (!existing) {
						if (
							existing === undefined &&
							["EPERM", "EACCES"].includes(failure ?? "")
						)
							throw error;
						await removeEmpty(path);
						continue;
					}
					if (existing.hostname !== owner.hostname) {
						throw new StorageLockedError(
							path,
							"owner is on another host",
							existing,
						);
					}
					try {
						process.kill(existing.pid, 0);
					} catch (probeError) {
						if (code(probeError) === "ESRCH") {
							await removeOwner(path, existing);
							continue;
						}
						// EPERM is a live process; other failures are not proof of death.
						throw new StorageLockedError(
							path,
							"owner process cannot be ruled out",
							existing,
						);
					}
					throw new StorageLockedError(
						path,
						`process ${existing.pid} is still alive`,
						existing,
					);
				}
			}
			throw new StorageLockedError(
				path,
				"ownership changed during acquisition; retry",
			);
		} finally {
			if (!published) await rm(prepared, { recursive: true, force: true });
		}
	}

	release(): Promise<void> {
		this.#release ??= this.#releaseOwned().catch((error) => {
			this.#release = undefined;
			throw error;
		});
		return this.#release;
	}

	async #releaseOwned(): Promise<void> {
		const current = await readOwner(this.path);
		if (current === undefined) return;
		if (
			!current ||
			current.token !== this.owner.token ||
			current.pid !== this.owner.pid ||
			current.hostname !== this.owner.hostname
		) {
			throw new StorageLockedError(
				this.path,
				"release refused: owner changed",
				current ?? undefined,
			);
		}
		await removeOwner(this.path, this.owner);
	}
}
