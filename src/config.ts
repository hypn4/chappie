import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";

export interface NetworkTlsConfig {
	ca: string;
	cert: string;
	key: string;
	serverName?: string | undefined;
}

const configSchema = z
	.strictObject({
		ask: z.boolean().optional(),
		cooldown: z.number().nonnegative().optional(),
		listenHost: z.string().min(1).optional(),
		tls: z
			.strictObject({
				ca: z.string().min(1),
				cert: z.string().min(1),
				key: z.string().min(1),
				serverName: z.string().min(1).optional(),
			})
			.optional(),
		connect: z.string().min(1).optional(),
		listen: z
			.union([z.boolean(), z.number().int().min(1).max(65535)])
			.optional(),
	})
	.superRefine((config, context) => {
		if ((config.connect || config.listen) && !config.tls)
			context.addIssue({
				code: "custom",
				message:
					"Network connections require mutual TLS: configure tls.ca, tls.cert and tls.key on both devices",
			});
	});

export async function readConfig(agentDir: string) {
	let contents: string;
	try {
		contents = await readFile(join(agentDir, "chappie.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	return configSchema.parse(JSON.parse(contents));
}
