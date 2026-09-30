import type {
	AssistantMessage,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI as OmpExtensionAPI,
	ExtensionContext as OmpExtensionContext,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import * as z from "zod";
import type { HistoryRange, HistoryResult } from "./history.ts";
import type {
	SessionInput,
	SessionInspection,
	SessionListItem,
} from "./ipc.ts";
import { type ResourceDescriptor, resourceDescriptors } from "./resources.ts";
import type { ToolInput } from "./tools.ts";

export interface RemoteToolsResult extends SessionInspection {
	inputs: SessionInput[];
	globalAgents?: { path: string };
}

export interface RemoteCallResult {
	sessionId: string;
	cwd: string;
	inputs: SessionInput[];
	toolResults: ToolResultMessage[];
}

export interface RemoteChatResult {
	sessionId: string;
	cwd: string;
	inputs: SessionInput[];
	message: AssistantMessage;
}

export interface OmpCollaborationSession {
	sessions(
		sessionId?: string,
		signal?: AbortSignal,
	): Promise<{ self: string; sessions: SessionListItem[] }>;
	tools(
		sessionId: string,
		names?: string[],
		signal?: AbortSignal,
	): Promise<RemoteToolsResult>;
	remoteCall(
		sessionId: string,
		calls: ToolInput[],
		signal?: AbortSignal,
	): Promise<RemoteCallResult>;
	remoteChat(
		sessionId: string,
		text: string,
		replyTo?: string,
		signal?: AbortSignal,
	): Promise<RemoteChatResult>;
	remoteHistory(
		range: HistoryRange,
		sessionId?: string,
		signal?: AbortSignal,
	): Promise<HistoryResult>;
}

const sessionsInput = z.object({
	sessionId: z.string().min(1).optional(),
});
const toolsInput = z.object({
	sessionId: z.string().min(1),
	names: z.array(z.string().min(1)).min(1).optional(),
});
const callInput = z.object({
	sessionId: z.string().min(1),
	calls: z
		.array(
			z.object({
				name: z.string().min(1),
				arguments: z.record(z.string(), z.unknown()),
			}),
		)
		.min(1)
		.max(128),
});
const chatInput = z.object({
	sessionId: z.string().min(1),
	text: z.string(),
	replyTo: z.string().min(1).optional(),
});
const historyInput = z.object({
	sessionId: z.string().min(1).optional(),
	limit: z.number().int().min(1).default(20),
	before: z.string().min(1).optional(),
	after: z.string().min(1).optional(),
	wait: z.boolean().optional(),
	observer: z.boolean().optional(),
});

export const collaborationToolNames = [
	"sessions",
	"remote_tools",
	"remote_call",
	"remote_chat",
	"history",
] as const;

interface NativeResult {
	content: Array<
		| { type: "text"; text: string }
		| { type: "image"; data: string; mimeType: string }
	>;
	details?: { resources?: ResourceDescriptor[] };
}

function nativeContent(content: readonly unknown[]): NativeResult["content"] {
	const normalized: NativeResult["content"] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") {
			normalized.push({ type: "text", text: JSON.stringify(block) });
			continue;
		}
		if (
			"type" in block &&
			block.type === "text" &&
			"text" in block &&
			typeof block.text === "string"
		) {
			normalized.push({ type: "text", text: block.text });
			continue;
		}
		if (
			"type" in block &&
			block.type === "image" &&
			"data" in block &&
			typeof block.data === "string" &&
			"mimeType" in block &&
			typeof block.mimeType === "string"
		) {
			normalized.push({
				type: "image",
				data: block.data,
				mimeType: block.mimeType,
			});
			continue;
		}
		normalized.push({ type: "text", text: JSON.stringify(block) });
	}
	return normalized;
}

function inputContent(inputs: SessionInput[]): NativeResult["content"] {
	return inputs.flatMap((input) => {
		if ("request" in input) {
			return [
				{
					type: "text" as const,
					text: JSON.stringify({
						modelRequest: input.id,
						sessionId: input.sessionId,
						request: input.request,
						instructions:
							"Reply with remote_chat using replyTo=modelRequest for this request.",
					}),
				},
			];
		}
		const blocks =
			typeof input.message.content === "string"
				? [{ type: "text" as const, text: input.message.content }]
				: nativeContent(input.message.content);
		return [
			{
				type: "text" as const,
				text: JSON.stringify({ input: input.id, sessionId: input.sessionId }),
			},
			...blocks,
		];
	});
}

