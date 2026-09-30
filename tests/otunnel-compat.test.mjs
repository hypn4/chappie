import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assertSupportedOtunnelVersion,
	parseOtunnelVersion,
} from "../scripts/verify-otunnel.mjs";

test("otunnel compatibility parser accepts the maintained 0.2 line", () => {
	assert.deepEqual(parseOtunnelVersion("otunnel 0.2.0\n"), {
		major: 0,
		minor: 2,
		patch: 0,
	});
	assert.doesNotThrow(() => assertSupportedOtunnelVersion("otunnel 0.2.9"));
});

test("otunnel compatibility parser rejects unsupported runtime lines", () => {
	assert.throws(
		() => assertSupportedOtunnelVersion("otunnel 0.1.4"),
		/requires otunnel 0\.2\.x/i,
	);
	assert.throws(
		() => assertSupportedOtunnelVersion("otunnel 0.3.0"),
		/requires otunnel 0\.2\.x/i,
	);
	assert.throws(() => parseOtunnelVersion("not-a-version"), /could not parse/i);
});
