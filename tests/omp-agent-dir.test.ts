import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { resolveOmpAgentDir } from "../src/omp-agent-dir.ts";

const home = "/home/tester";
test("OMP directory resolution uses canonical profile and explicit directory inputs", () => {
	assert.equal(resolveOmpAgentDir({}, home), join(home, ".omp", "agent"));
	assert.equal(
		resolveOmpAgentDir({ OMP_PROFILE: "work" }, home),
		join(home, ".omp", "profiles", "work", "agent"),
	);
	assert.equal(
		resolveOmpAgentDir(
			{ PI_CONFIG_DIR: ".config-omp", OMP_PROFILE: "work" },
			home,
		),
		join(home, ".config-omp", "profiles", "work", "agent"),
	);
	assert.equal(
		resolveOmpAgentDir({ PI_CODING_AGENT_DIR: "/custom/agent" }, home),
		resolve("/custom/agent"),
	);
});
test("the removed PI_PROFILE alias cannot select a broker session directory", () => {
	assert.equal(
		resolveOmpAgentDir({ PI_PROFILE: "old" }, home),
		join(home, ".omp", "agent"),
	);
	assert.equal(
		resolveOmpAgentDir(
			{ OMP_PROFILE: "", PI_PROFILE: "old", PI_CODING_AGENT_DIR: "/explicit" },
			home,
		),
		resolve("/explicit"),
	);
});
test("OMP profile names reject traversal and Windows device paths", () => {
	for (const profile of [
		"../bad",
		"CON",
		"con.txt",
		"aux",
		"lpt1",
		"trailing.",
	])
		assert.throws(
			() => resolveOmpAgentDir({ OMP_PROFILE: profile }, home),
			/Invalid OMP_PROFILE/,
		);
});
