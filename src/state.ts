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

const MAX_STATE_BYTES = 32 * 1024 * 1024;
const stateSchema = z.strictObject({
	bindings: z.record(z.string(), z.string()).optional(),
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
	readonly #bindings = new Map<string, string>();
	readonly #deliveries = new Map<string, DeliveryRecord>();
	readonly #questions = new Map<string, QuestionRecord>();
	readonly #operations = new Map<string, OperationReceipt>();
	readonly #deliveredIds = new Map<string, number>();
	#writes = Promise.resolve();

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
		for (const [chatId, sessionId] of Object.entries(state.bindings ?? {})) {
			if (typeof sessionId === "string") this.#bindings.set(chatId, sessionId);
		}
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
		return this.#bindings.get(chatId);
	}

	bindingCounts(): Map<string, number> {
		const counts = new Map<string, number>();
		for (const sessionId of this.#bindings.values()) {
			counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
		}
		return counts;
	}

	bind(chatId: string, sessionId: string): Promise<void> {
		this.#bindings.set(chatId, sessionId);
		return this.#save();
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
		if (!this.#questions.has(question.id) && this.#questions.size >= 1024)
			throw new Error("Saved question limit reached");
		this.#questions.set(question.id, question);
		await this.#save();
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

	async acknowledge(
		deliveries: DeliveryRecord[],
		answers: QuestionRecord[],
		signal: AbortSignal,
	): Promise<void> {
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
	}

	async flush(): Promise<void> {
		await this.#writes;
	}

	#save(): Promise<void> {
		const saved = this.#writes.then(async () => {
			const bindings = Object.fromEntries(this.#bindings);
			for (const [id, time] of this.#deliveredIds) {
				if (time < Date.now() - 24 * 60 * 60 * 1000)
					this.#deliveredIds.delete(id);
			}
			if (this.#deliveredIds.size > 4096)
				throw new Error("Delivery receipt limit reached");
			const contents = `${JSON.stringify({ bindings, deliveries: [...this.#deliveries.values()], questions: [...this.#questions.values()], operations: [...this.#operations.values()], deliveredIds: [...this.#deliveredIds] }, null, 2)}\n`;
			if (Buffer.byteLength(contents) > MAX_STATE_BYTES)
				throw new Error(
					"Chappie state exceeds the 32 MiB limit; pending results were not persisted",
				);
			await writeFile(this.#temporaryPath, contents, { mode: 0o600 });
			await rename(this.#temporaryPath, this.#path);
		});
		this.#writes = saved.catch(() => {});
		return saved;
	}
}
