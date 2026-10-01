/** Serialize Chappie file commits by canonical destination path. */
import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		((error as NodeJS.ErrnoException).code === "ENOENT" ||
			(error as NodeJS.ErrnoException).code === "ENOTDIR")
	);
}

async function getMutationQueueKey(filePath: string): Promise<string> {
	let current = resolve(filePath);
	const missing: string[] = [];
	for (;;) {
		try {
			const key = join(await realpath(current), ...missing.reverse());
			// Conservative serialization also covers case-insensitive volumes.
			return process.platform === "win32" || process.platform === "darwin"
				? key.toLowerCase()
				: key;
		} catch (error) {
			if (!isMissingPathError(error) || dirname(current) === current)
				throw error;
			missing.push(basename(current));
			current = dirname(current);
		}
	}
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(
	filePath: string,
	fn: () => Promise<T>,
): Promise<T> {
	const registration = registrationQueue.then(async () => {
		const key = await getMutationQueueKey(filePath);
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();
		const { promise: nextQueue, resolve: releaseNext } =
			Promise.withResolvers<void>();
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(key, chainedQueue);
		return { key, currentQueue, chainedQueue, releaseNext };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);
	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}
