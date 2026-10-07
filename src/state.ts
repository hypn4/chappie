import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as z from "zod";
import type { DeliveryRecord, DeliveryReference } from "./delivery.ts";
import { uuidV7 } from "./ids.ts";
import type { ModelInput } from "./ipc.ts";
import {
	deliverySchema,
	modelInputSchema,
	operationSourceSchema,
} from "./ipc-schema.ts";
import {
	OperationArchive,
	recoveryOperationId,
	TERMINAL_RETENTION_MS,
} from "./operation-archive.ts";
import {
	operationReceiptSchema,
	operationResourceSchema,
} from "./operation-schema.ts";
import type {
	OperationReceipt,
	OperationReservation,
	RecentOperations,
} from "./operations.ts";
import type { QuestionAnswer, QuestionRecord } from "./questions.ts";
import { questionOutput } from "./questions.ts";
import {
	canonicalResourceUri,
	type ResourceDescriptor,
	resourceDescriptors,
	resourceSessionId,
} from "./resources.ts";
import { ResponseStore } from "./responses.ts";
import { toolResult } from "./tools.ts";
import { continuationFor } from "./work.ts";

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
const MAX_STATE_BYTES = 128 * 1024 * 1024;
const RECLAIMED_STATE_BYTES = 96 * 1024 * 1024;
const MAX_OPERATIONS = 16_384;
const MAX_ERROR_CHARACTERS = 64 * 1024;
const RESULT_RETENTION_MS = TERMINAL_RETENTION_MS;
const deliveryReferenceSchema = deliverySchema
	.omit({ toolResults: true })
	.extend({
		error: z.string().max(MAX_ERROR_CHARACTERS).optional(),
		resultId: z.string().regex(/^[a-f0-9]{64}$/),
		bytes: z.number().int().nonnegative().safe(),
		failed: z.boolean(),
	})
	.refine(
		(value) => operationSourceSchema.safeParse(value).success,
		"Operation results require both operationKey and executionId, or neither",
	);
