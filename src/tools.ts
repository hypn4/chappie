import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import type { Initialization } from "./broker.ts";
import { toolResultsContent } from "./delivery.ts";
import type { SessionInput } from "./ipc.ts";
import type { ReplayReceipt } from "./operations.ts";
import { contentWithImageReferences } from "./resources.ts";
import { transfer } from "./transfer.ts";

export interface ToolInput {
	name: string;
	arguments: Record<string, unknown>;
}

export function decodeBase64ToolCalls(value: string): unknown {
	if (
		value.length === 0 ||
		value.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			value,
		)
	)
		throw new Error("call.base64 must be canonical Base64");
	const bytes = Buffer.from(value, "base64");
	const text = bytes.toString("utf8");
	if (!Buffer.from(text, "utf8").equals(bytes))
		throw new Error("call.base64 must contain valid UTF-8");
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("call.base64 must contain UTF-8 JSON");
	}
}

const definitions = [
	createReadToolDefinition("."),
	createBashToolDefinition("."),
	createEditToolDefinition("."),
	createWriteToolDefinition("."),
	transfer,
];

export const directTools = definitions.map((definition) => ({
	name: definition.name,
	description:
		definition.name === "edit"
			? "Pi: use path and exact-text edits. OMP: use patch with native anchors from the latest read. These formats are not interchangeable."
			: definition.description,
	inputSchema: fromJsonSchema<Record<string, unknown>>(
		withSessionId(
			definition.parameters as unknown as Record<string, unknown>,
			definition.name,
		),
	),
	fileParams: definition.name === "transfer" ? ["files"] : undefined,
}));

export function toolResult(
	toolResults: ToolResultMessage[],
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
				text: JSON.stringify({ piInput: id, sessionId }),
			},
			...(typeof message.content === "string"
				? [{ type: "text" as const, text: message.content }]
				: contentWithImageReferences(sessionId, message.content)),
		];
	});
}

function withSessionId(
	schema: Record<string, unknown>,
	name: string,
): Record<string, unknown> {
	const copy = structuredClone(schema) as {
		properties?: Record<string, unknown>;
		required?: string[];
	};
	if (name === "edit") {
		copy.properties = {
			...copy.properties,
			patch: {
				type: "string",
				description:
					"OMP native patch copied from the latest read snapshot; retain its hash and line anchors.",
			},
		};
		delete copy.required;
		return {
			...copy,
			properties: { ...copy.properties, sessionId: { type: "string" } },
			oneOf: [{ required: ["path", "edits"] }, { required: ["patch"] }],
			additionalProperties: false,
		};
	}
	return {
		...copy,
		...(name === "transfer"
			? { required: [...(copy.required ?? []), "operationId"] }
			: {}),
		properties: {
			...copy.properties,
			sessionId: {
				type: "string",
				description:
					"Pi session for this operation; becomes the default if none is set",
			},
		},
		additionalProperties: false,
	};
}
