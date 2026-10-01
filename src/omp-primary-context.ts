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

// Primary authorization is exact-session scoped. Empty context alone is not
// sufficient because OMP auxiliary helpers may reuse the main request hook.
export function hasOmpPrimaryContext(
	context: unknown,
	sessionId: string,
): boolean {
	if (typeof context !== "object" || context === null) return false;
	const messages = (context as OmpContext).messages;
	if (!Array.isArray(messages)) return false;
	return messages.some(
		(message) =>
			typeof message === "object" &&
			message !== null &&
			(message as Partial<OmpPrimaryContextMessage>)[primaryContextTag] ===
				sessionId,
	);
}
