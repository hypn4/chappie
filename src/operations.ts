import { createHash } from "node:crypto";
import type { ResourceDescriptor } from "./resources.ts";
import type { ToolInput } from "./tools.ts";

export interface OperationResource extends ResourceDescriptor {
	/** A successful broker-side source read, not confirmation of ChatGPT receipt. */
	sourceReadAt?: number | undefined;
}

export type OperationStatus =
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "uncertain";

export interface OperationReceipt {
	key: string;
	/** Stable caller-visible identifier for detached operations. */
	operationId?: string | undefined;
	signature: string;
	chatId: string;
	sessionId: string;
	cwd: string;
	createdAt?: number | undefined;
	status: OperationStatus;
	updatedAt: number;
	error?: string | undefined;
	resources?: OperationResource[] | undefined;
}

export interface ReplayReceipt {
	id: string;
	status: OperationReceipt["status"];
	replayed: true;
	delivery?: { hostReceipt: "unconfirmed"; resources: OperationResource[] };
}

export interface OperationView {
	operationId: string;
	status: OperationStatus;
	sessionId: string;
	cwd: string;
	updatedAt: number;
	error?: string | undefined;
	resources?: OperationResource[] | undefined;
}

export function validateOperationId(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 128) {
		throw new Error(
			"operationId must be a nonempty identifier of at most 128 characters",
		);
	}
	return value;
}

/** Canonical JSON allows equivalent object key ordering without widening intent. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, item]) => [key, canonical(item)]),
		);
	}
	return value;
}

export function operationIdentity(
	chatId: string,
	sessionId: string,
	kind: "call" | "chat",
	requestId: unknown,
	payload: ToolInput[] | string,
	explicitOperationId?: unknown,
): { key: string; signature: string; operationId?: string } | undefined {
	const operationId =
		explicitOperationId === undefined
			? undefined
			: validateOperationId(explicitOperationId);
	let id =
		operationId ??
		(typeof requestId === "string" && requestId.length > 0
			? requestId
			: undefined);
	let scope = operationId ? "operation" : "request";
	let content: unknown = payload;
	if (Array.isArray(payload)) {
		const single = payload.length === 1 ? payload[0] : undefined;
		if (
			!operationId &&
			single?.name === "transfer" &&
			single.arguments.operationId !== undefined
		) {
			const requested = validateOperationId(single.arguments.operationId);
			id = requested;
			scope = "operation";
		}
		content = payload.map((call) => {
			if (call.name !== "transfer" || !Array.isArray(call.arguments.files))
				return call;
			return {
				...call,
				arguments: {
					...call.arguments,
					files: call.arguments.files.map((file) => {
						if (
							!file ||
							typeof file !== "object" ||
							typeof file.file_id !== "string"
						)
							throw new Error(
								"Use the direct transfer tool for ChatGPT file imports",
							);
						// Signed URLs may rotate across host approvals; file identity must not.
						const { download_url: _url, ...identity } = file;
						return identity;
					}),
				},
			};
		});
	}

	if (!id) return undefined;
	return {
		key: createHash("sha256")
			.update(JSON.stringify([chatId, sessionId, kind, scope, id]))
			.digest("hex"),
		signature: createHash("sha256")
			.update(JSON.stringify(canonical(content)))
			.digest("hex"),
		...(operationId ? { operationId } : {}),
	};
}

export function operationView(receipt: OperationReceipt): OperationView {
	if (!receipt.operationId)
		throw new Error("Operation has no caller-visible identifier");
	return {
		operationId: receipt.operationId,
		status: receipt.status,
		sessionId: receipt.sessionId,
		cwd: receipt.cwd,
		updatedAt: receipt.updatedAt,
		...(receipt.error ? { error: receipt.error } : {}),
		...(receipt.resources?.length
			? { resources: structuredClone(receipt.resources) }
			: {}),
	};
}

export function replayReceipt(receipt: OperationReceipt): ReplayReceipt {
	return {
		id: receipt.key,
		status: receipt.status,
		replayed: true,
		...(receipt.resources?.length
			? {
					delivery: {
						hostReceipt: "unconfirmed" as const,
						resources: structuredClone(receipt.resources),
					},
				}
			: {}),
	};
}
