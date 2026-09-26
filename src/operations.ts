import { createHash } from "node:crypto";
import type { ResourceDescriptor } from "./resources.ts";
import type { ToolInput } from "./tools.ts";

export interface OperationResource extends ResourceDescriptor {
	/** A successful broker-side source read, not confirmation of ChatGPT receipt. */
	sourceReadAt?: number | undefined;
}

export interface OperationReceipt {
	key: string;
	signature: string;
	chatId: string;
	sessionId: string;
	cwd: string;
	status: "running" | "completed" | "uncertain";
	updatedAt: number;
	resources?: OperationResource[] | undefined;
}

export interface ReplayReceipt {
	id: string;
	status: OperationReceipt["status"];
	instructions: string;
	delivery?: { hostReceipt: "unconfirmed"; resources: OperationResource[] };
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
): { key: string; signature: string } | undefined {
	let id =
		typeof requestId === "string" && requestId.length > 0
			? requestId
			: undefined;
	let scope = "request";
	let content: unknown = payload;
	if (Array.isArray(payload)) {
		const single = payload.length === 1 ? payload[0] : undefined;
		if (
			single?.name === "transfer" &&
			single.arguments.operationId !== undefined
		) {
			const requested = single.arguments.operationId;
			if (
				typeof requested !== "string" ||
				!requested.trim() ||
				requested.length > 128
			) {
				throw new Error(
					"transfer.operationId must be a nonempty identifier of at most 128 characters",
				);
			}
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
	};
}

export function replayReceipt(receipt: OperationReceipt): ReplayReceipt {
	return {
		id: receipt.key,
		status: receipt.status,
		...(receipt.resources?.length
			? {
					delivery: {
						hostReceipt: "unconfirmed" as const,
						resources: structuredClone(receipt.resources),
					},
				}
			: {}),
		instructions:
			"Already accepted: do not rerun, reattach, or publish another completion automatically. Status covers native execution, not ChatGPT file receipt. delivery.resources are inert references; sourceReadAt means only a broker-side read. Explicit missing-file recovery may transfer the original URI with a stable ID for that separate user request, subject to approval. Never retry a denied approval. Reconcile uncertain executions; inspect history when references are absent.",
	};
}
