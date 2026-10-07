import type { ToolCall } from "@oh-my-pi/pi-ai";
import * as z from "zod";
import { uuidV7 } from "./ids.ts";
import type { ToolInput } from "./tools.ts";

// Only the transport envelope belongs to Chappie. Each tool's arguments are
// defined and validated by the active OMP tool, never a broker-side replica.
export const nativeCallSchema = z.strictObject({
	name: z.string().min(1).max(4096),
	arguments: z.record(z.string(), z.json()),
});
export const nativeCallsSchema = z.array(nativeCallSchema).min(1).max(128);

export function validateNativeCalls(
	calls: unknown,
	hostTransfer = false,
): ToolInput[] {
	const parsed = nativeCallsSchema.parse(calls);
	if (hostTransfer && (parsed.length !== 1 || parsed[0]?.name !== "transfer"))
		throw new Error(
			"The host transfer boundary accepts exactly one transfer call",
		);
	if (!hostTransfer && hasHostFileImport(parsed))
		throw new Error("Host file imports require the direct transfer tool");
	return parsed;
}

export function hasHostFileImport(calls: readonly ToolInput[]): boolean {
	return calls.some(
		(call) => call.name === "transfer" && Array.isArray(call.arguments.files),
	);
}

export function nativeToolCalls(calls: readonly ToolInput[]): ToolCall[] {
	return calls.map(({ name, arguments: args }) => ({
		type: "toolCall",
		id: `chappie-${uuidV7()}`,
		name,
		arguments: args,
	}));
}
