import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { UserMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI as PiExtensionAPI,
	ExtensionContext as PiExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI as OmpExtensionAPI,
	ExtensionContext as OmpExtensionContext,
	ToolInfo as OmpToolInfo,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	type Activity,
	chatLabel,
	type Source,
	sameSource,
	source,
} from "./activity.ts";
import type { NetworkTlsConfig } from "./config.ts";
import type { DeliveryRecord } from "./delivery.ts";
import { type HistoryRange, historyResult } from "./history.ts";
import { directHostCall, directHostResults } from "./host-tools.ts";
import {
	type BrokerMessage,
	IpcClient,
	type ModelRequest,
	type SessionDescription,
	type SessionInput,
	type SessionInspection,
	type SessionRequest,
	type SessionResult,
	type SessionSkillInfo,
	type SessionStatus,
	type SessionToolInfo,
	type SessionToolResult,
} from "./ipc.ts";
import { markOmpPrimaryContext } from "./omp-primary-context.ts";
import { ProviderOutput } from "./provider-core.ts";
import {
	type ResourceDescriptor,
	readSessionResource,
	releaseSessionResources,
	rememberImages,
	resourceSessionId,
} from "./resources.ts";
import type { ToolInput } from "./tools.ts";
import {
	copyFiles,
	executeTransfer,
	type TransferArgs,
	type TransferExecutionContext,
	type TransferResult,
	type TransferUpdate,
	transferResult,
} from "./transfer.ts";

type RemoteRequest = Extract<BrokerMessage, { type: "chat" | "call" }>;

interface Notice extends Activity {
	message: string;
	type: "info" | "warning" | "error";
}

type SessionHost = "pi" | "omp";

interface ChappieHostAPI {
	appendEntry(customType: string, data?: unknown): void;
	getSessionName(): string | undefined;
	getActiveTools(): string[];
	getAllTools(): SessionToolInfo[];
	getCommands(): SessionSkillInfo[];
	sendMessage(
		message: { customType: string; content: string; display: boolean },
		options?: { triggerTurn?: boolean },
	): void;
}

interface ChappieSessionManager {
	getSessionId(): string;
	getCwd(): string;
	getLeafId(): string | null;
	getLeafEntry(): SessionEntry | undefined;
	getEntry(id: string): SessionEntry | undefined;
	getBranch(): SessionEntry[];
}

interface ChappieContext {
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
	readonly cwd: string;
	readonly model: { provider: string } | undefined;
	sessionManager: ChappieSessionManager;
	isIdle(): boolean;
	abort(): void;
}

type OmpWireSchema = (tool: OmpToolInfo) => Record<string, unknown>;

export function createPiHostApi(pi: PiExtensionAPI): ChappieHostAPI {
	return {
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
		getSessionName: () => pi.getSessionName(),
		getActiveTools: () => pi.getActiveTools(),
		getAllTools: () => pi.getAllTools(),
		getCommands: () => pi.getCommands(),
		sendMessage: (message, options) => pi.sendMessage(message, options),
	};
}

