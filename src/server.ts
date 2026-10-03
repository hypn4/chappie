import { readFileSync } from "node:fs";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod";
import packageJson from "../package.json" with { type: "json" };
import type { Broker } from "./broker.ts";
import { deliveryContent, toolResultsContent } from "./delivery.ts";
import { historyInput } from "./history.ts";
import { nativeCallsSchema } from "./native-calls.ts";
import {
	answerContent,
	answerInput,
	questionInput,
	questionInstructions,
	questionOutput,
} from "./questions.ts";
import { MAX_RESULT_BYTES } from "./responses.ts";
import { inputContent, toolResult } from "./tools.ts";
import { operationIdSchema, transferSchema } from "./transfer.ts";
import { continuationFor } from "./work.ts";

const instructions = readFileSync(
	new URL("./instructions.md", import.meta.url),
	"utf8",
).trim();

const outputSchema = z.object({
	text: z
		.string()
		.describe(
			"Inline text, or a durable result reference/continuation page for oversized output. Images and file resources remain native content blocks when inline.",
		),
});

const questionTemplate = "ui://chappie/question.html";
const questionSchema = outputSchema.extend({ question: questionOutput });
function toolAnnotations(name: string) {
	const readOnly = ["tools", "history", "sessions", "get_operation"].includes(
		name,
	);
	const dangerous = [
		"call",
		"start_call",
		"cancel_operation",
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
		openWorldHint: dangerous,
	};
}

interface RequestContext {
	mcpReq: {
		id: string | number;
		_meta?: Record<string, unknown>;
		signal: AbortSignal;
	};
}

export type ResponseCommit = () => Promise<void>;
export type StageResponseCommit = (
	requestId: string | number,
	commit: ResponseCommit,
) => void;

const committedSignal = new AbortController().signal;

