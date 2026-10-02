import { randomUUID } from "node:crypto";
import { type Activity, chatLabel, source } from "./activity.ts";
import { readConfig } from "./config.ts";
import type { DeliveryRecord } from "./delivery.ts";
import { type HistoryRange, historyInstructions } from "./history.ts";
import {
	type BrokerMessage,
	type ExecutionWait,
	IpcServer,
	type JsonLinePeer,
	type ModelInput,
	type SessionDescription,
	type SessionInput,
	type SessionInspection,
	type SessionListItem,
	type SessionMessage,
	type SessionRequest,
	type SessionResult,
	type SessionToolResult,
} from "./ipc.ts";
import {
	hasHostFileImport,
	nativeToolCalls,
	validateNativeCalls,
} from "./native-calls.ts";
import {
	type OperationReceipt,
	type OperationView,
	operationIdentity,
	operationView,
	type ReplayReceipt,
	replayReceipt,
	validateOperationId,
} from "./operations.ts";
import {
	type Question,
	type QuestionAnswer,
	type QuestionInput,
	type QuestionRecord,
	questionView,
} from "./questions.ts";
import {
	type ResourceData,
	resourceDescriptors,
	resourceSessionId,
} from "./resources.ts";
import { ResponseStore } from "./responses.ts";
import {
	type BindingMutation,
	StaleOperationDeliveryError,
	State,
} from "./state.ts";
import type { ToolInput } from "./tools.ts";
import type { ChatMode, SessionWork } from "./work.ts";

const observerInstructions =
	"This ChatGPT conversation recently initialized or resumed work in this OMP session. A recent initialization may still own this task; do not assume another completion is needed. Participate as an observer for this task: read history with observer: true, follow new entries with after and wait: true, and think independently. Leave execution and OMP communication to the ongoing work. Do not export files, repeat the completed report, or publish a second completion response. Leave the single completion response to the original execution. Continue observing rather than reinitializing to take over.";

const operationCancelledMessage = "Operation cancelled by ChatGPT";

interface DetachedOperation {
	controller: AbortController;
	promise: Promise<void>;
	dispatched: boolean;
	signature: string;
}

interface RegisteredSession {
	description: SessionDescription;
	peer: JsonLinePeer<SessionMessage, BrokerMessage>;
}

interface PendingRequest {
	sessionId: string;
	peer: JsonLinePeer<SessionMessage, BrokerMessage>;
	resolve(result: SessionResult): void;
	reject(error: Error): void;
	signal: AbortSignal;
	onAbort(): void;
}

interface ChangeWaiter {
	resolve(): void;
	reject(error: Error): void;
	signal: AbortSignal;
	onAbort(): void;
}

export interface Initialization {
	mode?: "executor" | "observer";
	sessionId: string;
	instructions: string;
}

export interface InitializedSession
	extends Omit<SessionInspection, "tools" | "skills"> {
	selection: "existing" | "explicit" | "automatic";
	initialization?: Initialization;
	globalAgents?: { path: string };
	inputs: SessionInput[];
	tools: { name: string; description: string }[];
	skills: { name: string; description?: string; uri: string }[];
}

export interface InspectedSession extends SessionInspection {
	initialization?: Initialization;
	inputs: SessionInput[];
}

export interface ChatResult {
	progress?: true;
	work?: SessionWork;
	replay?: ReplayReceipt;
	initialization?: Initialization;
	sessionId: string;
	cwd: string;
	inputs: SessionInput[];
	execution?: ExecutionWait;
}

export interface CallResult extends ChatResult {
	toolResults: SessionToolResult[];
}

export interface StartedOperation {
	operation: OperationView;
	initialization?: Initialization;
}

export interface OperationResult {
	operation: OperationView;
	deliveries: DeliveryRecord[];
	result?: DeliveryRecord | undefined;
	inputs: ModelInput[];
}

interface InFlightOperation {
	signature: string;
	promise: Promise<ChatResult | CallResult>;
	controller: AbortController;
	waiters: number;
}

export interface BrokerOptions {
	sessionWaitMs?: number;
	inspectionTimeoutMs?: number;
}

const INIT_SUMMARY_CHARS = 512;

function compactSummary(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return value.split("\n", 1)[0]?.slice(0, INIT_SUMMARY_CHARS);
}

export class Broker {
	readonly #agentDir: string;
	readonly #sessionWaitMs: number;
	readonly #inspectionTimeoutMs: number;
	readonly #ipc: IpcServer;
	readonly #state: State;
	readonly #responses: ResponseStore;
	readonly #sessions = new Map<string, RegisteredSession>();
	// Pending automatic selections, keyed by chat so retries do not take a second slot.
	readonly #selectionReservations = new Map<string, string>();
	readonly #pending = new Map<number, PendingRequest>();
	readonly #waiters = new Set<ChangeWaiter>();
	readonly #cooldowns = new Map<string, number>();
	readonly #relays = new Map<
		JsonLinePeer<SessionMessage, BrokerMessage>,
		Map<number, AbortController>
	>();
	readonly #inFlightOperations = new Map<string, InFlightOperation>();
	readonly #detachedOperations = new Map<string, DetachedOperation>();
	#ask = true;
	#cooldownMs = 10_000;
	#localTools = false;
	#nextRequestId = 1;

