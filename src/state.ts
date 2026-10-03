import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as z from "zod";
import type { DeliveryRecord } from "./delivery.ts";
import type { ModelInput } from "./ipc.ts";
import { deliverySchema, modelInputSchema } from "./ipc-schema.ts";
import { OperationArchive, recoveryOperationId } from "./operation-archive.ts";
import {
	operationReceiptSchema,
	operationResourceSchema,
} from "./operation-schema.ts";
import type { OperationReceipt, RecentOperations } from "./operations.ts";
import type { QuestionAnswer, QuestionRecord } from "./questions.ts";
import { questionOutput } from "./questions.ts";
import {
	canonicalResourceUri,
	type ResourceDescriptor,
	resourceDescriptors,
	resourceSessionId,
} from "./resources.ts";

const BINDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BINDING_TOUCH_MS = 24 * 60 * 60 * 1000;
const MAX_BINDINGS = 16_384;
const bindingRecordSchema = z.strictObject({
	sessionId: z.string().min(1).max(4096),
	lastUsedAt: z.number().finite().nonnegative(),
});
interface BindingRecord extends z.infer<typeof bindingRecordSchema> {
	revision: number;
}
export interface BindingMutation {
	revision: number;
	previous?: z.infer<typeof bindingRecordSchema>;
}
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const RESULT_RETENTION_MS = TERMINAL_RETENTION_MS;
const stateSchema = z.strictObject({
	bindings: z.record(z.string(), bindingRecordSchema).optional(),
	deliveries: z.array(deliverySchema).max(2048).optional(),
	operationResults: z
		.array(
			z.strictObject({
				operationKey: z.string(),
				delivery: deliverySchema,
			}),
		)
		.max(2048)
		.optional(),
	questions: z
		.array(
			questionOutput.extend({ chatId: z.string(), delivered: z.boolean() }),
		)
		.max(1024)
		.optional(),
	operations: z.array(operationReceiptSchema).max(16384).optional(),
	deliveredIds: z
		.array(z.tuple([z.string(), z.number().nonnegative()]))
		.max(4096)
		.optional(),
});

/** A validated owner may discard a delayed result from an expired acceptance. */
export class StaleOperationDeliveryError extends Error {}

export class State {
	readonly #path: string;
	readonly #temporaryPath: string;
	readonly #bindings = new Map<string, BindingRecord>();
	readonly #deliveries = new Map<string, DeliveryRecord>();
	readonly #questions = new Map<string, QuestionRecord>();
	readonly #operations = new Map<string, OperationReceipt>();
	readonly #deliveredIds = new Map<string, number>();
	#writes = Promise.resolve();
	readonly #operationResults = new Map<string, DeliveryRecord>();
	readonly #pendingBindings = new Map<string, number>();
	#acknowledgements = Promise.resolve();
	#nextBindingRevision = 1;
	#writeError: unknown;
	#writeRevision = 0;
	readonly #archive: OperationArchive;
	#maintenance = Promise.resolve();

	constructor(agentDir: string) {
		this.#path = join(agentDir, "chappie.state.json");
		this.#temporaryPath = `${this.#path}.tmp`;
		this.#archive = new OperationArchive(agentDir);
	}

