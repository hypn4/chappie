import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type {
	ExtensionAPI as OmpExtensionAPI,
	ExtensionContext as OmpExtensionContext,
	ToolInfo as OmpToolInfo,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { Broker } from "../../src/broker.ts";
import { ProviderOutput } from "../../src/provider-core.ts";
import { createOmpHostApi, LocalSession } from "../../src/session.ts";
import { until } from "./async.ts";

function fixtureWireSchema(tool: OmpToolInfo): Record<string, unknown> {
	const parameters = tool.parameters;
	if (
		!parameters ||
		typeof parameters !== "object" ||
		Array.isArray(parameters)
	)
		throw new Error("Fixture tool schema must be an object");
	return Object.fromEntries(Object.entries(parameters));
}

export async function multiSessionFixture(
	t: TestContext,
	ids = ["A", "B"],
	localTools = false,
) {
	const root = await mkdtemp(
		join(process.platform === "win32" ? tmpdir() : "/tmp", "chmulti-"),
	);
	if (localTools)
		await writeFile(
			join(root, "chappie.json"),
			JSON.stringify({ localTools: true }),
		);
	const broker = new Broker(root);
	const controller = new AbortController();
	const timers: NodeJS.Timeout[] = [];
	const locals: LocalSession[] = [];
	const sessions = new Map<
		string,
		{
			id: string;
			cwd: string;
			local: LocalSession;
			context: OmpExtensionContext;
			branch: unknown[];
			emit(
				name: string,
				event: unknown,
				context?: OmpExtensionContext,
			): Promise<unknown>;
			wakes(): number;
		}
	>();
	t.after(async () => {
		controller.abort(new Error("fixture cleanup"));
		for (const timer of timers) clearInterval(timer);
		for (const local of locals) local.close();
		await broker.close();
		await rm(root, { recursive: true, force: true });
	});
	await broker.start();
	for (const id of ids) {
		const cwd = join(root, id);
		await mkdir(cwd, { recursive: true });
		const handlers = new Map<
			string,
			(event: unknown, context: OmpExtensionContext) => unknown
		>();
		const branch: unknown[] = [];
		let wakes = 0;
		const api = {
			on(
				name: string,
				handler: (event: unknown, context: OmpExtensionContext) => unknown,
			) {
				handlers.set(name, handler);
			},
			appendEntry() {},
			getSessionName: () => id,
			getActiveTools: () => ["read"],
			getAllTools: () => [
				{
					name: "read",
					description: "fixture read",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					},
				},
			],
			getCommands: () => [],
			sendMessage() {
				wakes++;
			},
		} as unknown as OmpExtensionAPI;
		const context = {
			cwd,
			model: { provider: "chappie" },
			ui: { notify() {} },
			sessionManager: {
				getSessionId: () => id,
				getCwd: () => cwd,
				getLeafId: () => null,
				getLeafEntry: () => undefined,
				getEntry: () => undefined,
				getBranch: () => branch,
				onSessionNameChanged: () => () => {},
			},
			isIdle: () => true,
			abort() {},
			setInterval() {
				const timer = setInterval(() => {}, 100000);
				timer.unref();
				timers.push(timer);
				return timer;
			},
		} as unknown as OmpExtensionContext;
		const local = new LocalSession(
			createOmpHostApi(api, fixtureWireSchema),
			root,
			undefined,
			undefined,
			localTools,
		);
		locals.push(local);
		local.installOmp(api);
		const emit = async (
			name: string,
			event: unknown,
			ctx: OmpExtensionContext = context,
		) => await handlers.get(name)?.(event, ctx);
		await emit("session_start", {});
		await until(() => broker.listSessions(id).length === 1);
		sessions.set(id, {
			id,
			cwd,
			local,
			context,
			branch,
			emit,
			wakes: () => wakes,
		});
	}
	return {
		root,
		broker,
		controller,
		session(id: string) {
			const value = sessions.get(id);
			if (!value) throw new Error(`Unknown fixture session: ${id}`);
			return value;
		},
	};
}

