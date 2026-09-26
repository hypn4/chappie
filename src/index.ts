import {
	type ExtensionAPI,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

export default async function chappie(pi: ExtensionAPI): Promise<void> {
	const agentDir = getAgentDir();
	pi.registerFlag("chappie", {
		description: "Serve Chappie over MCP",
		type: "boolean",
	});

	if (process.argv.includes("--chappie")) {
		try {
			const { serveChappie } = await import("./stdio.ts");
			await serveChappie(agentDir);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	}

	const [
		{ readConfig },
		{ createChappieProvider },
		{ createPiHostApi, LocalSession },
		{ transfer },
	] = await Promise.all([
		import("./config.ts"),
		import("./provider.ts"),
		import("./session.ts"),
		import("./transfer.ts"),
	]);
	const config = await readConfig(agentDir);
	const session = new LocalSession(
		createPiHostApi(pi),
		agentDir,
		config.connect,
		"pi",
		config.tls,
	);
	session.installPi(pi);
	pi.registerTool({
		...transfer,
		execute: (_id, args, signal, update, context) =>
			session.transfer(args, signal, update, {
				sessionId: context.sessionManager.getSessionId(),
				cwd: context.cwd,
			}),
	});
	pi.registerProvider(createChappieProvider((output) => session.start(output)));
}
