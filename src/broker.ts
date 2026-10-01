import { randomUUID } from "node:crypto";
import type { ToolCall } from "@earendil-works/pi-ai";
import { type Activity, chatLabel, source } from "./activity.ts";
import { readConfig } from "./config.ts";
import type { DeliveryRecord } from "./delivery.ts";
import { type HistoryRange, historyInstructions } from "./history.ts";
import {
	type BrokerMessage,
	IpcServer,
	type JsonLinePeer,
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
	operationIdentity,
	type ReplayReceipt,
	replayReceipt,
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
import { type BindingMutation, State } from "./state.ts";
import type { ToolInput } from "./tools.ts";

const observerInstructions =
	"This ChatGPT conversation recently initialized or resumed work in this Pi session. A recent initialization may still own this task; do not assume another completion is needed. Participate as an observer for this task: read history with observer: true, follow new entries with after and wait: true, and think independently. Leave execution and Pi communication to the ongoing work. Do not export files, repeat the completed report, or publish a second completion response. Leave the single completion response to the original execution. Continue observing rather than reinitializing to take over.";

function hasHostFileImport(
	calls: readonly { name: string; arguments: Record<string, unknown> }[],
): boolean {
	return calls.some(
		(call) => call.name === "transfer" && Array.isArray(call.arguments.files),
	);
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

export interface InitializedSession extends Omit<SessionInspection, "tools"> {
	selection: "existing" | "explicit" | "automatic";
	initialization?: Initialization;
	globalAgents?: { path: string };
	inputs: SessionInput[];
	tools: { name: string; description: string }[];
}

export interface InspectedSession extends SessionInspection {
	initialization?: Initialization;
	inputs: SessionInput[];
}

export interface ChatResult {
	replay?: ReplayReceipt;
	initialization?: Initialization;
	sessionId: string;
	cwd: string;
	inputs: SessionInput[];
}

export interface CallResult extends ChatResult {
	toolResults: SessionToolResult[];
}

export interface BrokerOptions {
	sessionWaitMs?: number;
	inspectionTimeoutMs?: number;
}

export class Broker {
	readonly #agentDir: string;
	readonly #sessionWaitMs: number;
	readonly #inspectionTimeoutMs: number;
	readonly #ipc: IpcServer;
	readonly #state: State;
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
	#ask = true;
	#cooldownMs = 10_000;
	#localTools = false;
	#nextRequestId = 1;

	constructor(agentDir: string, options: BrokerOptions = {}) {
		this.#sessionWaitMs = options.sessionWaitMs ?? 5000;
		this.#inspectionTimeoutMs = options.inspectionTimeoutMs ?? 3000;
		this.#agentDir = agentDir;
		this.#state = new State(agentDir);
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
			if (initialization?.mode !== "observer")
				await this.#ackInputs(target, inputs, signal);
			return {
				selection,
				...(initialization ? { initialization } : {}),
				...inspection,
				tools: inspection.tools.map(({ name, description }) => ({
					name,
					description: description.split("\n", 1)[0] ?? description,
				})),
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
	): Promise<ChatResult> {
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
			replyTo ? JSON.stringify({ text, replyTo }) : text,
		);
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
				...(identity ? { operationKey: identity.key } : {}),
				sessionId: target,
				text,
				...(replyTo ? { replyTo } : {}),
			}),
			signal,
		).catch(async (error: unknown) => {
			await this.#state.finishOperation(identity?.key, "uncertain");
			throw error;
		});
		await this.#state.finishOperation(identity?.key, "completed");
		if ("message" in result) {
			const inputs = result.inputs;
			await this.#ackInputs(target, inputs, signal);
			await this.#confirmBindingUse(chatId, sessionId, target);
			return {
				sessionId: target,
				cwd: result.cwd,
				inputs,
				...(initialization ? { initialization } : {}),
			};
		}
		throw new Error("Pi session returned no assistant message");
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
		await this.#ackInputs(target, inputs, signal);
		await this.#confirmBindingUse(chatId, sessionId, target);
		const selected = names ? new Set(names) : undefined;
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
		if (calls.length < 1 || calls.length > 128)
			throw new Error("Tool batches must contain between 1 and 128 calls");
		if (!direct && hasHostFileImport(calls))
			throw new Error("Host file imports require the direct transfer tool");
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

		const toolCalls: ToolCall[] = calls.map((call) => ({
			type: "toolCall",
			id: `chappie-${randomUUID()}`,
			name: call.name,
			arguments: call.arguments,
		}));
		const result = await this.#request(
			target,
			(id) => ({
				type: "call",
				id,
				...source(chatId, requestId),
				...(identity ? { operationKey: identity.key } : {}),
				sessionId: target,
				calls: toolCalls,
				...(direct ? { direct: true } : {}),
			}),
			signal,
		).catch(async (error: unknown) => {
			await this.#state.finishOperation(identity?.key, "uncertain");
			throw error;
		});
		if ("toolResults" in result) {
			await this.#state.finishOperation(
				identity?.key,
				"completed",
				result.toolResults.flatMap((result) =>
					resourceDescriptors(result.details),
				),
			);
			await this.#ackInputs(target, result.inputs, signal);
			await this.#confirmBindingUse(chatId, sessionId, target);
			return {
				sessionId: target,
				...(initialization ? { initialization } : {}),
				cwd: result.cwd,
				toolResults: result.toolResults,
				inputs: result.inputs,
			};
		}
		await this.#state.finishOperation(identity?.key, "uncertain");
		throw new Error("Pi session returned no tool results");
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
		if (!target) throw new Error("Specify a Pi sessionId to read history");
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
		throw new Error("Pi session returned no history");
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
			throw new Error("Pi session returned no pending inputs");
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
		if (!session) throw new Error(`Pi session ${target} is offline`);
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
				"Question widget did not load within 10 seconds. The question was automatically skipped. Use an installed Pi interactive tool through call if an answer is needed.",
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
		throw new Error("Pi session returned no resource");
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
				await this.#state.addDelivery(message.delivery);
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
		throw new Error("Pi session returned no inspection");
	}

	async #ackInputs(
		sessionId: string,
		inputs: SessionInput[],
		signal: AbortSignal,
	): Promise<void> {
		signal.throwIfAborted();
		if (inputs.length === 0) return;
		const session = this.#sessions.get(sessionId);
		if (!session) throw new Error(`Pi session ${sessionId} is offline`);
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
				: request.replyTo
					? JSON.stringify({ text: request.text, replyTo: request.replyTo })
					: request.text;
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
					`Already accepted remote operation (${replay.status}). ${replay.instructions}`,
				);
			}
		}
		const result = await this.#request(
			request.sessionId,
			(id) => ({
				...request,
				id,
				...(identity ? { operationKey: identity.key } : {}),
			}),
			signal,
		).catch(async (error: unknown) => {
			await this.#state.finishOperation(identity?.key, "uncertain");
			throw error;
		});
		if (
			(request.type === "call" && "toolResults" in result) ||
			(request.type === "chat" && "message" in result)
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
		if (!session) throw new Error(`Pi session ${sessionId} is offline`);
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
			controller.abort(new Error("Pi session disconnected"));
		}
		this.#relays.delete(peer);
		for (const [sessionId, session] of this.#sessions) {
			if (session.peer === peer) this.#removeSession(sessionId);
		}
		for (const [id, pending] of this.#pending) {
			if (pending.peer !== peer) continue;
			this.#finishRequest(id, pending);
			pending.reject(new Error("Pi session disconnected"));
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
