import { setTimeout as delay } from "node:timers/promises";

/** Poll only observable state; a frozen application clock must not disable the guard. */
export async function until(
	condition: () => boolean | Promise<boolean>,
	milliseconds = 2500,
): Promise<void> {
	const deadline = performance.now() + milliseconds;
	while (!(await condition())) {
		if (performance.now() >= deadline)
			throw new Error("Fixture condition timed out");
		await delay(5);
	}
}

/** Deadline guard, never a sleep used to guess that an operation has finished. */
export async function within<T>(
	promise: Promise<T>,
	milliseconds: number,
	message: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), milliseconds);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
