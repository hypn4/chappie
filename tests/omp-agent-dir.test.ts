import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { resolveOmpAgentDir } from "../src/omp-agent-dir.ts";

const home = "/home/tester";

describe("resolveOmpAgentDir", () => {
	test("uses the default OMP agent directory", () => {
		assert.equal(resolveOmpAgentDir({}, home), join(home, ".omp", "agent"));
	});

	test("uses a named OMP profile", () => {
		assert.equal(
			resolveOmpAgentDir({ OMP_PROFILE: "work" }, home),
			join(home, ".omp", "profiles", "work", "agent"),
		);
	});

	test("an explicit empty OMP_PROFILE ignores a profile-derived legacy override", () => {
		const legacy = join(home, ".omp", "profiles", "legacy", "agent");
		assert.equal(
			resolveOmpAgentDir(
				{
					OMP_PROFILE: "",
					PI_PROFILE: "legacy",
					PI_CODING_AGENT_DIR: legacy,
				},
				home,
			),
			join(home, ".omp", "agent"),
		);
	});

	test("rejects invalid and Windows-reserved profile names", () => {
		assert.throws(
			() => resolveOmpAgentDir({ OMP_PROFILE: "../bad" }, home),
			/Invalid OMP profile/,
		);
		assert.throws(
			() => resolveOmpAgentDir({ OMP_PROFILE: "CON" }, home),
			/Invalid OMP profile/,
		);
	});

	test("preserves PI_CONFIG_DIR exactly like OMP", () => {
		assert.equal(
			resolveOmpAgentDir({ PI_CONFIG_DIR: " custom " }, home),
			join(home, " custom ", "agent"),
		);
	});
});
