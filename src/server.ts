import { readFileSync } from "node:fs";
import {
	McpServer,
	ProtocolError,
	ProtocolErrorCode,
	ResourceTemplate,
} from "@modelcontextprotocol/server";
import * as z from "zod";
import packageJson from "../package.json" with { type: "json" };
import type { Broker } from "./broker.ts";
import { deliveryContent } from "./delivery.ts";
import {
	EVENT_DEFINITION,
	eventsListParamsSchema,
	eventsListResultSchema,
	eventsSubscribeParamsSchema,
	eventsSubscribeResultSchema,
	eventsUnsubscribeParamsSchema,
	eventsUnsubscribeResultSchema,
	OPERATION_FINISHED_EVENT,
} from "./event-types.ts";
import { historyInput } from "./history.ts";
import {
	answerContent,
	answerInput,
	questionInput,
	questionInstructions,
	questionOutput,
} from "./questions.ts";
import {
	directTools,
	inputContent,
	type ToolInput,
	toolResult,
} from "./tools.ts";

const instructions = readFileSync(
	new URL("./instructions.md", import.meta.url),
	"utf8",
).trim();

const outputSchema = z.object({
	text: z
		.string()
		.describe(
			"Complete text output, including OMP user input, submitted webpage answers, and deferred results. Images and file resources accompany it as native content blocks.",
		),
});

const nativeCallSchema = z.object({
	name: z.string(),
	arguments: z.record(z.string(), z.json()),
});
const nativeCallsSchema = z.array(nativeCallSchema).min(1).max(128);

const questionTemplate = "ui://chappie/question.html";
const questionSchema = outputSchema.extend({ question: questionOutput });
function toolAnnotations(name: string) {
	const readOnly = [
		"tools",
		"read",
		"history",
		"sessions",
		"get_operation",
	].includes(name);
	const dangerous = [
		"call",
		"start_call",
		"cancel_operation",
		"bash",
		"write",
		"edit",
		"transfer",
	].includes(name);
	return {
		readOnlyHint: readOnly,
		destructiveHint: dangerous,
		idempotentHint:
			readOnly ||
			name === "init" ||
			name === "transfer" ||
			name === "start_call" ||
			name === "cancel_operation",
		openWorldHint: dangerous || name === "read",
	};
}

interface RequestContext {
	mcpReq: {
		_meta?: Record<string, unknown>;
		signal: AbortSignal;
	};
}

