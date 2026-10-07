import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type CommonHistoryEntry,
	CommonHistoryStore,
	type CommonProject,
} from "./common-history.ts";

const MAX_PROJECTED_ENTRIES = 2048;
const MAX_PROJECTED_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_BYTES = 64 * 1024 * 1024;

/** Count JSON string bytes without allocating an escaped copy of a large native string. */
function stringBytes(value: string, maximum: number): number {
	let bytes = 2;
	for (let index = 0; index < value.length && bytes <= maximum; index++) {
		const code = value.charCodeAt(index);
		if (code === 34 || code === 92) bytes += 2;
		else if (code < 32) bytes += [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
		else if (code < 128) bytes++;
		else if (code < 2048) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index++;
			} else bytes += 6;
		} else bytes += code >= 0xdc00 && code <= 0xdfff ? 6 : 3;
	}
	return bytes;
}

function toolArguments(value: unknown, maximum: number): string | undefined {
	let remaining = maximum;
	let nodes = 0;
	try {
		return JSON.stringify(value, function (key, item: unknown) {
			// Bound traversal and allocations before JSON.stringify builds its output.
			if (++nodes > 65536)
				throw new Error("History tool arguments exceed the node budget");
			remaining -= Array.isArray(this) ? 1 : stringBytes(key, remaining) + 2;
			remaining -=
				typeof item === "string"
					? stringBytes(item, remaining)
					: typeof item === "number"
						? 32
						: 5;
			if (remaining < 0)
				throw new Error("History tool arguments exceed the byte budget");
			return item;
		});
	} catch {
		return undefined;
	}
}

function visible(entry: SessionEntry): boolean {
	if (entry.type === "message")
		return ["user", "assistant", "toolResult"].includes(entry.message.role);
	if (entry.type === "custom_message")
		return entry.display && entry.customType !== "chappie.request";
	if (entry.type === "custom")
		return (
			entry.customType === "chappie.notice" &&
			(entry.data as { event?: string } | undefined)?.event !== "history"
		);
	return entry.type === "compaction" || entry.type === "branch_summary";
}

function publicText(content: unknown, maximum: number): string | undefined {
	if (typeof content === "string")
		return stringBytes(content, maximum) <= maximum ? content : undefined;
	if (!Array.isArray(content)) return "";
	let remaining = maximum - 2;
	const parts: string[] = [];
	let blocks = 0;
	for (const value of content) {
		if (++blocks > 65536) return undefined;
		if (!value || typeof value !== "object") continue;
		const block = value as Record<string, unknown>;
		let part: string | undefined;
		if (block.type === "text" && typeof block.text === "string")
			part = block.text;
		else if (block.type === "image")
			part = "[Image content is available in the source session.]";
		else if (block.type === "toolCall") {
			if (
				typeof block.name !== "string" ||
				block.name.length > 1024 ||
				typeof block.id !== "string" ||
				block.id.length > 1024
			)
				return undefined;
			const args = toolArguments(block.arguments, remaining);
			if (args === undefined) return undefined;
			part = `Tool call ${block.name} (${block.id})\n${args}`;
		} else continue;
		remaining -= stringBytes(part, remaining + 2) - 2 + (parts.length ? 2 : 0);
		if (remaining < 0) return undefined;
		parts.push(part);
	}
	return parts.join("\n");
}

