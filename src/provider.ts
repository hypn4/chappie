import { createProvider } from "@earendil-works/pi-ai";
import { createChappieStream, type ProviderOutput } from "./provider-core.ts";

export { ProviderOutput } from "./provider-core.ts";

export function createChappieProvider(
	start: (output: ProviderOutput) => Promise<void>,
) {
	const stream = createChappieStream(start);
	return createProvider({
		id: "chappie",
		name: "Chappie",
		auth: {
			apiKey: {
				name: "Local Chappie",
				async resolve() {
					return { auth: { headers: {} }, source: "local" };
				},
			},
		},
		models: [
			{
				id: "chatgpt",
				name: "ChatGPT",
				api: "chappie",
				provider: "chappie",
				baseUrl: "",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000_000,
				maxTokens: 1_000_000_000,
			},
		],
		api: { stream, streamSimple: stream },
	});
}
