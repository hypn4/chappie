import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { LocalSession } from "./session.ts";
import type { TransferArgs } from "./transfer.ts";

const parameters = {
	type: "object",
	properties: {
		operationId: {
			type: "string",
			minLength: 1,
			maxLength: 128,
			description:
				"Stable transfer ID; reuse across approval retries, not across new user requests.",
		},
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
		from: {
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

export function createOmpTransferTool(session: LocalSession): ToolDefinition {
	return {
		name: "transfer",
		label: "transfer",
		description:
			"Import ChatGPT files with files, send local paths to a session with to, retrieve session files with from, or export local paths and images.",
		parameters,
		async execute(_id, args, signal, update, context) {
			return session.transfer(
				args as TransferArgs,
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
