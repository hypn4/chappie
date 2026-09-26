#!/usr/bin/env node

import { resolveOmpAgentDir } from "./omp-agent-dir.ts";
import { serveChappie } from "./stdio.ts";

interface OmpCliContext {
	agentDir: string;
	args: readonly string[];
}

/** Dedicated OMP CLI mode; importing it must not start a broker. */
export default async function run(context: OmpCliContext): Promise<never> {
	if (context.args.length !== 0)
		throw new Error("The Chappie broker does not accept positional arguments");
	return serveChappie(context.agentDir);
}

if (import.meta.main) {
	try {
		await run({
			agentDir: resolveOmpAgentDir(),
			args: process.argv.slice(2),
		});
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
