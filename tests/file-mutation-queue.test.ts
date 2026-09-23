import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { withFileMutationQueue } from "../src/file-mutation-queue.ts";

const root = join(tmpdir(), "chappie-mutation-queue-tests");

describe("withFileMutationQueue", () => {
	test("serializes mutations for the same path", async () => {
		const path = join(root, "same");
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const events: string[] = [];

		const first = withFileMutationQueue(path, async () => {
			events.push("first:start");
			await firstGate;
			events.push("first:end");
		});
		await Promise.resolve();

		const second = withFileMutationQueue(path, async () => {
			events.push("second:start");
		});
		await new Promise((resolve) => setTimeout(resolve, 10));

		assert.deepEqual(events, ["first:start"]);
		releaseFirst();
		await Promise.all([first, second]);
		assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
	});

	test("allows different paths to mutate concurrently", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let secondStarted = false;

		const first = withFileMutationQueue(join(root, "a"), async () => {
			await gate;
		});
		const second = withFileMutationQueue(join(root, "b"), async () => {
			secondStarted = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));

		assert.equal(secondStarted, true);
		release();
		await Promise.all([first, second]);
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
