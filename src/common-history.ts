import {
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { uuidV7 } from "./ids.ts";
import { StorageLock, StorageLockedError } from "./storage-lock.ts";

const MiB = 1024 * 1024;
const identifier = z.uuid().transform((value) => value.toLowerCase());
const timestamp = z.number().int().nonnegative().safe();
const entrySchema = z.object({
	sourceEntryId: z.string().min(1).max(1024),
	timestamp,
	kind: z.enum(["message", "tool", "summary"]),
	text: z.string(),
	role: z.enum(["user", "assistant", "system"]).optional(),
	toolName: z.string().max(1024).optional(),
	toolCallId: z.string().max(1024).optional(),
	isError: z.boolean().optional(),
});
const provenanceSchema = z.object({
	agent: z.string().min(1).max(256),
	sourceSessionId: z.string().min(1).max(1024),
});
const projectSchema = z.strictObject({
	projectId: identifier,
	name: z.string().max(1024),
	cwdAliases: z.array(z.string().min(1).max(8192)).min(1).max(256),
	createdAt: timestamp,
	updatedAt: timestamp,
});
const catalogSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		projects: z.array(projectSchema).max(10000),
	})
	.superRefine((value, ctx) => {
		const ids = new Set<string>();
		const aliases = new Set<string>();
		for (const project of value.projects) {
			if (ids.has(project.projectId))
				ctx.addIssue({ code: "custom", message: "Duplicate project identity" });
			ids.add(project.projectId);
			for (const alias of project.cwdAliases) {
				if (aliases.has(alias))
					ctx.addIssue({
						code: "custom",
						message: "Duplicate project cwd alias",
					});
				aliases.add(alias);
			}
		}
	});
const inputSchema = z
	.object({
		projectId: identifier,
		sessionId: identifier,
		cwd: z.string().min(1).max(8192),
		source: provenanceSchema,
		state: z.enum(["active", "finished"]),
		current: z.boolean(),
		startedAt: timestamp,
		updatedAt: timestamp,
		finishedAt: timestamp.optional(),
		sourceEntryCount: z.number().int().nonnegative().safe(),
		sourceNewestEntryId: z.string().min(1).max(1024).optional(),
		sourceOversizedEntries: z.number().int().nonnegative().safe().optional(),
		entries: z.array(entrySchema),
	})
	.superRefine((value, ctx) => {
		if (
			value.updatedAt < value.startedAt ||
			value.sourceEntryCount < value.entries.length ||
			(value.sourceOversizedEntries ?? 0) >
				value.sourceEntryCount - value.entries.length
		)
			ctx.addIssue({
				code: "custom",
				message: "Invalid history location, times, or source count",
			});
		if (
			value.state === "finished" &&
			(value.finishedAt === undefined || value.finishedAt < value.startedAt)
		)
			ctx.addIssue({
				code: "custom",
				message: "Finished history requires a finish timestamp",
			});
		const ids = new Set<string>();
		for (const entry of value.entries) {
			if (ids.has(entry.sourceEntryId))
				ctx.addIssue({
					code: "custom",
					message: "Duplicate source entry identity",
				});
			ids.add(entry.sourceEntryId);
		}
	});
const coverageSchema = z.strictObject({
	sourceEntryCount: z.number().int().nonnegative().safe(),
	suppliedEntries: z.number().int().nonnegative().safe(),
	retainedEntries: z.number().int().nonnegative().safe(),
	omittedEntries: z.number().int().nonnegative().safe(),
	oversizedEntries: z.number().int().nonnegative().safe(),
	complete: z.boolean(),
	newestEntryRetained: z.boolean(),
});
const snapshotSchema = inputSchema.safeExtend({
	schemaVersion: z.literal(1),
	coverage: coverageSchema,
	runtimeOwner: z.strictObject({
		pid: z.number().int().positive(),
		hostname: z.string().min(1).max(1024),
	}),
});