export async function sessionFixture(t: TestContext) {
	const root = await mkdtemp(
		join(process.platform === "win32" ? tmpdir() : "/tmp", "chs-"),
	);
	const controller = new AbortController();
	const watchdog = setTimeout(
		() => controller.abort(new Error("fixture timeout")),
		8000,
	);
	const handlers = new Map<
		string,
		(event: unknown, context: OmpExtensionContext) => unknown
	>();
	const timers: NodeJS.Timeout[] = [];
	let probes = 0;
	let aborts = 0;
	let sessionName: string | undefined;
	let sessionNameChanged: (() => void) | undefined;
	const api = {
		on(
			name: string,
			handler: (event: unknown, context: OmpExtensionContext) => unknown,
		) {
			handlers.set(name, handler);
		},
		appendEntry() {},
		getSessionName() {
			return sessionName;
		},
		getActiveTools: () => ["read"],
		getAllTools: () => [
			{
				name: "read",
				description: "fixture",
				parameters: {
					type: "object",
					properties: { path: { type: "string" } },
				},
			},
		],
		getCommands: () => [],
		sendMessage() {},
	} as unknown as OmpExtensionAPI;
	function context(id: string): OmpExtensionContext {
		return {
			cwd: join(root, id),
			model: { provider: "chappie" },
			ui: { notify() {} },
			sessionManager: {
				getSessionId: () => id,
				getCwd: () => join(root, id),
				getLeafId: () => null,
				getLeafEntry: () => undefined,
				getEntry: () => undefined,
				getBranch: () => [],
				onSessionNameChanged(callback: () => void) {
					sessionNameChanged = callback;
					return () => {
						if (sessionNameChanged === callback) sessionNameChanged = undefined;
					};
				},
			},
			isIdle() {
				probes++;
				return false;
			},
			abort() {
				aborts++;
			},
			setInterval() {
				const timer = setInterval(() => {}, 100000);
				timer.unref();
				timers.push(timer);
				return timer;
			},
		} as unknown as OmpExtensionContext;
	}
	let current = context("A");
	let broker = new Broker(root);
	const local = new LocalSession(
		createOmpHostApi(api, fixtureWireSchema),
		root,
		undefined,
	);
	t.after(async () => {
		controller.abort(new Error("fixture cleanup"));
		for (const timer of timers) clearInterval(timer);
		local.close();
		await broker.close();
		clearTimeout(watchdog);
		await delay(10);
		await rm(root, { recursive: true, force: true });
	});
	async function emit(name: string, event: unknown, ctx = current) {
		return await handlers.get(name)?.(event, ctx);
	}
	await broker.start();
	local.installOmp(api);
	await emit("session_start", {});
	await until(() => broker.listSessions().length === 1);
	await broker.initialize(
		"test-chat",
		"A",
		"initialization",
		controller.signal,
	);
	return {
		root,
		api,
		local,
		controller,
		context,
		emit,
		get broker() {
			return broker;
		},
		get current() {
			return current;
		},
		get aborts() {
			return aborts;
		},
		get intervalCount() {
			return timers.length;
		},
		setSessionName(value: string | undefined) {
			sessionName = value;
			sessionNameChanged?.();
		},
		async queue(
			requestId = "request-A",
			calls = [{ name: "read", arguments: { path: "test.txt" } }],
		) {
			const prior = probes;
			const pending = broker
				.call(
					"test-chat",
					current.sessionManager.getSessionId(),
					calls,
					requestId,
					controller.signal,
				)
				.then(
					(result) => ({ result }),
					(error) => ({ error: String(error) }),
				);
			await until(() => probes > prior);
			return { pending };
		},
		async dispatch() {
			const output = new ProviderOutput(
				{ api: "chappie", provider: "chappie", id: "chatgpt" },
				controller.signal,
			);
			await local.start(output);
			return output;
		},
		async complete(output: ProviderOutput, ctx = current) {
			const call = output.message.content.find(
				(block) => block.type === "toolCall",
			);
			if (call?.type !== "toolCall") throw new Error("Fixture expected a call");
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: "completed" }],
				isError: false,
				timestamp: Date.now(),
			};
			await emit(
				"turn_end",
				{ message: structuredClone(output.message), toolResults: [result] },
				ctx,
			);
			await emit("agent_end", { willContinue: false }, ctx);
		},
		async switchTo(id: string) {
			current = context(id);
			await emit("session_switch", {});
			await until(() =>
				broker.listSessions().some((session) => session.id === id),
			);
		},
		async reconnect() {
			await broker.close();
			await delay(30);
			broker = new Broker(root);
			await broker.start();
			await until(() => broker.listSessions().length === 1);
		},
	};
}
