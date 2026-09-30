import * as z from "zod";
import { historyInput } from "./history.ts";
import type { BrokerMessage, SessionMessage } from "./ipc.ts";

const id = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(64 * 1024 * 1024);
const name = z.string().min(1).max(4096);
const path = z.string().min(1).max(32768);
const source = {
	chatId: name,
	requestId: name.optional(),
	operationKey: name.optional(),
};
const toolCall = z.strictObject({
	type: z.literal("toolCall"),
	id: name,
	name,
	arguments: z.record(z.string(), z.unknown()),
});
const block = z.union([
	z.looseObject({ type: z.literal("text"), text }),
	z.looseObject({ type: z.literal("image"), data: text, mimeType: name }),
	toolCall,
	z.looseObject({ type: z.literal("resource_link"), uri: name, name }),
	z.looseObject({
		type: z.literal("resource"),
		resource: z.record(z.string(), z.unknown()),
	}),
]);
const content = z.array(block).max(4096);
const assistant = z.looseObject({ role: z.literal("assistant"), content });
const toolResult = z.looseObject({
	role: z.literal("toolResult"),
	toolCallId: name,
	toolName: name,
	content,
	isError: z.boolean(),
	timestamp: z.number(),
	details: z.unknown().optional(),
});
const toolResults = z.array(toolResult).max(128);
const inputs = z
	.array(
		z.strictObject({
			id: name,
			sessionId: name,
			message: z.looseObject({
				role: z.literal("user"),
				content: z.union([text, content]),
			}),
		}),
	)
	.max(4096);
const session = z.strictObject({
	id: name,
	cwd: path,
	device: name,
	name: z.string().max(4096).optional(),
	status: z.enum(["idle", "ready", "executing"]),
	host: z.enum(["pi", "omp"]).optional(),
	agentDir: path.optional(),
});
const descriptor = z.strictObject({
	uri: name,
	name,
	mimeType: name,
	size: id,
});
const inspection = z.strictObject({
	session,
	tools: z
		.array(
			z.looseObject({
				name,
				description: text,
				parameters: z.unknown().optional(),
				schemaError: text.optional(),
			}),
		)
		.max(4096),
	skills: z
		.array(
			z.looseObject({ name, source: z.enum(["extension", "prompt", "skill"]) }),
		)
		.max(4096),
});
const transfer = z.strictObject({
	files: z
		.array(
			z.union([
				z.strictObject({ path, bytes: id }),
				z.strictObject({ path, error: text }),
			]),
		)
		.max(128),
	resources: z.array(descriptor).max(128),
	device: name,
	to: z.strictObject({ sessionId: name, device: name }).optional(),
	from: z.strictObject({ sessionId: name, device: name }).optional(),
	failed: z.boolean().optional(),
});
const sessionRequest = z.union([
	z.strictObject({ type: z.literal("inspect"), sessionId: name }),
	z.strictObject({
		type: z.literal("readResource"),
		sessionId: name,
		uri: name,
		offset: id.optional(),
	}),
	z.strictObject({
		type: z.literal("export"),
		sessionId: name,
		paths: z.array(path).min(1).max(128),
	}),
	z.strictObject({
		type: z.literal("copy"),
		sessionId: name,
		resources: z.array(descriptor).max(128),
		paths: z.array(path).max(128),
		overwrite: z.boolean().optional(),
	}),
]);
export const deliverySchema = z.strictObject({
	id: name,
	...source,
	sessionId: name,
	cwd: path,
	toolResults,
	error: text.optional(),
	complete: z.boolean().optional(),
});
const resultPayloads = [
	{ inspection, inputs, globalAgents: z.strictObject({ path }).optional() },
	{
		message: assistant,
		cwd: path,
		inputs,
		toolResults: toolResults.optional(),
	},
	{
		history: z.strictObject({ count: id, hasMore: z.boolean(), content }),
		cwd: path,
	},
	{ resource: descriptor.extend({ blob: text }) },
	{ transfer },
	{ error: text },
];
const result = (type: "result" | "response") =>
	z.union(
		resultPayloads.map((payload) =>
			z.strictObject({ type: z.literal(type), id, ...payload }),
		),
	);

const sessionMessage = z.union([
	z.strictObject({ type: z.literal("sync"), id, session }),
	z.strictObject({ type: z.literal("unregister"), sessionId: name }),
	z.strictObject({ type: z.literal("delivery"), delivery: deliverySchema }),
	z.strictObject({ type: z.literal("request"), id, request: sessionRequest }),
	z.strictObject({ type: z.literal("cancelRequest"), id }),
	result("result"),
]);
const brokerMessage = z.union([
	z.strictObject({ type: z.literal("synced"), id, sessionId: name }),
	z.strictObject({ type: z.literal("stored"), id: name }),
	z.strictObject({
		type: z.literal("notice"),
		sessionId: name,
		message: text,
		activity: z.looseObject({}).optional(),
	}),
	z.strictObject({
		type: z.literal("history"),
		id,
		sessionId: name,
		range: historyInput,
		...source,
	}),
	z.strictObject({
		type: z.literal("chat"),
		id,
		sessionId: name,
		text,
		...source,
	}),
	z.strictObject({
		type: z.literal("call"),
		id,
		sessionId: name,
		calls: z.array(toolCall).min(1).max(128),
		direct: z.boolean().optional(),
		...source,
	}),
	z.strictObject({
		type: z.literal("cancel"),
		id,
		sessionId: name,
		reason: text,
	}),
	...sessionRequest.options.map((schema) => schema.extend({ id })),
	result("response"),
	z.strictObject({
		type: z.literal("ackInputs"),
		sessionId: name,
		ids: z.array(name).max(4096),
	}),
]);

export function validateSessionMessage(value: unknown): SessionMessage {
	return sessionMessage.parse(value) as SessionMessage;
}

export function validateBrokerMessage(value: unknown): BrokerMessage {
	return brokerMessage.parse(value) as BrokerMessage;
}