export function createServer(
	broker: Broker,
	stageResponseCommit: StageResponseCommit,
): McpServer {
	const capabilities = { tools: {} };
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
		return async (args: Args, context: RequestContext) => {
			const chatId = requireChatId(context);
			context.mcpReq.signal.throwIfAborted();
			const result = await callback(args, context).catch(
				async (error: unknown) => {
					const message =
						error instanceof Error ? error.message : String(error);
					if (Buffer.byteLength(message) <= MAX_RESULT_BYTES / 4) throw error;
					const resultId = await broker.saveResponse(
						chatId,
						JSON.stringify({ isError: true, message }),
					);
					throw new Error(
						`Tool failed. Full error is retained: get_operation(${JSON.stringify({ resultId, offset: 0 })})`,
					);
				},
			);
			if (Buffer.byteLength(JSON.stringify(result)) <= MAX_RESULT_BYTES - 1024)
				return result;
			const resultId = await broker.saveResponse(
				chatId,
				JSON.stringify(result),
			);
			context.mcpReq.signal.throwIfAborted();
			const reference = formatResult(
				textResult({
					resultId,
					format: "json",
					next: { resultId, offset: 0 },
					message:
						"Full response retained; snapshots expire 24h after first capture. Read sequential get_operation pages without repeating the original operation.",
				}),
				chatId,
			);
			// Keep small widget state inline even when unrelated pending text is paged.
			if (
				typeof result === "object" &&
				result !== null &&
				"structuredContent" in result
			) {
				const structured = result.structuredContent;
				if (
					typeof structured === "object" &&
					structured !== null &&
					"question" in structured
				) {
					const widget = {
						...reference,
						structuredContent: {
							...reference.structuredContent,
							question: structured.question,
						},
					};
					if (
						Buffer.byteLength(JSON.stringify(widget)) >
						MAX_RESULT_BYTES - 1024
					)
						throw new Error(
							`Question metadata exceeds the inline budget; saved resultId=${resultId}. Shorten the question before opening a widget.`,
						);
					return widget;
				}
			}
			return reference;
		};
	}

	function finish<
		T extends { content: ReturnType<typeof toolResult>["content"] },
	>(
		context: RequestContext,
		result: T,
		deliverPending = true,
		afterSend?: ResponseCommit,
	) {
		return finishResult(
			broker,
			stageResponseCommit,
			context,
			result,
			deliverPending,
			afterSend,
		);
	}

	server.registerTool(
		"init",
		{
			title: "Connect to OMP",
			description:
				"Select this chat's default OMP session and return its environment, active native tool and Skill shortlists, and participation instructions. Tool shortlist entries are for capability selection only; use tools before first native use to obtain the current full definition. Large catalogs return resultId; follow get_operation pages to inspect every entry. Read task-relevant Skills through their skill:// URI instead of preloading all Skill contents. Use the task's sessionId to resume, or find it by cwd/name with sessions. Read recent history when resuming work.",
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
			return finish(
				context,
				textResult(initialized, inputs),
				initialized.initialization?.mode !== "observer",
				initialized.initialization?.mode !== "observer" && inputs.length
					? () => broker.acknowledgeInputs(initialized.session.id, inputs)
					: undefined,
			);
		}),
	);

	server.registerTool(
		"chat",
		{
			title: "Reply in OMP",
			description:
				"Report progress to OMP without ending or starting a provider turn (default mode=progress). Use mode=message only for an intentional assistant turn after reviewing the requested scope, or replyTo for a recognized model request. Neither a progress report nor a native turn means the whole user task is complete.",
			outputSchema,
			inputSchema: z
				.object({
					text: z.string().min(1).describe("Assistant message in Markdown"),
					mode: z
						.enum(["progress", "message"])
						.optional()
						.describe(
							"Defaults to progress: report without a provider stop. message completes one native assistant turn. replyTo implies message and cannot use progress.",
						),
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
				})
				.refine((args) => !(args.mode === "progress" && args.replyTo), {
					message: "Progress cannot answer a model request",
				}),
			annotations: toolAnnotations("chat"),
		},
		handle(async (args, context) => {
			const result = await broker.chat(
				requireChatId(context),
				args.sessionId,
				args.text,
				context.mcpReq._meta?.["otunnel/requestId"],
				context.mcpReq.signal,
				args.replyTo,
				args.mode ?? (args.replyTo ? "message" : "progress"),
			);
			return finish(
				context,
				toolResult(
					[],
					result.sessionId,
					result.cwd,
					result.inputs,
					result.initialization,
					result.replay,
					result.execution,
					{
						work: result.work,
						scope: args.mode ?? (args.replyTo ? "message" : "progress"),
					},
				),
				true,
				!result.execution && result.inputs.length
					? () => broker.acknowledgeInputs(result.sessionId, result.inputs)
					: undefined,
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
				const result = await finish(context, {
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
				const result = await finish(context, {
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
				"Get current full definitions for selected active OMP tools, including registered MCP-backed tools. Before first use, request every candidate definition needed for the decision; reuse definitions while the session and native toolset are unchanged, and refresh after a session/toolset change or unavailable/schema error. Omit names only to inspect the entire active catalog.",
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
			return finish(
				context,
				textResult(
					{
						session: inspected.session,
						tools: inspected.tools,
						...(inspected.work ? { work: inspected.work } : {}),
						...(inspected.initialization
							? { initialization: inspected.initialization }
							: {}),
					},
					inputs,
				),
				true,
				inputs.length
					? () => broker.acknowledgeInputs(inspected.session.id, inputs)
					: undefined,
			);
		}),
	);

	server.registerTool(
		"call",
		{
			title: "Call OMP tools",
			description:
				"Execute one discovered native OMP batch. Fast results return inline; after a 25-second native wait budget, a durably accepted batch yields operation.operationId without cancelling execution. Recover with get_operation; cancel explicitly with cancel_operation. Prefer start_call for known long work. Neither result form completes the user goal: inspect continuation/work and continue authorized scope. Use the most specific native capability; prefer focused native edits over encoded shell mutation scripts. Batch only independent calls; dependent edits and checks require separate batches. Native schemas and permissions remain OMP-owned. needs_input/executed:false means no work ran.",
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
			return finish(
				context,
				toolResult(
					result.toolResults,
					result.sessionId,
					result.cwd,
					result.inputs,
					result.initialization,
					result.replay,
					result.execution,
					{ work: result.work, operation: result.operation },
				),
				true,
				!result.execution && result.inputs.length
					? () => broker.acknowledgeInputs(result.sessionId, result.inputs)
					: undefined,
			);
		}),
	);

	server.registerTool(
		"start_call",
		{
			title: "Start long OMP tool batch",
			description:
				"Start one discovered native OMP batch independently of this MCP request. Apply the same discovery, focused native editing and independent-batch rules as call; do not replace native edits with encoded shell mutation scripts. Returns one batch's durable operation status, not completion of all TODOs. Use get_operation or a later Chappie interaction to recover status and retained results. Reuse the same operationId and arguments; explicitly resume waiting_input only after handling its model request.",
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
			return finish(
				context,
				textResult({
					operation: result.operation,
					continuation: continuationFor({
						operationStatus: result.operation.status,
					}),
					...(result.initialization
						? { initialization: result.initialization }
						: {}),
				}),
			);
		}),
	);

	server.registerTool(
		"get_operation",
		{
			title: "Get long operation status",
			description:
				"Read an operation with operationId, or recover an oversized tool response with resultId and offset. Follow nextOffset while hasMore is true; pages contain ordered JSON-fragment text. Neither path re-executes native work. waiting_input is a known-unexecuted batch; completed refers to its native batch, not child jobs or the user goal. Retained work observations are historical; check the current scoped tracker before deciding the next action.",
			outputSchema,
			inputSchema: z
				.object({
					operationId: z.string().trim().min(1).max(128).optional(),
					resultId: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.optional(),
					offset: z.number().int().nonnegative().safe().optional(),
				})
				.refine(
					(value) =>
						(value.operationId !== undefined) !==
						(value.resultId !== undefined),
					"Supply operationId or resultId, not both",
				)
				.refine(
					(value) => value.offset === undefined || value.resultId !== undefined,
					"offset requires resultId",
				),
			annotations: toolAnnotations("get_operation"),
		},
		handle(async ({ operationId, resultId, offset = 0 }, context) => {
			const chatId = requireChatId(context);
			if (resultId) {
				const text = await broker.readResponse(chatId, resultId);
				return responsePage(resultId, text, offset, chatId);
			}
			if (!operationId) throw new Error("operationId is required");
			const result = broker.operation(chatId, operationId);
			return finish(
				context,
				{
					content: [
						...textResult(
							{
								operation: result.operation,
								...(result.result?.work ? { work: result.result.work } : {}),
								continuation: continuationFor({
									operationStatus: result.operation.status,
									work: result.result?.work,
									needsInput: result.inputs.length > 0,
									failed:
										Boolean(result.result?.error) ||
										(result.result?.toolResults.some(
											(item) =>
												item.isError ||
												(item.details as { failed?: boolean } | undefined)
													?.failed === true,
										) ??
											false),
								}),
							},
							result.inputs,
						).content,
						...(result.result
							? toolResultsContent(
									result.result.toolResults,
									result.result.sessionId,
								)
							: deliveryContent(result.deliveries)),
					],
				},
				false,
				result.deliveries.length
					? () => broker.acknowledge(result.deliveries, [], committedSignal)
					: undefined,
			);
		}),
	);

	server.registerTool(
		"cancel_operation",
		{
			title: "Cancel long operation",
			description:
				"Cancel a running operation started with start_call or yielded by call. Cancellation is explicit and independent of the originating ChatGPT MCP request. Repeating cancellation is safe and returns the current durable state.",
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
			return finish(context, textResult({ operation: result.operation }));
		}),
	);

	server.registerTool(
		"transfer",
		{
			title: "Transfer files",
			description:
				"Import host-injected ChatGPT files, copy between OMP sessions, or export local files and images.",
			outputSchema,
			inputSchema: transferSchema.extend({
				operationId: operationIdSchema,
				sessionId: z
					.string()
					.min(1)
					.optional()
					.describe("OMP session for this transfer"),
			}),
			annotations: toolAnnotations("transfer"),
			_meta: { "openai/fileParams": ["files"] },
		},
		handle(async ({ sessionId, ...input }, context) => {
			const result = await broker.call(
				requireChatId(context),
				sessionId,
				[{ name: "transfer", arguments: input }],
				context.mcpReq._meta?.["otunnel/requestId"],
				context.mcpReq.signal,
				true,
			);
			return finish(
				context,
				toolResult(
					result.toolResults,
					result.sessionId,
					result.cwd,
					result.inputs,
					result.initialization,
					result.replay,
					result.execution,
					{ work: result.work },
				),
				true,
				!result.execution && result.inputs.length
					? () => broker.acknowledgeInputs(result.sessionId, result.inputs)
					: undefined,
			);
		}),
	);

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
			return finish(context, result);
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

function responsePage(
	resultId: string,
	text: string,
	offset: number,
	chatId: string,
) {
	if (offset > text.length)
		throw new Error("Result offset exceeds the snapshot length");
	const page = (end: number) =>
		formatResult(
			textResult({
				resultId,
				format: "json-fragment",
				offset,
				text: text.slice(offset, end),
				hasMore: end < text.length,
				...(end < text.length ? { nextOffset: end } : {}),
				totalCharacters: text.length,
			}),
			chatId,
		);
	let low = offset,
		high = Math.min(text.length, offset + MAX_RESULT_BYTES);
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (
			Buffer.byteLength(JSON.stringify(page(middle))) <=
			MAX_RESULT_BYTES - 1024
		)
			low = middle;
		else high = middle - 1;
	}
	// Do not split a Unicode surrogate pair across pages.
	if (
		low > offset &&
		low < text.length &&
		/[\uD800-\uDBFF]/.test(text[low - 1] ?? "")
	)
		low--;
	if (low === offset && offset < text.length)
		throw new Error("Cannot fit result page");
	return page(low);
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
>(
	broker: Broker,
	stageResponseCommit: StageResponseCommit,
	context: RequestContext,
	result: T,
	deliverPending = true,
	afterSend?: ResponseCommit,
) {
	context.mcpReq.signal.throwIfAborted();
	const chatId = requestChatId(context);
	const deliveries = deliverPending && chatId ? broker.deliveries(chatId) : [];
	const answers = deliverPending && chatId ? broker.answers(chatId) : [];
	const content = deliverPending
		? [
				...result.content,
				...deliveryContent(deliveries),
				...answerContent(answers),
			]
		: result.content;
	const formatted = formatResult({ ...result, content }, chatId);
	const commits: ResponseCommit[] = [];
	if (deliveries.length || answers.length)
		commits.push(() =>
			broker.acknowledge(deliveries, answers, committedSignal),
		);
	if (afterSend) commits.push(afterSend);
	if (commits.length)
		stageResponseCommit(context.mcpReq.id, async () => {
			for (const commit of commits) await commit();
		});
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
