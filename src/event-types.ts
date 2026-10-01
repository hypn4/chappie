import { createHash } from "node:crypto";
import * as z from "zod";
import type { OperationReceipt } from "./operations.ts";

export const OPERATION_FINISHED_EVENT = "operation.finished";
const operationId = z.string().min(1).max(128);
const callbackUrl = z.url().max(8192);
export const eventArgumentsSchema = z.strictObject({
	operation_id: operationId,
});

export const eventSubscriptionSchema = z.strictObject({
	id: z.string().min(1).max(256),
	chatId: z.string().min(1).max(4096),
	name: z.literal(OPERATION_FINISHED_EVENT),
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

export const eventRecordSchema = z.strictObject({
	eventId: z.string().min(1).max(256),
	subscriptionId: z.string().min(1).max(256),
	name: z.literal(OPERATION_FINISHED_EVENT),
	timestamp: z.iso.datetime({ offset: true }),
	data: operationFinishedDataSchema,
	attempts: z.number().int().nonnegative().max(16),
	nextAttemptAt: z.number().nonnegative(),
});
export type EventRecord = z.infer<typeof eventRecordSchema>;

export function operationEvent(
	subscription: EventSubscription,
	receipt: OperationReceipt,
): EventRecord | undefined {
	if (
		!receipt.operationId ||
		subscription.eventId ||
		subscription.chatId !== receipt.chatId ||
		subscription.operationId !== receipt.operationId ||
		(subscription.expiresAt !== null && subscription.expiresAt <= Date.now())
	)
		return;
	const status = receipt.status;
	if (status !== "completed" && status !== "failed" && status !== "cancelled")
		return;
	return eventRecordSchema.parse({
		eventId: `evt_${createHash("sha256")
			.update(
				JSON.stringify([
					subscription.id,
					receipt.key,
					receipt.createdAt ?? receipt.updatedAt,
				]),
			)
			.digest("hex")}`,
		subscriptionId: subscription.id,
		name: OPERATION_FINISHED_EVENT,
		timestamp: new Date(receipt.updatedAt).toISOString(),
		data: {
			operation_id: receipt.operationId,
			status,
			session_id: receipt.sessionId,
			cwd: receipt.cwd,
			...(receipt.error ? { error: receipt.error.slice(0, 1024) } : {}),
		},
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
	name: z.literal(OPERATION_FINISHED_EVENT),
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
	name: z.literal(OPERATION_FINISHED_EVENT),
	arguments: eventArgumentsSchema,
	delivery: z.strictObject({ mode: z.literal("webhook"), url: callbackUrl }),
});
export const eventsUnsubscribeResultSchema = z.object({});

export const EVENT_DEFINITION = {
	name: OPERATION_FINISHED_EVENT,
	description:
		"A detached Chappie tool batch finished. Filter by its stable operation_id. An already-finished operation emits its retained terminal snapshot when first subscribed. Fetch the full result with get_operation; tool-batch completion does not imply a child background job finished.",
	delivery: ["webhook"],
	inputSchema: z.toJSONSchema(eventArgumentsSchema),
	payloadSchema: z.toJSONSchema(operationFinishedDataSchema),
} as const;