	async load(): Promise<void> {
		let contents: string;
		try {
			contents = await readFile(this.#path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if (Buffer.byteLength(contents) > MAX_STATE_BYTES)
			throw new Error("Chappie state exceeds the 32 MiB limit");
		let persisted: unknown = JSON.parse(contents);
		if (
			persisted &&
			typeof persisted === "object" &&
			!Array.isArray(persisted)
		) {
			const {
				eventSubscriptions: _eventSubscriptions,
				eventOutbox: _eventOutbox,
				...current
			} = persisted as Record<string, unknown>;
			persisted = current;
		}
		const state = stateSchema.parse(persisted);
		const loadedAt = Date.now();
		for (const [chatId, persisted] of Object.entries(state.bindings ?? {})) {
			this.#bindings.set(chatId, {
				...persisted,
				revision: this.#nextBindingRevision++,
			});
		}
		const bindingsChanged = this.#pruneBindings(loadedAt);
		if (this.#bindings.size > MAX_BINDINGS)
			throw new Error("Binding limit reached");
		for (const delivery of state.deliveries ?? []) {
			// The wire validator checks the persisted native result envelope before restoration.
			if (delivery?.id)
				this.#deliveries.set(delivery.id, delivery as DeliveryRecord);
		}
		for (const saved of state.operationResults ?? []) {
			this.#operationResults.set(
				saved.operationKey,
				saved.delivery as DeliveryRecord,
			);
		}
		for (const question of state.questions ?? [])
			this.#questions.set(question.id, question);
		for (const receipt of state.operations ?? []) {
			if (receipt.status === "running") receipt.status = "uncertain";
			this.#operations.set(receipt.key, receipt);
		}
		for (const [id, time] of state.deliveredIds ?? [])
			this.#deliveredIds.set(id, time);
		const operationsChanged = this.#pruneOperations(loadedAt);
		if (bindingsChanged || operationsChanged) await this.#save();
		await this.#compactUncertain();
	}

