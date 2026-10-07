import {
	lstat,
	mkdir,
	open,
	readFile,
	realpath,
	rename,
	rmdir,
	unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as z from "zod";
import { uuidV7 } from "./ids.ts";
import { StorageLock, StorageLockedError } from "./storage-lock.ts";

const MAX_MANIFEST_BYTES = 64 * 1024;
const CATALOG_WAIT_MS = 5000;
const storeIdPattern =
	/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const storeIdSchema = z.string().regex(storeIdPattern);
const manifestSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		defaultStoreId: storeIdSchema,
		storeIds: z.array(storeIdSchema).min(1).max(1024),
	})
	.refine(
		(value) =>
			new Set(value.storeIds).size === value.storeIds.length &&
			value.storeIds.includes(value.defaultStoreId),
	);
type StorageManifest = z.infer<typeof manifestSchema>;

export interface ChappieStorage {
	homeDir: string;
	storeDir: string;
	storeId: string;
}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function storageHome(env: NodeJS.ProcessEnv, home: string): string {
	const configured = env.CHAPPIE_HOME;
	const path =
		configured === undefined
			? join(home, ".chappie")
			: configured === "~"
				? home
				: configured.startsWith("~/") || configured.startsWith("~\\")
					? join(home, configured.slice(2))
					: configured;
	if (!isAbsolute(path))
		throw new Error("CHAPPIE_HOME must be an absolute path or start with ~/");
	return resolve(path);
}

async function directory(path: string): Promise<void> {
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error(`Invalid Chappie storage directory: ${path}`);
}

async function readManifest(
	path: string,
): Promise<StorageManifest | undefined> {
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.size > MAX_MANIFEST_BYTES)
			throw new Error("Invalid Chappie storage manifest");
		const contents = await readFile(path, "utf8");
		if (Buffer.byteLength(contents) > MAX_MANIFEST_BYTES)
			throw new Error("Invalid Chappie storage manifest");
		const parsed = manifestSchema.safeParse(JSON.parse(contents));
		if (!parsed.success) throw new Error("Invalid Chappie storage manifest");
		return parsed.data;
	} catch (error) {
		if (missing(error)) return undefined;
		if (error instanceof SyntaxError)
			throw new Error("Invalid Chappie storage manifest", { cause: error });
		throw error;
	}
}

async function catalogLock(homeDir: string): Promise<StorageLock> {
	const deadline = performance.now() + CATALOG_WAIT_MS;
	while (true) {
		try {
			return await StorageLock.acquire(homeDir);
		} catch (error) {
			if (!(error instanceof StorageLockedError)) throw error;
			if (performance.now() >= deadline)
				throw new Error(
					"Chappie storage catalog is busy; its identity was not changed",
					{
						cause: error,
					},
				);
			await delay(25);
		}
	}
}

async function initialize(homeDir: string): Promise<StorageManifest> {
	const storesDir = join(homeDir, "stores");
	await mkdir(storesDir, { recursive: true, mode: 0o700 });
	await directory(storesDir);
	const storeId = uuidV7();
	const storeDir = join(storesDir, storeId);
	const manifest: StorageManifest = {
		schemaVersion: 1,
		defaultStoreId: storeId,
		storeIds: [storeId],
	};
	const temporary = join(homeDir, `manifest.${uuidV7()}.tmp`);
	let committed = false;
	await mkdir(storeDir, { mode: 0o700 });
	try {
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, join(homeDir, "manifest.json"));
		committed = true;
		return manifest;
	} finally {
		await unlink(temporary).catch((error: unknown) => {
			if (!missing(error)) throw error;
		});
		if (!committed)
			await rmdir(storeDir).catch((error: NodeJS.ErrnoException) => {
				if (!missing(error) && error.code !== "ENOTEMPTY") throw error;
			});
	}
}

/** Resolve one neutral store identity; this never migrates or merges data. */
export async function resolveChappieStorage(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): Promise<ChappieStorage> {
	const requestedHome = storageHome(env, home);
	const selected = env.CHAPPIE_STORE_ID?.toLowerCase();
	if (selected !== undefined && !storeIdPattern.test(selected))
		throw new Error("CHAPPIE_STORE_ID must be a UUID v7 store identifier");
	const lock = await catalogLock(requestedHome);
	try {
		const homeDir = await realpath(requestedHome);
		let manifest = await readManifest(join(homeDir, "manifest.json"));
		if (!manifest) {
			if (selected !== undefined)
				throw new Error("Selected Chappie store is not registered");
			manifest = await initialize(homeDir);
		}
		const storeId = selected ?? manifest.defaultStoreId;
		if (!manifest.storeIds.includes(storeId))
			throw new Error("Selected Chappie store is not registered");
		const storesDir = join(homeDir, "stores");
		const storeDir = join(storesDir, storeId);
		await directory(storesDir);
		await directory(storeDir);
		return { homeDir, storeDir, storeId };
	} finally {
		await lock.release();
	}
}
