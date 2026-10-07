import assert from "node:assert/strict";
import { test } from "node:test";
import * as z from "zod";
import { uuidV7 } from "../src/ids.ts";
import { nativeToolCalls } from "../src/native-calls.ts";

test("UUID v7 matches the RFC 9562 example timestamp and standard validator", () => {
	// Appendix A.6: 2022-02-22T19:22:22.000Z has prefix 017f22e2-79b0.
	const value = uuidV7(1645557742000);
	assert.match(
		value,
		/^017f22e2-79b0-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
	assert.equal(z.uuid({ version: "v7" }).parse(value), value);
	assert.ok(uuidV7(1645557742000) < uuidV7(1645557742001));
});

test("UUID v7 remains unique for many same-millisecond allocations and native calls", () => {
	const values = Array.from({ length: 10_000 }, () => uuidV7(1645557742000));
	assert.equal(new Set(values).size, values.length);
	const calls = nativeToolCalls([
		{ name: "read", arguments: {} },
		{ name: "read", arguments: {} },
	]);
	for (const call of calls)
		z.uuid({ version: "v7" }).parse(call.id.slice("chappie-".length));
	assert.notEqual(calls[0]?.id, calls[1]?.id);
});

test("UUID v7 rejects timestamps outside its wire representation", () => {
	for (const value of [
		-1,
		0x1000000000000,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		1.5,
	])
		assert.throws(() => uuidV7(value), RangeError);
	assert.ok(
		z.uuid({ version: "v7" }).safeParse(uuidV7(0xffffffffffff)).success,
	);
});