	#receipt(key: string): OperationReceipt | undefined {
		return this.#operations.get(key) ?? this.#archive.get(key);
	}

	#compactUncertain(): Promise<void> {
		const compacted = this.#maintenance.then(async () => {
			const cutoff = Date.now() - TERMINAL_RETENTION_MS;
			const pending = new Set(
				[...this.#deliveries.values()].map((delivery) => delivery.operationKey),
			);
			let changed = false;
			for (const [key, receipt] of this.#operations) {
				if (
					receipt.status !== "uncertain" ||
					receipt.updatedAt >= cutoff ||
					pending.has(key) ||
					this.#operationResults.has(key)
				)
					continue;
				const snapshot = structuredClone(receipt);
				await this.#archive.save(snapshot);
				// A cold record must exist before hot replay protection is removed.
				if (
					this.#operations.get(key) === receipt &&
					isDeepStrictEqual(receipt, snapshot)
				) {
					this.#operations.delete(key);
					changed = true;
				}
			}
			if (changed) await this.#save();
		});
		this.#maintenance = compacted.catch(() => {});
		return compacted;
	}

	ownsOperation(
		key: string | undefined,
		chatId: string,
		sessionId: string,
	): boolean {
		this.#pruneOperations();
		const receipt = key ? this.#receipt(key) : undefined;
		return receipt?.chatId === chatId && receipt.sessionId === sessionId;
	}

	executionSource(key: string | undefined): {
		operationKey?: string;
		executionId?: string;
	} {
		if (!key) return {};
		const receipt = this.#operations.get(key);
		if (!receipt) throw new Error("Operation has no retained receipt");
		return {
			operationKey: key,
			...(receipt.executionId ? { executionId: receipt.executionId } : {}),
		};
	}

	async reserveOperation(
		receipt: OperationReceipt,
	): Promise<OperationReceipt | undefined> {
		await this.#compactUncertain();
		this.#pruneOperations();
		if (receipt.operationId) {
			const conflict =
				[...this.#operations.values()].find(
					(value) =>
						value.chatId === receipt.chatId &&
						(recoveryOperationId(value) === receipt.operationId ||
							value.key === receipt.operationId) &&
						value.key !== receipt.key,
				) ?? this.#archive.find(receipt.chatId, receipt.operationId);
			if (conflict && conflict.key !== receipt.key)
				throw new Error(
					"Operation identifier already belongs to another session or operation",
				);
		}
		const existing = this.#receipt(receipt.key);
		if (existing) {
			if (existing.signature !== receipt.signature)
				throw new Error("Operation identifier reused with different arguments");
			if (existing.status !== "waiting_input") {
				await this.flush();
				return existing;
			}
			// Only a host-confirmed unexecuted request may be retried. Claim before
			// yielding, so simultaneous retries still dispatch just one batch.
			const resumed: OperationReceipt = {
				...existing,
				// A pre-upgrade unexecuted request can acquire a public recovery alias,
				// but keeps the original key and acceptance incarnation.
				...(existing.operationId === undefined && receipt.operationId
					? { operationId: receipt.operationId }
					: {}),
				status: "running",
				updatedAt: Date.now(),
			};
			delete resumed.waitingInputs;
			delete resumed.error;
			this.#operations.set(receipt.key, resumed);
			try {
				await this.#save();
			} catch (error) {
				resumed.status = "uncertain";
				throw error;
			}
			return undefined;
		}
		this.#pruneOperations();
		if (this.#operations.size >= 16384)
			throw new Error(
				"Operation receipt limit reached; reconcile pending work before retrying",
			);
		// A fresh acceptance must never share its predecessor's delivery identity.
		receipt = { ...receipt, executionId: randomUUID() };
		// Reserve before yielding so two simultaneous approvals cannot both execute.
		this.#operations.set(receipt.key, receipt);
		try {
			await this.#save();
		} catch (error) {
			receipt.status = "uncertain";
			throw error;
		}
		return undefined;
	}

	async waitForInput(
		key: string | undefined,
		inputs: ModelInput[],
	): Promise<void> {
		await this.#maintenance;
		if (!key) return;
		const receipt = this.#operations.get(key);
		if (receipt?.status !== "running") return;
		const waitingInputs = z
			.array(modelInputSchema)
			.min(1)
			.max(4096)
			.parse(inputs);
		if (waitingInputs.some((input) => input.sessionId !== receipt.sessionId))
			throw new Error("Model input belongs to another operation session");
		receipt.waitingInputs = waitingInputs;
		await this.finishOperation(key, "waiting_input");
	}

	async finishOperation(
		key: string | undefined,
		status: OperationReceipt["status"],
		resources: ResourceDescriptor[] = [],
		error?: string,
		response?: { executionId: string; resultId: string },
	): Promise<void> {
		await this.#maintenance;
		if (!key) return;
		const archived = !this.#operations.has(key);
		const receipt = this.#receipt(key);
		if (response) {
			if (!receipt || receipt.executionId !== response.executionId)
				throw new StaleOperationDeliveryError(
					"Response belongs to a replaced acceptance",
				);
			if (!/^[a-f0-9]{64}$/.test(response.resultId))
				throw new Error("Invalid result identifier");
			if (receipt.resultId && receipt.resultId !== response.resultId)
				throw new Error("Operation response snapshot is immutable");
		}
		if (!receipt) return;
		if (archived) this.#operations.set(key, receipt);
		// Persist only bounded descriptors, never file bytes or signed download URLs.
		const original = resources.map((resource) => {
			const value = operationResourceSchema.parse({
				uri: canonicalResourceUri(resource.uri),
				name: resource.name,
				mimeType: resource.mimeType,
				size: resource.size,
			});
			if (resourceSessionId(value.uri) !== receipt.sessionId)
				throw new Error("Operation resource belongs to another session");
			return {
				uri: value.uri,
				name: value.name,
				mimeType: value.mimeType,
				size: value.size,
			};
		});
		if (original.length > 16384)
			throw new Error("Too many operation resource references");
		if (response) receipt.resultId = response.resultId;
		if (original.length && !receipt.resources?.length)
			receipt.resources = [
				...new Map(
					original.map((resource) => [resource.uri, resource]),
				).values(),
			];
		const terminal = ["completed", "failed", "cancelled"].includes(
			receipt.status,
		);
		if (!terminal) {
			receipt.status = status;
			receipt.updatedAt = Date.now();
			if (status !== "waiting_input") delete receipt.waitingInputs;
			if (error) receipt.error = error.slice(0, 64 * 1024);
			else if (status === "completed") delete receipt.error;
		}
		await this.#save();
		if (archived) await this.#archive.remove(receipt);
	}

	/** Observed source reads do not acknowledge host attachment receipt. */
	async recordResourceRead(chatId: string, uri: string): Promise<void> {
		const canonical = canonicalResourceUri(uri);
		await this.#maintenance;
		let changed = false;
		for (const receipt of this.#operations.values()) {
			if (receipt.chatId !== chatId) continue;
			for (const resource of receipt.resources ?? []) {
				if (resource.uri !== canonical || resource.sourceReadAt !== undefined)
					continue;
				resource.sourceReadAt = Date.now();
				changed = true;
			}
		}
		if (changed) await this.#save();
	}

	findOperation(
		chatId: string,
		operationId: string,
	): OperationReceipt | undefined {
		this.#pruneOperations();
		const receipt =
			[...this.#operations.values()].find(
				(value) =>
					value.chatId === chatId &&
					(recoveryOperationId(value) === operationId ||
						value.key === operationId),
			) ?? this.#archive.find(chatId, operationId);
		return receipt
			? structuredClone({
					...receipt,
					operationId: recoveryOperationId(receipt),
				})
			: undefined;
	}

	operation(chatId: string, operationId: string): OperationReceipt {
		const receipt = this.findOperation(chatId, operationId);
		if (!receipt)
			throw new Error("Operation not found in this ChatGPT conversation");
		return receipt;
	}

	/** Bounded discovery, not a task ledger or a scan of cold replay-protection files. */
	recentOperations(
		chatId: string,
		sessionId: string,
		limit = 10,
	): RecentOperations {
		if (!sessionId || !Number.isSafeInteger(limit) || limit < 1 || limit > 20)
			throw new Error(
				"Recent operations require a sessionId and a limit from 1 to 20",
			);
		this.#pruneOperations();
		const matching = [...this.#operations.values()]
			.filter(
				(receipt) =>
					receipt.chatId === chatId && receipt.sessionId === sessionId,
			)
			.sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
		return {
			scope: "recent",
			sessionId,
			observedAt: Date.now(),
			operations: matching.slice(0, limit).map((receipt) => ({
				operationId: recoveryOperationId(receipt),
				status: receipt.status,
				updatedAt: receipt.updatedAt,
				...(receipt.resultId ? { resultId: receipt.resultId } : {}),
			})),
			hasOlder: matching.length > limit,
		};
	}

	deliveriesForOperation(chatId: string, key: string): DeliveryRecord[] {
		return [...this.#deliveries.values()].filter(
			(delivery) => delivery.chatId === chatId && delivery.operationKey === key,
		);
	}

	resultForOperation(
		chatId: string,
		operationId: string,
	): DeliveryRecord | undefined {
		const receipt = this.operation(chatId, operationId);
		const retained = this.#operationResults.get(receipt.key);
		return retained ? structuredClone(retained) : undefined;
	}

	binding(chatId: string): string | undefined {
		this.#pruneBindings();
		return this.#bindings.get(chatId)?.sessionId;
	}
	async confirmBindingUse(chatId: string, sessionId: string): Promise<void> {
		const now = Date.now();
		this.#pruneBindings(now);
		const previous = this.#bindings.get(chatId);
		if (previous && previous.sessionId !== sessionId) return;
		const next: BindingRecord = {
			sessionId,
			lastUsedAt: previous?.lastUsedAt ?? now,
			revision: this.#nextBindingRevision++,
		};
		const pending = (this.#pendingBindings.get(chatId) ?? 0) > 0;
		const persist =
			previous === undefined ||
			pending ||
			now - next.lastUsedAt >= BINDING_TOUCH_MS;
		if (persist) next.lastUsedAt = now;
		this.#bindings.set(chatId, next);
		if (!persist) return;
		try {
			await this.#save();
		} catch (error) {
			if (this.#bindings.get(chatId) === next) {
				if (previous) this.#bindings.set(chatId, previous);
				else this.#bindings.delete(chatId);
			}
			throw error;
		}
	}

	bindingCounts(): Map<string, number> {
		this.#pruneBindings();
		const counts = new Map<string, number>();
		for (const { sessionId } of this.#bindings.values()) {
			counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
		}
		return counts;
	}

	async bind(chatId: string, sessionId: string): Promise<BindingMutation> {
		const previous = this.#bindings.get(chatId);
		const next: BindingRecord = {
			sessionId,
			lastUsedAt: Date.now(),
			revision: this.#nextBindingRevision++,
		};
		this.#pendingBindings.set(
			chatId,
			(this.#pendingBindings.get(chatId) ?? 0) + 1,
		);
		this.#bindings.set(chatId, next);
		try {
			await this.#save();
		} catch (error) {
			if (this.#bindings.get(chatId) === next) {
				if (previous === undefined) this.#bindings.delete(chatId);
				else this.#bindings.set(chatId, previous);
			}
			throw error;
		} finally {
			const pending = (this.#pendingBindings.get(chatId) ?? 1) - 1;
			if (pending > 0) this.#pendingBindings.set(chatId, pending);
			else this.#pendingBindings.delete(chatId);
		}
		return {
			revision: next.revision,
			...(previous
				? {
						previous: {
							sessionId: previous.sessionId,
							lastUsedAt: previous.lastUsedAt,
						},
					}
				: {}),
		};
	}

	async restoreBinding(
		chatId: string,
		mutation: BindingMutation,
	): Promise<void> {
		const current = this.#bindings.get(chatId);
		if (current?.revision !== mutation.revision) return;
		const restored = mutation.previous
			? {
					...mutation.previous,
					revision: this.#nextBindingRevision++,
				}
			: undefined;
		if (restored) this.#bindings.set(chatId, restored);
		else this.#bindings.delete(chatId);
		try {
			await this.#save();
		} catch (error) {
			const latest = this.#bindings.get(chatId);
			if (
				(restored && latest === restored) ||
				(!restored && latest === undefined)
			)
				this.#bindings.set(chatId, current);
			throw error;
		}
	}

	deliveries(chatId: string): DeliveryRecord[] {
		return [...this.#deliveries.values()].filter(
			(delivery) => delivery.chatId === chatId,
		);
	}

	async addDelivery(delivery: DeliveryRecord): Promise<void> {
		await this.#maintenance;
		this.#pruneOperations();
		if (!this.#deliveries.has(delivery.id) && this.#deliveries.size >= 2048)
			throw new Error("Pending delivery limit reached");
		const archived =
			!!delivery.operationKey && !this.#operations.has(delivery.operationKey);
		const receipt = delivery.operationKey
			? this.#receipt(delivery.operationKey)
			: undefined;
		if (delivery.operationKey && !receipt)
			throw new StaleOperationDeliveryError(
				"Operation delivery has no retained operation receipt",
			);
		if (receipt && receipt.executionId !== delivery.executionId)
			throw new StaleOperationDeliveryError(
				"Operation delivery belongs to a different execution",
			);
		if (this.#deliveredIds.has(delivery.id)) return;
		if (
			receipt &&
			(receipt.chatId !== delivery.chatId ||
				receipt.sessionId !== delivery.sessionId)
		)
			throw new Error(
				"Operation result belongs to another conversation or session",
			);
		if (receipt) {
			receipt.operationId ??= recoveryOperationId(receipt);
			if (archived) this.#operations.set(receipt.key, receipt);
		}
		if (receipt?.operationId && delivery.complete) {
			if (
				!this.#operationResults.has(receipt.key) &&
				this.#operationResults.size >= 2048
			)
				throw new Error("Retained operation result limit reached");
			this.#operationResults.set(receipt.key, delivery);
		}
		this.#deliveries.set(delivery.id, delivery);
		await this.finishOperation(
			delivery.operationKey,
			delivery.complete ? "completed" : "uncertain",
			delivery.toolResults.flatMap((result) =>
				resourceDescriptors(result.details),
			),
		);
		await this.#save();
		if (archived && receipt) await this.#archive.remove(receipt);
	}

	question(chatId: string, id: string): QuestionRecord {
		const question = this.#questions.get(id);
		if (!question || question.chatId !== chatId)
			throw new Error("Question not found in this ChatGPT conversation");
		return question;
	}

	async addQuestion(question: QuestionRecord): Promise<void> {
		const previous = this.#questions.get(question.id);
		const removed: [string, QuestionRecord][] = [];
		if (!previous && this.#questions.size >= 1024) {
			for (const [id, saved] of this.#questions) {
				if (!saved.delivered) continue;
				this.#questions.delete(id);
				removed.push([id, saved]);
				if (this.#questions.size < 1024) break;
			}
			if (this.#questions.size >= 1024)
				throw new Error("Saved question limit reached");
		}
		this.#questions.set(question.id, question);
		try {
			await this.#save();
		} catch (error) {
			if (this.#questions.get(question.id) === question) {
				if (previous) this.#questions.set(question.id, previous);
				else this.#questions.delete(question.id);
				for (const [id, saved] of removed)
					if (!this.#questions.has(id)) this.#questions.set(id, saved);
			}
			throw error;
		}
	}

	async answer(
		chatId: string,
		id: string,
		answer: QuestionAnswer,
	): Promise<QuestionRecord> {
		const question = this.question(chatId, id);
		const selections = [...new Set(answer.selections)].sort((a, b) => a - b);
		if (selections.some((index) => !question.options[index]))
			throw new Error("Unknown question option");
		if (!question.allowMultiple && selections.length > 1)
			throw new Error("Select one option");
		if (answer.skipped && (selections.length > 0 || answer.text))
			throw new Error("A skipped question cannot include an answer");
		if (!answer.skipped && selections.length === 0 && !answer.text)
			throw new Error("Select an option or enter an answer");
		const value: QuestionAnswer = {
			selections,
			text: answer.text,
			...(answer.skipped ? { skipped: true } : {}),
		};
		if (JSON.stringify(question.answer) === JSON.stringify(value))
			return question;
		const updated = { ...question, answer: value, delivered: false };
		await this.addQuestion(updated);
		return updated;
	}

	answers(chatId: string): QuestionRecord[] {
		return [...this.#questions.values()].filter(
			(question) =>
				question.chatId === chatId && question.answer && !question.delivered,
		);
	}

	acknowledge(
		deliveries: DeliveryRecord[],
		answers: QuestionRecord[],
		signal: AbortSignal,
	): Promise<void> {
		const run = this.#acknowledgements.then(async () => {
			if (deliveries.length === 0 && answers.length === 0) return;
			signal.throwIfAborted();
			const delivered = new Map(
				answers.map((question) => [question, { ...question, delivered: true }]),
			);
			const consumed = deliveries.filter((delivery) => {
				const current = this.#deliveries.get(delivery.id);
				return (
					current === delivery ||
					(current !== undefined && isDeepStrictEqual(current, delivery))
				);
			});
			for (const delivery of consumed) {
				this.#deliveries.delete(delivery.id);
				this.#deliveredIds.set(delivery.id, Date.now());
			}
			for (const [question, updated] of delivered) {
				if (this.#questions.get(question.id) === question)
					this.#questions.set(question.id, updated);
			}
			try {
				await this.#save();
				signal.throwIfAborted();
			} catch (error) {
				for (const delivery of consumed) {
					if (this.#deliveries.has(delivery.id)) continue;
					this.#deliveries.set(delivery.id, delivery);
					this.#deliveredIds.delete(delivery.id);
				}
				for (const [question, updated] of delivered) {
					if (this.#questions.get(question.id) === updated)
						this.#questions.set(question.id, question);
				}
				await this.#save();
				throw error;
			}
		});
		this.#acknowledgements = run.catch(() => {});
		return run;
	}

	async flush(): Promise<void> {
		await this.#maintenance;
		await this.#acknowledgements;
		await this.#writes;
		if (this.#writeError) throw this.#writeError;
	}

	#save(): Promise<void> {
		const revision = ++this.#writeRevision;
		let contents: string;
		try {
			contents = this.#snapshot();
		} catch (error) {
			this.#writeError = error;
			return Promise.reject(error);
		}
		const saved = this.#writes.then(async () => {
			await writeFile(this.#temporaryPath, contents, { mode: 0o600 });
			await rename(this.#temporaryPath, this.#path);
			if (revision === this.#writeRevision) this.#writeError = undefined;
		});
		this.#writes = saved.catch((error) => {
			if (revision === this.#writeRevision) this.#writeError = error;
		});
		return saved;
	}

	#snapshot(): string {
		const now = Date.now();
		this.#pruneBindings(now);
		this.#pruneOperations(now);
		if (this.#bindings.size > MAX_BINDINGS)
			throw new Error("Binding limit reached");
		const bindings = Object.fromEntries(
			[...this.#bindings].map(([chatId, binding]) => [
				chatId,
				{
					sessionId: binding.sessionId,
					lastUsedAt: binding.lastUsedAt,
				},
			]),
		);
		for (const [key] of this.#operationResults) {
			const receipt = this.#operations.get(key);
			if (
				receipt &&
				(receipt.status === "running" ||
					receipt.status === "uncertain" ||
					receipt.updatedAt >= now - RESULT_RETENTION_MS)
			)
				continue;
			this.#operationResults.delete(key);
		}
		for (const [id, time] of this.#deliveredIds) {
			if (time < now - 24 * 60 * 60 * 1000) this.#deliveredIds.delete(id);
		}
		if (this.#deliveredIds.size > 4096)
			throw new Error("Delivery receipt limit reached");
		const contents = `${JSON.stringify(
			{
				bindings,
				deliveries: [...this.#deliveries.values()],
				operationResults: [...this.#operationResults].map(
					([operationKey, delivery]) => ({ operationKey, delivery }),
				),
				questions: [...this.#questions.values()],
				operations: [...this.#operations.values()],
				deliveredIds: [...this.#deliveredIds],
			},
			null,
			2,
		)}\n`;
		if (Buffer.byteLength(contents) > MAX_STATE_BYTES)
			throw new Error(
				"Chappie state exceeds the 32 MiB limit; pending results were not persisted",
			);
		return contents;
	}

	#pruneBindings(now = Date.now()): boolean {
		const cutoff = now - BINDING_TTL_MS;
		let changed = false;
		for (const [chatId, binding] of this.#bindings) {
			if (binding.lastUsedAt >= cutoff) continue;
			this.#bindings.delete(chatId);
			changed = true;
		}
		return changed;
	}

	#pruneOperations(now = Date.now()): boolean {
		const cutoff = now - TERMINAL_RETENTION_MS;
		let changed = false;
		for (const [key, receipt] of this.#operations) {
			if (
				(receipt.status === "completed" ||
					receipt.status === "failed" ||
					receipt.status === "cancelled") &&
				receipt.updatedAt < cutoff
			) {
				this.#operations.delete(key);
				const retained = this.#operationResults.get(key);
				if (retained) this.#deliveredIds.delete(retained.id);
				this.#operationResults.delete(key);
				for (const [id, delivery] of this.#deliveries) {
					if (delivery.operationKey !== key) continue;
					this.#deliveries.delete(id);
					this.#deliveredIds.delete(id);
				}
				this.#deliveredIds.delete(`operation:${key}`);
				changed = true;
			}
		}
		return changed;
	}
}
