import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { withFileMutationQueue } from "../src/file-mutation-queue.ts";

const root = join(tmpdir(), "chappie-mutation-queue-tests");

describe("withFileMutationQueue", () => {
	test("serializes mutations for the same path", async () => {
		const path = join(root, "same");
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const events: string[] = [];
		const first = withFileMutationQueue(path, async () => {
			events.push("first:start");
			entered.resolve();
			await gate.promise;
			events.push("first:end");
		});
		let second: Promise<void> | undefined;
		try {
			await bounded(entered.promise);
			second = withFileMutationQueue(path, async () => {
				events.push("second:start");
			});
			// Registrations are ordered. An unrelated callback proves that the
			// second registration completed without waiting for the first mutation.
			await bounded(
				withFileMutationQueue(join(root, "barrier"), async () => {}),
			);
			assert.deepEqual(events, ["first:start"]);
		} finally {
			gate.resolve();
			await bounded(Promise.all([first, second]));
		}
		assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
	});

	test("allows different paths to mutate concurrently", async () => {
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		let secondStarted = false;
		const first = withFileMutationQueue(join(root, "a"), async () => {
			entered.resolve();
			await gate.promise;
		});
		let second: Promise<void> | undefined;
		try {
			await bounded(entered.promise);
			second = withFileMutationQueue(join(root, "b"), async () => {
				secondStarted = true;
			});
			await bounded(second);
			assert.equal(secondStarted, true);
		} finally {
			gate.resolve();
			await bounded(Promise.all([first, second]));
		}
	});

	test("releases the queue when a mutation throws", async () => {
		const path = join(root, "throws");
		await assert.rejects(
			withFileMutationQueue(path, async () => {
				throw new Error("boom");
			}),
			/boom/,
		);

		let ran = false;
		await withFileMutationQueue(path, async () => {
			ran = true;
		});
		assert.equal(ran, true);
	});
});

// This is a deadlock deadline, not an assumption about filesystem latency.
async function bounded<T>(promise: Promise<T>): Promise<T> {
	const controller = new AbortController();
	try {
		return await Promise.race([
			promise,
			delay(5000, undefined, { signal: controller.signal }).then(() => {
				throw new Error("Mutation queue did not make progress");
			}),
		]);
	} finally {
		controller.abort();
	}
}
