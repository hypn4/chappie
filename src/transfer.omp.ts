import type { OmpToolDefinition } from "./omp-api.ts";
import type { LocalSession } from "./session.ts";
import type { TransferArgs, TransferDetails } from "./transfer.ts";

const parameters = {
	type: "object",
	properties: {
		paths: {
			type: "array",
			items: { type: "string" },
			minItems: 1,
			description:
				"Agent destinations for import; agent source paths or chappie:// image references for export or session copies",
		},
		files: {
			type: "array",
			items: {
				type: "object",
				properties: {
					file_id: { type: "string" },
					download_url: { type: "string" },
					file_name: { type: "string" },
					mime_type: { type: "string" },
				},
				required: ["file_id", "download_url"],
			},
			minItems: 1,
			description:
				"ChatGPT files paired with paths in order; omit for agent sources",
		},
		to: {
			type: "object",
			properties: {
				sessionId: { type: "string" },
				paths: {
					type: "array",
					items: { type: "string" },
					minItems: 1,
				},
			},
			required: ["sessionId", "paths"],
		},
		overwrite: { type: "boolean" },
	},
	required: ["paths"],
	additionalProperties: false,
} satisfies Record<string, unknown>;

export function createOmpTransferTool(
	session: LocalSession,
): OmpToolDefinition<TransferArgs, TransferDetails> {
	return {
		name: "transfer",
		label: "transfer",
		description:
			"Copy ChatGPT files into agent paths with files, copy between connected sessions with to, or export agent files and images.",
		parameters,
		async execute(_id, args, signal, update, context) {
			return session.transfer(
				args,
				signal,
				update
					? (result) => {
							update(result);
						}
					: undefined,
				{
					sessionId: context.sessionManager.getSessionId(),
					cwd: context.sessionManager.getCwd(),
				},
			);
		},
	};
}
