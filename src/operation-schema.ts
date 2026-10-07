import * as z from "zod";
import { modelInputSchema } from "./ipc-schema.ts";

export const operationResourceSchema = z.strictObject({
	uri: z.string().min(1).max(4096),
	name: z.string().min(1).max(4096),
	mimeType: z.string().min(1).max(4096),
	size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	sourceReadAt: z.number().finite().nonnegative().optional(),
});

/** One validator for both hot state and cold replay-protection records. */
export const operationReceiptSchema = z.strictObject({
	key: z.string(),
	executionId: z.string().uuid(),
	operationId: z.string().min(1).max(128).optional(),
	signature: z.string(),
	chatId: z.string(),
	sessionId: z.string(),
	cwd: z.string(),
	createdAt: z.number().nonnegative().optional(),
	status: z.enum([
		"running",
		"waiting_input",
		"completed",
		"failed",
		"cancelled",
		"uncertain",
	]),
	updatedAt: z.number().nonnegative(),
	error: z
		.string()
		.max(64 * 1024)
		.optional(),
	resources: z.array(operationResourceSchema).max(16384).optional(),
	waitingInputs: z.array(modelInputSchema).max(4096).optional(),
	resultId: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	resultAcknowledged: z.boolean().optional(),
	resultUnread: z.boolean().optional(),
});
