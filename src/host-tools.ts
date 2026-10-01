import type { ToolCall } from "@earendil-works/pi-ai";
import * as z from "zod";
import type { SessionToolInfo, SessionToolResult } from "./ipc.ts";
import type { ToolInput } from "./tools.ts";

/** Normalize native schema objects before JSON.stringify can erase callable types. */
export function serializableTool(tool: SessionToolInfo): SessionToolInfo {
	try {
		const original = tool.parameters;
		if (
			!original ||
			(typeof original !== "object" && typeof original !== "function")
		)
			throw new Error("Missing native parameter schema");
		const schema = original as {
			toJsonSchema?: () => unknown;
			toJSONSchema?: () => unknown;
			"~standard"?: {
				jsonSchema?: { input(options: { target: string }): unknown };
			};
		};
		let value: unknown;
		if (typeof schema["~standard"]?.jsonSchema?.input === "function")
			value = schema["~standard"].jsonSchema.input({ target: "draft-07" });
		else if (typeof schema.toJsonSchema === "function")
			value = schema.toJsonSchema();
		else if (typeof schema.toJSONSchema === "function")
			value = schema.toJSONSchema();
		else if ("_zod" in original)
			value = z.toJSONSchema(original as z.ZodType, { io: "input" });
		else value = original;
		const json = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
		if (
			!json ||
			typeof json !== "object" ||
			Array.isArray(json) ||
			!(json.type || json.anyOf || json.oneOf || json.$ref)
		)
			throw new Error("Native parameter schema is not JSON Schema");
		return { ...tool, parameters: json };
	} catch (error) {
		return {
			...tool,
			parameters: undefined,
			schemaError: `Cannot expose native tool schema: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** Adapt only the documented direct MCP contract; generic call stays native. */
export function directHostCall(
	host: "pi" | "omp",
	call: ToolInput,
	nativeTool?: SessionToolInfo,
): ToolInput {
	const args = call.arguments;
	if (call.name === "edit") {
		if (host === "omp" && typeof args.patch !== "string")
			throw new Error(
				"OMP edit requires its native patch input. Read the file and use the returned snapshot anchors; exact-text edits are not converted.",
			);
		if (host === "pi" && args.patch !== undefined)
			throw new Error(
				"Pi edit requires path and edits; native patch input is OMP-only",
			);
		if (host === "omp" && nativeTool) {
			const schema = serializableTool(nativeTool);
			if (schema.schemaError) throw new Error(schema.schemaError);
			const properties = (
				schema.parameters as { properties?: Record<string, unknown> }
			).properties;
			if (properties?.input && !properties.patch) {
				if (typeof args.patch !== "string")
					throw new Error("OMP edit requires its native patch input");
				return { ...call, arguments: { input: args.patch } };
			}
			if (!properties?.patch)
				throw new Error(
					"This OMP edit mode requires native arguments; use tools and call",
				);
		}
		return call;
	}
	if (
		host !== "omp" ||
		call.name !== "read" ||
		(args.offset === undefined && args.limit === undefined)
	)
		return call;
	if (typeof args.path !== "string")
		throw new Error("read.path must be a string");
	const offset = args.offset ?? 1;
	const limit = args.limit;
	if (
		!Number.isSafeInteger(offset) ||
		(offset as number) < 1 ||
		(limit !== undefined &&
			(!Number.isSafeInteger(limit) || (limit as number) < 1))
	)
		throw new Error("Read offset and limit must be positive integers");
	if (/:(?:raw|img|\d+(?:[-+,]\d*)?)$/.test(args.path))
		throw new Error(
			"Use either a native path selector or offset/limit, not both",
		);
	return {
		...call,
		arguments: {
			path: `${args.path}:${offset}${limit === undefined ? "-" : `+${limit}`}`,
		},
	};
}

/** OMP may expand small-file previews; keep the direct read range exact. */
export function directHostResults(
	calls: ToolCall[],
	results: SessionToolResult[],
): SessionToolResult[] {
	return results.map((result) => {
		const call = calls.find(
			(call) => call.id === result.toolCallId && call.name === "read",
		);
		if (!call || result.isError || typeof call.arguments.path !== "string")
			return result;
		const selected = /:(\d+)(?:\+(\d+)|-)$/.exec(call.arguments.path);
		if (!selected) return result;
		const first = Number(selected[1]);
		const last = selected[2] ? first + Number(selected[2]) - 1 : Infinity;
		const details = result.details as
			| {
					displayContent?: {
						text?: unknown;
						lineNumbers?: unknown;
						startLine?: unknown;
					};
			  }
			| undefined;
		const display = details?.displayContent;
		if (
			typeof display?.text !== "string" ||
			!Array.isArray(display.lineNumbers) ||
			!display.lineNumbers.every((n) => Number.isSafeInteger(n) && n > 0)
		) {
			return {
				...result,
				isError: true,
				content: [
					{
						type: "text",
						text: "Cannot verify the direct read range for this native result. Use native read through tools/call.",
					},
				],
			};
		}
		const lines = display.text.split(/\r?\n/);
		const rows = (display.lineNumbers as number[]).flatMap((number, index) =>
			number >= first && number <= last
				? [{ number, text: lines[index] ?? "" }]
				: [],
		);
		const header = result.content
			.flatMap((block) =>
				block.type === "text"
					? [block.text.match(/^\[[^\]\n]+#[a-fA-F0-9]+\]/)?.[0]]
					: [],
			)
			.find(Boolean);
		const text = [header, ...rows.map((row) => `${row.number}:${row.text}`)]
			.filter((value) => value !== undefined)
			.join("\n");
		return {
			...result,
			content: [{ type: "text", text }],
			details: {
				...details,
				displayContent: {
					...display,
					text: rows.map((row) => row.text).join("\n"),
					startLine: rows[0]?.number ?? first,
					lineNumbers: rows.map((row) => row.number),
				},
			},
		};
	});
}
