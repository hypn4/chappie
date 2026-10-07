import { createHmac, randomBytes } from "node:crypto";
import { appendFile, lstat, mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { uuidV7 } from "./ids.ts";

export type DiagnosticPhase =
	| "rpc.received"
	| "rpc.ready"
	| "rpc.failed"
	| "snapshot.saved"
	| "snapshot.failed"
	| "native.dispatch"
	| "native.result"
	| "native.failed"
	| "stdio.written"
	| "stdio.failed"
	| "ack.staged"
	| "ack.cancelled"
	| "ack.committed"
	| "ack.failed"
	| "transport.closed";

export interface DiagnosticFields {
	rpc?: string | number;
	chat?: string;
	request?: string;
	session?: string;
	native?: number;
	bytes?: number;
	pending?: number;
	durationMs?: number;
}

interface DiagnosticLimits {
	maxBytes: number;
	maxPending: number;
}

/** Local boundary evidence, not proof of host receipt. No message content is accepted. */
export class Diagnostics {
	readonly #directory: string;
	readonly #path: string;
	readonly #salt = randomBytes(32);
	readonly #run = uuidV7();
	readonly #limits: DiagnosticLimits;
	#enabled = true;
	#pending = 0;
	#dropped = 0;
	#sequence = 0;
	#writes = Promise.resolve();
	constructor(directory: string, limits: Partial<DiagnosticLimits> = {}) {
		this.#directory = directory;
		this.#path = join(directory, "chappie.diagnostics.jsonl");
		this.#limits = { maxBytes: 1024 * 1024, maxPending: 256, ...limits };
		if (
			Object.values(this.#limits).some((v) => !Number.isSafeInteger(v) || v < 1)
		)
			throw new Error("Invalid diagnostic limits");
	}
	setEnabled(enabled: boolean): void {
		this.#enabled = enabled;
	}
	get stats() {
		return { pending: this.#pending, dropped: this.#dropped };
	}
	record(phase: DiagnosticPhase, fields: DiagnosticFields = {}): void {
		if (!this.#enabled) return;
		if (this.#pending >= this.#limits.maxPending) {
			this.#dropped++;
			return;
		}
		const event: Record<string, string | number> = {
			version: 1,
			run: this.#run,
			sequence: ++this.#sequence,
			time: Date.now(),
			phase,
			dropped: this.#dropped,
		};
		for (const key of ["rpc", "chat", "request", "session"] as const) {
			const value = fields[key];
			if (value !== undefined)
				event[key] = createHmac("sha256", this.#salt)
					.update(JSON.stringify([key, value]))
					.digest("hex");
		}
		for (const key of ["native", "bytes", "pending", "durationMs"] as const) {
			const value = fields[key];
			if (typeof value === "number" && Number.isFinite(value) && value >= 0)
				event[key] = value;
		}
		const line = `${JSON.stringify(event)}\n`;
		if (Buffer.byteLength(line) > this.#limits.maxBytes) {
			this.#dropped++;
			return;
		}
		this.#pending++;
		this.#writes = this.#writes
			.then(async () => {
				await mkdir(this.#directory, { recursive: true, mode: 0o700 });
				let size = 0;
				try {
					const info = await lstat(this.#path);
					if (!info.isFile()) throw new Error("Invalid diagnostic destination");
					size = info.size;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				if (size + Buffer.byteLength(line) > this.#limits.maxBytes) {
					await unlink(`${this.#path}.1`).catch(
						(error: NodeJS.ErrnoException) => {
							if (error.code !== "ENOENT") throw error;
						},
					);
					await rename(this.#path, `${this.#path}.1`);
				}
				await appendFile(this.#path, line, { mode: 0o600 });
			})
			.catch(() => {
				this.#dropped++;
			})
			.finally(() => {
				this.#pending--;
			});
	}
	async flush(): Promise<void> {
		await this.#writes;
	}
}
