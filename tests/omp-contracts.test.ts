import assert from "node:assert/strict";
import { test } from "node:test";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import * as z from "zod";
import { createOmpHostApi } from "../src/session.ts";
import { directTools } from "../src/tools.ts";
import { sessionFixture } from "./helpers/session-fixture.ts";

test("OMP schemas are serialized by the official wire API", () => {
	const parameters = z.toJSONSchema(z.strictObject({ path: z.string() }), {
		io: "input",
	});
	const api = createOmpHostApi(
		{
			getAllTools: () => [{ name: "read", description: "read", parameters }],
		} as unknown as ExtensionAPI,
		toolWireSchema,
	);
	const tool = api.getAllTools()[0];
	assert.ok(tool && !tool.schemaError);
	const schema = JSON.parse(JSON.stringify(tool.parameters));
	assert.equal(schema.type, "object");
	assert.deepEqual(schema.required, ["path"]);
	assert.equal(schema.properties.path.type, "string");
});

test("wire conversion failures stay explicit and never silently erase a tool schema", () => {
	const api = createOmpHostApi(
		{
			getAllTools: () => [{ name: "unsupported", description: "unsupported" }],
		} as unknown as ExtensionAPI,
		() => {
			throw new Error("Unsupported native schema");
		},
	);
	assert.match(
		api.getAllTools()[0]?.schemaError ?? "",
		/Unsupported native schema/,
	);
});

test("direct tools expose current native read and edit input without aliases", () => {
	const read = directTools.find((tool) => tool.name === "read");
	const edit = directTools.find((tool) => tool.name === "edit");
	assert.ok(read && edit);
	const readSchema = z.toJSONSchema(read.inputSchema);
	const editSchema = z.toJSONSchema(edit.inputSchema);
	assert.deepEqual(readSchema.required, ["path"]);
	assert.deepEqual(editSchema.required, ["input"]);
	assert.equal(readSchema.properties?.offset, undefined);
	assert.equal(readSchema.properties?.limit, undefined);
	assert.equal(editSchema.properties?.patch, undefined);
	assert.equal(editSchema.properties?.edits, undefined);
});

test("native read selectors reach OMP unchanged", async (t) => {
	const f = await sessionFixture(t);
	const pending = f.broker.call(
		"test-chat",
		"A",
		[{ name: "read", arguments: { path: "test.txt:6+1" } }],
		"native-selector",
		f.controller.signal,
		true,
	);
	const output = await f.dispatch();
	const call = output.message.content.find(
		(block) => block.type === "toolCall",
	);
	assert.ok(call?.type === "toolCall");
	assert.deepEqual(call.arguments, { path: "test.txt:6+1" });
	await f.complete(output);
	await pending;
});

test("a missing native observer remains rejected on repeated lifecycle events", async (t) => {
	const f = await sessionFixture(t);
	const unsupported = {
		...f.current,
		sessionManager: {
			...f.current.sessionManager,
			onSessionNameChanged: undefined,
		},
	};
	for (let attempt = 0; attempt < 2; attempt++) {
		await assert.rejects(
			f.emit("session_start", {}, unsupported),
			/must support name-change subscriptions/,
		);
	}
});
