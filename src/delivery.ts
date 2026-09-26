import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { Source } from "./activity.ts";
import {
	contentWithImageReferences,
	resourceDescriptors,
} from "./resources.ts";

export interface DeliveryRecord extends Source {
	id: string;
	sessionId: string;
	cwd: string;
	toolResults: ToolResultMessage[];
	error?: string;
	complete?: boolean;
}

export function toolResultsContent(
	toolResults: ToolResultMessage[],
	sessionId: string,
	resources: "links" | "references" = "links",
) {
	return toolResults.flatMap((result) => [
		{
			type: "text" as const,
			text: JSON.stringify({
				toolCallId: result.toolCallId,
				toolName: result.toolName,
				isError:
					result.isError ||
					(result.details as { failed?: boolean } | undefined)?.failed === true,
			}),
		},
		...contentWithImageReferences(sessionId, result.content),
		...resourceDescriptors(result.details).map((resource) =>
			resources === "links"
				? { type: "resource_link" as const, ...resource }
				: {
						type: "text" as const,
						text: JSON.stringify({ resourceReference: resource }),
					},
		),
	]);
}

export function deliveryContent(deliveries: DeliveryRecord[]) {
	return deliveries.flatMap((delivery) => [
		{
			type: "text" as const,
			text: JSON.stringify({
				deferredResult: delivery.id,
				requestId: delivery.requestId,
				sessionId: delivery.sessionId,
				cwd: delivery.cwd,
				error: delivery.error,
			}),
		},
		...toolResultsContent(
			delivery.toolResults,
			delivery.sessionId,
			"references",
		),
	]);
}
