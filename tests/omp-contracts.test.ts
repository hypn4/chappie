import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	ExtensionAPI as OmpExtensionAPI,
	ToolInfo as OmpToolInfo,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { directHostCall, serializableTool } from "../src/host-tools.ts";
import { resolveOmpAgentDir } from "../src/omp-agent-dir.ts";
import { createOmpHostApi } from "../src/session.ts";
import { directTools } from "../src/tools.ts";
import { sessionFixture } from "./helpers/session-fixture.ts";

const schema = {
	type: "object",
	properties: { path: { type: "string" } },
	required: ["path"],
};

function legacyWireSchema(tool: OmpToolInfo): Record<string, unknown> {
	const normalized = serializableTool({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.promptGuidelines
			? { promptGuidelines: tool.promptGuidelines }
			: {}),
		sourceInfo: tool.sourceInfo,
	});
	if (normalized.schemaError) throw new Error(normalized.schemaError);
	const parameters = normalized.parameters;
	if (
		!parameters ||
		typeof parameters !== "object" ||
		Array.isArray(parameters)
	)
		throw new Error("Native parameter schema is not an object");
	return Object.fromEntries(Object.entries(parameters));
}

test("callable OMP parameter types survive the JSON boundary", () => {
	const parameters = Object.assign(() => undefined, {
		toJsonSchema: () => schema,
	});
	const api = createOmpHostApi(
		{
			getAllTools: () => [{ name: "read", description: "read", parameters }],
		} as unknown as OmpExtensionAPI,
		legacyWireSchema,
	);
	const serialized = JSON.parse(JSON.stringify(api.getAllTools()));
	assert.deepEqual(serialized[0].parameters, schema);
});

test("unsupported schema representations are explicitly diagnosed", () => {
	const api = createOmpHostApi(
		{
			getAllTools: () => [{ name: "unknown", description: "unknown" }],
		} as unknown as OmpExtensionAPI,
		legacyWireSchema,
	);
	const serialized = JSON.parse(JSON.stringify(api.getAllTools()));
	assert.match(serialized[0].schemaError ?? "", /schema/i);
});

test("OMP native schemas use the injected official wire normalization", () => {
	let calls = 0;
	const api = createOmpHostApi(
		{
			getAllTools: () => [
				{
					name: "lookup",
					description: "lookup",
					parameters: {
						type: "object",
						definitions: { Value: { type: "string" } },
						properties: { value: { $ref: "#/definitions/Value" } },
					},
				},
			],
		} as unknown as OmpExtensionAPI,
		() => {
			calls++;
			return {
				type: "object",
				$defs: { Value: { type: "string" } },
				properties: { value: { $ref: "#/$defs/Value" } },
			};
		},
	);
	const parameters = api.getAllTools()[0]?.parameters as Record<
		string,
		unknown
	>;
	assert.equal(calls, 1);
	assert.equal(parameters.definitions, undefined);
	assert.deepEqual(parameters.$defs, { Value: { type: "string" } });
	assert.deepEqual((parameters.properties as Record<string, unknown>).value, {
		$ref: "#/$defs/Value",
	});
});

test("ordinary profile prefixes are not Windows device names", () => {
	for (const profile of [
		"console",
		"auxiliary",
		"com1-tools",
		"com10",
		"nullish",
	])
		assert.doesNotThrow(() =>
			resolveOmpAgentDir({ OMP_PROFILE: profile }, "/home/test"),
		);
	for (const profile of ["con", "con.txt", "nul", "lpt1", "lpt1.log"])
		assert.throws(() =>
			resolveOmpAgentDir({ OMP_PROFILE: profile }, "/home/test"),
		);
});

test("direct edit describes the native OMP patch contract", () => {
	const edit = directTools.find((tool) => tool.name === "edit");
	assert.match(edit?.description ?? "", /OMP.*patch/);
});

test("direct OMP read ranges reach the native provider without being ignored", async (t) => {
	const f = await sessionFixture(t);
	const pending = f.broker.call(
		"test-chat",
		"A",
		[{ name: "read", arguments: { path: "test.txt", offset: 6, limit: 1 } }],
		"direct-read",
		f.controller.signal,
		true,
	);
	const output = await f.dispatch();
	const call = output.message.content.find(
		(block) => block.type === "toolCall",
	);
	assert.equal(call?.type, "toolCall");
	if (call?.type !== "toolCall") throw new Error("missing call");
	assert.deepEqual(call.arguments, { path: "test.txt:6+1" });
	await f.complete(output);
	await pending;
});

test("native hashline patches retain anchors and Pi replacements stay Pi-only", () => {
	const patch = "[file.ts#1234]\nPUT 2.=2:\n+replacement";
	const call = { name: "edit", arguments: { patch } };
	assert.deepEqual(directHostCall("omp", call), call);
	assert.throws(() => directHostCall("pi", call), /Pi edit/);
	assert.throws(
		() =>
			directHostCall("omp", {
				name: "edit",
				arguments: { path: "file.ts", edits: [] },
			}),
		/native patch/,
	);
	assert.throws(
		() =>
			directHostCall("omp", {
				name: "read",
				arguments: { path: "file.ts:2-5", offset: 6 },
			}),
		/either/,
	);
});

test("OMP-expanded read previews are trimmed to the requested direct range", async (t) => {
	const f = await sessionFixture(t);
	const pending = f.broker.call(
		"test-chat",
		"A",
		[{ name: "read", arguments: { path: "file.txt", offset: 2, limit: 1 } }],
		"preview-range",
		f.controller.signal,
		true,
	);
	const output = await f.dispatch();
	const call = output.message.content.find(
		(block) => block.type === "toolCall",
	);
	if (!call) throw new Error("missing call");
	await f.emit("turn_end", {
		message: structuredClone(output.message),
		toolResults: [
			{
				role: "toolResult",
				toolCallId: call.id,
				toolName: "read",
				isError: false,
				timestamp: 1,
				content: [
					{ type: "text", text: "[file.txt#1234]\n1:Alpha\n2:Beta\n3:Gamma" },
				],
				details: {
					displayContent: {
						text: "Alpha\nBeta\nGamma",
						startLine: 1,
						lineNumbers: [1, 2, 3],
					},
					totalLines: 3,
				},
			},
		],
	});
	await f.emit("agent_end", { willContinue: false });
	const result = await pending;
	const text = JSON.stringify(result.toolResults[0]?.content);
	assert.match(text, /Beta/);
	assert.doesNotMatch(text, /Alpha|Gamma/);
	assert.match(text, /file.txt#1234/);
});

test("direct OMP patch uses the native schema field without changing its text", () => {
	const result = directHostCall(
		"omp",
		{ name: "edit", arguments: { patch: "native-patch" } },
		{
			name: "edit",
			description: "native",
			parameters: {
				type: "object",
				properties: { input: { type: "string" } },
				required: ["input"],
			},
		},
	);
	assert.deepEqual(result.arguments, { input: "native-patch" });
});