export type HistoryProvenance = z.infer<typeof provenanceSchema>;
export type CommonHistoryEntry = z.infer<typeof entrySchema>;
export type CommonHistoryInput = Omit<
	z.infer<typeof inputSchema>,
	"entries"
> & { entries: readonly CommonHistoryEntry[] };
export type CommonProject = z.infer<typeof projectSchema>;
export type CommonHistorySnapshot = z.infer<typeof snapshotSchema>;
export type CommonHistorySummary = Omit<CommonHistorySnapshot, "entries"> & {
	bytes: number;
};
export interface CommonHistoryLimits {
	maxSessionBytes: number;
	maxProjectBytes: number;
	maxGlobalBytes: number;
	maxPendingBytes: number;
	maxPendingSessions: number;
	maxProjectSessions: number;
	maxGlobalSessions: number;
}
const defaultLimits: CommonHistoryLimits = {
	maxSessionBytes: 16 * MiB,
	maxProjectBytes: 128 * MiB,
	maxGlobalBytes: 512 * MiB,
	maxPendingBytes: 64 * MiB,
	maxPendingSessions: 128,
	maxProjectSessions: 512,
	maxGlobalSessions: 4096,
};
interface Publication {
	snapshot: CommonHistorySnapshot;
	text: string;
	bytes: number;
}
interface CachedHistory {
	identity: string;
	history: StoredHistory;
}
interface StoredHistory {
	path: string;
	summary: CommonHistorySummary;
}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
function errorOf(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
async function directory(path: string): Promise<void> {
	if (!(await lstat(path)).isDirectory())
		throw new Error(`History path is not a directory: ${path}`);
}
async function readJson(
	path: string,
	maximum: number,
): Promise<{ value: unknown; bytes: number } | undefined> {
	try {
		const stat = await lstat(path);
		if (!stat.isFile() || stat.size > maximum)
			throw new Error(`Invalid or oversized common history file: ${path}`);
		const text = await readFile(path, "utf8");
		const bytes = Buffer.byteLength(text);
		if (bytes > maximum)
			throw new Error(`Oversized common history file: ${path}`);
		return { value: JSON.parse(text), bytes };
	} catch (error) {
		if (missing(error)) return undefined;
		throw error;
	}
}
async function atomicWrite(path: string, text: string): Promise<void> {
	const temporary = `${path}.${uuidV7()}.tmp`;
	try {
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(text, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch((error: unknown) => {
			if (!missing(error)) throw error;
		});
	}
}
async function lockDirectory(path: string): Promise<StorageLock> {
	const deadline = performance.now() + 1000;
	for (;;) {
		try {
			return await StorageLock.acquire(path);
		} catch (error) {
			if (
				!(error instanceof StorageLockedError) ||
				performance.now() >= deadline
			)
				throw error;
			await delay(25);
		}
	}
}

/** Agent-neutral, public, whole-entry history. Publication failure never stops native work. */
export class CommonHistoryStore {
	readonly homeDir: string;
	readonly limits: CommonHistoryLimits;
	#pending = new Map<string, Publication>();
	#index = new Map<string, CachedHistory>();
	#pendingBytes = 0;
	#draining: Promise<void> | undefined;
	#onError: ((error: Error) => void) | undefined;

	constructor(options: {
		homeDir: string;
		limits?: Partial<CommonHistoryLimits>;
		onError?: (error: Error) => void;
	}) {
		this.homeDir = resolve(options.homeDir);
		this.limits = { ...defaultLimits, ...options.limits };
		this.#onError = options.onError;
		for (const value of Object.values(this.limits))
			if (!Number.isSafeInteger(value) || value <= 0)
				throw new Error("History limits must be positive safe integers");
		if (
			this.limits.maxSessionBytes > 32 * MiB ||
			this.limits.maxSessionBytes > this.limits.maxProjectBytes ||
			this.limits.maxProjectBytes > this.limits.maxGlobalBytes
		)
			throw new Error(
				"History byte limits must satisfy session <= 32 MiB and session <= project <= global",
			);
	}

	#report(error: unknown): void {
		try {
			this.#onError?.(errorOf(error));
		} catch {
			/* Observers cannot block native work. */
		}
	}
	get #catalogPath(): string {
		return join(this.homeDir, "project-catalog.json");
	}
	get #projectsDir(): string {
		return join(this.homeDir, "projects");
	}
	#sessionPath(projectId: string, sessionId: string): string {
		return join(
			this.#projectsDir,
			identifier.parse(projectId),
			"sessions",
			`${identifier.parse(sessionId)}.json`,
		);
	}
	async #catalog(): Promise<z.infer<typeof catalogSchema>> {
		const file = await readJson(this.#catalogPath, 4 * MiB);
		return file
			? catalogSchema.parse(file.value)
			: { schemaVersion: 1, projects: [] };
	}

	async resolveProject(input: {
		cwd: string;
		projectId?: string;
		name?: string;
	}): Promise<CommonProject | undefined> {
		try {
			if (!isAbsolute(input.cwd))
				throw new Error("Project cwd must be absolute");
			const cwd = await realpath(input.cwd);
			await directory(cwd);
			const requested =
				input.projectId === undefined
					? undefined
					: identifier.parse(input.projectId);
			return await withFileMutationQueue(this.#catalogPath, async () => {
				const lock = await lockDirectory(this.homeDir);
				try {
					const catalog = await this.#catalog();
					const alias = catalog.projects.find((project) =>
						project.cwdAliases.includes(cwd),
					);
					if (alias && requested && alias.projectId !== requested)
						throw new Error("Project cwd already belongs to another identity");
					let project = requested
						? catalog.projects.find((item) => item.projectId === requested)
						: alias;
					const now = Date.now();
					if (!project) {
						project = {
							projectId: requested ?? uuidV7(),
							name: input.name ?? basename(cwd),
							cwdAliases: [cwd],
							createdAt: now,
							updatedAt: now,
						};
						catalog.projects.push(project);
					} else {
						if (!project.cwdAliases.includes(cwd)) project.cwdAliases.push(cwd);
						if (input.name !== undefined) project.name = input.name;
						project.updatedAt = now;
					}
					catalogSchema.parse(catalog);
					const text = `${JSON.stringify(catalog, null, 2)}\n`;
					if (Buffer.byteLength(text) > 4 * MiB)
						throw new Error("Project catalog capacity exceeded");
					await atomicWrite(this.#catalogPath, text);
					return project;
				} finally {
					await lock.release();
				}
			});
		} catch (error) {
			this.#report(error);
			return undefined;
		}
	}

	async listProjects(): Promise<CommonProject[]> {
		return (await this.#catalog()).projects;
	}
	async readSession(
		projectId: string,
		sessionId: string,
	): Promise<CommonHistorySnapshot | undefined> {
		const file = await readJson(
			this.#sessionPath(projectId, sessionId),
			32 * MiB,
		);
		if (!file) return undefined;
		const snapshot = snapshotSchema.parse(file.value);
		if (
			snapshot.projectId !== identifier.parse(projectId) ||
			snapshot.sessionId !== identifier.parse(sessionId)
		)
			throw new Error("History file identity mismatch");
		if (
			snapshot.coverage.retainedEntries !== snapshot.entries.length ||
			snapshot.coverage.omittedEntries !==
				snapshot.sourceEntryCount - snapshot.entries.length
		)
			throw new Error("History coverage mismatch");
		return snapshot;
	}
	async listSessions(projectId: string): Promise<CommonHistorySummary[]> {
		return (await this.#scan(identifier.parse(projectId)))
			.map((item) => structuredClone(item.summary))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	#publication(input: CommonHistoryInput): Publication {
		const normalized = inputSchema.parse(input);
		if (!isAbsolute(normalized.cwd))
			throw new Error("History publication cwd must be absolute on this host");
		// JSON owns a public allowlist; unknown native fields never enter persisted history.
		const base: CommonHistorySnapshot = {
			...normalized,
			entries: [],
			runtimeOwner: { pid: process.pid, hostname: hostname() },
			schemaVersion: 1,
			coverage: {
				sourceEntryCount: normalized.sourceEntryCount,
				suppliedEntries: normalized.entries.length,
				retainedEntries: 0,
				omittedEntries: normalized.sourceEntryCount,
				oversizedEntries: normalized.sourceOversizedEntries ?? 0,
				complete: false,
				newestEntryRetained: normalized.sourceEntryCount === 0,
			},
		};
		const initialBytes = Buffer.byteLength(JSON.stringify(base)) + 1;
		// Reserve decimal count changes and formatting; final encoding is checked exactly.
		let remaining = this.limits.maxSessionBytes - initialBytes - 256;
		if (remaining < 0)
			throw new Error("History identity metadata exceeds the session budget");
		const retained: CommonHistoryEntry[] = [];
		let full = false;
		for (let index = normalized.entries.length - 1; index >= 0; index--) {
			const entry = normalized.entries[index];
			if (!entry) continue;
			const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
			if (bytes > this.limits.maxSessionBytes - initialBytes - 256) {
				base.coverage.oversizedEntries++;
				continue;
			}
			if (full || bytes > remaining) {
				full = true;
				continue;
			}
			retained.push(entry);
			remaining -= bytes;
			if (
				normalized.sourceNewestEntryId
					? entry.sourceEntryId === normalized.sourceNewestEntryId
					: index === normalized.entries.length - 1
			)
				base.coverage.newestEntryRetained = true;
		}
		base.entries = retained.reverse();
		base.coverage.retainedEntries = retained.length;
		base.coverage.omittedEntries =
			normalized.sourceEntryCount - retained.length;
		base.coverage.complete = base.coverage.omittedEntries === 0;
		const text = `${JSON.stringify(base)}\n`;
		const bytes = Buffer.byteLength(text);
		if (bytes > this.limits.maxSessionBytes)
			throw new Error("History snapshot exceeds the session budget");
		return { snapshot: base, text, bytes };
	}

	enqueue(input: CommonHistoryInput): boolean {
		try {
			const publication = this.#publication(input);
			const key = this.#sessionPath(
				publication.snapshot.projectId,
				publication.snapshot.sessionId,
			);
			const previous = this.#pending.get(key);
			if (
				previous &&
				(previous.snapshot.source.agent !== publication.snapshot.source.agent ||
					previous.snapshot.source.sourceSessionId !==
						publication.snapshot.source.sourceSessionId ||
					previous.snapshot.startedAt !== publication.snapshot.startedAt)
			)
				throw new Error("History session provenance cannot change");
			if (
				previous &&
				previous.snapshot.updatedAt > publication.snapshot.updatedAt
			)
				return true;
			const bytes =
				this.#pendingBytes - (previous?.bytes ?? 0) + publication.bytes;
			if (
				bytes > this.limits.maxPendingBytes ||
				(!previous && this.#pending.size >= this.limits.maxPendingSessions)
			)
				throw new Error("Common history publication queue is full");
			this.#pending.set(key, publication);
			this.#pendingBytes = bytes;
			this.#draining ??= Promise.resolve().then(() => this.#drain());
			return true;
		} catch (error) {
			this.#report(error);
			return false;
		}
	}
	async flush(): Promise<void> {
		while (this.#draining) await this.#draining;
	}
	async #drain(): Promise<void> {
		try {
			while (this.#pending.size) {
				const next = this.#pending.entries().next().value;
				if (!next) break;
				const [path, publication] = next;
				this.#pending.delete(path);
				this.#pendingBytes -= publication.bytes;
				try {
					await withFileMutationQueue(this.#projectsDir, () =>
						this.#publish(path, publication),
					);
				} catch (error) {
					this.#report(error);
				}
			}
		} finally {
			this.#draining = undefined;
		}
	}

	/** Release a confirmed finished native session without replaying or retaining its body in RAM. */
	async finishSession(
		projectId: string,
		sessionId: string,
		finishedAt = Date.now(),
	): Promise<void> {
		try {
			timestamp.parse(finishedAt);
			const path = this.#sessionPath(projectId, sessionId);
			await this.flush();
			await withFileMutationQueue(this.#projectsDir, async () => {
				const lock = await lockDirectory(this.#projectsDir);
				try {
					const snapshot = await this.readSession(projectId, sessionId);
					if (!snapshot) return;
					if (!this.#owns(snapshot))
						throw new Error("History session is owned by another process");
					snapshot.state = "finished";
					snapshot.current = false;
					snapshot.finishedAt = Math.max(snapshot.startedAt, finishedAt);
					snapshot.updatedAt = Math.max(
						snapshot.updatedAt,
						snapshot.finishedAt,
					);
					await atomicWrite(path, `${JSON.stringify(snapshot)}\n`);
					await this.#remember(path, snapshot);
				} finally {
					await lock.release();
				}
			});
		} catch (error) {
			this.#report(error);
		}
	}

	#owns(snapshot: Pick<CommonHistorySnapshot, "runtimeOwner">): boolean {
		return (
			snapshot.runtimeOwner.pid === process.pid &&
			snapshot.runtimeOwner.hostname === hostname()
		);
	}

	#reclaimable(summary: CommonHistorySummary): boolean {
		if (summary.state === "finished" && !summary.current) return true;
		if (summary.runtimeOwner.hostname !== hostname()) return false;
		try {
			process.kill(summary.runtimeOwner.pid, 0);
		} catch (error) {
			return (error as NodeJS.ErrnoException | undefined)?.code === "ESRCH";
		}
		return false;
	}

	async #fileIdentity(
		path: string,
	): Promise<{ identity: string; bytes: number } | undefined> {
		try {
			const stat = await lstat(path, { bigint: true });
			if (!stat.isFile() || stat.size > BigInt(32 * MiB))
				throw new Error(`Invalid or oversized common history file: ${path}`);
			return {
				identity: [
					stat.dev,
					stat.ino,
					stat.size,
					stat.mtimeNs,
					stat.ctimeNs,
				].join(":"),
				bytes: Number(stat.size),
			};
		} catch (error) {
			if (missing(error)) {
				this.#index.delete(path);
				return undefined;
			}
			throw error;
		}
	}
	#cache(
		path: string,
		identity: string,
		snapshot: CommonHistorySnapshot,
		bytes: number,
	): StoredHistory {
		const { entries: _entries, ...summary } = snapshot;
		const history = { path, summary: { ...summary, bytes } };
		this.#index.set(path, { identity, history });
		if (this.#index.size > this.limits.maxGlobalSessions) {
			const oldest = this.#index.keys().next().value;
			if (oldest) this.#index.delete(oldest);
		}
		return history;
	}
	async #remember(
		path: string,
		snapshot: CommonHistorySnapshot,
	): Promise<void> {
		const file = await this.#fileIdentity(path);
		if (file) this.#cache(path, file.identity, snapshot, file.bytes);
	}
	async #storedHistory(
		projectId: string,
		sessionId: string,
	): Promise<StoredHistory | undefined> {
		const path = this.#sessionPath(projectId, sessionId);
		const file = await this.#fileIdentity(path);
		if (!file) return undefined;
		const cached = this.#index.get(path);
		if (cached?.identity === file.identity) return cached.history;
		this.#index.delete(path);
		const snapshot = await this.readSession(projectId, sessionId);
		if (!snapshot) return undefined;
		return this.#cache(path, file.identity, snapshot, file.bytes);
	}
	async #scan(projectId?: string): Promise<StoredHistory[]> {
		const projects = projectId
			? [projectId]
			: (await this.#catalog()).projects.map((project) => project.projectId);
		const histories: StoredHistory[] = [];
		const found = new Set<string>();
		for (const id of projects) {
			const dir = join(this.#projectsDir, id, "sessions");
			let names: string[];
			try {
				await directory(dir);
				names = await readdir(dir);
			} catch (error) {
				if (missing(error)) continue;
				throw error;
			}
			for (const name of names) {
				if (
					!name.endsWith(".json") ||
					!identifier.safeParse(name.slice(0, -5)).success
				)
					continue;
				const history = await this.#storedHistory(id, name.slice(0, -5));
				if (!history) continue;
				histories.push(history);
				found.add(history.path);
			}
		}
		for (const [path, cached] of this.#index) {
			if (
				(!projectId || cached.history.summary.projectId === projectId) &&
				!found.has(path)
			)
				this.#index.delete(path);
		}
		return histories;
	}
	async #publish(path: string, publication: Publication): Promise<void> {
		const lock = await lockDirectory(this.#projectsDir);
		try {
			const snapshot = publication.snapshot;
			const project = (await this.#catalog()).projects.find(
				(item) => item.projectId === snapshot.projectId,
			);
			if (!project?.cwdAliases.includes(await realpath(snapshot.cwd)))
				throw new Error("History project or cwd alias is not registered");
			const previous = (
				await this.#storedHistory(snapshot.projectId, snapshot.sessionId)
			)?.summary;
			if (previous) {
				if (
					previous.source.agent !== snapshot.source.agent ||
					previous.source.sourceSessionId !== snapshot.source.sourceSessionId ||
					previous.startedAt !== snapshot.startedAt
				)
					throw new Error("History session provenance cannot change");
				if (previous.updatedAt > snapshot.updatedAt) return;
				// A late shutdown cannot finish a resumed writer's session. A new
				// active writer may resume only released or provably dead ownership.
				if (
					!this.#owns(previous) &&
					(snapshot.state !== "active" || !this.#reclaimable(previous))
				)
					throw new Error("History session is owned by another process");
			}
			const histories = (await this.#scan()).filter(
				(item) => item.path !== path,
			);
			const victims: StoredHistory[] = [];
			const eligible = histories
				.filter((item) => this.#reclaimable(item.summary))
				.sort(
					(a, b) =>
						(a.summary.finishedAt ?? a.summary.updatedAt) -
							(b.summary.finishedAt ?? b.summary.updatedAt) ||
						a.path.localeCompare(b.path),
				);
			let projectBytes = publication.bytes;
			let globalBytes = publication.bytes;
			let projectCount = 1;
			let globalCount = 1;
			for (const item of histories) {
				globalBytes += item.summary.bytes;
				globalCount++;
				if (item.summary.projectId === snapshot.projectId) {
					projectBytes += item.summary.bytes;
					projectCount++;
				}
			}
			const remove = (item: StoredHistory) => {
				victims.push(item);
				globalBytes -= item.summary.bytes;
				globalCount--;
				if (item.summary.projectId === snapshot.projectId) {
					projectBytes -= item.summary.bytes;
					projectCount--;
				}
			};
			for (const item of eligible) {
				if (
					projectBytes <= this.limits.maxProjectBytes &&
					projectCount <= this.limits.maxProjectSessions
				)
					break;
				if (item.summary.projectId === snapshot.projectId) remove(item);
			}
			for (const item of eligible) {
				if (
					globalBytes <= this.limits.maxGlobalBytes &&
					globalCount <= this.limits.maxGlobalSessions
				)
					break;
				if (!victims.includes(item)) remove(item);
			}
			if (
				projectBytes > this.limits.maxProjectBytes ||
				globalBytes > this.limits.maxGlobalBytes ||
				projectCount > this.limits.maxProjectSessions ||
				globalCount > this.limits.maxGlobalSessions
			)
				throw new Error(
					"Common history capacity is occupied by active or current sessions",
				);
			const dir = join(this.#projectsDir, snapshot.projectId, "sessions");
			await mkdir(dir, { recursive: true, mode: 0o700 });
			await directory(join(this.#projectsDir, snapshot.projectId));
			await directory(dir);
			await atomicWrite(path, publication.text);
			await this.#remember(path, snapshot);
			for (const victim of victims) {
				await unlink(victim.path).catch((error: unknown) => {
					if (!missing(error)) throw error;
				});
				this.#index.delete(victim.path);
			}
		} finally {
			await lock.release();
		}
	}
}
