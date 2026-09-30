import type { AssistantMessageEventStream as OmpAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type {
	ExtensionAPI as OmpExtensionAPI,
	ProviderConfig as OmpProviderConfig,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { createChappieStream, type ProviderOutput } from "./provider-core.ts";

const CHAPPIE_API = "chappie";
const CHAPPIE_LOCAL_API_KEY = "chappie-local";
const CHAPPIE_LOCAL_BASE_URL = "http://127.0.0.1";

// OMP can load multiple copies of an extension in one process. Symbols share
// this local-only contract without storing sessions in a global registry.
const requestTag = Symbol.for("@hypn4/chappie/omp-request/v1");
const routeTag = Symbol.for("@hypn4/chappie/omp-route/v1");
type Start = (output: ProviderOutput, sessionId: string) => Promise<void>;
interface OmpRequest {
	[requestTag]: true;
	sessionId: string;
}
interface RoutedRequest extends OmpRequest {
	[routeTag]: Start;
}

function isRequest(value: unknown): value is OmpRequest {
	return (
		typeof value === "object" &&
		value !== null &&
		requestTag in value &&
		value[requestTag] === true &&
		"sessionId" in value &&
		typeof value.sessionId === "string"
	);
}

function isRouted(value: unknown): value is RoutedRequest {
	return (
		isRequest(value) &&
		routeTag in value &&
		typeof value[routeTag] === "function"
	);
}

type OmpStreamSimple = NonNullable<OmpProviderConfig["streamSimple"]>;

// This dispatcher must not close over an extension's LocalSession: OMP's
// custom API registration is process-wide, but onPayload belongs to the caller.
const streamSimple: OmpStreamSimple = (model, context, options) => {
	const stream = createChappieStream(async (output) => {
		const sessionId = options?.sessionId;
		if (!sessionId || !options?.onPayload) {
			throw new Error(
				"Chappie requires an OMP session request hook; auxiliary model requests are not supported.",
			);
		}
		// installOmp's context hook deliberately removes native model prompts.
		// A helper can reuse the session ID/hook, but must not consume its tools.
		if (
			typeof context !== "object" ||
			context === null ||
			!("messages" in context) ||
			!Array.isArray(context.messages) ||
			context.messages.length !== 0
		) {
			throw new Error(
				"Chappie cannot answer auxiliary model prompts; use the ChatGPT-controlled session instead.",
			);
		}
		const payload: OmpRequest = { [requestTag]: true, sessionId };
		const routed = await options.onPayload(payload, model, options.signal);
		if (output.closed) return;
		if (!isRouted(routed) || routed.sessionId !== sessionId) {
			throw new Error(
				`Chappie has no owning OMP session for request ${sessionId}; auxiliary model requests are not supported.`,
			);
		}
		await routed[routeTag](output, sessionId);
	});
	// OMP rewrites the Pi AI import to its own event-stream implementation.
	// The private stream classes are nominally distinct at type-check time.
	return stream(
		model,
		context,
		options,
	) as unknown as OmpAssistantMessageEventStream;
};

export function createOmpChappieProvider(
	start: Start,
	api: Pick<OmpExtensionAPI, "on">,
): OmpProviderConfig {
	let disposed = false;
	api.on("session_shutdown", () => {
		disposed = true;
	});
	api.on("before_provider_request", (event, context) => {
		const request = event.payload;
		if (!isRequest(request)) return;
		const ownsRequest = () =>
			!disposed &&
			context.model?.provider === CHAPPIE_API &&
			context.sessionManager.getSessionId() === request.sessionId;
		if (!ownsRequest()) return;
		const routed: RoutedRequest = {
			...request,
			[routeTag]: async (output, sessionId) => {
				// Hooks may await while the owner changes model/session or shuts down.
				if (!ownsRequest() || sessionId !== request.sessionId)
					throw new Error("Chappie's owning OMP session is no longer active");
				await start(output, sessionId);
			},
		};
		return routed;
	});

	return {
		// OMP validates custom providers as HTTP endpoints. These sentinel values
		// satisfy registration; the local stream never uses them for network I/O.
		baseUrl: CHAPPIE_LOCAL_BASE_URL,
		apiKey: CHAPPIE_LOCAL_API_KEY,
		api: CHAPPIE_API,
		streamSimple,
		models: [
			{
				id: "chatgpt",
				name: "ChatGPT",
				api: CHAPPIE_API,
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000_000,
				maxTokens: 1_000_000_000,
			},
		],
	};
}
