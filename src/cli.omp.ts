#!/usr/bin/env bun

import { resolveOmpAgentDir } from "./omp-agent-dir.ts";
import { serveChappie } from "./stdio.ts";

try {
	await serveChappie(resolveOmpAgentDir());
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
