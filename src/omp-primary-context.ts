// OMP can load multiple Chappie module copies while keeping one process-wide
// provider registration. A global symbol lets those copies recognize the same
// per-call provenance without serializing it into session history or IPC.
const primaryContextTag = Symbol.for("@hypn4/chappie/omp-primary-context/v1");

export interface OmpPrimaryContextMessage {
	role: "developer";
	content: "";
	attribution: "agent";
	timestamp: number;
	[primaryContextTag]: string;
}

interface OmpContext {
	messages?: unknown;
}

const markerCarrierRoles = new Set([
	"user",
	"developer",
	"assistant",
	"toolResult",
]);

function canCarryPrimaryContext(
	message: unknown,
): message is Record<PropertyKey, unknown> {
	return (
		typeof message === "object" &&
		message !== null &&
		"role" in message &&
		typeof message.role === "string" &&
		markerCarrierRoles.has(message.role)
	);
}

// Provider-visible authorization is attached to one ordinary message with a
// symbol key. OMP's core-role conversion spreads these messages, preserving the
// symbol in-process, while JSON/provider serialization ignores symbol keys.
// If a turn has only custom control messages, append one empty developer
// carrier so the marker still survives conversion.
export function markOmpPrimaryContext<T>(
	messages: readonly T[],
	sessionId: string,
): Array<T | OmpPrimaryContextMessage> {
	const carrierIndex = messages.findIndex(canCarryPrimaryContext);
	if (carrierIndex < 0) {
		return [...messages, createOmpPrimaryContextMessage(sessionId)];
	}
	const carrier = messages[carrierIndex] as Record<PropertyKey, unknown>;
	const marked = [...messages] as Array<T | OmpPrimaryContextMessage>;
	marked[carrierIndex] = {
		...carrier,
		[primaryContextTag]: sessionId,
	} as T;
	return marked;
}

export function createOmpPrimaryContextMessage(
	sessionId: string,
): OmpPrimaryContextMessage {
	return {
		role: "developer",
		content: "",
		attribution: "agent",
		timestamp: Date.now(),
		[primaryContextTag]: sessionId,
	};
}

// Resolve the persistent owner from local-only provenance, not from the
// provider transport/cache ID, which OMP rotates on /clear and /fresh.
// Conflicting markers never grant ownership to either session.
export function getOmpPrimarySessionId(context: unknown): string | undefined {
	if (typeof context !== "object" || context === null) return undefined;
	const messages = (context as OmpContext).messages;
	if (!Array.isArray(messages)) return undefined;
	let sessionId: string | undefined;
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		const value = (message as Partial<OmpPrimaryContextMessage>)[
			primaryContextTag
		];
		if (value === undefined) continue;
		if (
			typeof value !== "string" ||
			!value ||
			(sessionId !== undefined && value !== sessionId)
		)
			return undefined;
		sessionId = value;
	}
	return sessionId;
}

// Empty context alone is insufficient: auxiliary helpers may reuse the hook.
export function hasOmpPrimaryContext(
	context: unknown,
	sessionId: string,
): boolean {
	return getOmpPrimarySessionId(context) === sessionId;
}