function toolResultContent(
	sessionId: string,
	toolResults: ToolResultMessage[],
): NativeResult {
	const resources = toolResults.flatMap((result) =>
		resourceDescriptors(result.details),
	);
	const content: NativeResult["content"] = [
		{ type: "text", text: JSON.stringify({ sessionId }) },
	];
	for (const result of toolResults) {
		content.push({
			type: "text",
			text: JSON.stringify({
				toolCallId: result.toolCallId,
				toolName: result.toolName,
				isError:
					result.isError ||
					(result.details as { failed?: boolean } | undefined)?.failed === true,
			}),
		});
		content.push(...nativeContent(result.content));
	}
	return {
		content,
		...(resources.length ? { details: { resources } } : {}),
	};
}

function nativeTool<S extends z.ZodObject>(
	name: string,
	description: string,
	schema: S,
	execute: (args: z.output<S>, signal?: AbortSignal) => Promise<NativeResult>,
): ToolDefinition {
	return {
		name,
		label: name,
		description,
		parameters: z.toJSONSchema(schema),
		defaultInactive: true,
		async execute(_id, args, signal) {
			return execute(schema.parse(args), signal);
		},
	};
}

export function createOmpCollaborationTools(
	session: OmpCollaborationSession,
): ToolDefinition[] {
	return [
		nativeTool(
			"sessions",
			"List connected Chappie sessions and identify this local OMP session.",
			sessionsInput,
			async ({ sessionId }, signal) => ({
				content: [
					{
						type: "text",
						text: JSON.stringify(await session.sessions(sessionId, signal)),
					},
				],
			}),
		),
		nativeTool(
			"remote_tools",
			"Read native tool definitions from a connected Chappie session.",
			toolsInput,
			async ({ sessionId, names }, signal) => {
				const result = await session.tools(sessionId, names, signal);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								session: result.session,
								tools: result.tools,
								skills: result.skills,
								...(result.globalAgents
									? { globalAgents: result.globalAgents }
									: {}),
							}),
						},
						...inputContent(result.inputs),
					],
				};
			},
		),
		nativeTool(
			"remote_call",
			"Execute one native tool batch in a connected Chappie session using definitions from remote_tools.",
			callInput,
			async ({ sessionId, calls }, signal) => {
				const result = await session.remoteCall(sessionId, calls, signal);
				const native = toolResultContent(sessionId, result.toolResults);
				if (
					result.toolResults.some(
						(item) =>
							item.isError ||
							(item.details as { failed?: boolean } | undefined)?.failed ===
								true,
					)
				)
					throw new Error(
						native.content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("\n"),
					);
				return {
					...native,
					content: [...native.content, ...inputContent(result.inputs)],
				};
			},
		),
		nativeTool(
			"remote_chat",
			"Send an assistant message to a Chappie session, or reply to its pending model request with replyTo.",
			chatInput,
			async ({ sessionId, text, replyTo }, signal) => {
				const result = await session.remoteChat(
					sessionId,
					text,
					replyTo,
					signal,
				);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ sessionId, cwd: result.cwd }),
						},
						...nativeContent(result.message.content),
						...inputContent(result.inputs),
					],
				};
			},
		),
		nativeTool(
			"history",
			"Read this OMP session's history or a connected Chappie session. Use before/after to page and wait to follow progress.",
			historyInput,
			async ({ sessionId, ...range }, signal) => {
				const result = await session.remoteHistory(range, sessionId, signal);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								count: result.count,
								hasMore: result.hasMore,
							}),
						},
						...nativeContent(result.content),
					],
				};
			},
		),
	];
}

export function installOmpCollaborationTools(
	pi: OmpExtensionAPI,
	session: OmpCollaborationSession,
	enabled: boolean,
): void {
	if (!enabled) return;
	const tools = createOmpCollaborationTools(session);
	for (const tool of tools) pi.registerTool(tool);
	const names = new Set<string>(collaborationToolNames);

	const sync = async (context: OmpExtensionContext): Promise<void> => {
		const current = pi.getActiveTools();
		const next = current.filter((name) => !names.has(name));
		if (context.model?.provider !== "chappie")
			next.push(...collaborationToolNames);
		if (
			next.length === current.length &&
			next.every((name, index) => name === current[index])
		)
			return;
		await pi.setActiveTools(next);
	};

	pi.on("session_start", (_event, context) => sync(context));
	pi.on("session_switch", (_event, context) => sync(context));
	pi.on("session_branch", (_event, context) => sync(context));
	pi.on("session_tree", (_event, context) => sync(context));
	pi.on("before_agent_start", (_event, context) => sync(context));
	pi.on("context", (_event, context) => sync(context));
}
