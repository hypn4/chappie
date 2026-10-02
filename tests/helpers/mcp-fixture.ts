import type { TestContext } from "node:test";
import type { Broker } from "../../src/broker.ts";
import { mcpClient, resultOf } from "./mcp-client.ts";

export async function mcpFixture(
	t: TestContext,
	overrides: Partial<Broker> = {},
) {
	let acknowledgements = 0;
	// Only the broker boundary is substituted; the real MCP server/transport path runs.
	const broker = {
		askEnabled: false,
		binding: () => "A",
		listSessions: () => [
			{
				id: "A",
				cwd: "/fixture",
				device: "test",
				host: "omp",
				status: "idle",
				bindingCount: 1,
			},
		],
		inputs: async () => [],
		deliveries: () => [],
		answers: () => [],
		acknowledge: async () => {
			acknowledgements++;
		},
		...overrides,
	} satisfies Partial<Broker>;
	const client = mcpClient(t, broker as Broker);
	await client.request("server/discover");
	return {
		request: async (method: string, params: Record<string, unknown> = {}) =>
			resultOf(await client.request(method, params)),
		call: async (name: string, args: Record<string, unknown> = {}) =>
			resultOf(await client.call(name, args)),
		get acknowledgements() {
			return acknowledgements;
		},
	};
}
