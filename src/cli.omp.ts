#!/usr/bin/env bun

import { serveChappie } from "./stdio.ts";
import { resolveChappieStorage } from "./storage.ts";

try {
	const storage = await resolveChappieStorage();
	await serveChappie(storage.storeDir);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