export function createOmpHostApi(
	pi: OmpExtensionAPI,
	wireSchema: OmpWireSchema,
): ChappieHostAPI {
	return {
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
		getSessionName: () => pi.getSessionName(),
		getActiveTools: () => pi.getActiveTools(),
		getAllTools: () =>
			pi.getAllTools().map((tool) => {
				try {
					return { ...tool, parameters: wireSchema(tool) };
				} catch (error) {
					return {
						...tool,
						parameters: undefined,
						schemaError: `Cannot expose native tool schema: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
			}),
		getCommands: () => pi.getCommands(),
		sendMessage: (message, options) => pi.sendMessage(message, options),
	};
}

function adaptPiContext(context: PiExtensionContext): ChappieContext {
	const sessionManager = context.sessionManager;
	return {
		ui: context.ui,
		get cwd() {
			return sessionManager.getCwd();
		},
		get model() {
			return context.model ? { provider: context.model.provider } : undefined;
		},
		sessionManager,
		isIdle: () => context.isIdle(),
		abort: () => context.abort(),
	};
}

function adaptOmpContext(context: OmpExtensionContext): ChappieContext {
	const sessionManager = context.sessionManager;
	return {
		ui: context.ui,
		get cwd() {
			return sessionManager.getCwd();
		},
		get model() {
			return context.model ? { provider: context.model.provider } : undefined;
		},
		sessionManager: {
			getSessionId: () => sessionManager.getSessionId(),
			getCwd: () => sessionManager.getCwd(),
			getLeafId: () => sessionManager.getLeafId(),
			// SAFETY: Chappie only consumes the shared persisted entry fields
			// (type/id/parent/message/custom payloads) that Pi and OMP keep compatible.
			getLeafEntry: () =>
				sessionManager.getLeafEntry() as SessionEntry | undefined,
			getEntry: (id) => sessionManager.getEntry(id) as SessionEntry | undefined,
			getBranch: () => sessionManager.getBranch() as SessionEntry[],
		},
		isIdle: () => context.isIdle(),
		abort: () => context.abort(),
	};
}

interface SyncRequest {
	resolve(): void;
	reject(error: Error): void;
}

interface StoreRequest {
	resolve(): void;
	reject(error: Error): void;
}

interface PendingRequest {
	resolve(result: SessionResult): void;
	reject(error: Error): void;
}

interface HistoryRequest {
	request: Extract<BrokerMessage, { type: "history" }>;
	timeout: NodeJS.Timeout;
}

interface ActiveRequest {
	id: string;
	connectionGeneration: number;
	request: RemoteRequest;
	session: SessionDescription;
	message: ProviderOutput["message"];
	completed: boolean;
	error?: string;
	cancelled: string | undefined;
	toolResults: SessionToolResult[];
}

interface GenerationRequest {
	output: ProviderOutput;
	request: ModelRequest;
	sessionId: string;
	connectionGeneration: number;
}

export class LocalSession {
	readonly #api: ChappieHostAPI;
	readonly #agentDir: string;
	readonly #connect: string | undefined;
	readonly #host: SessionHost;
	readonly #tls: NetworkTlsConfig | undefined;
	readonly #localTools: boolean;
	readonly #syncs = new Map<number, SyncRequest>();
	readonly #stores = new Map<string, StoreRequest>();
	readonly #queue: RemoteRequest[] = [];
	readonly #pendingInputs = new Map<string, SessionInput>();
	readonly #generations = new Map<string, GenerationRequest>();
	readonly #deliveries = new Map<string, DeliveryRecord>();
	readonly #histories = new Map<number, HistoryRequest>();
	readonly #requests = new Map<number, PendingRequest>();
	readonly #operations = new Map<
		number,
		{ controller: AbortController; suppressAbortResponse: boolean }
	>();
	#context: ChappieContext | undefined;
	#connection: IpcClient | undefined;
	#output: ProviderOutput | undefined;
	#active: ActiveRequest | undefined;
	readonly #retired = new Map<string, ActiveRequest>();
	#connectionGeneration = 0;
	#status: SessionStatus = "idle";
	#nextRequestId = 1;
	#starting = false;
	#sessionId: string | undefined;
	#inputCursor: string | null = null;
	#flushing = Promise.resolve();
	#ompProviderActive = false;
	#ompSessionName: string | undefined;
	#ompSessionManager: OmpExtensionContext["sessionManager"] | undefined;
	#ompSessionNameUnsubscribe: (() => void) | undefined;
	#latestOmpContext: OmpExtensionContext | undefined;

	constructor(
		api: ChappieHostAPI,
		agentDir: string,
		connect?: string,
		host: SessionHost = "pi",
		tls?: NetworkTlsConfig,
		localTools = false,
	) {
		this.#api = api;
		this.#agentDir = agentDir;
		this.#connect = connect;
		this.#host = host;
		this.#tls = tls;
		this.#localTools = localTools;
	}

	get localTools(): boolean {
		return this.#localTools;
	}

	installPi(pi: PiExtensionAPI): void {
		pi.registerEntryRenderer<Notice>(
			"chappie.notice",
			({ data }, _options, theme) => {
				if (!data) return;
				return new Text(
					theme.fg(data.type === "info" ? "dim" : data.type, data.message),
					1,
					0,
				);
			},
		);
		pi.on("session_start", (_event, context) =>
			this.#update(adaptPiContext(context)),
		);
		pi.on("model_select", (event, context) =>
			this.#update(adaptPiContext(context), event.model.provider === "chappie"),
		);
		pi.on("session_info_changed", (_event, context) => {
			this.#context = adaptPiContext(context);
			void this.#sync().catch(() => {});
		});
		pi.on("session_tree", (event, context) => {
			const shared = adaptPiContext(context);
			this.#context = shared;
			if (shared.model?.provider === "chappie") {
				this.#resetInputs(shared, event.newLeafId);
			}
			this.#historyChanged();
		});
		// Pi persists messages after message_end handlers finish.
		pi.on("message_start", (_event, context) => {
			this.#context = adaptPiContext(context);
			this.#historyChanged();
		});
		pi.on("tool_call", (_event, context) => {
			this.#context = adaptPiContext(context);
			this.#historyChanged();
		});
		pi.on("session_compact", (_event, context) => {
			this.#context = adaptPiContext(context);
			this.#historyChanged();
		});
		pi.on("context", (event, context) => ({
			messages:
				context.model?.provider === "chappie"
					? []
					: event.messages.filter(
							(message) =>
								message.role !== "custom" ||
								message.customType !== "chappie.request",
						),
		}));
		pi.on("turn_end", (event, context) =>
			this.#turnEnd(event.message, event.toolResults, adaptPiContext(context)),
		);
		pi.on("agent_settled", (_event, context) =>
			this.#settled(adaptPiContext(context)),
		);
		pi.on("session_shutdown", () => this.close());
	}

	installOmp(pi: OmpExtensionAPI): void {
		pi.on("session_start", (_event, context) => {
			this.#refreshOmpContext(context);
		});
		pi.on("session_switch", (_event, context) => {
			this.#refreshOmpContext(context);
			this.#historyChanged();
		});
		pi.on("session_branch", (_event, context) => {
			this.#refreshOmpContext(context);
			this.#historyChanged();
		});
		pi.on("before_agent_start", (_event, context) => {
			// During a remote wake, OMP can briefly expose no model while restoring
			// a resumed session. Preserve that accepted request only for the unknown
			// state; an explicit provider value remains authoritative.
			if (!this.#starting || context.model !== undefined)
				this.#refreshOmpContext(context);
		});
		pi.on("session_before_tree", async (event, context) => {
			const shared = this.#refreshOmpContext(context);
			if (
				shared.model?.provider !== "chappie" ||
				!event.preparation.userWantsSummary ||
				event.preparation.entriesToSummarize.length === 0
			)
				return;
			try {
				const summary = await this.requestGeneration(
					{
						kind: "branch_summary",
						input: {
							preparation: event.preparation,
							instructions:
								"Summarize the abandoned branch for the new branch. Preserve important decisions, progress, unresolved work, and relevant file operations.",
						},
					},
					event.signal,
					shared.sessionManager.getSessionId(),
				);
				return { summary: { summary } };
			} catch (error) {
				if (event.signal.aborted) return { cancel: true };
				throw error;
			}
		});
		pi.on("session_tree", (event, context) => {
			const shared = this.#refreshOmpContext(context);
			if (shared.model?.provider === "chappie") {
				this.#resetInputs(shared, event.newLeafId);
			}
			this.#historyChanged();
		});
		pi.on("message_start", (_event, context) => {
			this.#refreshOmpContext(context);
			this.#historyChanged();
		});
		pi.on("tool_call", (_event, context) => {
			this.#refreshOmpContext(context);
			this.#historyChanged();
		});
		pi.on("session_compact", (_event, context) => {
			this.#refreshOmpContext(context);
			this.#historyChanged();
		});
		pi.on("context", (event, context) => {
			const messages = event.messages.filter(
				(message) =>
					message.role !== "custom" || message.customType !== "chappie.request",
			);
			const primaryCandidate =
				this.#starting ||
				this.#ompProviderActive ||
				context.model?.provider === "chappie";
			return {
				messages: primaryCandidate
					? markOmpPrimaryContext(
							messages,
							context.sessionManager.getSessionId(),
						)
					: messages,
			};
		});
		pi.on("turn_end", (event, context) => {
			const shared = adaptOmpContext(context);
			return this.#turnEnd(event.message, event.toolResults, shared);
		});
		pi.on("agent_end", (event, context) => {
			const shared = adaptOmpContext(context);
			if (event.willContinue === true) return;
			return this.#settled(shared);
		});
		pi.on("session_shutdown", () => {
			this.#stopOmpSessionObservers();
			this.close();
		});
	}

	observeOmpProviderRequest(context: OmpExtensionContext): void {
		// before_provider_request is scoped to the model OMP will actually call.
		// It is therefore authoritative when resume-time ExtensionContext.model
		// briefly disagrees with the provider dispatch.
		this.#refreshOmpContext(context);
	}

	#refreshOmpContext(context: OmpExtensionContext): ChappieContext {
		this.#latestOmpContext = context;
		this.#observeOmpSession(context);
		const shared = adaptOmpContext(context);
		const providerActive = shared.model?.provider === "chappie";
		const name = this.#api.getSessionName();
		const nameChanged = name !== this.#ompSessionName;
		const providerChanged = this.#ompProviderActive !== providerActive;
		if (providerChanged && this.#connection) this.close(false);
		this.#ompProviderActive = providerActive;
		this.#ompSessionName = name;

		if (!providerActive && !this.#localTools) {
			this.#context = shared;
			return shared;
		}

		const sessionChanged =
			this.#sessionId !== shared.sessionManager.getSessionId();
		if (!this.#connection || sessionChanged || providerChanged) {
			this.#update(shared, true);
			return shared;
		}

		this.#context = shared;
		if (nameChanged) void this.#sync().catch(() => {});
		return shared;
	}

	#observeOmpSession(context: OmpExtensionContext): void {
		const manager = context.sessionManager;
		if (manager === this.#ompSessionManager) return;
		this.#ompSessionNameUnsubscribe?.();
		this.#ompSessionManager = manager;
		const observable = manager as typeof manager & {
			onSessionNameChanged?: (callback: () => void) => () => void;
		};
		this.#ompSessionNameUnsubscribe = observable.onSessionNameChanged?.(() => {
			const current = this.#latestOmpContext;
			if (current?.sessionManager === manager) this.#refreshOmpContext(current);
		});
	}

	#stopOmpSessionObservers(): void {
		this.#ompSessionNameUnsubscribe?.();
		this.#ompSessionNameUnsubscribe = undefined;
		this.#ompSessionManager = undefined;
		this.#latestOmpContext = undefined;
	}

	async #settled(context: ChappieContext): Promise<void> {
		if (context.sessionManager.getSessionId() !== this.#sessionId) return;
		this.#context = context;
		const starting = this.#starting;
		this.#starting = false;
		const reason = "Session ended before the request completed";
		const active = this.#active;
		if (active && !active.completed) {
			active.completed = true;
			active.error ??= reason;
		} else if (!active && starting) {
			const request = this.#queue.shift();
			if (request) await this.#sendError(request.id, reason);
		}
		this.#collectInputs();
		this.#historyChanged();
		await this.#completeActive();
		this.#dispatch();
	}

	#notify(
		message: string,
		type: Notice["type"] = "info",
		activity: Activity = {},
	): void {
		if (this.#context) {
			this.#api.appendEntry("chappie.notice", {
				message,
				type,
				...activity,
			});
			if (this.#host === "omp") this.#context.ui.notify(message, type);
		}
		if (activity.event !== "history") this.#historyChanged();
	}

	async start(
		output: ProviderOutput,
		expectedSessionId?: string,
	): Promise<void> {
		const context = this.#context;
		const connection = this.#connection;
		if (context?.model?.provider !== "chappie" || !connection) {
			throw new Error("Chappie is not active for this session");
		}
		if (
			expectedSessionId !== undefined &&
			expectedSessionId !== context.sessionManager.getSessionId()
		) {
			throw new Error(
				"Chappie provider request has a mismatched session identity",
			);
		}
		if (this.#output && !this.#output.closed) {
			throw new Error("Chappie already has an active provider request");
		}

		this.#starting = false;
		this.#output = output;
		try {
			await connection.connect();
			if (output.closed) return;
			this.#collectInputs();
			this.#historyChanged();
			await this.#completeActive();
			this.#status = "ready";
			await this.#sync();
			if (output.closed) return;
			output.begin();
			this.#dispatch();
			await output.finished;
		} finally {
			if (this.#output === output) {
				this.#output = undefined;
				this.#status = this.#active ? "executing" : "idle";
				void this.#sync().catch(() => {});
			}
		}
	}

	async generate(
		output: ProviderOutput,
		request: ModelRequest,
		expectedSessionId?: string,
	): Promise<void> {
		const context = this.#context;
		const connection = this.#connection;
		if (context?.model?.provider !== "chappie" || !connection)
			throw new Error("Chappie is not active for this session");
		const sessionId = context.sessionManager.getSessionId();
		if (expectedSessionId !== undefined && expectedSessionId !== sessionId)
			throw new Error("Chappie generation has a mismatched session identity");
		if (output.closed) return;
		const id = randomUUID();
		const generation: GenerationRequest = {
			output,
			request,
			sessionId,
			connectionGeneration: this.#connectionGeneration,
		};
		this.#generations.set(id, generation);
		this.#pendingInputs.set(id, { id, sessionId, request });
		this.#starting = false;
		try {
			await connection.connect();
			if (output.closed) return;
			if (
				this.#context?.model?.provider !== "chappie" ||
				this.#context.sessionManager.getSessionId() !== sessionId
			)
				throw new Error("Chappie's owning OMP session is no longer active");
			generation.connectionGeneration = this.#connectionGeneration;
			output.begin();
			await this.#sync();
			await output.finished;
		} finally {
			this.#generations.delete(id);
			this.#pendingInputs.delete(id);
			void this.#sync().catch(() => {});
		}
	}

	async requestGeneration(
		request: ModelRequest,
		signal: AbortSignal,
		expectedSessionId: string,
	): Promise<string> {
		const output = new ProviderOutput(
			{ api: "chappie", provider: "chappie", id: "chatgpt" },
			signal,
		);
		await this.generate(output, request, expectedSessionId);
		if (output.message.stopReason === "aborted")
			throw signal.reason ?? new Error("Chappie generation was cancelled");
		if (output.message.stopReason === "error")
			throw new Error(
				output.message.errorMessage ?? "Chappie generation failed",
			);
		return output.message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
	}

	async sessions(sessionId?: string, signal?: AbortSignal) {
		const result = await this.#request(
			{ type: "sessions", ...(sessionId ? { sessionId } : {}) },
			signal,
		);
		if (!("sessions" in result))
			throw new Error("Broker returned no session list");
		const self = this.#context?.sessionManager.getSessionId();
		if (!self) throw new Error("Chappie session is not available");
		return {
			self,
			sessions: result.sessions,
		};
	}

	async tools(sessionId: string, names?: string[], signal?: AbortSignal) {
		const result = await this.#request({ type: "inspect", sessionId }, signal);
		if (!("inspection" in result))
			throw new Error("Agent session returned no tool catalog");
		const selected = names ? new Set(names) : undefined;
		return {
			...result.inspection,
			inputs: result.inputs,
			...(result.globalAgents ? { globalAgents: result.globalAgents } : {}),
			tools: selected
				? result.inspection.tools.filter((tool) => selected.has(tool.name))
				: result.inspection.tools,
		};
	}

	async remoteCall(
		sessionId: string,
		operationId: string,
		calls: ToolInput[],
		signal?: AbortSignal,
	) {
		if (calls.length < 1 || calls.length > 128)
			throw new Error("Tool batches must contain between 1 and 128 calls");
		const self = this.#context?.sessionManager.getSessionId();
		if (!self) throw new Error("Chappie session is not available");
		const result = await this.#request(
			{
				type: "call",
				sessionId,
				chatId: self,
				requestId: operationId,
				calls: calls.map((call) => ({
					type: "toolCall",
					id: `chappie-${randomUUID()}`,
					name: call.name,
					arguments: call.arguments,
				})),
			},
			signal,
		);
		if (!("toolResults" in result))
			throw new Error("Agent session returned no tool results");
		return { sessionId, ...result };
	}

	async remoteChat(
		sessionId: string,
		operationId: string,
		text: string,
		replyTo?: string,
		signal?: AbortSignal,
	) {
		const self = this.#context?.sessionManager.getSessionId();
		if (!self) throw new Error("Chappie session is not available");
		const result = await this.#request(
			{
				type: "chat",
				sessionId,
				chatId: self,
				requestId: operationId,
				text,
				...(replyTo ? { replyTo } : {}),
			},
			signal,
		);
		if (!("message" in result))
			throw new Error("Agent session returned no assistant message");
		return { sessionId, ...result };
	}

	async remoteHistory(
		range: HistoryRange,
		sessionId?: string,
		signal?: AbortSignal,
	) {
		const context = this.#context;
		if (!context) throw new Error("Chappie session is not available");
		const self = context.sessionManager.getSessionId();
		if (!sessionId || sessionId === self)
			return historyResult(context.sessionManager.getBranch(), self, range);
		const result = await this.#request(
			{
				type: "history",
				sessionId,
				range,
				chatId: self,
				requestId: randomUUID(),
			},
			signal,
		);
		if (!("history" in result))
			throw new Error("Agent session returned no history");
		return result.history;
	}

	async transfer(
		args: TransferArgs,
		signal: AbortSignal | undefined,
		update: TransferUpdate | undefined,
		context: TransferExecutionContext,
	): Promise<TransferResult> {
		if (args.paths.length < 1 || args.paths.length > 128)
			throw new Error("Transfers require between 1 and 128 paths");
		if ([args.files, args.from, args.to].filter(Boolean).length > 1)
			throw new Error("Supply one of files, from, or to");
		if (args.files && !this.#allowsHostFileImport(args))
			throw new Error("Host file imports require the direct transfer tool");
		if (args.from) {
			const exported = await this.#request(
				{
					type: "export",
					sessionId: args.from.sessionId,
					paths: args.from.paths,
				},
				signal,
			);
			if (!("transfer" in exported))
				throw new Error("Agent session returned no resources");
			const copySignal = signal ?? new AbortController().signal;
			const files = await copyFiles(
				args.paths,
				exported.transfer.resources,
				context.cwd,
				args.overwrite === true,
				(resource) => this.#readChunks(resource, copySignal),
				copySignal,
			);
			return transferResult({
				device: hostname(),
				files,
				resources: [],
				from: {
					sessionId: args.from.sessionId,
					device: exported.transfer.device,
				},
			});
		}
		if (!args.to) return executeTransfer(args, signal, update, context);
		if (args.paths.length !== args.to.paths.length)
			throw new Error("Source and destination counts must match");
		const inspected = await this.#request(
			{ type: "inspect", sessionId: args.to.sessionId },
			signal,
		);
		if (!("inspection" in inspected))
			throw new Error("Agent session returned no environment");
		const exported = await executeTransfer(
			{ paths: args.paths },
			signal,
			undefined,
			context,
		);
		update?.({
			content: [],
			details: {
				...exported.details,
				to: {
					sessionId: args.to.sessionId,
					device: inspected.inspection.session.device,
				},
			},
		});
		const result = await this.#request(
			{
				type: "copy",
				sessionId: args.to.sessionId,
				paths: args.to.paths,
				resources: exported.details.resources,
				...(args.overwrite !== undefined ? { overwrite: args.overwrite } : {}),
			},
			signal,
		);
		if (!("transfer" in result))
			throw new Error("Agent session returned no transfer result");
		return transferResult({ ...result.transfer, device: hostname() });
	}

	#allowsHostFileImport(args: TransferArgs): boolean {
		const active = this.#active;
		if (active?.request.type !== "call" || !active.request.direct) return false;
		return active.request.calls.some(
			(call) =>
				call.name === "transfer" &&
				call.arguments.operationId === args.operationId &&
				isDeepStrictEqual(call.arguments.paths, args.paths) &&
				isDeepStrictEqual(call.arguments.files, args.files),
		);
	}

	close(permanent = true): void {
		const sessionId = this.#sessionId;
		if (permanent) this.#latestOmpContext = undefined;
		if (this.#active && !this.#active.completed) this.#context?.abort();
		if (sessionId) releaseSessionResources(sessionId);
		this.#retired.clear();
		if (sessionId && this.#connection?.connected) {
			void this.#connection
				.send({ type: "unregister", sessionId })
				.catch(() => {});
		}
		this.#output?.fail(new Error("Chappie session ended"), true);
		this.#failGenerations(new Error("Chappie session ended"));
		this.#output = undefined;
		this.#active = undefined;
		this.#queue.length = 0;
		this.#starting = false;
		this.#connection?.close();
		this.#connection = undefined;
		this.#context = undefined;
		this.#resetInputs();
		this.#cancelRequests(new Error("Chappie session ended"));
		this.#rejectSyncs(new Error("Chappie session ended"));
		this.#rejectStores(new Error("Chappie session ended"));
		for (const id of this.#histories.keys()) this.#finishHistory(id);
	}

	#update(
		context: ChappieContext,
		active = context.model?.provider === "chappie",
	): void {
		if (!active) {
			this.close(false);
			return;
		}
		const nextId = context.sessionManager.getSessionId();
		if (this.#sessionId && this.#sessionId !== nextId)
			this.#transitionSession();
		this.#context = context;
		if (this.#sessionId !== nextId) this.#resetInputs(context);
		if (!this.#connection) {
			this.#connection = new IpcClient(
				this.#agentDir,
				this.#connect,
				{
					onOpen: async () => {
						this.#connectionGeneration++;
						await this.#sync();
						await this.#flushDeliveries();
					},
					onMessage: (message) => this.#receive(message),
					onClose: (error) => {
						this.#cancelRequests(error);
						for (const id of this.#histories.keys()) this.#finishHistory(id);
						this.#rejectSyncs(error);
						this.#rejectStores(error);
						if (this.#output && !this.#output.closed) this.#output.fail(error);
						else this.#notify(error.message, "error");
						this.#failGenerations(error);
						if (this.#active) {
							this.#active.cancelled ??=
								"Connection lost before result delivery";
							void this.#completeActive().catch(() => {});
						}
						this.#queue.length = 0;
						this.#starting = false;
						this.#status = this.#active ? "executing" : "idle";
					},
				},
				this.#tls,
			);
			this.#connection.start();
		} else {
			void this.#sync().catch(() => {});
		}
	}

	#transitionSession(): void {
		const error = new Error("Session changed before request completion");
		const connection = this.#connection;
		for (const request of this.#queue) {
			void connection
				?.send({ type: "result", id: request.id, error: error.message })
				.catch(() => {});
		}
		this.#queue.length = 0;
		const active = this.#active;
		if (active) {
			active.cancelled = error.message;
			this.#active = undefined;
			if (active.completed) this.#retainResult(active);
			else this.#retired.set(active.id, active);
			void connection
				?.send({ type: "result", id: active.request.id, error: error.message })
				.catch(() => {});
		}
		// Retain a bounded set of late completions; never retarget them to the new session.
		while (this.#retired.size > 32) {
			const oldest = this.#retired.values().next().value;
			if (!oldest) break;
			this.#retired.delete(oldest.id);
			this.#retainResult(oldest);
		}
		for (const [id] of this.#histories) {
			void connection
				?.send({ type: "result", id, error: error.message })
				.catch(() => {});
			this.#finishHistory(id);
		}
		this.#cancelRequests(error);
		this.#output?.fail(error, true);
		this.#failGenerations(error);
		this.#output = undefined;
		this.#starting = false;
		this.#status = "idle";
		if (this.#sessionId) {
			void connection
				?.send({ type: "unregister", sessionId: this.#sessionId })
				.catch(() => {});
		}
	}

	#description(): SessionDescription {
		const context = this.#context;
		if (!context) throw new Error("Chappie session is not available");
		const name = this.#api.getSessionName();
		return {
			id: context.sessionManager.getSessionId(),
			cwd: context.cwd,
			device: hostname(),
			host: this.#host,
			agentDir: this.#agentDir,
			status: this.#status,
			...(name ? { name } : {}),
		};
	}

	async #sync(): Promise<void> {
		const connection = this.#connection;
		if (
			!connection?.connected ||
			!this.#context ||
			(this.#context.model?.provider !== "chappie" && !this.#localTools)
		)
			return;
		const id = this.#nextRequestId++;
		const completion = Promise.withResolvers<void>();
		void completion.promise.catch(() => {});
		this.#syncs.set(id, completion);
		const timer = setTimeout(
			() =>
				completion.reject(
					new Error("Broker registration acknowledgement timed out"),
				),
			5000,
		);
		timer.unref();
		try {
			await connection.send({ type: "sync", id, session: this.#description() });
			await completion.promise;
		} finally {
			clearTimeout(timer);
			this.#syncs.delete(id);
		}
	}

	async #receive(message: BrokerMessage): Promise<void> {
		switch (message.type) {
			case "response": {
				const pending = this.#requests.get(message.id);
				if (!pending) break;
				if ("error" in message) pending.reject(new Error(message.error));
				else {
					const { type: _type, id: _id, ...result } = message;
					pending.resolve(result);
				}
				break;
			}
			case "synced":
				this.#syncs.get(message.id)?.resolve();
				break;
			case "stored":
				this.#stores.get(message.id)?.resolve();
				break;
			case "notice":
				if (
					message.sessionId === this.#context?.sessionManager.getSessionId()
				) {
					this.#notify(message.message, "info", message.activity);
				}
				break;
			case "inspect":
				await this.#reply(message.id, message.sessionId, async (signal) => {
					signal.throwIfAborted();
					const globalAgents = await this.#globalAgents();
					return {
						type: "result",
						id: message.id,
						inspection: this.#inspection(),
						inputs: this.#inputs(),
						...(globalAgents ? { globalAgents } : {}),
					};
				});
				break;
			case "inputs":
				await this.#reply(message.id, message.sessionId, async (signal) => {
					signal.throwIfAborted();
					return {
						type: "result",
						id: message.id,
						inputs: this.#inputs(),
					};
				});
				break;
			case "history":
				await this.#readHistory(message);
				break;
			case "ackInputs":
				if (
					message.sessionId === this.#context?.sessionManager.getSessionId()
				) {
					for (const id of message.ids) this.#pendingInputs.delete(id);
				}
				break;
			case "readResource":
				await this.#reply(message.id, message.sessionId, async (signal) => {
					signal.throwIfAborted();
					return {
						type: "result",
						id: message.id,
						resource: await readSessionResource(
							message.sessionId,
							message.uri,
							message.offset,
						),
					};
				});
				break;
			case "export":
				await this.#reply(message.id, message.sessionId, async (signal) => {
					const context = this.#context;
					if (!context) throw new Error("Chappie session is not available");
					const result = await executeTransfer(
						{ paths: message.paths },
						signal,
						undefined,
						{
							sessionId: message.sessionId,
							cwd: context.cwd,
						},
					);
					return {
						type: "result",
						id: message.id,
						transfer: result.details,
					};
				});
				break;
			case "copy":
				void this.#reply(message.id, message.sessionId, async (signal) => {
					const context = this.#context;
					if (!context) throw new Error("Chappie session is not available");
					const files = await copyFiles(
						message.paths,
						message.resources,
						context.cwd,
						message.overwrite === true,
						(resource) => this.#readChunks(resource, signal),
						signal,
					);
					return {
						type: "result",
						id: message.id,
						transfer: {
							device: hostname(),
							files,
							resources: [],
							to: { sessionId: message.sessionId, device: hostname() },
						},
					};
				}).catch(() => {});
				break;
			case "cancel": {
				if (message.sessionId !== this.#sessionId) break;
				const operation = this.#operations.get(message.id);
				if (operation) {
					operation.suppressAbortResponse = true;
					operation.controller.abort(new Error(message.reason));
					break;
				}
				if (this.#histories.has(message.id)) {
					this.#finishHistory(message.id);
					break;
				}
				const queued = this.#queue.findIndex(
					(request) => request.id === message.id,
				);
				const request =
					this.#queue[queued] ??
					(this.#active?.request.id === message.id &&
					this.#active.connectionGeneration === this.#connectionGeneration
						? this.#active.request
						: undefined);
				if (!request) break;
				const name =
					request.type === "call"
						? [...new Set(request.calls.map((call) => call.name))].join(", ")
						: "chat";
				this.#notify(
					`${name} cancelled for ${chatLabel(request)}: ${message.reason}`,
					"warning",
					{
						event: "cancelled",
						...source(request.chatId, request.requestId),
					},
				);
				if (queued !== -1) {
					this.#queue.splice(queued, 1);
					break;
				}
				const active = this.#active;
				if (!active) break;
				active.cancelled = message.reason;
				if (active.completed) await this.#completeActive();
				else this.#context?.abort();
				break;
			}
			case "chat":
			case "call":
				if (
					message.sessionId !== this.#context?.sessionManager.getSessionId()
				) {
					await this.#sendError(
						message.id,
						"The requested Pi session is no longer active",
					);
					break;
				}
				if (this.#context?.model?.provider !== "chappie") {
					await this.#sendError(
						message.id,
						"The requested OMP session is not using the Chappie provider",
					);
					break;
				}
				if (message.type === "chat" && message.replyTo) {
					const generation = this.#generations.get(message.replyTo);
					if (
						!generation ||
						generation.output.closed ||
						generation.sessionId !== message.sessionId ||
						generation.connectionGeneration !== this.#connectionGeneration ||
						this.#context?.model?.provider !== "chappie"
					) {
						await this.#sendError(message.id, "The model request has ended");
						break;
					}
					generation.output.message.chappie = source(
						message.chatId,
						message.requestId,
					);
					generation.output.text(message.text);
					generation.output.done();
					this.#pendingInputs.delete(message.replyTo);
					await this.#connection?.send({
						type: "result",
						id: message.id,
						cwd: this.#context.cwd,
						message: generation.output.message,
						inputs: this.#inputs(),
					});
					break;
				}
				if (message.type === "call" && message.direct) {
					try {
						this.#queue.push({
							...message,
							calls: message.calls.map((call) => ({
								...call,
								arguments: directHostCall(
									this.#host,
									call,
									this.#api
										.getAllTools()
										.find((tool) => tool.name === call.name),
								).arguments,
							})),
						});
					} catch (error) {
						await this.#sendError(
							message.id,
							error instanceof Error ? error.message : String(error),
						);
						break;
					}
				} else this.#queue.push(message);
				this.#dispatch();
				break;
		}
	}

	async #request(
		request: SessionRequest,
		signal?: AbortSignal,
	): Promise<SessionResult> {
		signal?.throwIfAborted();
		const connection = this.#connection;
		if (!connection?.connected) throw new Error("Chappie is not connected");
		const id = this.#nextRequestId++;
		const completion = Promise.withResolvers<SessionResult>();
		const onAbort = (): void => {
			completion.reject(signal?.reason);
			void connection.send({ type: "cancelRequest", id }).catch(() => {});
		};
		this.#requests.set(id, completion);
		signal?.addEventListener("abort", onAbort, { once: true });
		void connection
			.send({ type: "request", id, request })
			.catch(completion.reject);
		try {
			return await completion.promise;
		} finally {
			this.#requests.delete(id);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async *#readChunks(
		resource: ResourceDescriptor,
		signal: AbortSignal,
	): AsyncGenerator<Uint8Array> {
		for (let offset = 0; offset < resource.size; ) {
			const result = await this.#request(
				{
					type: "readResource",
					sessionId: resourceSessionId(resource.uri),
					uri: resource.uri,
					offset,
				},
				signal,
			);
			if (!("resource" in result))
				throw new Error("Pi session returned no resource");
			const data = Buffer.from(result.resource.blob, "base64");
			if (data.length === 0)
				throw new Error(
					`Source ended before ${resource.size} bytes: ${resource.name}`,
				);
			yield data;
			offset += data.length;
		}
	}

	#cancelRequests(error: Error): void {
		for (const pending of this.#requests.values()) pending.reject(error);
		this.#requests.clear();
		for (const operation of this.#operations.values())
			operation.controller.abort(error);
		this.#operations.clear();
	}

	async #readHistory(
		request: HistoryRequest["request"],
		wait = request.range.wait,
	): Promise<void> {
		try {
			const context = this.#context;
			if (context?.sessionManager.getSessionId() !== request.sessionId)
				throw new Error("The requested Pi session is no longer active");
			const history = historyResult(
				context.sessionManager.getBranch(),
				request.sessionId,
				request.range,
			);
			if (wait && !request.range.before && history.count === 0) {
				if (!this.#histories.has(request.id)) {
					this.#histories.set(request.id, {
						request,
						timeout: setTimeout(() => {
							void this.#readHistory(request, false).catch(() => {});
						}, 30_000),
					});
				}
				return;
			}
			this.#finishHistory(request.id);
			if (!request.range.observer) {
				this.#notify(
					`${chatLabel(request)} read history: ${history.count} entries`,
					"info",
					{ event: "history", ...source(request.chatId, request.requestId) },
				);
			}
			await this.#connection?.send({
				type: "result",
				id: request.id,
				cwd: context.cwd,
				history,
			});
		} catch (error) {
			this.#finishHistory(request.id);
			await this.#sendError(
				request.id,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	#historyChanged(): void {
		for (const { request } of this.#histories.values()) {
			void this.#readHistory(request).catch(() => {});
		}
	}

	#finishHistory(id: number): void {
		const pending = this.#histories.get(id);
		if (!pending) return;
		clearTimeout(pending.timeout);
		this.#histories.delete(id);
	}

	#inspection(): SessionInspection {
		const activeTools = new Set(this.#api.getActiveTools());
		this.#collectInputs();
		return {
			session: this.#description(),
			tools: this.#api
				.getAllTools()
				.filter((tool) => activeTools.has(tool.name)),
			skills: this.#api
				.getCommands()
				.filter((command) => command.source === "skill"),
		};
	}

	async #globalAgents(): Promise<{ path: string } | undefined> {
		const path = resolve(this.#agentDir, "AGENTS.md");
		try {
			await access(path);
			return { path };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	#dispatch(): void {
		if (this.#active) return;
		const request = this.#queue[0];
		if (!request) return;
		if (
			request.sessionId !== this.#sessionId ||
			request.sessionId !== this.#context?.sessionManager.getSessionId()
		) {
			this.#queue.shift();
			void this.#sendError(
				request.id,
				"The requested session is no longer active",
			).catch(() => {});
			this.#dispatch();
			return;
		}
		const output = this.#output;
		if (!output || output.closed) {
			this.#wake();
			return;
		}

		this.#queue.shift();
		const invocationId = randomUUID();
		output.message.chappie = {
			...source(request.chatId, request.requestId),
			invocationId,
		};
		this.#active = {
			id: invocationId,
			connectionGeneration: this.#connectionGeneration,
			request,
			session: this.#description(),
			message: output.message,
			completed: false,
			cancelled: undefined,
			toolResults: [],
		};
		this.#status = "executing";
		void this.#sync().catch(() => {});
		if (request.type === "chat") {
			output.text(request.text);
			output.done();
		} else {
			output.toolCalls(request.calls);
			output.done("toolUse");
		}
	}

	#wake(): void {
		if (
			this.#starting ||
			this.#output ||
			this.#active ||
			this.#queue.length === 0 ||
			!this.#context?.isIdle()
		)
			return;
		this.#starting = true;
		this.#api.sendMessage(
			{
				customType: "chappie.request",
				content: "",
				display: false,
			},
			{ triggerTurn: true },
		);
	}

	async #turnEnd(
		message: unknown,
		toolResults: SessionToolResult[],
		context: ChappieContext,
	): Promise<void> {
		if (context.sessionManager.getSessionId() === this.#sessionId) {
			this.#context = context;
			this.#historyChanged();
		}
		const completed = message as Partial<ProviderOutput["message"]> | undefined;
		const failure = completed?.errorMessage;
		const responseSource =
			typeof message === "object" && message !== null
				? (message as { chappie?: Source }).chappie
				: undefined;
		const active =
			this.#active?.id === responseSource?.invocationId
				? this.#active
				: responseSource?.invocationId
					? this.#retired.get(responseSource.invocationId)
					: failure !== undefined
						? this.#active
						: undefined;
		if (!active || active.completed) return;
		if (
			failure === undefined &&
			message !== active.message &&
			(this.#host !== "omp" ||
				!sameSource(responseSource, active.message.chappie))
		)
			return;
		if (failure === undefined && active.request.type === "call") {
			const expectedCalls = active.request.calls;
			const content = completed?.content ?? [];
			const ids = content
				.filter((block) => block.type === "toolCall")
				.map((block) => block.id);
			if (
				ids.length !== expectedCalls.length ||
				ids.some((id, index) => id !== expectedCalls[index]?.id)
			)
				return;
		}
		for (const result of toolResults)
			rememberImages(active.session.id, result.content);
		if (failure !== undefined) active.error = failure;
		if (active.request.type === "call") {
			const results = new Map(
				toolResults.map((result) => [result.toolCallId, result]),
			);
			const ordered = active.request.calls.flatMap(
				(call) => results.get(call.id) ?? [],
			);
			const missing = active.request.calls.flatMap((call, index) =>
				results.has(call.id) ? [] : [`${index + 1} (${call.name})`],
			);
			if (missing.length)
				active.error ??= `No results for calls ${missing.join(", ")}`;
			active.toolResults =
				this.#host === "omp" && active.request.direct
					? directHostResults(active.request.calls, ordered)
					: ordered;
		} else {
			active.toolResults = toolResults;
		}
		active.completed = true;
		if (this.#retired.delete(active.id)) this.#retainResult(active);
		else if (this.#host === "omp") {
			// A completed tool batch belongs to its caller even when OMP continues
			// for a TODO reminder or background work. Do not wait for another stream.
			await this.#completeActive();
		}
	}

	#retainResult(active: ActiveRequest): void {
		const delivery: DeliveryRecord = {
			id: active.id,
			complete: active.completed,
			...source(active.request.chatId, active.request.requestId),
			...(active.request.operationKey
				? { operationKey: active.request.operationKey }
				: {}),
			sessionId: active.session.id,
			cwd: active.session.cwd,
			toolResults: active.toolResults,
			...(active.cancelled || active.error
				? { error: active.cancelled ?? active.error }
				: {}),
		};
		this.#deliveries.set(delivery.id, delivery);
		void this.#flushDeliveries().catch(() => {});
	}

	async #completeActive(): Promise<void> {
		const active = this.#active;
		if (!active?.completed) return;
		// Claim completion synchronously so overlapping settled/provider events cannot deliver it twice.
		this.#active = undefined;
		const connection = this.#connection;
		if (
			active.cancelled !== undefined ||
			!connection?.connected ||
			active.connectionGeneration !== this.#connectionGeneration
		) {
			active.cancelled ??= "Connection lost before result delivery";
			this.#retainResult(active);
		} else {
			try {
				if (active.error !== undefined) {
					await connection.send({
						type: "result",
						id: active.request.id,
						error: active.error,
					});
				} else {
					await connection.send({
						type: "result",
						id: active.request.id,
						cwd: active.session.cwd,
						message: active.message,
						inputs: active.session.id === this.#sessionId ? this.#inputs() : [],
						...(active.request.type === "call"
							? { toolResults: active.toolResults }
							: {}),
					});
				}
			} catch (error) {
				active.cancelled =
					error instanceof Error ? error.message : String(error);
				this.#retainResult(active);
			}
		}
		if (!this.#active) this.#status = "idle";
		void this.#sync().catch(() => {});
	}

	#resetInputs(
		context?: ChappieContext,
		cursor = context?.sessionManager.getLeafId() ?? null,
	): void {
		this.#sessionId = context?.sessionManager.getSessionId();
		this.#inputCursor = cursor;
		this.#pendingInputs.clear();
	}

	#collectInputs(): void {
		const context = this.#context;
		if (!context) return;
		const sessionManager = context.sessionManager;
		const sessionId = sessionManager.getSessionId();
		if (this.#sessionId !== sessionId) {
			this.#resetInputs(context);
			return;
		}
		const leafId = sessionManager.getLeafId();
		if (leafId === this.#inputCursor) return;
		const entries: SessionEntry[] = [];
		let current = sessionManager.getLeafEntry();
		while (current && current.id !== this.#inputCursor) {
			entries.push(current);
			current = current.parentId
				? sessionManager.getEntry(current.parentId)
				: undefined;
		}
		if (this.#inputCursor !== null && !current) {
			this.#resetInputs(context);
			return;
		}
		for (const entry of entries.reverse()) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const message = entry.message as UserMessage;
			if (typeof message.content !== "string") {
				rememberImages(sessionId, message.content);
			}
			this.#pendingInputs.set(entry.id, { id: entry.id, sessionId, message });
		}
		this.#inputCursor = leafId;
	}

	#inputs(): SessionInput[] {
		this.#collectInputs();
		return [...this.#pendingInputs.values()];
	}

	#failGenerations(error: Error): void {
		for (const generation of this.#generations.values()) {
			if (!generation.output.closed) generation.output.fail(error, true);
		}
	}

	async #flushDeliveries(): Promise<void> {
		const flushed = this.#flushing.then(async () => {
			const connection = this.#connection;
			if (!connection?.connected) return;
			for (const delivery of this.#deliveries.values()) {
				const completion = Promise.withResolvers<void>();
				void completion.promise.catch(() => {});
				this.#stores.set(delivery.id, completion);
				const timer = setTimeout(
					() =>
						completion.reject(
							new Error("Result storage acknowledgement timed out"),
						),
					5000,
				);
				timer.unref();
				try {
					await connection.send({ type: "delivery", delivery });
					await completion.promise;
					this.#deliveries.delete(delivery.id);
					this.#notify(
						`Result saved for ChatGPT ${delivery.chatId.slice(-4)}`,
						"info",
						{
							event: "result_saved",
							...source(delivery.chatId, delivery.requestId),
						},
					);
				} finally {
					clearTimeout(timer);
					this.#stores.delete(delivery.id);
				}
			}
		});
		this.#flushing = flushed.catch(() => {});
		return flushed;
	}

	async #reply(
		id: number,
		sessionId: string,
		response: (
			signal: AbortSignal,
		) =>
			| Parameters<IpcClient["send"]>[0]
			| Promise<Parameters<IpcClient["send"]>[0]>,
	): Promise<void> {
		const connection = this.#connection;
		const generation = this.#connectionGeneration;
		const operation = {
			controller: new AbortController(),
			suppressAbortResponse: false,
		};
		this.#operations.set(id, operation);
		try {
			if (sessionId !== this.#sessionId)
				throw new Error("The requested Pi session is no longer active");
			operation.controller.signal.throwIfAborted();
			const result = await response(operation.controller.signal);
			operation.controller.signal.throwIfAborted();
			if (
				connection !== this.#connection ||
				generation !== this.#connectionGeneration
			)
				return;
			if (sessionId !== this.#sessionId)
				throw new Error("Session changed before request completion");
			await connection?.send(result);
		} catch (error) {
			if (
				connection === this.#connection &&
				generation === this.#connectionGeneration &&
				connection?.connected &&
				!operation.suppressAbortResponse
			) {
				await connection?.send({
					type: "result",
					id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			this.#operations.delete(id);
		}
	}

	async #sendError(id: number, error: string): Promise<void> {
		await this.#connection?.send({ type: "result", id, error });
	}

	#rejectSyncs(error: Error): void {
		for (const sync of this.#syncs.values()) sync.reject(error);
		this.#syncs.clear();
	}

	#rejectStores(error: Error): void {
		for (const store of this.#stores.values()) store.reject(error);
		this.#stores.clear();
	}
}