/** Project public text only; native execution state and private metadata stay native. */
export function commonOmpHistory(branch: readonly SessionEntry[]): {
	sourceEntryCount: number;
	sourceNewestEntryId?: string;
	sourceOversizedEntries: number;
	entries: CommonHistoryEntry[];
	bytes: number;
} {
	let sourceEntryCount = 0;
	let sourceNewestEntryId: string | undefined;
	let sourceOversizedEntries = 0;
	let bytes = 0;
	let full = false;
	const entries: CommonHistoryEntry[] = [];
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (!entry || !visible(entry)) continue;
		sourceEntryCount++;
		sourceNewestEntryId ??= entry.id;
		if (full || entries.length >= MAX_PROJECTED_ENTRIES) continue;
		const parsedTime = Date.parse(entry.timestamp);
		const identity = {
			sourceEntryId: entry.id,
			timestamp: Number.isFinite(parsedTime) ? parsedTime : 0,
		};
		let projected: CommonHistoryEntry | undefined;
		let text: string | undefined;
		const maximum = MAX_PROJECTED_BYTES - 8192;
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			text = publicText(entry.summary, maximum);
			if (text !== undefined)
				projected = { ...identity, kind: "summary", text };
		} else if (entry.type === "custom") {
			const message = (entry.data as { message?: unknown } | undefined)
				?.message;
			if (typeof message === "string") text = publicText(message, maximum);
			if (text !== undefined)
				projected = {
					...identity,
					kind: "message",
					role: "system",
					text,
				};
		} else if (entry.type === "custom_message") {
			text = publicText(entry.content, maximum);
			if (text !== undefined)
				projected = {
					...identity,
					kind: "message",
					role: "system",
					text,
				};
		} else if (entry.type === "message") {
			const message = entry.message;
			if (
				message.role !== "toolResult" &&
				message.role !== "user" &&
				message.role !== "assistant"
			)
				continue;
			text = publicText(message.content, maximum);
			if (message.role === "toolResult") {
				if (text !== undefined)
					projected = {
						...identity,
						kind: "tool",
						toolName: message.toolName,
						toolCallId: message.toolCallId,
						isError: message.isError,
						text,
					};
			} else if (message.role === "user" || message.role === "assistant") {
				if (text !== undefined)
					projected = {
						...identity,
						kind: "message",
						role: message.role,
						text,
					};
			}
		}
		if (
			!projected ||
			projected.sourceEntryId.length > 1024 ||
			(projected.toolName?.length ?? 0) > 1024 ||
			(projected.toolCallId?.length ?? 0) > 1024
		) {
			sourceOversizedEntries++;
			continue;
		}
		const size = Buffer.byteLength(JSON.stringify(projected)) + 1;
		if (size > MAX_PROJECTED_BYTES) {
			sourceOversizedEntries++;
			continue;
		}
		if (bytes + size > MAX_PROJECTED_BYTES) {
			full = true;
			continue;
		}
		bytes += size;
		entries.push(projected);
	}
	return {
		sourceEntryCount,
		sourceOversizedEntries,
		...(sourceNewestEntryId ? { sourceNewestEntryId } : {}),
		entries: entries.reverse(),
		bytes,
	};
}

interface HistoryContext {
	cwd: string;
	sessionManager: Pick<
		ReadonlySessionManager,
		"getSessionId" | "getHeader" | "getBranch"
	>;
}

interface RecordingSession {
	id: string;
	cwd: string;
	context: HistoryContext;
	startedAt: number;
	project: Promise<CommonProject | undefined>;
	finished: boolean;
}

/** Coalesce public history off the native execution path. */
export class OmpHistoryRecorder {
	readonly #store: CommonHistoryStore;
	readonly #projectId: string | undefined;
	readonly #onError: (error: Error) => void;
	readonly #pending = new Map<
		string,
		{ work: () => Promise<void>; bytes: number }
	>();
	#pendingBytes = 0;
	#current: RecordingSession | undefined;
	#timer: NodeJS.Timeout | undefined;
	#draining: Promise<void> | undefined;

	constructor(
		homeDir: string,
		options: {
			projectId?: string | undefined;
			onError: (error: Error) => void;
		},
	) {
		this.#store = new CommonHistoryStore({ homeDir, onError: options.onError });
		this.#projectId = options.projectId;
		this.#onError = options.onError;
	}

	observe(context: HistoryContext): void {
		try {
			this.#observe(context);
		} catch (error) {
			this.#report(error);
		}
	}