const stateSchema = z.strictObject({
	schemaVersion: z.literal(1),
	bindings: z.record(z.string(), bindingRecordSchema).optional(),
	deliveries: z.array(deliveryReferenceSchema).max(2048).optional(),
	operationResults: z
		.array(
			z.strictObject({
				operationKey: z.string(),
				delivery: deliveryReferenceSchema,
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
	operations: z
		.array(
			operationReceiptSchema.refine(
				(receipt) => !receipt.resultId || receipt.resultUnread !== undefined,
				"A saved result requires an explicit unread state",
			),
		)
		.max(16384)
		.optional(),
	deliveredIds: z
		.array(z.tuple([z.string(), z.number().nonnegative()]))
		.max(4096)
		.optional(),
});

/** A validated owner may discard a delayed result from an expired acceptance. */
export class StaleOperationDeliveryError extends Error {}

/** Store the complete public failure body once, outside shared metadata. */
function publicDeliveryText(delivery: DeliveryRecord): string {
	const result = toolResult(
		delivery.toolResults,
		delivery.sessionId,
		delivery.cwd,
		[],
		undefined,
		undefined,
		undefined,
		{ work: delivery.work },
	);
	if (delivery.error) {
		const header = result.content[0];
		if (header?.type === "text")
			header.text = JSON.stringify({
				...JSON.parse(header.text),
				continuation: continuationFor({ work: delivery.work, failed: true }),
			});
		result.content.push({ type: "text", text: delivery.error });
		result.isError = true;
	}
	return JSON.stringify(result);
}

export class State {
	readonly #path: string;
	readonly #temporaryPath: string;
	readonly #bindings = new Map<string, BindingRecord>();
	readonly #deliveries = new Map<string, DeliveryReference>();
	readonly #questions = new Map<string, QuestionRecord>();
	readonly #operations = new Map<string, OperationReceipt>();
	readonly #deliveredIds = new Map<string, number>();
	#writes = Promise.resolve();
	readonly #operationResults = new Map<string, DeliveryReference>();
	readonly #pendingBindings = new Map<string, number>();
	#acknowledgements = Promise.resolve();
	#nextBindingRevision = 1;
	#writeError: unknown;
	#writeRevision = 0;
	readonly #archive: OperationArchive;
	readonly #responses: ResponseStore;
	#maintenance = Promise.resolve();
	#mutations = Promise.resolve();
	#mutation:
		| {
				restore(): void;
				pins: Map<
					string,
					Pick<DeliveryReference, "chatId" | "id" | "resultId">
				>;
		  }
		| undefined;

	constructor(storageDir: string) {
		this.#path = join(storageDir, "chappie.state.json");
		this.#temporaryPath = `${this.#path}.tmp`;
		this.#archive = new OperationArchive(storageDir);
		this.#responses = new ResponseStore(storageDir);
	}

	/** Serialize the whole mutation, so another writer cannot capture an uncommitted candidate. */
	#mutate<T>(change: () => Promise<T>): Promise<T> {
		const run = this.#mutations.then(async () => {
			const mutation = {
				restore: this.#captureMaps(),
				pins: new Map<
					string,
					Pick<DeliveryReference, "chatId" | "id" | "resultId">
				>(),
			};
			const previousDeliveries = [...this.#deliveries.values()];
			this.#mutation = mutation;
			try {
				let value: T;
				try {
					value = await change();
				} catch (error) {
					// Successful internal commits advance this checkpoint. A later
					// cache-cleanup failure must never resurrect an acknowledged result.
					mutation.restore();
					await this.#save().catch(() => {});
					await this.#releaseDeliveryPins([
						...previousDeliveries,
						...mutation.pins.values(),
					]).catch(() => {});
					throw error;
				}
				// Pending references were durably changed before their protection is
				// released. Errors here leave committed state intact for startup repair.
				await this.#releaseDeliveryPins([
					...previousDeliveries,
					...mutation.pins.values(),
				]);
				return value;
			} finally {
				this.#mutation = undefined;
			}
		});
		this.#mutations = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	#captureMaps(): () => void {
		const maps = [
			this.#bindings,
			this.#deliveries,
			this.#questions,
			this.#operations,
			this.#deliveredIds,
			this.#operationResults,
		] as const;
		const restore = maps.map((map) => {
			const previous = new Map(map as Map<string, unknown>);
			return () => {
				map.clear();
				for (const [key, value] of previous)
					(map as Map<string, unknown>).set(key, value);
			};
		});
		return () => {
			for (const reset of restore) reset();
		};
	}

	async #releaseDeliveryPins(
		references: Iterable<Pick<DeliveryReference, "chatId" | "id" | "resultId">>,
	): Promise<void> {
		for (const reference of references) {
			const live = this.#deliveries.get(reference.id);
			if (
				live?.chatId === reference.chatId &&
				live.resultId === reference.resultId
			)
				continue;
			await this.#responses.unpin(
				reference.chatId,
				reference.resultId,
				`delivery:${reference.id}`,
			);
		}
	}

	async load(): Promise<void> {
		let contents: string;
		try {
			contents = await readFile(this.#path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				await this.#responses.reconcileDeliveryPins([]);
				return;
			}
			throw error;
		}
		if (Buffer.byteLength(contents) > MAX_STATE_BYTES)
			throw new Error("Chappie state exceeds the 128 MiB metadata limit");
		const state = stateSchema.parse(JSON.parse(contents));
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
		for (const question of state.questions ?? [])
			this.#questions.set(question.id, question);
		for (const receipt of state.operations ?? []) {
			if (receipt.status === "running") receipt.status = "uncertain";
			this.#operations.set(receipt.key, receipt);
		}
		for (const [id, time] of state.deliveredIds ?? [])
			this.#deliveredIds.set(id, time);
		await this.#responses.reconcileDeliveryPins(
			(state.deliveries ?? []).map((delivery) => ({
				chatId: delivery.chatId,
				resultId: delivery.resultId,
				pin: `delivery:${delivery.id}`,
			})),
		);
		// Pin every existing pending reference before the first snapshot admission/GC.
		for (const delivery of state.deliveries ?? []) {
			if (!this.#deliveryWasRead(delivery))
				await this.#responses.pin(delivery.chatId, delivery.resultId, "unread");
			await this.#responses.pin(
				delivery.chatId,
				delivery.resultId,
				`delivery:${delivery.id}`,
			);
		}
		for (const delivery of state.deliveries ?? []) {
			this.#deliveries.set(delivery.id, delivery as DeliveryReference);
		}
		for (const saved of state.operationResults ?? []) {
			const reference =
				this.#deliveries.get(saved.delivery.id) ?? saved.delivery;
			this.#operationResults.set(
				saved.operationKey,
				reference as DeliveryReference,
			);
		}
		const protectedSnapshots = new Set(
			[...this.#deliveries.values()]
				.filter((delivery) => !this.#deliveryWasRead(delivery))
				.map((delivery) =>
					JSON.stringify([delivery.chatId, delivery.resultId]),
				),
		);
		const consumedSnapshots = new Map<
			string,
			{ chatId: string; resultId: string }
		>();
		for (const receipt of this.#operations.values()) {
			if (!receipt.resultId) continue;
			const identity = JSON.stringify([receipt.chatId, receipt.resultId]);
			if (receipt.resultUnread === false) {
				consumedSnapshots.set(identity, {
					chatId: receipt.chatId,
					resultId: receipt.resultId,
				});
				continue;
			}
			if (receipt.resultUnread === true) {
				protectedSnapshots.add(identity);
			}
		}
		// A crash can leave an unread pin after durable body consumption. Repair
		// only that pin, and only when no other acceptance still needs this body.
		for (const [identity, reference] of consumedSnapshots) {
			if (!protectedSnapshots.has(identity))
				await this.#responses.unpin(
					reference.chatId,
					reference.resultId,
					"unread",
				);
		}
		const operationsChanged = this.#pruneOperations(loadedAt);
		if (bindingsChanged || operationsChanged) await this.#save();
		await this.#mutate(() => this.#compactUncertain());
		await this.#responses.reconcileDeliveryPins(
			[...this.#deliveries.values()].map((delivery) => ({
				chatId: delivery.chatId,
				resultId: delivery.resultId,
				pin: `delivery:${delivery.id}`,
			})),
		);
	}

	#receipt(key: string): OperationReceipt | undefined {
		return this.#operations.get(key) ?? this.#archive.get(key);
	}

	#compactUncertain(admitOperation = false): Promise<void> {
		const compacted = this.#maintenance.then(async () => {
			const cutoff = Date.now() - TERMINAL_RETENTION_MS;
			const pending = new Set(
				[...this.#deliveries.values()].map((delivery) => delivery.operationKey),
			);
			let changed = false;
			for (const [key, receipt] of this.#operations) {
				if (
					receipt.status !== "uncertain" ||
					receipt.resultUnread ||
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
			if (admitOperation && this.#operations.size >= MAX_OPERATIONS) {
				const candidates = [...this.#operations.values()]
					.filter(
						(receipt) =>
							["completed", "failed", "cancelled"].includes(receipt.status) &&
							!receipt.resultUnread &&
							!pending.has(receipt.key),
					)
					.sort(
						(a, b) => a.updatedAt - b.updatedAt || a.key.localeCompare(b.key),
					);
				for (const receipt of candidates) {
					if (this.#operations.size < MAX_OPERATIONS) break;
					const snapshot = structuredClone(receipt);
					await this.#archive.save(snapshot);
					if (
						this.#operations.get(receipt.key) !== receipt ||
						!isDeepStrictEqual(receipt, snapshot)
					)
						continue;
					// The archived receipt retains its immutable resultId and replay
					// identity. Secondary display metadata can leave hot state with it.
					this.#operations.delete(receipt.key);
					this.#operationResults.delete(receipt.key);
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

	executionSource(key: string): { operationKey: string; executionId: string };
	executionSource(key: string | undefined): {
		operationKey?: string;
		executionId?: string;
	};
	executionSource(key: string | undefined): {
		operationKey?: string;
		executionId?: string;
	} {
		if (key === undefined) return {};
		const receipt = this.#operations.get(key);
		if (!receipt) throw new Error("Operation has no retained receipt");
		return {
			operationKey: key,
			executionId: receipt.executionId,
		};
	}

	async reserveOperation(
		receipt: OperationReservation,
	): Promise<OperationReceipt | undefined> {
		return this.#mutate(() => this.#reserveOperation(receipt));
	}

	async #reserveOperation(
		receipt: OperationReservation,
	): Promise<OperationReceipt | undefined> {
		await this.#compactUncertain(true);
		this.#pruneOperations();
		if (receipt.operationId) {
			const conflict =
				[...this.#operations.values()].find(
					(value) =>
						value.chatId === receipt.chatId &&
						recoveryOperationId(value) === receipt.operationId &&
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
				await this.#flushWrites();
				return existing;
			}
			// Only a host-confirmed unexecuted request may be retried. Claim before
			// yielding, so simultaneous retries still dispatch just one batch.
			const resumed: OperationReceipt = {
				...existing,
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
		if (this.#operations.size >= MAX_OPERATIONS)
			throw new Error(
				"Operation receipt limit reached; reconcile pending work before retrying",
			);
		// A fresh acceptance must never share its predecessor's delivery identity.
		const accepted: OperationReceipt = { ...receipt, executionId: uuidV7() };
		// Reserve before yielding so two simultaneous approvals cannot both execute.
		this.#operations.set(accepted.key, accepted);
		try {
			await this.#save();
		} catch (error) {
			accepted.status = "uncertain";
			throw error;
		}
		return undefined;
	}

	async waitForInput(
		key: string | undefined,
		inputs: ModelInput[],
	): Promise<void> {
		return this.#mutate(() => this.#waitForInput(key, inputs));
	}

	async #waitForInput(
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
		if (Buffer.byteLength(JSON.stringify(waitingInputs)) > 4 * 1024 * 1024)
			throw new Error(
				"Model input exceeds the 4 MiB per-operation limit; input remains available in OMP",
			);
		this.#operations.set(key, { ...receipt, waitingInputs });
		await this.#finishOperation(key, "waiting_input");
	}

	async finishOperation(
		key: string | undefined,
		status: OperationReceipt["status"],
		resources: ResourceDescriptor[] = [],
		error?: string,
		response?: { executionId: string; resultId: string },
	): Promise<void> {
		return this.#mutate(() =>
			this.#finishOperation(key, status, resources, error, response),
		);
	}

	async #finishOperation(
		key: string | undefined,
		status: OperationReceipt["status"],
		resources: ResourceDescriptor[] = [],
		error?: string,
		response?: { executionId: string; resultId: string },
	): Promise<void> {
		await this.#maintenance;
		if (!key) return;
		const archived = !this.#operations.has(key);
		const previous = this.#receipt(key);
		const receipt = previous ? { ...previous } : undefined;
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
		this.#operations.set(key, receipt);
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
		if (response) {
			if (receipt.resultId !== response.resultId || !receipt.resultAcknowledged)
				receipt.resultUnread = true;
			receipt.resultId = response.resultId;
		}
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
			if (error) receipt.error = error.slice(0, MAX_ERROR_CHARACTERS);
			else if (status === "completed") delete receipt.error;
		}
		await this.#save();
		if (archived) await this.#archive.remove(receipt);
	}

	/** Observed source reads do not acknowledge host attachment receipt. */
	async recordResourceRead(chatId: string, uri: string): Promise<void> {
		return this.#mutate(() => this.#recordResourceRead(chatId, uri));
	}

	async #recordResourceRead(chatId: string, uri: string): Promise<void> {
		const canonical = canonicalResourceUri(uri);
		await this.#maintenance;
		let changed = false;
		for (const original of this.#operations.values()) {
			const receipt = structuredClone(original);
			if (receipt.chatId !== chatId) continue;
			for (const resource of receipt.resources ?? []) {
				if (resource.uri !== canonical || resource.sourceReadAt !== undefined)
					continue;
				resource.sourceReadAt = Date.now();
				this.#operations.set(receipt.key, receipt);
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
					value.chatId === chatId && recoveryOperationId(value) === operationId,
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

	deliveriesForOperation(chatId: string, key: string): DeliveryReference[] {
		return [...this.#deliveries.values()].filter(
			(delivery) => delivery.chatId === chatId && delivery.operationKey === key,
		);
	}

	resultForOperation(
		chatId: string,
		operationId: string,
	): DeliveryReference | undefined {
		const receipt = this.operation(chatId, operationId);
		const retained = this.#operationResults.get(receipt.key);
		return retained ? structuredClone(retained) : undefined;
	}

	binding(chatId: string): string | undefined {
		this.#pruneBindings();
		return this.#bindings.get(chatId)?.sessionId;
	}
	async confirmBindingUse(chatId: string, sessionId: string): Promise<void> {
		return this.#mutate(() => this.#confirmBindingUse(chatId, sessionId));
	}

	async #confirmBindingUse(chatId: string, sessionId: string): Promise<void> {
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
		return this.#mutate(() => this.#bind(chatId, sessionId));
	}

	async #bind(chatId: string, sessionId: string): Promise<BindingMutation> {
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
		return this.#mutate(() => this.#restoreBinding(chatId, mutation));
	}

	async #restoreBinding(
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

	deliveries(chatId: string): DeliveryReference[] {
		return [...this.#deliveries.values()].filter(
			(delivery) => delivery.chatId === chatId,
		);
	}

	#deliveryWasRead(delivery: {
		operationKey?: string | undefined;
		chatId: string;
		executionId?: string | undefined;
		resultId: string;
	}): boolean {
		const receipt = delivery.operationKey
			? this.#operations.get(delivery.operationKey)
			: undefined;
		return (
			receipt?.chatId === delivery.chatId &&
			receipt.executionId === delivery.executionId &&
			receipt.resultId === delivery.resultId &&
			receipt.resultUnread === false
		);
	}

	async addDelivery(delivery: DeliveryRecord): Promise<void> {
		return this.#mutate(() => this.#addDelivery(delivery));
	}

	async #storeDelivery(
		delivery: DeliveryRecord,
		pending: boolean,
	): Promise<DeliveryReference> {
		const text = publicDeliveryText(delivery);
		const id = createHash("sha256")
			.update(JSON.stringify([delivery.chatId, text]))
			.digest("hex");
		if (pending)
			this.#mutation?.pins.set(`${id}:${delivery.id}`, {
				id: delivery.id,
				chatId: delivery.chatId,
				resultId: id,
			});
		const resultId = await this.#responses.save(
			delivery.chatId,
			text,
			pending ? { pin: `delivery:${delivery.id}` } : undefined,
		);
		const { toolResults, error, ...metadata } = delivery;
		return {
			...metadata,
			...(error !== undefined
				? { error: error.slice(0, MAX_ERROR_CHARACTERS) }
				: {}),
			resultId,
			bytes: Buffer.byteLength(text),
			failed:
				Boolean(delivery.error) ||
				toolResults.some(
					(result) =>
						result.isError ||
						(result.details as { failed?: boolean } | undefined)?.failed ===
							true,
				),
		};
	}

	async #addDelivery(delivery: DeliveryRecord): Promise<void> {
		operationSourceSchema.parse(delivery);
		await this.#maintenance;
		this.#pruneOperations();
		const archived =
			!!delivery.operationKey && !this.#operations.has(delivery.operationKey);
		const previousReceipt = delivery.operationKey
			? this.#receipt(delivery.operationKey)
			: undefined;
		const receipt = previousReceipt ? { ...previousReceipt } : undefined;
		if (delivery.operationKey && !receipt)
			throw new StaleOperationDeliveryError(
				"Operation delivery has no retained operation receipt",
			);
		if (receipt && receipt.executionId !== delivery.executionId)
			throw new StaleOperationDeliveryError(
				"Operation delivery belongs to a different execution",
			);
		if (
			receipt &&
			(receipt.chatId !== delivery.chatId ||
				receipt.sessionId !== delivery.sessionId)
		)
			throw new Error(
				"Operation result belongs to another conversation or session",
			);
		const current = this.#deliveries.get(delivery.id);
		if (
			current &&
			(current.chatId !== delivery.chatId ||
				current.sessionId !== delivery.sessionId ||
				current.operationKey !== delivery.operationKey ||
				current.executionId !== delivery.executionId)
		)
			throw new Error(
				"Delivery identifier belongs to another acceptance or owner",
			);
		// An incomplete packet from the same execution cannot supersede a saved
		// final result, even after its small acknowledgement cache was retired.
		if (!delivery.complete && receipt?.resultId) return;
		const publicText = publicDeliveryText(delivery);
		const publicId = createHash("sha256")
			.update(JSON.stringify([delivery.chatId, publicText]))
			.digest("hex");
		if (delivery.complete && receipt?.resultId && receipt.resultId !== publicId)
			throw new Error("Operation response snapshot is immutable");
		if (delivery.complete && receipt?.resultAcknowledged) return;
		if (this.#deliveredIds.has(delivery.id)) {
			// An ACK of an incomplete observation is not an ACK of its later final
			// result. The same still-retained acceptance can finish exactly once.
			if (!(delivery.complete && receipt && !receipt.resultId)) return;
			this.#deliveredIds.delete(delivery.id);
		}
		if (!this.#deliveries.has(delivery.id) && this.#deliveries.size >= 2048)
			throw new Error(
				"Pending delivery limit reached; retrieve pending results to continue",
			);
		if (receipt) {
			receipt.operationId ??= recoveryOperationId(receipt);
			this.#operations.set(receipt.key, receipt);
		}
		const reference = await this.#storeDelivery(delivery, true);
		if (receipt?.operationId && delivery.complete) {
			// Completed, acknowledged secondary metadata can retire. The acceptance
			// and its resultId remain recoverable in the receipt.
			for (const [key, saved] of this.#operationResults) {
				if (this.#operationResults.size < 2048) break;
				if (
					this.#deliveries.has(saved.id) ||
					!this.#operations.get(key)?.resultAcknowledged
				)
					continue;
				this.#operationResults.delete(key);
			}
			if (
				!this.#operationResults.has(receipt.key) &&
				this.#operationResults.size >= 2048
			)
				throw new Error("Retained operation result limit reached");
			this.#operationResults.set(receipt.key, reference);
		}
		this.#deliveries.set(delivery.id, reference);
		await this.#finishOperation(
			delivery.operationKey,
			delivery.complete ? "completed" : "uncertain",
			delivery.toolResults.flatMap((result) =>
				resourceDescriptors(result.details),
			),
			delivery.error,
			delivery.complete && receipt
				? { executionId: receipt.executionId, resultId: reference.resultId }
				: undefined,
		);
		if (!delivery.operationKey) await this.#save();
		if (archived && receipt) await this.#archive.remove(receipt);
	}

	question(chatId: string, id: string): QuestionRecord {
		const question = this.#questions.get(id);
		if (!question || question.chatId !== chatId)
			throw new Error("Question not found in this ChatGPT conversation");
		return question;
	}

	async addQuestion(question: QuestionRecord): Promise<void> {
		return this.#mutate(() => this.#addQuestion(question));
	}

	async #addQuestion(question: QuestionRecord): Promise<void> {
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
		return this.#mutate(() => this.#answer(chatId, id, answer));
	}

	async #answer(
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
		await this.#addQuestion(updated);
		return updated;
	}

	answers(chatId: string): QuestionRecord[] {
		return [...this.#questions.values()].filter(
			(question) =>
				question.chatId === chatId && question.answer && !question.delivered,
		);
	}

	acknowledge(
		deliveries: DeliveryReference[],
		answers: QuestionRecord[],
		signal: AbortSignal,
	): Promise<void> {
		return this.#mutate(() => this.#acknowledge(deliveries, answers, signal));
	}

	#acknowledge(
		deliveries: DeliveryReference[],
		answers: QuestionRecord[],
		signal: AbortSignal,
	): Promise<void> {
		const run = this.#acknowledgements.then(async () => {
			if (deliveries.length === 0 && answers.length === 0) return;
			signal.throwIfAborted();
			const delivered = new Map(
				answers.map((question) => [question, { ...question, delivered: true }]),
			);
			const acknowledged = new Map<OperationReceipt, OperationReceipt>();
			const consumed = deliveries.filter((delivery) => {
				const current = this.#deliveries.get(delivery.id);
				return (
					current === delivery ||
					(current !== undefined && isDeepStrictEqual(current, delivery))
				);
			});
			// Sending a reference is not reading its body. Keep the first page
			// available even when a pending result was captured over 24h ago.
			for (const delivery of consumed) {
				if (!this.#deliveryWasRead(delivery))
					await this.#responses.pin(
						delivery.chatId,
						delivery.resultId,
						"unread",
					);
			}
			for (const delivery of consumed) {
				this.#deliveries.delete(delivery.id);
				const receipt = delivery.operationKey
					? this.#operations.get(delivery.operationKey)
					: undefined;
				if (delivery.complete && receipt?.resultId === delivery.resultId) {
					const updated = {
						...receipt,
						resultAcknowledged: true,
					};
					acknowledged.set(receipt, updated);
					this.#operations.set(receipt.key, updated);
					this.#deliveredIds.delete(delivery.id);
				} else this.#deliveredIds.set(delivery.id, Date.now());
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
				for (const [receipt, updated] of acknowledged) {
					if (this.#operations.get(receipt.key) === updated)
						this.#operations.set(receipt.key, receipt);
				}
				await this.#save();
				throw error;
			}
		});
		this.#acknowledgements = run.catch(() => {});
		return run;
	}

	/** Receipt-level dedup survives retirement of acknowledged result metadata. */
	acknowledgeResult(chatId: string, resultId: string): Promise<void> {
		return this.#mutate(async () => {
			let changed = false;
			for (const [key, receipt] of this.#operations) {
				if (
					receipt.chatId !== chatId ||
					receipt.resultId !== resultId ||
					(receipt.resultAcknowledged && receipt.resultUnread === false)
				)
					continue;
				this.#operations.set(key, {
					...receipt,
					resultAcknowledged: true,
					resultUnread: false,
				});
				changed = true;
			}
			if (changed) await this.#save();
		});
	}

	async flush(): Promise<void> {
		await this.#mutations;
		await this.#flushWrites();
	}

	async #flushWrites(): Promise<void> {
		await this.#maintenance;
		await this.#acknowledgements;
		await this.#writes;
		if (this.#writeError) throw this.#writeError;
	}

	async #save(): Promise<void> {
		const revision = ++this.#writeRevision;
		let contents: string;
		try {
			contents = this.#snapshot();
			if (Buffer.byteLength(contents) > MAX_STATE_BYTES)
				contents = await this.#reclaimMetadata(contents);
		} catch (error) {
			this.#writeError = error;
			return Promise.reject(error);
		}
		const mutation = this.#mutation;
		const restore = this.#captureMaps();
		const saved = this.#writes.then(async () => {
			await writeFile(this.#temporaryPath, contents, { mode: 0o600 });
			await rename(this.#temporaryPath, this.#path);
			if (mutation && this.#mutation === mutation) mutation.restore = restore;
			if (revision === this.#writeRevision) this.#writeError = undefined;
		});
		this.#writes = saved.catch((error) => {
			if (revision === this.#writeRevision) this.#writeError = error;
		});
		return saved;
	}

	async #reclaimMetadata(contents: string): Promise<string> {
		let bytes = Buffer.byteLength(contents);
		const pending = new Set(
			[...this.#deliveries.values()].map((delivery) => delivery.operationKey),
		);
		const references = [...this.#operationResults]
			.filter(
				([key, reference]) =>
					!this.#deliveries.has(reference.id) &&
					this.#operations.get(key)?.resultAcknowledged,
			)
			.sort(
				([left], [right]) =>
					(this.#operations.get(left)?.updatedAt ?? 0) -
						(this.#operations.get(right)?.updatedAt ?? 0) ||
					left.localeCompare(right),
			);
		// Compact JSON underestimates the pretty-printed bytes reclaimed, so the
		// estimate cannot admit an oversized file. Serialize once more at the end.
		const removeReference = (key: string) => {
			const delivery = this.#operationResults.get(key);
			if (!delivery) return;
			this.#operationResults.delete(key);
			bytes -= Buffer.byteLength(
				JSON.stringify({ operationKey: key, delivery }),
			);
		};
		for (const [key] of references) {
			if (bytes <= RECLAIMED_STATE_BYTES) break;
			removeReference(key);
		}
		const receipts = [...this.#operations.values()]
			.filter(
				(receipt) =>
					["completed", "failed", "cancelled"].includes(receipt.status) &&
					!receipt.resultUnread &&
					!pending.has(receipt.key),
			)
			.sort(
				(left, right) =>
					left.updatedAt - right.updatedAt || left.key.localeCompare(right.key),
			);
		for (const receipt of receipts) {
			if (bytes <= RECLAIMED_STATE_BYTES) break;
			const snapshot = structuredClone(receipt);
			try {
				await this.#archive.save(snapshot);
			} catch (error) {
				// Hysteresis is best effort. Failure to gain optional headroom must
				// not reject a candidate that already fits the hard metadata bound.
				const current = this.#snapshot();
				if (Buffer.byteLength(current) > MAX_STATE_BYTES) throw error;
				return current;
			}
			if (
				this.#operations.get(receipt.key) !== receipt ||
				!isDeepStrictEqual(receipt, snapshot)
			)
				continue;
			this.#operations.delete(receipt.key);
			bytes -= Buffer.byteLength(JSON.stringify(receipt));
			removeReference(receipt.key);
		}
		const reclaimed = this.#snapshot();
		if (Buffer.byteLength(reclaimed) > MAX_STATE_BYTES)
			throw new Error(
				"Chappie metadata exceeds the 128 MiB limit; protected work remains intact and this change was not persisted",
			);
		return reclaimed;
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
				(this.#deliveries.has(this.#operationResults.get(key)?.id ?? "") ||
					receipt.status === "running" ||
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
				schemaVersion: 1,
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
		const pending = new Set(
			[...this.#deliveries.values()].map((delivery) => delivery.operationKey),
		);
		let changed = false;
		for (const [key, receipt] of this.#operations) {
			if (
				(receipt.status === "completed" ||
					receipt.status === "failed" ||
					receipt.status === "cancelled") &&
				!receipt.resultUnread &&
				receipt.updatedAt < cutoff &&
				!pending.has(key)
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
