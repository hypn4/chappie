import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";
import type { ExtensionAPI as OmpExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { readConfig } from "./config.ts";
import { createOmpChappieProvider } from "./provider.omp.ts";
import { createOmpHostApi, LocalSession } from "./session.ts";
import { createOmpTransferTool } from "./transfer.omp.ts";

export default async function chappie(pi: OmpExtensionAPI): Promise<void> {
	const agentDir = getAgentDir();
	const config = await readConfig(agentDir);
	const session = new LocalSession(
		createOmpHostApi(pi, toolWireSchema),
		agentDir,
		config.connect,
		"omp",
		config.tls,
	);
	session.installOmp(pi);
	pi.registerTool(createOmpTransferTool(session));
	pi.registerProvider(
		"chappie",
		createOmpChappieProvider(
			(output, sessionId) => session.start(output, sessionId),
			pi,
		),
	);
}
