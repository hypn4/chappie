import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import type {
	ExtensionAPI as OmpExtensionAPI,
	ExtensionContext as OmpExtensionContext,
	ProviderConfig as OmpProviderConfig,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { createOmpChappieProvider } from "../src/provider.omp.ts";
import type { ProviderOutput } from "../src/provider-core.ts";

// Routing tests need only the provider/id fields consumed by Chappie.
const model = {
	api: "chappie",
	provider: "chappie",
	id: "chatgpt",
} as unknown as Model<Api>;

// Session-scoped request hooks, with a process-wide last-registered provider.
// These are callback fixtures, not agents or model calls.
function owner(
	id: string,
	start?: (output: ProviderOutput) => Promise<void>,
	generate?: (output: ProviderOutput, kind: string) => Promise<void>,
) {
	let currentId = id;
	let provider = "chappie";
	const handlers = new Map<
		string,
		Array<(event: unknown, ctx: OmpExtensionContext) => unknown>
	>();
	const context = {
		get model() {
			return { provider };
		},
		sessionManager: { getSessionId: () => currentId },
	} as unknown as OmpExtensionContext;
	const api = {
		on(
			name: string,
			handler: (event: unknown, ctx: OmpExtensionContext) => unknown,
		) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
	} as unknown as OmpExtensionAPI;
	const starts: string[] = [];
	const config = createOmpChappieProvider(
		async (output) => {
			starts.push(currentId);
			if (start) return start(output);
			output.text(currentId);
			output.done();
		},
		async (output, request) => {
			if (generate) return generate(output, request.kind);
			throw new Error("unexpected generation");
		},
		api,
	);
	async function emit(name: string, event: unknown) {
		for (const handler of handlers.get(name) ?? [])
			await handler(event, context);
	}
	async function onPayload(payload: unknown) {
		let result = payload;
		for (const handler of handlers.get("before_provider_request") ?? []) {
			const next = await handler(
				{ type: "before_provider_request", payload: result },
				context,
			);
			if (next !== undefined) result = next;
		}
		return result;
	}
	return {
		config,
		starts,
		emit,
		onPayload,
		options: () => ({ sessionId: currentId, onPayload }),
		switchTo(value: string) {
			currentId = value;
		},
		setProvider(value: string) {
			provider = value;
		},
	};
}

async function result(
	config: OmpProviderConfig,
	options?: SimpleStreamOptions,
	context: Context = { messages: [] },
) {
	const stream = config.streamSimple?.(model, context, options);
	assert.ok(stream);
	// The adapter returns the shared Pi/OMP event stream implementation.
	const events = stream as unknown as AssistantMessageEventStream;
	return await events.result();
}

test("the latest provider registration routes each request through its owning session hook", async () => {
	const a = owner("A");
	const b = owner("B");
	const latest = b.config;
	for (const target of [a, b, a]) {
		const reply = await result(latest, target.options());
		assert.equal(reply.stopReason, "stop");
	}
	assert.deepEqual(a.starts, ["A", "A"]);
	assert.deepEqual(b.starts, ["B"]);
});

test("auxiliary requests cannot claim an owner even while its slot is empty", async () => {
	const a = owner("A");
	for (const options of [
		undefined,
		{},
		{ sessionId: "A" },
		{ sessionId: "label", onPayload: a.onPayload },
		{ onPayload: a.onPayload },
	]) {
		const reply = await result(a.config, options);
		assert.equal(reply.stopReason, "error");
		assert.match(reply.errorMessage ?? "", /session|auxiliary|request hook/i);
	}
	assert.deepEqual(a.starts, []);
	assert.equal((await result(a.config, a.options())).stopReason, "stop");
});

test("shutdown of the last registration leaves a surviving owner routable", async () => {
	const a = owner("A");
	const b = owner("B");
	await b.emit("session_shutdown", {});
	assert.equal((await result(b.config, b.options())).stopReason, "error");
	assert.equal((await result(b.config, a.options())).stopReason, "stop");
	assert.deepEqual(b.starts, []);
	assert.deepEqual(a.starts, ["A"]);
});

test("session switches reject stale identities without falling back to another owner", async () => {
	const a = owner("A");
	const stale = a.options();
	a.switchTo("C");
	assert.equal((await result(a.config, stale)).stopReason, "error");
	assert.equal((await result(a.config, a.options())).stopReason, "stop");
	assert.deepEqual(a.starts, ["C"]);
});

test("shutdown or a model change while request hooks await cannot start a stale owner", async () => {
	for (const invalidate of ["shutdown", "model", "session"] as const) {
		const a = owner("A");
		const options = a.options();
		options.onPayload = async (payload: unknown) => {
			const routed = await a.onPayload(payload);
			if (invalidate === "shutdown") await a.emit("session_shutdown", {});
			else if (invalidate === "model") a.setProvider("other");
			else a.switchTo("C");
			return routed;
		};
		assert.equal(
			(await result(a.config, options)).stopReason,
			"error",
			invalidate,
		);
		assert.deepEqual(a.starts, [], invalidate);
	}
});

test("cancellation while a request hook awaits does not claim a provider slot", async () => {
	const a = owner("A");
	const controller = new AbortController();
	const options = {
		...a.options(),
		signal: controller.signal,
		onPayload: async (payload: unknown) => {
			const routed = await a.onPayload(payload);
			controller.abort();
			return routed;
		},
	};
	assert.equal((await result(a.config, options)).stopReason, "aborted");
	assert.deepEqual(a.starts, []);
});

test("stale or cancelled compaction routes never start a generation owner", async () => {
	for (const invalidate of [
		"shutdown",
		"model",
		"session",
		"cancel",
	] as const) {
		let generations = 0;
		const a = owner("A", undefined, async (output) => {
			generations++;
			output.text("summary");
			output.done();
		});
		const controller = new AbortController();
		const options: SimpleStreamOptions = {
			...a.options(),
			signal: controller.signal,
			codexCompaction: {} as NonNullable<
				SimpleStreamOptions["codexCompaction"]
			>,
		};
		options.onPayload = async (payload: unknown) => {
			const routed = await a.onPayload(payload);
			if (invalidate === "shutdown") await a.emit("session_shutdown", {});
			else if (invalidate === "model") a.setProvider("other");
			else if (invalidate === "session") a.switchTo("C");
			else controller.abort();
			return routed;
		};
		const reply = await result(a.config, options, {
			messages: [{ role: "user", content: "compact", timestamp: Date.now() }],
		});
		assert.ok(
			reply.stopReason === "error" || reply.stopReason === "aborted",
			invalidate,
		);
		assert.equal(generations, 0, invalidate);
	}
});

test("an auxiliary error cannot replace an open primary request", async () => {
	const entered = Promise.withResolvers<void>();
	let primary: ProviderOutput | undefined;
	const a = owner("A", async (output) => {
		if (primary) {
			output.done();
			return;
		}
		primary = output;
		entered.resolve();
		await output.finished;
	});
	const pending = result(a.config, a.options());
	try {
		await entered.promise;
		assert.equal(
			(await result(a.config, { sessionId: "label", onPayload: a.onPayload }))
				.stopReason,
			"error",
		);
		assert.equal(primary?.closed, false);
		assert.deepEqual(a.starts, ["A"]);
	} finally {
		primary?.done();
		await pending;
	}
});

test("auxiliary prompts sharing a session hook cannot be mistaken for a native turn", async () => {
	const a = owner("A");
	const reply = await result(a.config, a.options(), {
		messages: [
			{ role: "user", content: "Summarize a label", timestamp: Date.now() },
		],
	});
	assert.equal(reply.stopReason, "error");
	assert.match(reply.errorMessage ?? "", /auxiliary/i);
	assert.deepEqual(a.starts, []);
});

test("separately loaded provider modules still use the caller's hook", async () => {
	const a = owner("A");
	const duplicate: typeof import("../src/provider.omp.ts") = await import(
		new URL("../src/provider.omp.ts?isolated-copy", import.meta.url).href
	);
	const foreign = duplicate.createOmpChappieProvider(
		async () => {
			throw new Error("wrong owner");
		},
		async () => {
			throw new Error("wrong generation owner");
		},
		{ on() {} },
	);
	assert.equal((await result(foreign, a.options())).stopReason, "stop");
	assert.deepEqual(a.starts, ["A"]);
});

test("unrelated provider payloads are not modified by the Chappie hook", async () => {
	const a = owner("A");
	const payload = {
		model: "unrelated",
		messages: [{ role: "user", content: "hello" }],
	};
	assert.equal(await a.onPayload(payload), payload);
	assert.deepEqual(a.starts, []);
});

test("recognized compaction requests use a separate generation route", async () => {
	const handlers = new Map<
		string,
		Array<(event: unknown, ctx: OmpExtensionContext) => unknown>
	>();
	const context = {
		model: { provider: "chappie" },
		sessionManager: { getSessionId: () => "A" },
	} as unknown as OmpExtensionContext;
	const api = {
		on(
			name: string,
			handler: (event: unknown, ctx: OmpExtensionContext) => unknown,
		) {
			const values = handlers.get(name) ?? [];
			values.push(handler);
			handlers.set(name, values);
		},
	} as unknown as OmpExtensionAPI;
	const generations: string[] = [];
	const onPayload = async (payload: unknown) => {
		let value = payload;
		for (const handler of handlers.get("before_provider_request") ?? []) {
			const next = await handler(
				{ type: "before_provider_request", payload: value },
				context,
			);
			if (next !== undefined) value = next;
		}
		return value;
	};
	const config = Reflect.apply(createOmpChappieProvider, undefined, [
		async () => {
			throw new Error("primary route must not run");
		},
		async (output: ProviderOutput, request: { kind: string }) => {
			generations.push(request.kind);
			output.text("summary");
			output.done();
		},
		api,
	]) as OmpProviderConfig;
	const reply = await result(
		config,
		{
			sessionId: "A",
			onPayload,
			codexCompaction: {} as NonNullable<
				SimpleStreamOptions["codexCompaction"]
			>,
		},
		{
			messages: [
				{ role: "user", content: "compact this", timestamp: Date.now() },
			],
		},
	);
	assert.equal(reply.stopReason, "stop");
	assert.deepEqual(generations, ["compaction"]);
});
