import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { loadSkillsFromDir } from "@oh-my-pi/pi-coding-agent/extensibility/skills";

// This verifies our authored resource through the real OMP loader, not model compliance.
test("OMP discovers the project quality workflow as an on-demand authored Skill", async () => {
	const loaded = await loadSkillsFromDir({
		dir: resolve(".agents/skills"),
		source: "agents:project",
	});
	assert.deepEqual(loaded.warnings, []);
	const matches = loaded.skills.filter(
		(item) => item.name === "chappie-quality",
	);
	assert.equal(matches.length, 1);
	const skill = matches[0];
	assert.ok(skill);
	assert.equal(skill.name, "chappie-quality");
	assert.equal(skill.hide, false);
	assert.ok(skill.description.length > 0);
	assert.equal(
		skill.filePath,
		resolve(".agents/skills/chappie-quality/SKILL.md"),
	);
	// Local references must work after checkout; no private /Users paths or installed-plugin paths.
	const markdown = await readFile(skill.filePath, "utf8");
	const links = [...markdown.matchAll(/\]\(([^)]+)\)/g)].map(
		(match) => match[1],
	);
	assert.ok(links.length > 0);
	for (const link of links) {
		assert.ok(
			link && !link.includes("://"),
			"Skill entrypoint references must be repository-local",
		);
		await readFile(resolve(skill.baseDir, link.split("#", 1)[0] ?? ""), "utf8");
	}
});