function callbackEndpointError(error: unknown): ProtocolError {
	const message = error instanceof Error ? error.message : String(error);
	const lower = message.toLowerCase();
	const reason = lower.includes("timeout")
		? "timeout"
		: lower.includes("challenge")
			? "challenge_failed"
			: lower.includes("https") || lower.includes("public")
				? "invalid_url"
				: "verification_failed";
	return new ProtocolError(-32015, "Callback endpoint verification failed", {
		reason,
	});
}
export function createServer(broker: Broker): McpServer {
	const capabilities = { tools: {}, events: {} };
	const server = new McpServer(
		{
			name: "chappie",
			version: packageJson.version,
		},
		{
			instructions: [
				instructions,
				...(broker.askEnabled ? [questionInstructions] : []),
			].join("\n\n"),
			capabilities,
		},
	);

	function handle<Args, Result>(
		callback: (args: Args, context: RequestContext) => Promise<Result>,
	) {
		return (args: Args, context: RequestContext): Promise<Result> => {
			requireChatId(context);
			context.mcpReq.signal.throwIfAborted();
			return callback(args, context);
		};
	}

	server.registerTool(
		"init",
		{
			title: "Connect to OMP",
			description:
				"Select this chat's default OMP session and return its environment, tool catalog, and participation instructions. Use the task's sessionId to resume, or find it by cwd/name with sessions. For a task without a specified target, omit sessionId to reuse the default or select the first online, unbound session. Read recent history when resuming work.",
			outputSchema,
			inputSchema: z.object({
				sessionId: z
					.string()
					.optional()
					.describe("Default OMP session ID; may be shared with other chats"),
			}),
			annotations: toolAnnotations("init"),
		},
		handle(async (args, context) => {
			const chatId = requireChatId(context);
			const { inputs, ...initialized } = await broker.initialize(
				chatId,
				args.sessionId,
				context.mcpReq._meta?.["otunnel/requestId"],
				context.mcpReq.signal,
			);
			return finishResult(
				broker,
				context,
				textResult(initialized, inputs),
				initialized.initialization?.mode !== "observer",
			);
		}),
	);

	server.registerTool(
		"chat",
		{
			title: "Reply in OMP",
			description:
				"Send a Markdown assistant message to OMP. When modelRequest is returned by a prior Chappie result, set replyTo to that modelRequest ID.",
			outputSchema,
			inputSchema: z.object({
				text: z.string().min(1).describe("Assistant message in Markdown"),
				sessionId: z
					.string()
					.optional()
					.describe(
						"OMP session for this operation; becomes the default if none is set",
					),
				replyTo: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Model request ID to answer instead of starting a OMP turn",
					),
			}),
			annotations: toolAnnotations("chat"),
		},
		handle(async (args, context) => {
			const chatId = requireChatId(context);
			const { sessionId, cwd, inputs, initialization, replay } =
				await broker.chat(
					chatId,
					args.sessionId,
					args.text,
					context.mcpReq._meta?.["otunnel/requestId"],
					context.mcpReq.signal,
					args.replyTo,
				);
			return finishResult(
				broker,
				context,
				textResult(
					{
						sessionId,
						cwd,
						...(initialization ? { initialization } : {}),
						...(replay ? { replay } : {}),
					},
					inputs,
				),
			);
		}),
	);

	if (broker.askEnabled) {
		server.registerTool(
			"ask",
			{
				title: "Ask in ChatGPT",
				description:
					"Request a question widget in ChatGPT and return its ID immediately. Display depends on the host; call ask_assert next with question.id to confirm loading. Answers, revisions, and skips arrive as webAnswer in later tool results.",
				inputSchema: questionInput.extend({
					sessionId: z
						.string()
						.optional()
						.describe(
							"OMP session for this question; defaults to this chat's session",
						),
				}),
				outputSchema: questionSchema,
				annotations: toolAnnotations("ask"),
				_meta: { ui: { resourceUri: questionTemplate } },
			},
			handle(async ({ sessionId, ...input }, context) => {
				const { initialization, ...question } = await broker.ask(
					requireChatId(context),
					sessionId,
					input,
					context.mcpReq._meta?.["otunnel/requestId"],
					context.mcpReq.signal,
				);
				const result = await finishResult(broker, context, {
					content: [
						...(initialization ? textResult({ initialization }).content : []),
						{
							type: "text",
							text: `Question widget requested. Call ask_assert({"questionId":"${question.id}"}) next.`,
						},
					],
				});
				return {
					...result,
					structuredContent: { ...result.structuredContent, question },
				};
			}),
		);

		server.registerTool(
			"ask_assert",
			{
				title: "Assert question display",
				description:
					"Confirm that an ask widget loaded in ChatGPT. Call immediately after ask with question.id. Fails after 10 seconds without loading and records the question as skipped. Use a OMP interactive tool if an answer is needed. User answers arrive separately as webAnswer.",
				inputSchema: z.object({
					questionId: z.string().describe("question.id returned by ask"),
				}),
				outputSchema: questionSchema,
				annotations: toolAnnotations("ask_assert"),
			},
			handle(async ({ questionId }, context) => {
				const question = await broker.assertQuestion(
					requireChatId(context),
					questionId,
					context.mcpReq.signal,
				);
				const result = await finishResult(broker, context, {
					content: [{ type: "text", text: "Question widget loaded." }],
				});
				return {
					...result,
					structuredContent: { ...result.structuredContent, question },
				};
			}),
		);

		server.registerTool(
			"answer",
			{
				title: "Question state",
				description:
					"Read a saved question, report widget loading, or save an answer, revision, or skip.",
				inputSchema: z.object({
					questionId: z.string(),
					answer: answerInput.optional(),
					loaded: z
						.literal(true)
						.optional()
						.describe("The question widget has loaded"),
				}),
				outputSchema: questionSchema,
				annotations: toolAnnotations("answer"),
				_meta: { ui: { visibility: ["app"] }, "openai/widgetAccessible": true },
			},
			async ({ questionId, answer, loaded = false }, context) => {
				const question = await broker.answer(
					requireChatId(context),
					questionId,
					answer,
					loaded,
				);
				const text = answer
					? answer.skipped
						? "Question skipped."
						: "Answer saved."
					: loaded
						? "Question widget loaded."
						: "Question state.";
				return {
					content: [{ type: "text", text }],
					structuredContent: { text, question },
				};
			},
		);

		server.registerResource(
			"question",
			questionTemplate,
			{ title: "Chappie question", mimeType: "text/html;profile=mcp-app" },
			async () => ({
				contents: [
					{
						uri: questionTemplate,
						mimeType: "text/html;profile=mcp-app",
						text: readFileSync(
							new URL("./question.html", import.meta.url),
							"utf8",
						),
						_meta: {
							ui: {
								prefersBorder: true,
								csp: { connectDomains: [], resourceDomains: [] },
							},
							"openai/widgetDescription":
								"A question the user can answer or revise.",
						},
					},
				],
			}),
		);
	}

	server.registerTool(
		"tools",
		{
			title: "OMP tools",
			description:
				"Get full definitions of OMP tools for call. Filter by names, or omit names to list all active tools.",
			outputSchema,
			inputSchema: z.object({
				names: z
					.array(z.string())
					.min(1)
					.optional()
					.describe("Tool names to describe; omit to return every active tool"),
				sessionId: z
					.string()
					.optional()
					.describe(
						"OMP session for this operation; becomes the default if none is set",
					),
			}),
			annotations: toolAnnotations("tools"),
		},
		handle(async (args, context) => {
			const { inputs, ...inspected } = await broker.tools(
				requireChatId(context),
				args.sessionId,
				args.names,
				context.mcpReq._meta?.["otunnel/requestId"],
				context.mcpReq.signal,
			);
			return finishResult(
				broker,
				context,
				textResult(
					{
						session: inspected.session,
						tools: inspected.tools,
						...(inspected.initialization
							? { initialization: inspected.initialization }
							: {}),
					},
					inputs,
				),
			);
		}),
	);

	server.registerTool(
		"call",
		{
			title: "Call OMP tools",
			description:
				"Execute OMP tools using the definitions returned by tools. Each calls array is one native OMP batch.",
			outputSchema,
			inputSchema: z.strictObject({
				calls: nativeCallsSchema,
				sessionId: z.string().optional().describe("OMP session for this batch"),
			}),
			annotations: toolAnnotations("call"),
		},
		handle(async (args, context) => {
			const result = await broker.call(
				requireChatId(context),
				args.sessionId,
				args.calls,
				context.mcpReq._meta?.["otunnel/requestId"],
				context.mcpReq.signal,
			);
			return finishResult(
				broker,
				context,
				toolResult(
					result.toolResults,
					result.sessionId,
					result.cwd,
					result.inputs,
					result.initialization,
					result.replay,
				),
			);
		}),
	);

	server.registerTool(
		"start_call",
		{
			title: "Start long OMP tool batch",
			description:
				"Start a native OMP tool batch independently of this ChatGPT MCP request. Returns durable operation status, not an MCP Tasks handle. Subscribe to operation.finished for completion, or use get_operation to recover the result. Reuse the same operationId for transport retries; never change its arguments.",
			outputSchema,
			inputSchema: z.strictObject({
				operationId: z
					.string()
					.trim()
					.min(1)
					.max(128)
					.describe("Stable identifier; reuse only for the same operation."),
				calls: nativeCallsSchema,
				sessionId: z
					.string()
					.optional()
					.describe("OMP session for this operation"),
			}),
			annotations: toolAnnotations("start_call"),
		},
		handle(async (args, context) => {
			const result = await broker.startCall(
				requireChatId(context),
				args.sessionId,
				args.calls,
				args.operationId,
				context.mcpReq._meta?.["otunnel/requestId"],
				context.mcpReq.signal,
			);
			return finishResult(
				broker,
				context,
				textResult({
					operation: result.operation,
					...(result.initialization
						? { initialization: result.initialization }
						: {}),
				}),
			);
		}),
	);

	server.server.setRequestHandler(
		"events/list",
		{
			params: eventsListParamsSchema,
			result: eventsListResultSchema,
		},
		async (_params, context) => {
			requireChatId(context);
			return eventsListResultSchema.parse({
				events: [EVENT_DEFINITION],
			});
		},
	);
	server.server.setRequestHandler(
		"events/subscribe",
		{
			params: eventsSubscribeParamsSchema,
			result: eventsSubscribeResultSchema,
		},
		async (params, context) => {
			const chatId = requireChatId(context);
			try {
				broker.operation(chatId, params.arguments.operation_id);
			} catch {
				throw new ProtocolError(
					ProtocolErrorCode.InvalidParams,
					"Unknown operation_id for this conversation",
				);
			}
			let subscription: Awaited<ReturnType<Broker["subscribeOperationEvent"]>>;
			try {
				subscription = await broker.subscribeOperationEvent(
					chatId,
					params.arguments.operation_id,
					params.delivery.url,
					params.delivery.secret,
					params.ttlMs,
					context.mcpReq.signal,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.toLowerCase().includes("signing secret"))
					throw new ProtocolError(ProtocolErrorCode.InvalidParams, message);
				throw callbackEndpointError(error);
			}
			return eventsSubscribeResultSchema.parse({
				id: subscription.id,
				refreshBefore:
					subscription.expiresAt === null
						? null
						: new Date(subscription.expiresAt).toISOString(),
				cursor: null,
				truncated: false,
			});
		},
	);
	server.server.setRequestHandler(
		"events/unsubscribe",
		{
			params: eventsUnsubscribeParamsSchema,
			result: eventsUnsubscribeResultSchema,
		},
		async (params, context) => {
			const chatId = requireChatId(context);
			if (params.name !== OPERATION_FINISHED_EVENT)
				throw new ProtocolError(
					ProtocolErrorCode.InvalidParams,
					"Unknown event name",
				);
			await broker.unsubscribeOperationEvent(
				chatId,
				params.arguments.operation_id,
				params.delivery.url,
			);
			return eventsUnsubscribeResultSchema.parse({});
		},
	);

	server.registerTool(
		"get_operation",
		{
			title: "Get long operation status",
			description:
				"Read the durable status and retained native result of a start_call operation. Completion refers to the native batch, not child jobs it may have started. Result retrieval is repeatable; it never re-executes the work.",
			outputSchema,
			inputSchema: z.object({
				operationId: z.string().trim().min(1).max(128),
			}),
			annotations: toolAnnotations("get_operation"),
		},
		handle(async ({ operationId }, context) => {
			const result = broker.operation(requireChatId(context), operationId);
			const formatted = await finishResult(
				broker,
				context,
				{
					content: [
						...textResult({ operation: result.operation }).content,
						...(result.result
							? toolResult(
									result.result.toolResults,
									result.result.sessionId,
									result.result.cwd,
								).content
							: deliveryContent(result.deliveries)),
					],
				},
				false,
			);
			await broker.acknowledge(result.deliveries, [], context.mcpReq.signal);
			return formatted;
		}),
	);

	server.registerTool(
		"cancel_operation",
		{
			title: "Cancel long operation",
			description:
				"Cancel a running operation started with start_call. Cancellation is explicit and independent of the originating ChatGPT MCP request. Repeating cancellation is safe and returns the current durable state.",
			outputSchema,
			inputSchema: z.object({
				operationId: z.string().trim().min(1).max(128),
			}),
			annotations: toolAnnotations("cancel_operation"),
		},
		handle(async ({ operationId }, context) => {
			const result = await broker.cancelOperation(
				requireChatId(context),
				operationId,
			);
			return finishResult(
				broker,
				context,
				textResult({ operation: result.operation }),
			);
		}),
	);

	for (const tool of directTools) {
		server.registerTool(
			tool.name,
			{
				title: tool.name,
				description: tool.description,
				outputSchema,
				inputSchema: tool.inputSchema,
				annotations: toolAnnotations(tool.name),
				...(tool.fileParams
					? { _meta: { "openai/fileParams": tool.fileParams } }
					: {}),
			},
			handle(async (args, context) => {
				const input = { ...args } as Record<string, unknown> & {
					sessionId?: string;
				};
				const sessionId = input.sessionId;
				delete input.sessionId;
				const calls: ToolInput[] = [
					{ name: tool.name, arguments: input as ToolInput["arguments"] },
				];
				const result = await broker.call(
					requireChatId(context),
					sessionId,
					calls,
					context.mcpReq._meta?.["otunnel/requestId"],
					context.mcpReq.signal,
					true,
				);
				return finishResult(
					broker,
					context,
					toolResult(
						result.toolResults,
						result.sessionId,
						result.cwd,
						result.inputs,
						result.initialization,
						result.replay,
					),
				);
			}),
		);
	}

	server.registerTool(
		"history",
		{
			title: "Session history",
			description:
				"Read OMP history with entry IDs and timestamps. Use before/after to page the current branch, and wait to follow new progress when caught up. Set observer when reading as an observer. An explicit sessionId applies only to this read.",
			inputSchema: historyInput.extend({
				sessionId: z
					.string()
					.optional()
					.describe("OMP session to read; defaults to this chat's session"),
			}),
			outputSchema,
			annotations: toolAnnotations("history"),
		},
		handle(async ({ sessionId, ...range }, context) => {
			const { history, ...session } = await broker.history(
				requireChatId(context),
				sessionId,
				range,
				context.mcpReq._meta?.["otunnel/requestId"],
				context.mcpReq.signal,
			);
			const { content, ...page } = history;
			return formatResult(
				{
					content: [
						...textResult({ ...session, history: page }).content,
						...content,
					],
				},
				requireChatId(context),
			);
		}),
	);

	server.registerTool(
		"sessions",
		{
			title: "Local sessions",
			description:
				"List online OMP sessions with their IDs, devices, cwd, names, execution status, and saved binding counts. Also returns this chat's default.",
			outputSchema,
			inputSchema: z.object({
				sessionId: z
					.string()
					.optional()
					.describe("Filter the online list to this OMP session"),
			}),
			annotations: toolAnnotations("sessions"),
		},
		handle(async (args, context) => {
			const chatId = requestChatId(context);
			const result = textResult({
				binding: chatId ? (broker.binding(chatId) ?? null) : null,
				sessions: broker.listSessions(args.sessionId),
			});
			return finishResult(broker, context, result);
		}),
	);

	server.registerResource(
		"OMP resource",
		new ResourceTemplate(
			"chappie://session/{sessionId}/{kind}/{id}/{name}{?chatId}",
			{
				list: undefined,
			},
		),
		{ title: "OMP resource" },
		async (uri, _variables, context) => {
			const resource = await broker.readResource(
				uri.href,
				context.mcpReq.signal,
			);
			return {
				contents: [
					{
						uri: resource.uri,
						mimeType: resource.mimeType,
						blob: resource.blob,
					},
				],
			};
		},
	);

	return server;
}

