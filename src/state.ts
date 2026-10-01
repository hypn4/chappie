import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import type { DeliveryRecord } from "./delivery.ts";
import { deliverySchema } from "./ipc-schema.ts";
import type { OperationReceipt } from "./operations.ts";
import type { QuestionAnswer, QuestionRecord } from "./questions.ts";
import { questionOutput } from "./questions.ts";
import {
	canonicalResourceUri,
	type ResourceDescriptor,
	resourceDescriptors,
	resourceSessionId,
} from "./resources.ts";

const operationResourceSchema = z.strictObject({
	uri: z.string().min(1).max(4096),
	name: z.string().min(1).max(4096),
	mimeType: z.string().min(1).max(4096),
	size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	sourceReadAt: z.number().finite().nonnegative().optional(),
});

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
const stateSchema = z.strictObject({
	bindings: z
		.record(z.string(), z.union([z.string(), bindingRecordSchema]))
		.optional(),
	deliveries: z.array(deliverySchema).max(2048).optional(),
	questions: z
		.array(
			questionOutput.extend({ chatId: z.string(), delivered: z.boolean() }),
		)
		.max(1024)
		.optional(),
	operations: z
		.array(
			z.strictObject({
				key: z.string(),
				signature: z.string(),
				chatId: z.string(),
				sessionId: z.string(),
				cwd: z.string(),
				status: z.enum(["running", "completed", "uncertain"]),
				updatedAt: z.number().nonnegative(),
				resources: z.array(operationResourceSchema).max(16384).optional(),
			}),
		)
		.max(16384)
		.optional(),
	deliveredIds: z
		.array(z.tuple([z.string(), z.number().nonnegative()]))
		.max(4096)
		.optional(),
});

export class State {
	readonly #path: string;
	readonly #temporaryPath: string;
	readonly #bindings = new Map<string, BindingRecord>();
	readonly #deliveries = new Map<string, DeliveryRecord>();
	readonly #questions = new Map<string, QuestionRecord>();
	readonly #operations = new Map<string, OperationReceipt>();
	readonly #deliveredIds = new Map<string, number>();
	#writes = Promise.resolve();
	readonly #pendingBindings = new Map<string, number>();
	#acknowledgements = Promise.resolve();
	#nextBindingRevision = 1;

	constructor(agentDir: string) {
		this.#path = join(agentDir, "chappie.state.json");
		this.#temporaryPath = `${this.#path}.tmp`;
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
		const state = stateSchema.parse(JSON.parse(contents));
		const loadedAt = Date.now();
		let bindingsChanged = false;
		for (const [chatId, value] of Object.entries(state.bindings ?? {})) {
			if (typeof value === "string") bindingsChanged = true;
			const persisted =
				typeof value === "string"
					? { sessionId: value, lastUsedAt: loadedAt }
					: value;
			this.#bindings.set(chatId, {
				...persisted,
				revision: this.#nextBindingRevision++,
			});
		}
		bindingsChanged = this.#pruneBindings(loadedAt) || bindingsChanged;
		if (this.#bindings.size > MAX_BINDINGS)
			throw new Error("Binding limit reached");
		for (const delivery of state.deliveries ?? []) {
			// The wire validator checks the persisted native result envelope before restoration.
			if (delivery?.id)
				this.#deliveries.set(delivery.id, delivery as DeliveryRecord);
		}
		for (const question of state.questions ?? [])
			this.#questions.set(question.id, question);
		for (const receipt of state.operations ?? []) {
			if (receipt.status === "running") receipt.status = "uncertain";
			this.#operations.set(receipt.key, receipt);
		}
		for (const [id, time] of state.deliveredIds ?? [])
			this.#deliveredIds.set(id, time);
		if (bindingsChanged) await this.#save();
	}

	ownsOperation(
		key: string | undefined,
		chatId: string,
		sessionId: string,
	): boolean {
		const receipt = key ? this.#operations.get(key) : undefined;
		return receipt?.chatId === chatId && receipt.sessionId === sessionId;
	}

	async reserveOperation(
		receipt: OperationReceipt,
	): Promise<OperationReceipt | undefined> {
		const existing = this.#operations.get(receipt.key);
		if (existing) {
			if (existing.signature !== receipt.signature)
				throw new Error("Operation identifier reused with different arguments");
			await this.#writes;
			return existing;
		}
		const cutoff = Date.now() - 24 * 60 * 60 * 1000;
		for (const [key, value] of this.#operations) {
			if (value.status === "completed" && value.updatedAt < cutoff)
				this.#operations.delete(key);
		}
		if (this.#operations.size >= 16384)
			throw new Error(
				"Operation receipt limit reached; reconcile pending work before retrying",
			);
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

	async finishOperation(
		key: string | undefined,
		status: OperationReceipt["status"],
		resources: ResourceDescriptor[] = [],
	): Promise<void> {
		if (!key) return;
		const receipt = this.#operations.get(key);
		if (!receipt) return;
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
		if (original.length && !receipt.resources?.length)
			receipt.resources = [
				...new Map(
					original.map((resource) => [resource.uri, resource]),
				).values(),
			];
		if (receipt.status !== "completed") receipt.status = status;
		receipt.updatedAt = Date.now();
		await this.#save();
	}

	/** Observed source reads do not acknowledge host attachment receipt. */
	async recordResourceRead(chatId: string, uri: string): Promise<void> {
		const canonical = canonicalResourceUri(uri);
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
		if (this.#deliveredIds.has(delivery.id)) return;
		if (!this.#deliveries.has(delivery.id) && this.#deliveries.size >= 2048)
			throw new Error("Pending delivery limit reached");
		this.#deliveries.set(delivery.id, delivery);
		await this.finishOperation(
			delivery.operationKey,
			delivery.complete ? "completed" : "uncertain",
			delivery.toolResults.flatMap((result) =>
				resourceDescriptors(result.details),
			),
		);
		await this.#save();
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
			for (const delivery of deliveries) {
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
				for (const delivery of deliveries) {
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
		await this.#acknowledgements;
		await this.#writes;
	}

	#save(): Promise<void> {
		const contents = this.#snapshot();
		const saved = this.#writes.then(async () => {
			await writeFile(this.#temporaryPath, contents, { mode: 0o600 });
			await rename(this.#temporaryPath, this.#path);
		});
		this.#writes = saved.catch(() => {});
		return saved;
	}

	#snapshot(): string {
		const now = Date.now();
		this.#pruneBindings(now);
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
		for (const [id, time] of this.#deliveredIds) {
			if (time < now - 24 * 60 * 60 * 1000) this.#deliveredIds.delete(id);
		}
		if (this.#deliveredIds.size > 4096)
			throw new Error("Delivery receipt limit reached");
		const contents = `${JSON.stringify({ bindings, deliveries: [...this.#deliveries.values()], questions: [...this.#questions.values()], operations: [...this.#operations.values()], deliveredIds: [...this.#deliveredIds] }, null, 2)}\n`;
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
}
