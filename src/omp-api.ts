import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionSkillInfo, SessionToolInfo } from "./ipc.ts";

export interface OmpSessionManager {
	getSessionId(): string;
	getCwd(): string;
	getLeafId(): string | null;
	getLeafEntry(): SessionEntry | undefined;
	getEntry(id: string): SessionEntry | undefined;
	getBranch(): SessionEntry[];
}

export interface OmpExtensionContext {
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
	readonly cwd: string;
	readonly model: { provider: string } | undefined;
	sessionManager: OmpSessionManager;
	isIdle(): boolean;
	abort(): void;
	setInterval(
		callback: (...args: unknown[]) => void,
		ms?: number,
		...args: unknown[]
	): ReturnType<typeof setInterval>;
}

interface OmpEventMap {
	session_start: unknown;
	session_switch: unknown;
	session_branch: unknown;
	session_tree: { newLeafId: string | null };
	message_start: unknown;
	tool_call: unknown;
	session_compact: unknown;
	context: { messages: Array<{ role: string; customType?: string }> };
	turn_end: { message: unknown; toolResults: ToolResultMessage[] };
	agent_end: { willContinue?: boolean };
	session_shutdown: unknown;
}

export interface OmpProviderConfig {
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	streamSimple?: (
		model: { api: string; provider: string; id: string },
		context: unknown,
		options?: { signal?: AbortSignal },
	) => unknown;
	models?: Array<{
		id: string;
		name: string;
		api?: string;
		reasoning: boolean;
		input: ("text" | "image")[];
		cost: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
		};
		contextWindow: number;
		maxTokens: number;
	}>;
}

export interface OmpToolDefinition<TArgs, TDetails> {
	name: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
	execute(
		toolCallId: string,
		args: TArgs,
		signal: AbortSignal | undefined,
		update:
			| ((result: { content: unknown[]; details: TDetails }) => void)
			| undefined,
		context: OmpExtensionContext,
	): Promise<{ content: unknown[]; details: TDetails }>;
}

export interface OmpExtensionAPI {
	on<Event extends keyof OmpEventMap>(
		event: Event,
		handler: (
			event: OmpEventMap[Event],
			context: OmpExtensionContext,
		) => unknown,
	): void;
	registerTool<TArgs, TDetails>(tool: OmpToolDefinition<TArgs, TDetails>): void;
	registerProvider(name: string, config: OmpProviderConfig): void;
	appendEntry(customType: string, data?: unknown): void;
	getSessionName(): string | undefined;
	getActiveTools(): string[];
	getAllTools(): SessionToolInfo[];
	getCommands(): SessionSkillInfo[];
	sendMessage(
		message: { customType: string; content: string; display: boolean },
		options?: { triggerTurn?: boolean },
	): void;
}
