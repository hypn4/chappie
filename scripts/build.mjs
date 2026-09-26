import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
await rm(join(root, "dist"), { recursive: true, force: true });
const result = spawnSync(
	process.execPath,
	[
		join(
			dirname(require.resolve("typescript/package.json")),
			require("typescript/package.json").bin.tsc,
		),
		"-p",
		"tsconfig.build.json",
	],
	{ cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await mkdir(join(root, "dist/src"), { recursive: true });
for (const asset of ["instructions.md", "question.html"])
	await copyFile(join(root, "src", asset), join(root, "dist/src", asset));
await chmod(join(root, "dist/src/cli.omp.js"), 0o755);