	constructor(agentDir: string, options: BrokerOptions = {}) {
		this.#sessionWaitMs = options.sessionWaitMs ?? 5000;
		this.#inspectionTimeoutMs = options.inspectionTimeoutMs ?? 3000;
		this.#agentDir = agentDir;
		this.#state = new State(agentDir);
		this.#responses = new ResponseStore(agentDir);
		this.#ipc = new IpcServer(
			agentDir,
			(peer, message) => this.#receive(peer, message),
			(peer) => this.#removePeer(peer),
		);
	}

	async start(): Promise<void> {
		const config = await readConfig(this.#agentDir);
		this.#ask = config.ask ?? true;
		this.#cooldownMs = (config.cooldown ?? 10) * 1000;
		this.#localTools = config.localTools === true;
		await this.#state.load();
		await this.#ipc.start(config.listen ?? false, {
			...(config.tls ? { tls: config.tls } : {}),
			...(config.listenHost ? { host: config.listenHost } : {}),
		});
	}

	async close(): Promise<void> {
		const error = new Error("Chappie broker ended");
		for (const operation of this.#detachedOperations.values())
			operation.controller.abort(error);
		this.#cooldowns.clear();
		for (const relays of this.#relays.values()) {
			for (const controller of relays.values()) controller.abort(error);
		}
		this.#relays.clear();
		for (const [id, pending] of this.#pending) {
			this.#finishRequest(id, pending);
			pending.reject(error);
		}
		for (const waiter of this.#waiters) {
			waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.reject(error);
		}
		this.#waiters.clear();
		this.#sessions.clear();
		await this.#ipc.close();
		if (this.#detachedOperations.size > 0)
			await Promise.allSettled(
				[...this.#detachedOperations.values()].map(
					(operation) => operation.promise,
				),
			);
		await this.#state.flush();
	}

	listSessions(sessionId?: string): SessionListItem[] {
		const counts = this.#state.bindingCounts();
		return [...this.#sessions.values()]
			.filter(({ description }) => !sessionId || description.id === sessionId)
			.map(({ description }) => ({
				...description,
				bindingCount: counts.get(description.id) ?? 0,
			}));
	}

	saveResponse(chatId: string, text: string): Promise<string> {
		return this.#responses.save(chatId, text);
	}

	readResponse(chatId: string, resultId: string): Promise<string> {
		return this.#responses.read(chatId, resultId);
	}

	get askEnabled(): boolean {
		return this.#ask;
	}

	binding(chatId: string): string | undefined {
		return this.#state.binding(chatId);
	}

	async initialize(
		chatId: string,
		sessionId: string | undefined,
		requestId: unknown,
		signal: AbortSignal,
	): Promise<InitializedSession> {
		const {
			sessionId: target,
			selection,
			initialization,
			bindingMutation,
		} = await this.#selectSession(chatId, sessionId, requestId, signal, true);
		try {
			const { inspection, inputs, globalAgents } = await this.#inspect(
				target,
				signal,
			);
			return {
				selection,
				...(initialization ? { initialization } : {}),
				session: inspection.session,
				...(inspection.work ? { work: inspection.work } : {}),
				tools: inspection.tools.map(({ name, description }) => ({
					name,
					description: compactSummary(description) ?? "",
				})),
				skills: inspection.skills.map(({ name, description }) => {
					const skillName = name.startsWith("skill:") ? name.slice(6) : name;
					const summary = compactSummary(description);
					return {
						name: skillName,
						...(summary ? { description: summary } : {}),
						uri: `skill://${skillName}`,
					};
				}),
				inputs: initialization?.mode === "observer" ? [] : inputs,
				...(globalAgents ? { globalAgents } : {}),
			};
		} catch (error) {
			if (bindingMutation) {
				try {
					await this.#state.restoreBinding(chatId, bindingMutation);
				} catch (rollbackError) {
					throw new AggregateError(
						[error, rollbackError],
						"Session initialization failed and its binding could not be restored",
					);
				}
			}
			throw error;
		}
	}

	async chat(
		chatId: string,
		sessionId: string | undefined,
		text: string,
		requestId: unknown,
		signal: AbortSignal,
		replyTo?: string,
		mode: ChatMode = "message",
	): Promise<ChatResult> {
		if (mode === "progress" && replyTo)
			throw new Error("Progress cannot answer a model request");
		const { sessionId: target, initialization } = await this.#selectSession(
			chatId,
			sessionId,
			requestId,
			signal,
		);
		const identity = operationIdentity(
			chatId,
			target,
			"chat",
			requestId,
			JSON.stringify({ text, replyTo, mode }),
		);
		return this.#coalesceOperation(
			identity,
			signal,
			async (operationSignal) => {
				if (identity) {
					const session = this.#sessions.get(target);
					if (!session) throw new Error("Target session disconnected");
					const replay = await this.#state.reserveOperation({
						...identity,
						chatId,
						sessionId: target,
						cwd: session.description.cwd,
						status: "running",
						updatedAt: Date.now(),
					});
					if (replay) {
						await this.#confirmBindingUse(chatId, sessionId, target);
						return {
							sessionId: target,
							cwd: replay.cwd,
							inputs: [],
							replay: replayReceipt(replay),
						};
					}
				}

				const result = await this.#request(
					target,
					(id) => ({
						type: "chat",
						id,
						...source(chatId, requestId),
						...this.#state.executionSource(identity?.key),
						sessionId: target,
						text,
						mode,
						...(replyTo ? { replyTo } : {}),
					}),
					operationSignal,
				).catch(async (error: unknown) => {
					await this.#state.finishOperation(identity?.key, "uncertain");
					throw error;
				});
				if ("execution" in result) {
					await this.#recordInputWait(identity?.key, result);
					return {
						sessionId: target,
						cwd: result.cwd,
						inputs: result.inputs,
						...(result.work ? { work: result.work } : {}),
						execution: result.execution,
						...(initialization ? { initialization } : {}),
					};
				}
				await this.#state.finishOperation(identity?.key, "completed");
				if ("message" in result || "progress" in result) {
					await this.#confirmBindingUse(chatId, sessionId, target);
					return {
						...("progress" in result ? { progress: true as const } : {}),
						sessionId: target,
						cwd: result.cwd,
						inputs: result.inputs,
						...(result.work ? { work: result.work } : {}),
						...(initialization ? { initialization } : {}),
					};
				}
				throw new Error("OMP session returned no assistant message");
			},
		);
	}

	async tools(
		chatId: string,
		sessionId: string | undefined,
		names: string[] | undefined,
		requestId: unknown,
		signal: AbortSignal,
	): Promise<InspectedSession> {
		const { sessionId: target, initialization } = await this.#selectSession(
			chatId,
			sessionId,
			requestId,
			signal,
		);
		const { inspection, inputs } = await this.#inspect(target, signal);
		const selected = names ? new Set(names) : undefined;
		if (selected) {
			const available = new Set(inspection.tools.map(({ name }) => name));
			const missing = [...selected].filter((name) => !available.has(name));
			if (missing.length)
				throw new Error(
					`Native tools are not active: ${missing.join(", ")}. Refresh the session tool catalog.`,
				);
		}
		await this.#confirmBindingUse(chatId, sessionId, target);
		return {
			...inspection,
			...(initialization ? { initialization } : {}),
			tools: selected
				? inspection.tools.filter(({ name }) => selected.has(name))
				: inspection.tools,
			inputs,
		};
	}

	async call(
		chatId: string,
		sessionId: string | undefined,
		calls: ToolInput[],
		requestId: unknown,
		signal: AbortSignal,
		direct = false,
	): Promise<CallResult> {
		signal.throwIfAborted();
		calls = validateNativeCalls(calls, direct);
		const { sessionId: target, initialization } = await this.#selectSession(
			chatId,
			sessionId,
			requestId,
			signal,
		);
		const identity = operationIdentity(
			chatId,
			target,
			"call",
			requestId,
			calls,
		);
		return this.#coalesceOperation(
			identity,
			signal,
			async (operationSignal) => {
				if (identity) {
					const session = this.#sessions.get(target);
					if (!session) throw new Error("Target session disconnected");
					const replay = await this.#state.reserveOperation({
						...identity,
						chatId,
						sessionId: target,
						cwd: session.description.cwd,
						status: "running",
						updatedAt: Date.now(),
					});
					if (replay) {
						await this.#confirmBindingUse(chatId, sessionId, target);
						return {
							sessionId: target,
							cwd: replay.cwd,
							inputs: [],
							toolResults: [],
							replay: replayReceipt(replay),
						};
					}
				}

				const toolCalls = nativeToolCalls(calls);
				const result = await this.#request(
					target,
					(id) => ({
						type: "call",
						id,
						...source(chatId, requestId),
						...this.#state.executionSource(identity?.key),
						sessionId: target,
						calls: toolCalls,
						...(direct ? { direct: true } : {}),
					}),
					operationSignal,
				).catch(async (error: unknown) => {
					await this.#state.finishOperation(identity?.key, "uncertain");
					throw error;
				});
				if ("execution" in result) {
					await this.#recordInputWait(identity?.key, result);
					return {
						sessionId: target,
						cwd: result.cwd,
						inputs: result.inputs,
						...(result.work ? { work: result.work } : {}),
						toolResults: [],
						execution: result.execution,
						...(initialization ? { initialization } : {}),
					};
				}
				if ("toolResults" in result) {
					await this.#state.finishOperation(
						identity?.key,
						"completed",
						result.toolResults.flatMap((result) =>
							resourceDescriptors(result.details),
						),
					);
					await this.#confirmBindingUse(chatId, sessionId, target);
					return {
						sessionId: target,
						...(initialization ? { initialization } : {}),
						cwd: result.cwd,
						toolResults: result.toolResults,
						inputs: result.inputs,
						...(result.work ? { work: result.work } : {}),
					};
				}
				await this.#state.finishOperation(identity?.key, "uncertain");
				throw new Error("OMP session returned no tool results");
			},
		);
	}

	async startCall(
		chatId: string,
		sessionId: string | undefined,
		calls: ToolInput[],
		operationId: string,
		requestId: unknown,
		signal: AbortSignal,
	): Promise<StartedOperation> {
		signal.throwIfAborted();
		calls = validateNativeCalls(calls);
		const stableId = validateOperationId(operationId);
		const prior = this.#state.findOperation(chatId, stableId);
		if (prior) {
			if (sessionId && sessionId !== prior.sessionId)
				throw new Error(
					"Operation identifier already belongs to another session",
				);
			const replay = operationIdentity(
				chatId,
				prior.sessionId,
				"call",
				requestId,
				calls,
				stableId,
			);
			if (replay?.signature !== prior.signature)
				throw new Error("Operation identifier reused with different arguments");
			if (prior.status !== "waiting_input") {
				await this.#state.flush();
				return {
					operation: operationView(this.#state.operation(chatId, stableId)),
				};
			}
			// Finish recording the known-unexecuted attempt before reclaiming it.
			await this.#detachedOperations.get(prior.key)?.promise;
			signal.throwIfAborted();
			sessionId = prior.sessionId;
		}
		const { sessionId: target, initialization } = await this.#selectSession(
			chatId,
			sessionId,
			requestId,
			signal,
		);
		const identity = operationIdentity(
			chatId,
			target,
			"call",
			requestId,
			calls,
			stableId,
		);
		if (!identity?.operationId)
			throw new Error("Detached calls require a stable operationId");
		const session = this.#sessions.get(target);
		if (!session) throw new Error("Target session disconnected");
		await this.#confirmBindingUse(chatId, sessionId, target);
		signal.throwIfAborted();
		const createdAt = Date.now();
		const receipt = {
			...identity,
			chatId,
			sessionId: target,
			cwd: session.description.cwd,
			createdAt,
			status: "running" as const,
			updatedAt: createdAt,
		};
		// Own cancellation before reserveOperation exposes running state or yields.
		// A competing submitter must not replace the owner of this acceptance.
		const accepting = this.#detachedOperations.get(identity.key);
		if (accepting) {
			if (accepting.signature !== identity.signature)
				throw new Error("Operation identifier reused with different arguments");
			await this.#state.flush();
			return {
				operation: operationView(this.#state.operation(chatId, stableId)),
			};
		}
		const completion = Promise.withResolvers<void>();
		const execution = new AbortController();
		const tracked: DetachedOperation = {
			controller: execution,
			promise: completion.promise,
			dispatched: false,
			signature: identity.signature,
		};
		this.#detachedOperations.set(identity.key, tracked);
		void completion.promise
			.finally(() => {
				if (this.#detachedOperations.get(identity.key) === tracked)
					this.#detachedOperations.delete(identity.key);
			})
			.catch(() => {});
		try {
			const existing = await this.#state.reserveOperation(receipt);
			if (!existing && execution.signal.aborted) {
				const error = execution.signal.reason;
				await this.#state.finishOperation(
					identity.key,
					error instanceof Error && error.message === operationCancelledMessage
						? "cancelled"
						: "uncertain",
					[],
					error instanceof Error ? error.message : String(error),
				);
			}
			if (
				!existing &&
				!execution.signal.aborted &&
				this.#state.operation(chatId, stableId).status === "running"
			) {
				const toolCalls = nativeToolCalls(calls);
				const executionSource = this.#state.executionSource(identity.key);
				const isCurrent = () =>
					this.#state.findOperation(chatId, stableId)?.executionId ===
					executionSource.executionId;
				tracked.dispatched = true;
				const detached = this.#request(
					target,
					(id) => ({
						type: "call",
						id,
						chatId,
						requestId: stableId,
						...executionSource,
						sessionId: target,
						calls: toolCalls,
					}),
					execution.signal,
				)
					.then(async (result) => {
						if (!isCurrent()) return;
						if ("execution" in result) {
							await this.#recordInputWait(identity.key, result);
							return;
						}
						if (!("toolResults" in result)) {
							await this.#state.finishOperation(
								identity.key,
								"uncertain",
								[],
								"Agent session returned no tool results",
							);
							return;
						}
						await this.#state.addDelivery({
							id: `operation:${executionSource.executionId ?? identity.key}`,
							chatId,
							...executionSource,
							sessionId: target,
							cwd: result.cwd,
							toolResults: result.toolResults,
							...(result.work ? { work: result.work } : {}),
							complete: true,
						});
					})
					.catch(async (error: unknown) => {
						if (!isCurrent()) return;
						const cancelled =
							execution.signal.aborted &&
							execution.signal.reason instanceof Error &&
							execution.signal.reason.message === operationCancelledMessage;
						await this.#state.finishOperation(
							identity.key,
							cancelled ? "cancelled" : "uncertain",
							[],
							error instanceof Error ? error.message : String(error),
						);
					});
				void detached.then(completion.resolve, completion.reject);
			}
			return {
				operation: operationView(this.#state.operation(chatId, stableId)),
				...(initialization ? { initialization } : {}),
			};
		} finally {
			if (!tracked.dispatched) completion.resolve();
		}
	}

	operation(chatId: string, operationId: string): OperationResult {
		const receipt = this.#state.operation(
			chatId,
			validateOperationId(operationId),
		);
		return {
			operation: operationView(receipt),
			deliveries: this.#state.deliveriesForOperation(chatId, receipt.key),
			result: this.#state.resultForOperation(chatId, operationId),
			inputs: receipt.waitingInputs ?? [],
		};
	}

	async #recordInputWait(
		key: string | undefined,
		result: Extract<SessionResult, { execution: ExecutionWait }>,
	): Promise<void> {
		await this.#state.waitForInput(
			key,
			result.inputs.filter((input): input is ModelInput => "request" in input),
		);
	}

	async cancelOperation(
		chatId: string,
		operationId: string,
	): Promise<OperationResult> {
		const receipt = this.#state.operation(
			chatId,
			validateOperationId(operationId),
		);
		await this.#cancelDetached(receipt);
		return this.operation(chatId, operationId);
	}

	async #cancelDetached(receipt: OperationReceipt) {
		if (receipt.status !== "running" && receipt.status !== "waiting_input")
			return;
		const detached = this.#detachedOperations.get(receipt.key);
		if (detached) {
			detached.controller.abort(new Error(operationCancelledMessage));
			// Persist the intent even if the result is concurrently becoming an input wait.
			await this.#state.finishOperation(
				receipt.key,
				"cancelled",
				[],
				operationCancelledMessage,
			);
			if (detached.dispatched) await detached.promise;
			return;
		}
		await this.#state.finishOperation(
			receipt.key,
			receipt.status === "waiting_input" ? "cancelled" : "uncertain",
			[],
			receipt.status === "waiting_input"
				? operationCancelledMessage
				: "Detached execution is no longer attached to this broker",
		);
	}
	async history(
		chatId: string,
		sessionId: string | undefined,
		range: HistoryRange,
		requestId: unknown,
		signal: AbortSignal,
	) {
		const boundId = sessionId ? undefined : this.#state.binding(chatId);
		const target = sessionId ?? boundId;
		if (!target) throw new Error("Specify a OMP sessionId to read history");
		await this.#waitForSession(target, signal);
		const result = await this.#request(
			target,
			(id) => ({
				type: "history",
				id,
				sessionId: target,
				range,
				...source(chatId, requestId),
			}),
			signal,
		);
		if ("history" in result) {
			await this.#confirmBindingUse(chatId, sessionId, target);
			return { sessionId: target, ...result };
		}
		throw new Error("OMP session returned no history");
	}

	async acknowledgeInputs(
		sessionId: string,
		inputs: SessionInput[],
	): Promise<void> {
		await this.#ackInputs(sessionId, inputs);
	}

	async inputs(
		chatId: string,
		sessionId: string | undefined,
		signal: AbortSignal,
	): Promise<SessionInput[]> {
		const boundId = sessionId ? undefined : this.#state.binding(chatId);
		const target = sessionId ?? boundId;
		if (!target || !this.#sessions.has(target)) return [];
		const result = await this.#request(
			target,
			(id) => ({ type: "inputs", id, sessionId: target }),
			signal,
		);
		if (!("inputs" in result))
			throw new Error("OMP session returned no pending inputs");
		await this.#ackInputs(target, result.inputs, signal);
		await this.#confirmBindingUse(chatId, sessionId, target);
		return result.inputs;
	}

	async ask(
		chatId: string,
		sessionId: string | undefined,
		input: QuestionInput,
		requestId: unknown,
		signal: AbortSignal,
	): Promise<Question & { initialization?: Initialization }> {
		const { sessionId: target, initialization } = await this.#selectSession(
			chatId,
			sessionId,
			requestId,
			signal,
		);
		signal.throwIfAborted();
		const session = this.#sessions.get(target);
		if (!session) throw new Error(`OMP session ${target} is offline`);
		const question: QuestionRecord = {
			...input,
			id: randomUUID(),
			chatId,
			sessionId: target,
			cwd: session.description.cwd,
			delivered: false,
		};
		await this.#state.addQuestion(question);
		await this.#confirmBindingUse(chatId, sessionId, target);
		const activity = source(chatId, requestId);
		void this.#notify(
			target,
			`${chatLabel(activity)} asked: ${question.question}`,
			{
				event: "asked",
				...activity,
			},
		).catch(() => {});
		return {
			...questionView(question),
			...(initialization ? { initialization } : {}),
		};
	}

	async assertQuestion(
		chatId: string,
		id: string,
		signal: AbortSignal,
	): Promise<Question> {
		const timeout = AbortSignal.timeout(10_000);
		const combined = AbortSignal.any([signal, timeout]);
		try {
			for (;;) {
				signal.throwIfAborted();
				const question = this.#state.question(chatId, id);
				if (question.loaded) return questionView(question);
				await this.#waitForChange(combined);
			}
		} catch (error) {
			signal.throwIfAborted();
			if (!timeout.aborted) throw error;
			const question = this.#state.question(chatId, id);
			if (question.loaded) return questionView(question);
			if (!question.answer) {
				await this.#state.answer(chatId, id, {
					selections: [],
					text: "",
					skipped: true,
				});
				void this.#notify(
					question.sessionId,
					`Question skipped after display timeout: ${question.question}`,
					{ event: "skipped", chatId },
				).catch(() => {});
			}
			throw new Error(
				"Question widget did not load within 10 seconds. The question was automatically skipped. Use an installed OMP interactive tool through call if an answer is needed.",
			);
		}
	}

	async answer(
		chatId: string,
		id: string,
		answer?: QuestionAnswer,
		loaded = false,
	): Promise<Question> {
		let question = this.#state.question(chatId, id);
		if ((loaded || answer) && !question.loaded) {
			this.#cooldown(chatId, question.sessionId);
			question = { ...question, loaded: true };
			await this.#state.addQuestion(question);
			this.#notifyChange();
		}
		if (answer) {
			const previous = question.answer;
			question = await this.#state.answer(chatId, id, answer);
			if (question.answer !== previous) {
				const response = [
					...(question.answer?.selections ?? []).map(
						(index) => question.options[index]?.title,
					),
					question.answer?.text,
				]
					.filter(Boolean)
					.join(", ");
				const message = question.answer?.skipped
					? `Skipped in ChatGPT ${chatId.slice(-4)}: ${question.question}`
					: previous
						? `Answer updated in ChatGPT ${chatId.slice(-4)}: ${question.question} — ${response}`
						: `Answered in ChatGPT ${chatId.slice(-4)}: ${question.question} — ${response}`;
				void this.#notify(question.sessionId, message, {
					event: question.answer?.skipped ? "skipped" : "answered",
					chatId,
				}).catch(() => {});
			}
		}
		return questionView(question);
	}

	answers(chatId: string): QuestionRecord[] {
		return this.#state.answers(chatId);
	}

	async readResource(uri: string, signal: AbortSignal): Promise<ResourceData> {
		const requested = new URL(uri);
		const chatId = requested.searchParams.get("chatId");
		requested.search = "";
		const sessionId = resourceSessionId(requested.href);
		if (chatId) this.#cooldown(chatId, sessionId);
		await this.#waitForSession(sessionId, signal);
		const result = await this.#request(
			sessionId,
			(id) => ({ type: "readResource", id, sessionId, uri: requested.href }),
			signal,
		);
		if ("resource" in result) {
			if (chatId) await this.#state.recordResourceRead(chatId, requested.href);
			if (chatId) this.#cooldown(chatId, sessionId);
			return { ...result.resource, uri };
		}
		throw new Error("OMP session returned no resource");
	}

	deliveries(chatId: string): DeliveryRecord[] {
		return this.#state.deliveries(chatId);
	}

	acknowledge(
		deliveries: DeliveryRecord[],
		answers: QuestionRecord[],
		signal: AbortSignal,
	): Promise<void> {
		return this.#state.acknowledge(deliveries, answers, signal);
	}

	async #receive(
		peer: JsonLinePeer<SessionMessage, BrokerMessage>,
		message: SessionMessage,
	): Promise<void> {
		switch (message.type) {
			case "request": {
				const sourceSession = [...this.#sessions.values()].find(
					(session) => session.peer === peer,
				);
				if (!sourceSession)
					throw new Error("Unregistered IPC peer cannot relay requests");
				if (
					message.request.type === "call" ||
					message.request.type === "chat"
				) {
					const validOperationId =
						typeof message.request.requestId === "string" &&
						message.request.requestId.length > 0 &&
						message.request.requestId.length <= 128;
					if (
						!this.#localTools ||
						sourceSession.description.host !== "omp" ||
						message.request.chatId !== sourceSession.description.id ||
						!validOperationId ||
						(message.request.type === "call" && message.request.direct === true)
					) {
						await peer.send({
							type: "response",
							id: message.id,
							error: "Remote collaboration is not authorized for this session",
						});
						break;
					}
				}
				if (
					message.request.type === "call" &&
					hasHostFileImport(message.request.calls)
				) {
					await peer.send({
						type: "response",
						id: message.id,
						error: "Host file imports require the direct transfer tool",
					});
					break;
				}
				if (message.request.type === "sessions") {
					await peer.send({
						type: "response",
						id: message.id,
						sessions: this.listSessions(message.request.sessionId),
					});
					break;
				}
				let relays = this.#relays.get(peer);
				if (!relays) {
					relays = new Map();
					this.#relays.set(peer, relays);
				}
				if (relays.has(message.id) || relays.size >= 128)
					throw new Error("Duplicate or excessive relay requests");
				const controller = new AbortController();
				relays.set(message.id, controller);
				const relay =
					message.request.type === "call" || message.request.type === "chat"
						? this.#relayExecution(message.request, controller.signal)
						: this.#request(
								message.request.sessionId,
								(id) => ({ ...message.request, id }),
								controller.signal,
							);
				void relay
					.then(
						(result) =>
							peer.send({ ...result, type: "response", id: message.id }),
						(error: unknown) =>
							peer.send({
								type: "response",
								id: message.id,
								error: error instanceof Error ? error.message : String(error),
							}),
					)
					.finally(() => relays.delete(message.id))
					.catch(() => {});
				break;
			}
			case "cancelRequest":
				this.#relays
					.get(peer)
					?.get(message.id)
					?.abort(new Error("Transfer cancelled"));
				break;
			case "sync": {
				const owner = this.#sessions.get(message.session.id)?.peer;
				if (owner && owner !== peer && !owner.closed)
					throw new Error("Session already belongs to another connection");
				const registered =
					this.#sessions.get(message.session.id)?.peer === peer;
				this.#sessions.set(message.session.id, {
					description: message.session,
					peer,
				});
				await peer.send({
					type: "synced",
					id: message.id,
					sessionId: message.session.id,
				});
				if (!registered)
					await this.#notify(message.session.id, "Chappie connected", {
						event: "connected",
					});
				this.#notifyChange();
				break;
			}
			case "unregister": {
				const session = this.#sessions.get(message.sessionId);
				if (session?.peer === peer) this.#removeSession(message.sessionId);
				break;
			}
			case "delivery":
				if (
					![...this.#sessions.values()].some((session) => session.peer === peer)
				)
					throw new Error("Unregistered peer cannot submit results");
				if (
					this.#sessions.get(message.delivery.sessionId)?.peer !== peer &&
					!this.#state.ownsOperation(
						message.delivery.operationKey,
						message.delivery.chatId,
						message.delivery.sessionId,
					)
				)
					throw new Error("Deferred result does not belong to this operation");
				try {
					await this.#state.addDelivery(message.delivery);
				} catch (error) {
					// Ownership was checked above. Release a stale packet so the
					// connected OMP does not endlessly reconnect and resend it.
					if (!(error instanceof StaleOperationDeliveryError)) throw error;
				}
				await peer.send({ type: "stored", id: message.delivery.id });
				break;
			case "result": {
				const pending = this.#pending.get(message.id);
				if (!pending || pending.peer !== peer) break;
				this.#finishRequest(message.id, pending);
				if ("error" in message) pending.reject(new Error(message.error));
				else {
					const { type: _type, id: _id, ...result } = message;
					pending.resolve(result);
				}
				break;
			}
		}
	}

	async #coalesceOperation<T extends ChatResult | CallResult>(
		identity: { key: string; signature: string } | undefined,
		signal: AbortSignal,
		execute: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		if (!identity) return execute(signal);
		const existing = this.#inFlightOperations.get(identity.key);
		if (existing) {
			if (existing.signature !== identity.signature)
				throw new Error("Operation identifier reused with different arguments");
			return this.#waitForOperation<T>(existing, signal);
		}
		const controller = new AbortController();
		const task = execute(controller.signal);
		const tracked: InFlightOperation = {
			signature: identity.signature,
			promise: task,
			controller,
			waiters: 0,
		};
		this.#inFlightOperations.set(identity.key, tracked);
		void task
			.finally(() => {
				if (this.#inFlightOperations.get(identity.key) === tracked)
					this.#inFlightOperations.delete(identity.key);
			})
			.catch(() => {});
		return this.#waitForOperation<T>(tracked, signal);
	}

	#waitForOperation<T>(
		operation: InFlightOperation,
		signal: AbortSignal,
	): Promise<T> {
		if (signal.aborted) {
			const error = abortError(signal);
			if (operation.waiters === 0) operation.controller.abort(error);
			return Promise.reject(error);
		}
		operation.waiters++;
		const completion = Promise.withResolvers<T>();
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			signal.removeEventListener("abort", onAbort);
			operation.waiters--;
		};
		const onAbort = () => {
			const error = abortError(signal);
			release();
			completion.reject(error);
			if (operation.waiters === 0) operation.controller.abort(error);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		void (operation.promise as Promise<T>).then(
			(value) => {
				release();
				completion.resolve(value);
			},
			(error) => {
				release();
				completion.reject(error);
			},
		);
		return completion.promise;
	}

	async #confirmBindingUse(
		chatId: string,
		requestedId: string | undefined,
		sessionId: string,
	): Promise<void> {
		if (requestedId !== undefined) return;
		await this.#state.confirmBindingUse(chatId, sessionId);
	}

	async #selectSession(
		chatId: string,
		requestedId: string | undefined,
		requestId: unknown,
		signal: AbortSignal,
		bindRequested = false,
	): Promise<{
		sessionId: string;
		selection: InitializedSession["selection"];
		initialization?: Initialization;
		bindingMutation?: BindingMutation;
	}> {
		const selectionTimeout = AbortSignal.timeout(this.#sessionWaitMs);
		for (;;) {
			signal.throwIfAborted();
			const boundId = this.#state.binding(chatId);
			let target = requestedId ?? boundId;
			let reserved = false;
			if (!target && !this.#selectionReservations.has(chatId)) {
				const occupied = this.#state.bindingCounts();
				const reservations = new Set(this.#selectionReservations.values());
				target = [...this.#sessions.keys()].find(
					(id) => !occupied.has(id) && !reservations.has(id),
				);
				if (target) {
					// Reserve before the first await, not after the binding is saved.
					this.#selectionReservations.set(chatId, target);
					reserved = true;
				}
			}
			if (!target) {
				await this.#waitForChange(
					AbortSignal.any([signal, selectionTimeout]),
				).catch((error: unknown) => {
					if (selectionTimeout.aborted && error === selectionTimeout.reason)
						throw new Error(
							"No available unbound session. Use sessions and select a sessionId explicitly.",
						);
					throw error;
				});
				continue;
			}
			try {
				await this.#waitForSession(target, signal);
				signal.throwIfAborted();
				const joined =
					bindRequested || !boundId
						? await this.#join(chatId, target, requestId, signal, bindRequested)
						: undefined;
				return {
					sessionId: target,
					selection: requestedId
						? "explicit"
						: boundId
							? "existing"
							: "automatic",
					...(joined
						? {
								initialization: joined.initialization,
								bindingMutation: joined.bindingMutation,
							}
						: {}),
				};
			} finally {
				if (reserved) {
					this.#selectionReservations.delete(chatId);
					this.#notifyChange();
				}
			}
		}
	}

	async #join(
		chatId: string,
		sessionId: string,
		requestId: unknown,
		signal: AbortSignal,
		explicit = false,
	): Promise<{
		initialization: Initialization;
		bindingMutation: BindingMutation;
	}> {
		signal.throwIfAborted();
		const previous = this.#state.binding(chatId);
		const key = JSON.stringify([chatId, sessionId]);
		const observer = (this.#cooldowns.get(key) ?? 0) > Date.now();
		if (!observer) this.#cooldown(chatId, sessionId);
		let bindingMutation: BindingMutation | undefined;
		try {
			bindingMutation = await this.#state.bind(chatId, sessionId);
			signal.throwIfAborted();
			const activity = source(chatId, requestId);
			if (previous !== sessionId) {
				this.#notifyChange();
				if (previous)
					await this.#notify(previous, `${chatLabel(activity)} left`, {
						...activity,
						event: "left",
					});
			}
			signal.throwIfAborted();
			await this.#notify(sessionId, `${chatLabel(activity)} joined`, {
				...activity,
				event: "joined",
				initialization: explicit ? "explicit" : "implicit",
			});
			return {
				initialization: {
					sessionId,
					instructions: observer ? observerInstructions : historyInstructions,
					mode: observer ? "observer" : "executor",
				},
				bindingMutation,
			};
		} catch (error) {
			if (!observer) this.#cooldowns.delete(key);
			if (bindingMutation) {
				try {
					await this.#state.restoreBinding(chatId, bindingMutation);
				} catch (rollbackError) {
					throw new AggregateError(
						[error, rollbackError],
						"Session join failed and its binding could not be restored",
					);
				}
			}
			throw error;
		}
	}

	#cooldown(chatId: string, sessionId: string): void {
		const now = Date.now();
		for (const [key, expires] of this.#cooldowns) {
			if (expires <= now) this.#cooldowns.delete(key);
		}
		const key = JSON.stringify([chatId, sessionId]);
		if (this.#cooldownMs === 0) {
			this.#cooldowns.delete(key);
			return;
		}
		this.#cooldowns.set(key, now + this.#cooldownMs);
	}

	async #notify(
		sessionId: string,
		message: string,
		activity: Activity = {},
	): Promise<void> {
		await this.#sessions
			.get(sessionId)
			?.peer.send({ type: "notice", sessionId, message, activity });
	}

	async #waitForSession(sessionId: string, signal: AbortSignal): Promise<void> {
		const timeout = AbortSignal.timeout(this.#sessionWaitMs);
		try {
			while (!this.#sessions.has(sessionId))
				await this.#waitForChange(AbortSignal.any([signal, timeout]));
		} catch (error) {
			if (timeout.aborted && error === timeout.reason)
				throw new Error(
					`Session ${sessionId} is offline or unavailable. Check sessions and the broker's agent directory.`,
				);
			throw error;
		}
	}

	async #inspect(
		sessionId: string,
		signal: AbortSignal,
	): Promise<Extract<SessionResult, { inspection: SessionInspection }>> {
		const timeout = AbortSignal.timeout(this.#inspectionTimeoutMs);
		const result = await this.#request(
			sessionId,
			(id) => ({ type: "inspect", id, sessionId }),
			AbortSignal.any([signal, timeout]),
		).catch((error: unknown) => {
			// Preserve the cause that settled the request, not a later caller abort.
			if (timeout.aborted && error === timeout.reason)
				throw new Error(
					`Session ${sessionId} did not respond to inspection. Check the local host connection.`,
				);
			throw error;
		});
		if ("inspection" in result) return result;
		throw new Error("OMP session returned no inspection");
	}

	async #ackInputs(
		sessionId: string,
		inputs: SessionInput[],
		signal?: AbortSignal,
	): Promise<void> {
		signal?.throwIfAborted();
		if (inputs.length === 0) return;
		const session = this.#sessions.get(sessionId);
		if (!session) throw new Error(`OMP session ${sessionId} is offline`);
		await session.peer.send({
			type: "ackInputs",
			sessionId,
			ids: inputs.map(({ id }) => id),
		});
	}

	async #relayExecution(
		request: Extract<SessionRequest, { type: "chat" | "call" }>,
		signal: AbortSignal,
	): Promise<SessionResult> {
		const payload: ToolInput[] | string =
			request.type === "call"
				? request.calls.map(({ name, arguments: input }) => {
						if (name !== "transfer" || input.operationId === undefined)
							return { name, arguments: input };
						const { operationId: _nestedId, ...argumentsWithoutId } = input;
						return { name, arguments: argumentsWithoutId };
					})
				: JSON.stringify({
						text: request.text,
						replyTo: request.replyTo,
						mode: request.mode ?? "message",
					});
		const identity = operationIdentity(
			request.chatId,
			request.sessionId,
			request.type,
			request.requestId,
			payload,
		);
		if (identity) {
			const session = this.#sessions.get(request.sessionId);
			if (!session) throw new Error("Target session disconnected");
			const existing = await this.#state.reserveOperation({
				...identity,
				chatId: request.chatId,
				sessionId: request.sessionId,
				cwd: session.description.cwd,
				status: "running",
				updatedAt: Date.now(),
			});
			if (existing) {
				const replay = replayReceipt(existing);
				throw new Error(
					`Already accepted remote operation (${replay.status}); native execution was not repeated`,
				);
			}
		}
		const result = await this.#request(
			request.sessionId,
			(id) => ({
				...request,
				id,
				...this.#state.executionSource(identity?.key),
			}),
			signal,
		).catch(async (error: unknown) => {
			await this.#state.finishOperation(identity?.key, "uncertain");
			throw error;
		});
		if ("execution" in result) {
			await this.#recordInputWait(identity?.key, result);
			return result;
		}
		if (
			(request.type === "call" && "toolResults" in result) ||
			(request.type === "chat" && ("message" in result || "progress" in result))
		) {
			await this.#state.finishOperation(
				identity?.key,
				"completed",
				request.type === "call" && "toolResults" in result
					? result.toolResults.flatMap((item) =>
							resourceDescriptors(item.details),
						)
					: [],
			);
			return result;
		}
		await this.#state.finishOperation(identity?.key, "uncertain");
		throw new Error(
			request.type === "call"
				? "Agent session returned no tool results"
				: "Agent session returned no assistant message",
		);
	}
	async #request(
		sessionId: string,
		message: (id: number) => BrokerMessage,
		signal: AbortSignal,
	): Promise<SessionResult> {
		const session = this.#sessions.get(sessionId);
		if (!session) throw new Error(`OMP session ${sessionId} is offline`);
		if (signal.aborted) throw abortError(signal);
		if (this.#pending.size >= 512)
			throw new Error("Too many pending session requests");
		const id = this.#nextRequestId++;
		const completion = Promise.withResolvers<SessionResult>();
		const onAbort = (): void => {
			const pending = this.#pending.get(id);
			if (!pending) return;
			void pending.peer
				.send({
					type: "cancel",
					id,
					sessionId,
					reason: abortError(signal).message,
				})
				.catch(() => {});
			this.#finishRequest(id, pending);
			pending.reject(abortError(signal));
		};
		const pending: PendingRequest = {
			sessionId,
			peer: session.peer,
			resolve: completion.resolve,
			reject: completion.reject,
			signal,
			onAbort,
		};
		this.#pending.set(id, pending);
		signal.addEventListener("abort", onAbort, { once: true });
		void session.peer.send(message(id)).catch((error: unknown) => {
			this.#finishRequest(id, pending);
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		});
		return completion.promise;
	}

	#waitForChange(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return Promise.reject(abortError(signal));
		const completion = Promise.withResolvers<void>();
		const onAbort = (): void => {
			this.#waiters.delete(waiter);
			waiter.reject(abortError(signal));
		};
		const waiter: ChangeWaiter = {
			resolve: completion.resolve,
			reject: completion.reject,
			signal,
			onAbort,
		};
		this.#waiters.add(waiter);
		signal.addEventListener("abort", onAbort, { once: true });
		return completion.promise;
	}

	#notifyChange(): void {
		for (const waiter of this.#waiters) {
			this.#waiters.delete(waiter);
			waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.resolve();
		}
	}

	#finishRequest(id: number, pending: PendingRequest): void {
		this.#pending.delete(id);
		pending.signal.removeEventListener("abort", pending.onAbort);
	}

	#removePeer(peer: JsonLinePeer<SessionMessage, BrokerMessage>): void {
		for (const controller of this.#relays.get(peer)?.values() ?? []) {
			controller.abort(new Error("OMP session disconnected"));
		}
		this.#relays.delete(peer);
		for (const [sessionId, session] of this.#sessions) {
			if (session.peer === peer) this.#removeSession(sessionId);
		}
		for (const [id, pending] of this.#pending) {
			if (pending.peer !== peer) continue;
			this.#finishRequest(id, pending);
			pending.reject(new Error("OMP session disconnected"));
		}
	}

	#removeSession(sessionId: string): void {
		this.#sessions.delete(sessionId);
		for (const [id, pending] of this.#pending) {
			if (pending.sessionId !== sessionId) continue;
			this.#finishRequest(id, pending);
			pending.reject(
				new Error("Session changed or disconnected before request completion"),
			);
		}
		this.#notifyChange();
	}
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error(
				typeof signal.reason === "string" ? signal.reason : "Request cancelled",
			);
}