function textResult(
	value: unknown,
	inputs: Parameters<typeof inputContent>[0] = [],
) {
	return {
		content: [
			{ type: "text" as const, text: JSON.stringify(value) },
			...inputContent(inputs),
		],
	};
}

async function finishResult<
	T extends { content: ReturnType<typeof toolResult>["content"] },
>(broker: Broker, context: RequestContext, result: T, deliverPending = true) {
	context.mcpReq.signal.throwIfAborted();
	const chatId = requestChatId(context);
	if (!deliverPending) return formatResult(result, chatId);
	const deliveries = chatId ? broker.deliveries(chatId) : [];
	const answers = chatId ? broker.answers(chatId) : [];
	const content = [
		...result.content,
		...deliveryContent(deliveries),
		...answerContent(answers),
	];
	// Validate/serialize before consuming durable pending results.
	const formatted = formatResult({ ...result, content }, chatId);
	await broker.acknowledge(deliveries, answers, context.mcpReq.signal);
	return formatted;
}

function formatResult<
	T extends { content: ReturnType<typeof toolResult>["content"] },
>(result: T, chatId?: string) {
	const content = result.content.map((block) => {
		if (block.type !== "resource_link" || !chatId) return block;
		const uri = new URL(block.uri);
		uri.searchParams.set("chatId", chatId);
		return { ...block, uri: uri.href };
	});
	return {
		...result,
		content,
		structuredContent: {
			text: content
				.flatMap((block) => (block.type === "text" ? [block.text] : []))
				.join("\n"),
		},
	};
}

function requestChatId(context: RequestContext): string | undefined {
	const value = context.mcpReq._meta?.["openai/session"];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireChatId(context: RequestContext): string {
	const chatId = requestChatId(context);
	if (!chatId)
		throw new Error("ChatGPT did not provide openai/session metadata");
	return chatId;
}
