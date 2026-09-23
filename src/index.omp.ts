import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { readConfig } from "./config.ts";
import type { OmpExtensionAPI } from "./omp-api.ts";
import { createOmpChappieProvider } from "./provider.omp.ts";
import { createOmpHostApi, LocalSession } from "./session.ts";
import { createOmpTransferTool } from "./transfer.omp.ts";

export default async function chappie(pi: OmpExtensionAPI): Promise<void> {
	const agentDir = getAgentDir();
	const config = await readConfig(agentDir);
	const session = new LocalSession(
		createOmpHostApi(pi),
		agentDir,
		config.connect,
		"omp",
	);
	session.installOmp(pi);
	pi.registerTool(createOmpTransferTool(session));
	pi.registerProvider(
		"chappie",
		createOmpChappieProvider((output) => session.start(output)),
	);
}