	/** Capture while the native manager still refers to the departing session. */
	capture(context: HistoryContext): void {
		this.observe(context);
		if (this.#current) this.#capture(this.#current);
	}

	#report(error: unknown): void {
		try {
			this.#onError(error instanceof Error ? error : new Error(String(error)));
		} catch {
			/* A history warning must not interrupt native execution. */
		}
	}

	#observe(context: HistoryContext): void {
		const id = context.sessionManager.getSessionId();
		const cwd = context.cwd;
		if (this.#current?.id !== id || this.#current.cwd !== cwd) {
			// The manager is mutable: only the before-switch hook can capture the old branch.
			this.#finish(false);
			const timestamp = Date.parse(
				context.sessionManager.getHeader()?.timestamp ?? "",
			);
			this.#current = {
				id,
				cwd,
				context,
				startedAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
				project: this.#store.resolveProject({
					cwd,
					...(this.#projectId ? { projectId: this.#projectId } : {}),
				}),
				finished: false,
			};
		} else this.#current.context = context;
		if (this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			if (this.#current) this.#capture(this.#current);
		}, 200);
		this.#timer.unref();
	}

	finish(): void {
		this.#finish(true);
	}

	#finish(capture: boolean): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		const session = this.#current;
		if (!session) return;
		session.finished = true;
		if (capture) this.#capture(session);
		this.#current = undefined;
		this.#queue(this.#key("finish", session), async () => {
			const project = await session.project;
			if (project && !(await this.#isCurrent(project.projectId, session.id))) {
				await this.#store.flush();
				await this.#store.finishSession(project.projectId, session.id);
			}
		});
	}

	async flush(): Promise<void> {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (this.#current) this.#capture(this.#current);
		while (this.#draining) await this.#draining;
		await this.#store.flush();
	}

	#capture(session: RecordingSession): void {
		try {
			if (session.context.sessionManager.getSessionId() !== session.id) return;
			const { bytes, ...projection } = commonOmpHistory(
				session.context.sessionManager.getBranch(),
			);
			const updatedAt = Math.max(Date.now(), session.startedAt);
			this.#queue(
				this.#key("write", session),
				async () => {
					const project = await session.project;
					if (
						!project ||
						(session.finished &&
							(await this.#isCurrent(project.projectId, session.id)))
					)
						return;
					this.#store.enqueue({
						projectId: project.projectId,
						sessionId: session.id,
						cwd: session.cwd,
						source: { agent: "omp", sourceSessionId: session.id },
						state: session.finished ? "finished" : "active",
						current: !session.finished,
						startedAt: session.startedAt,
						updatedAt,
						...(session.finished ? { finishedAt: updatedAt } : {}),
						...projection,
					});
				},
				bytes,
			);
		} catch (error) {
			this.#report(error);
		}
	}

	#key(action: string, session: RecordingSession): string {
		return JSON.stringify([action, session.cwd, session.id]);
	}

	async #isCurrent(projectId: string, sessionId: string): Promise<boolean> {
		while (this.#current?.id === sessionId) {
			const current = this.#current;
			const project = await current.project;
			if (this.#current === current) return project?.projectId === projectId;
		}
		return false;
	}

	#queue(key: string, work: () => Promise<void>, bytes = 0): void {
		const total =
			this.#pendingBytes - (this.#pending.get(key)?.bytes ?? 0) + bytes;
		if (
			(!this.#pending.has(key) && this.#pending.size >= 16) ||
			total > MAX_PENDING_BYTES
		) {
			this.#report(new Error("Shared history publication queue is full"));
			return;
		}
		this.#pending.set(key, { work, bytes });
		this.#pendingBytes = total;
		this.#draining ??= (async () => {
			// Start after assignment so a synchronous empty drain cannot leave a stale promise.
			await Promise.resolve();
			while (this.#pending.size) {
				const next = this.#pending.entries().next().value;
				if (!next) break;
				this.#pending.delete(next[0]);
				this.#pendingBytes -= next[1].bytes;
				try {
					await next[1].work();
				} catch (error) {
					this.#report(error);
				}
			}
		})().finally(() => {
			this.#draining = undefined;
		});
	}
}
