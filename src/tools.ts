import type { ToolCall } from "@oh-my-pi/pi-ai";
import * as z from "zod";
import type { Initialization } from "./broker.ts";
import { toolResultsContent } from "./delivery.ts";
import type { SessionInput, SessionToolResult } from "./ipc.ts";
import type { ReplayReceipt } from "./operations.ts";
import { contentWithImageReferences } from "./resources.ts";
import { operationIdSchema, transferSchema } from "./transfer.ts";

export interface ToolInput {
	name: string;
	arguments: ToolCall["arguments"];
}

const session = {
	sessionId: z
		.string()
		.min(1)
		.optional()
		.describe("OMP session for this operation"),
};

// Direct MCP tools use native OMP argument names. Other tools are discovered
// from the running session; the broker does not instantiate a second tool host.
const definitions: {
	name: string;
	description: string;
	inputSchema: z.ZodType<Record<string, unknown>, Record<string, unknown>>;
}[] = [
	{
		name: "read",
		description:
			"Read through native OMP. Use path selectors such as file.ts:20-40 or image.svg:img; returned snapshot anchors are authoritative.",
		inputSchema: z.strictObject({ path: z.string().min(1), ...session }),
	},
	{
		name: "bash",
		description:
			"Execute a native OMP shell command. For commands that exceed a ChatGPT request, use start_call instead.",
		inputSchema: z.strictObject({
			command: z.string().min(1),
			timeout: z.number().nonnegative().optional(),
			cwd: z.string().optional(),
			pty: z.boolean().optional(),
			async: z.boolean().optional(),
			name: z.string().max(48).optional(),
			ready: z
				.strictObject({
					log: z.string().optional(),
					port: z.int().min(1).max(65535).optional(),
					host: z.string().optional(),
					timeout: z.number().nonnegative().optional(),
				})
				.optional(),
			...session,
		}),
	},
	{
		name: "edit",
		description:
			"Apply a native OMP hashline patch in input. Copy exact file hashes and line anchors from the latest read; no path/edits or patch alias is accepted.",
		inputSchema: z.strictObject({ input: z.string().min(1), ...session }),
	},
	{
		name: "write",
		description:
			"Write a new text file using native OMP. Use edit for changes to existing files.",
		inputSchema: z.strictObject({
			path: z.string().min(1),
			content: z.string(),
			...session,
		}),
	},
	{
		name: "transfer",
		description:
			"Import host-injected ChatGPT files, copy between OMP sessions, or export local files and images.",
		inputSchema: transferSchema.extend({
			operationId: operationIdSchema,
			...session,
		}),
	},
];

export const directTools = definitions.map((definition) => ({
	...definition,
	fileParams: definition.name === "transfer" ? ["files"] : undefined,
}));

export function toolResult(
	toolResults: SessionToolResult[],
	sessionId: string,
	cwd: string,
	inputs: SessionInput[] = [],
	initialization?: Initialization,
	replay?: ReplayReceipt,
) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({
					sessionId,
					cwd,
					...(initialization ? { initialization } : {}),
					...(replay ? { replay } : {}),
				}),
			},
			...toolResultsContent(toolResults, sessionId),
			...(replay?.status === "completed"
				? (replay.delivery?.resources ?? [])
						.filter((resource) => resource.sourceReadAt === undefined)
						.map(({ sourceReadAt: _read, ...resource }) => ({
							type: "resource_link" as const,
							...resource,
						}))
				: []),
			...inputContent(inputs),
		],
		isError: toolResults.some(
			(result) =>
				result.isError ||
				(result.details as { failed?: boolean } | undefined)?.failed === true,
		),
	};
}

export function inputContent(inputs: SessionInput[]) {
	return inputs.flatMap((input) => {
		const { id, sessionId } = input;
		if ("request" in input) {
			return [
				{
					type: "text" as const,
					text: JSON.stringify({
						modelRequest: id,
						sessionId,
						request: input.request,
						instructions:
							"Reply with chat using replyTo=modelRequest for this request.",
					}),
				},
			];
		}
		const { message } = input;
		return [
			{
				type: "text" as const,
				text: JSON.stringify({ ompInput: id, sessionId }),
			},
			...(typeof message.content === "string"
				? [{ type: "text" as const, text: message.content }]
				: contentWithImageReferences(sessionId, message.content)),
		];
	});
}
