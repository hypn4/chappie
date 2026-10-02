import type { ToolCall } from "@oh-my-pi/pi-ai";
import type { Initialization } from "./broker.ts";
import { toolResultsContent } from "./delivery.ts";
import type { ExecutionWait, SessionInput, SessionToolResult } from "./ipc.ts";
import type { OperationView, ReplayReceipt } from "./operations.ts";
import { contentWithImageReferences } from "./resources.ts";
import { continuationFor, type SessionWork } from "./work.ts";

export interface ToolInput {
	name: string;
	arguments: ToolCall["arguments"];
}

export function toolResult(
	toolResults: SessionToolResult[],
	sessionId: string,
	cwd: string,
	inputs: SessionInput[] = [],
	initialization?: Initialization,
	replay?: ReplayReceipt,
	execution?: ExecutionWait,
	observation: {
		work?: SessionWork | undefined;
		operation?: OperationView | undefined;
		scope?: "native_batch" | "progress" | "message";
	} = {},
) {
	const failed = toolResults.some(
		(result) =>
			result.isError ||
			(result.details as { failed?: boolean } | undefined)?.failed === true,
	);
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({
					sessionId,
					cwd,
					...(initialization ? { initialization } : {}),
					...(replay ? { replay } : {}),
					...(execution ? { execution } : {}),
					...(observation.work ? { work: observation.work } : {}),
					...(observation.operation
						? { operation: observation.operation }
						: {}),
					continuation: continuationFor({
						...observation,
						needsInput:
							execution !== undefined ||
							inputs.some((input) => "request" in input),
						failed,
						operationStatus: observation.operation?.status ?? replay?.status,
					}),
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
		isError: failed,
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
