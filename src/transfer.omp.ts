import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import * as z from "zod";
import type { LocalSession } from "./session.ts";
import { transferSchema } from "./transfer.ts";

export function createOmpTransferTool(session: LocalSession): ToolDefinition {
	return {
		name: "transfer",
		label: "transfer",
		description:
			"Import host-injected ChatGPT files, copy between OMP sessions, or export local files and images.",
		parameters: z.toJSONSchema(transferSchema, { io: "input" }),
		execute: (_id, args, signal, update, context) =>
			session.transfer(transferSchema.parse(args), signal, update, {
				sessionId: context.sessionManager.getSessionId(),
				cwd: context.sessionManager.getCwd(),
			}),
	};
}
