import type { OmpProviderConfig } from "./omp-api.ts";
import { createChappieStream, type ProviderOutput } from "./provider-core.ts";

const CHAPPIE_API = "chappie";
const CHAPPIE_LOCAL_API_KEY = "chappie-local";
const CHAPPIE_LOCAL_BASE_URL = "http://127.0.0.1";

type OmpStreamSimple = NonNullable<OmpProviderConfig["streamSimple"]>;

export function createOmpChappieProvider(
	start: (output: ProviderOutput) => Promise<void>,
): OmpProviderConfig {
	const legacyStream = createChappieStream(start);
	const streamSimple: OmpStreamSimple = (model, context, options) => {
		const stream = legacyStream(
			{ api: model.api, provider: model.provider, id: model.id },
			context,
			options,
		);
		// SAFETY: OMP's extension loader rewrites @earendil-works/pi-ai to its
		// legacy-pi-ai shim, which re-exports OMP's own AssistantMessageEventStream.
		// The compile-time upstream type is different, but the runtime stream is the
		// exact OMP implementation expected by ProviderConfig.streamSimple.
		return stream;
	};

	return {
		// OMP currently validates custom runtime providers as if they use an HTTP
		// endpoint + API key. Chappie supplies its own streamSimple transport, so
		// these sentinel values satisfy registration and are never used for I/O.
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
