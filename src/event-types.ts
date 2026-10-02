import { createHash } from "node:crypto";
import * as z from "zod";
import type { OperationReceipt } from "./operations.ts";

export const OPERATION_FINISHED_EVENT = "operation.finished";
export const OPERATION_INPUT_REQUIRED_EVENT = "operation.input_required";
export const operationEventNameSchema = z.enum([
	OPERATION_FINISHED_EVENT,
	OPERATION_INPUT_REQUIRED_EVENT,
]);
export type OperationEventName = z.infer<typeof operationEventNameSchema>;
const operationId = z.string().min(1).max(128);
const callbackUrl = z.url().max(8192);
export const eventArgumentsSchema = z.strictObject({
	operation_id: operationId,
});

export const eventSubscriptionSchema = z.strictObject({
	id: z.string().min(1).max(256),
	chatId: z.string().min(1).max(4096),
	name: operationEventNameSchema,
	operationId,
	url: callbackUrl,
	secret: z.string().min(1).max(4096),
	previousSecret: z.string().min(1).max(4096).optional(),
	previousSecretUntil: z.number().nonnegative().optional(),
	expiresAt: z.number().nonnegative().nullable(),
	updatedAt: z.number().nonnegative(),
	// Retained after an outbox item is acknowledged, so refresh/recovery cannot recreate it.
	eventId: z.string().max(256).optional(),
	deliveryStatus: z.enum(["pending", "delivered", "failed"]).optional(),
	deliveryError: z.string().max(256).optional(),
});
export type EventSubscription = z.infer<typeof eventSubscriptionSchema>;

export const operationFinishedDataSchema = z.strictObject({
	operation_id: operationId,
	status: z.enum(["completed", "failed", "cancelled"]),
	session_id: z.string().min(1).max(4096),
	cwd: z.string().max(32768),
	error: z.string().max(1024).optional(),
});
export type OperationFinishedData = z.infer<typeof operationFinishedDataSchema>;

export const operationInputRequiredDataSchema = z.strictObject({
	operation_id: operationId,
	status: z.literal("waiting_input"),
	session_id: z.string().min(1).max(4096),
	cwd: z.string().max(32768),
	wait_id: z.string().length(64),
	input_count: z.number().int().min(1).max(4096),
});

const eventRecordBase = z.strictObject({
	eventId: z.string().min(1).max(256),
	subscriptionId: z.string().min(1).max(256),
	timestamp: z.iso.datetime({ offset: true }),
	attempts: z.number().int().nonnegative().max(16),
	nextAttemptAt: z.number().nonnegative(),
});
export const eventRecordSchema = z.discriminatedUnion("name", [
	eventRecordBase.extend({
		name: z.literal(OPERATION_FINISHED_EVENT),
		data: operationFinishedDataSchema,
	}),
	eventRecordBase.extend({
		name: z.literal(OPERATION_INPUT_REQUIRED_EVENT),
		data: operationInputRequiredDataSchema,
	}),
]);
export type EventRecord = z.infer<typeof eventRecordSchema>;

export function operationEvent(
	subscription: EventSubscription,
	receipt: OperationReceipt,
): EventRecord | undefined {
	if (
		!receipt.operationId ||
		subscription.chatId !== receipt.chatId ||
		subscription.operationId !== receipt.operationId ||
		(subscription.expiresAt !== null && subscription.expiresAt <= Date.now())
	)
		return;
	const common = {
		operation_id: receipt.operationId,
		session_id: receipt.sessionId,
		cwd: receipt.cwd,
	};
	const status = receipt.status;
	let data:
		| z.infer<typeof operationInputRequiredDataSchema>
		| OperationFinishedData;
	let identity: unknown[];
	if (subscription.name === OPERATION_INPUT_REQUIRED_EVENT) {
		if (status !== "waiting_input" || !receipt.waitingInputs?.length) return;
		// Model request IDs stay stable across transport retries but change for a new obligation.
		const waitId = createHash("sha256")
			.update(
				JSON.stringify(
					[...new Set(receipt.waitingInputs.map((input) => input.id))].sort(),
				),
			)
			.digest("hex");
		data = {
			...common,
			status,
			wait_id: waitId,
			input_count: receipt.waitingInputs.length,
		};
		identity = [subscription.id, receipt.key, subscription.name, waitId];
	} else {
		if (
			subscription.eventId ||
			(status !== "completed" && status !== "failed" && status !== "cancelled")
		)
			return;
		data = {
			...common,
			status,
			...(receipt.error ? { error: receipt.error.slice(0, 1024) } : {}),
		};
		identity = [
			subscription.id,
			receipt.key,
			receipt.createdAt ?? receipt.updatedAt,
		];
	}
	const eventId = `evt_${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
	if (subscription.eventId === eventId) return;
	return eventRecordSchema.parse({
		eventId,
		subscriptionId: subscription.id,
		name: subscription.name,
		timestamp: new Date(receipt.updatedAt).toISOString(),
		data,
		attempts: 0,
		nextAttemptAt: Date.now(),
	});
}

export const eventsListParamsSchema = z.object({ cursor: z.null().optional() });
export const eventsListResultSchema = z.object({
	events: z.array(z.unknown()),
	nextCursor: z.string().nullable().optional(),
});
export const eventsSubscribeParamsSchema = z.object({
	name: operationEventNameSchema,
	arguments: eventArgumentsSchema,
	delivery: z.strictObject({
		mode: z.literal("webhook"),
		url: callbackUrl,
		secret: z.string().min(1).max(4096),
	}),
	cursor: z.null().optional(),
	ttlMs: z.number().int().positive().nullable().optional(),
});
export const eventsSubscribeResultSchema = z.object({
	id: z.string(),
	refreshBefore: z.iso.datetime({ offset: true }).nullable(),
	cursor: z.null(),
	truncated: z.literal(false),
});
export const eventsUnsubscribeParamsSchema = z.object({
	name: operationEventNameSchema,
	arguments: eventArgumentsSchema,
	delivery: z.strictObject({ mode: z.literal("webhook"), url: callbackUrl }),
});
export const eventsUnsubscribeResultSchema = z.object({});

export const EVENT_DEFINITIONS = [
	{
		name: OPERATION_FINISHED_EVENT,
		description:
			"A detached native batch finished. Filter by operation_id. Retrieve authoritative output with get_operation. For unattended work, also subscribe to operation.input_required so an intermediate model-input wait can be handled. Batch completion does not imply a child background job finished.",
		delivery: ["webhook"],
		inputSchema: z.toJSONSchema(eventArgumentsSchema),
		payloadSchema: z.toJSONSchema(operationFinishedDataSchema),
	},
	{
		name: OPERATION_INPUT_REQUIRED_EVENT,
		description:
			"A detached batch has not executed and needs a compaction or branch-summary response. Filter by operation_id. Use get_operation and current tools input to retrieve and validate the model request before replying, then explicitly resume the same operationId and arguments. Also subscribe to operation.finished for completion. Repeated delivery is not permission to re-execute.",
		delivery: ["webhook"],
		inputSchema: z.toJSONSchema(eventArgumentsSchema),
		payloadSchema: z.toJSONSchema(operationInputRequiredDataSchema),
	},
] as const;
