import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, unlink } from "node:fs/promises";
import {
	createConnection,
	createServer,
	isIP,
	type Server,
	type Socket,
} from "node:net";
import { join, resolve } from "node:path";
import {
	connect as connectTls,
	createServer as createTlsServer,
} from "node:tls";
import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ToolCall,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import type { Activity } from "./activity.ts";
import type { NetworkTlsConfig } from "./config.ts";
import type { DeliveryRecord } from "./delivery.ts";
import type { HistoryRange, HistoryResult } from "./history.ts";
import { validateBrokerMessage, validateSessionMessage } from "./ipc-schema.ts";
import type { ResourceData, ResourceDescriptor } from "./resources.ts";
import type { TransferDetails } from "./transfer.ts";

const defaultPort = 24274;

export type SessionStatus = "idle" | "ready" | "executing";

export interface SessionDescription {
	host: "omp";
	agentDir?: string;
	id: string;
	cwd: string;
	device: string;
	name?: string;
	status: SessionStatus;
}

export interface SessionListItem extends SessionDescription {
	bindingCount: number;
}

export interface SessionToolInfo {
	name: string;
	description: string;
	parameters: unknown;
	schemaError?: string;
	promptGuidelines?: string[];
	sourceInfo?: unknown;
}

export interface SessionSkillInfo {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	sourceInfo?: unknown;
	location?: string;
	path?: string;
}

export interface SessionInspection {
	session: SessionDescription;
	tools: SessionToolInfo[];
	skills: SessionSkillInfo[];
}

export interface ModelRequest {
	kind: "compaction" | "branch_summary";
	input: unknown;
}

export type SessionInput = {
	id: string;
	sessionId: string;
} & ({ message: UserMessage } | { request: ModelRequest });

export interface SessionToolResult {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: unknown;
	isError: boolean;
	timestamp: number;
}

export type SessionResult =
	| { sessions: SessionListItem[] }
	| {
			inspection: SessionInspection;
			inputs: SessionInput[];
			globalAgents?: { path: string };
	  }
	| { message: AssistantMessage; cwd: string; inputs: SessionInput[] }
	| {
			message: AssistantMessage;
			cwd: string;
			toolResults: SessionToolResult[];
			inputs: SessionInput[];
	  }
	| { inputs: SessionInput[] }
	| { history: HistoryResult; cwd: string }
	| { resource: ResourceData }
	| { transfer: TransferDetails }
	| { error: string };

export type SessionRequest =
	| { type: "sessions"; sessionId?: string }
	| { type: "inspect"; sessionId: string }
	| { type: "inputs"; sessionId: string }
	| { type: "readResource"; sessionId: string; uri: string; offset?: number }
	| { type: "export"; sessionId: string; paths: string[] }
	| {
			type: "history";
			sessionId: string;
			range: HistoryRange;
			chatId: string;
			requestId?: string;
	  }
	| {
			type: "chat";
			sessionId: string;
			chatId: string;
			requestId?: string;
			operationKey?: string;
			text: string;
			replyTo?: string;
	  }
	| {
			type: "call";
			sessionId: string;
			chatId: string;
			requestId?: string;
			operationKey?: string;
			calls: ToolCall[];
			direct?: boolean;
	  }
	| {
			type: "copy";
			sessionId: string;
			resources: ResourceDescriptor[];
			paths: string[];
			overwrite?: boolean;
	  };

export type SessionMessage =
	| { type: "sync"; id: number; session: SessionDescription }
	| { type: "unregister"; sessionId: string }
	| { type: "delivery"; delivery: DeliveryRecord }
	| { type: "request"; id: number; request: SessionRequest }
	| { type: "cancelRequest"; id: number }
	| ({ type: "result"; id: number } & SessionResult);

export type BrokerMessage =
	| { type: "synced"; id: number; sessionId: string }
	| { type: "stored"; id: string }
	| { type: "notice"; sessionId: string; message: string; activity?: Activity }
	| {
			type: "history";
			id: number;
			sessionId: string;
			range: HistoryRange;
			chatId: string;
			requestId?: string;
			operationKey?: string;
	  }
	| {
			type: "chat";
			id: number;
			chatId: string;
			requestId?: string;
			operationKey?: string;
			sessionId: string;
			text: string;
			replyTo?: string;
	  }
	| {
			type: "call";
			id: number;
			chatId: string;
			requestId?: string;
			operationKey?: string;
			sessionId: string;
			calls: ToolCall[];
			direct?: boolean;
	  }
	| { type: "cancel"; id: number; sessionId: string; reason: string }
	| (SessionRequest & { id: number })
	| ({ type: "response"; id: number } & SessionResult)
	| { type: "ackInputs"; sessionId: string; ids: string[] };

export function ipcEndpoint(agentDir: string): string {
	const directory = resolve(agentDir);
	if (process.platform !== "win32") return join(directory, "chappie.sock");
	const identity = directory.replaceAll("\\", "/").toLowerCase();
	return String.raw`\\.\pipe\chappie-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

export interface PeerLimits {
	maxFrameBytes?: number;
	maxQueuedBytes?: number;
	maxQueuedMessages?: number;
}

export class JsonLinePeer<Incoming, Outgoing> {
	readonly #socket: Socket;
	readonly #onMessage: (message: Incoming) => Promise<void> | void;
	readonly #onClose: () => void;
	readonly #limits: Required<PeerLimits>;
	#queuedBytes = 0;
	#queuedMessages = 0;
	#buffer = "";
	#messages = Promise.resolve();
	#writes = Promise.resolve();
	#closed = false;

	constructor(
		socket: Socket,
		onMessage: (message: Incoming) => Promise<void> | void,
		onClose: () => void,
		limits: PeerLimits = {},
	) {
		this.#socket = socket;
		this.#limits = {
			maxFrameBytes: 64 * 1024 * 1024,
			maxQueuedBytes: 128 * 1024 * 1024,
			maxQueuedMessages: 256,
			...limits,
		};
		socket.setKeepAlive(true, 15000);
		this.#onMessage = onMessage;
		this.#onClose = onClose;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => this.#receive(chunk));
		socket.once("close", () => {
			this.#closed = true;
			this.#onClose();
		});
		socket.on("error", () => {});
	}

	get closed(): boolean {
		return this.#closed;
	}

	send(message: Outgoing): Promise<void> {
		const line = `${JSON.stringify(message)}\n`;
		if (Buffer.byteLength(line) > this.#limits.maxFrameBytes)
			return Promise.reject(new Error("IPC frame exceeds the size limit"));
		const sent = this.#writes.then(
			() =>
				new Promise<void>((resolveWrite, rejectWrite) => {
					if (this.#closed) {
						rejectWrite(new Error("Chappie IPC connection is closed"));
						return;
					}
					this.#socket.write(line, (error) => {
						if (error) rejectWrite(error);
						else resolveWrite();
					});
				}),
		);
		this.#writes = sent.catch(() => {});
		return sent;
	}

	close(): void {
		this.#closed = true;
		this.#socket.destroy();
	}

	#receive(chunk: string): void {
		if (this.#closed) return;
		this.#buffer += chunk;
		let end = this.#buffer.indexOf("\n");
		while (end !== -1) {
			const line = this.#buffer.slice(0, end);
			this.#buffer = this.#buffer.slice(end + 1);
			const bytes = Buffer.byteLength(line);
			if (
				bytes > this.#limits.maxFrameBytes ||
				this.#queuedBytes + bytes > this.#limits.maxQueuedBytes ||
				this.#queuedMessages >= this.#limits.maxQueuedMessages
			) {
				this.close();
				return;
			}
			if (line.length > 0) {
				this.#queuedBytes += bytes;
				this.#queuedMessages++;
				this.#messages = this.#messages
					.then(async () => {
						if (!this.#closed)
							await this.#onMessage(JSON.parse(line) as Incoming);
					})
					.catch(() => {
						this.close();
					})
					.finally(() => {
						this.#queuedBytes -= bytes;
						this.#queuedMessages--;
					});
			}
			end = this.#buffer.indexOf("\n");
		}
		if (Buffer.byteLength(this.#buffer) > this.#limits.maxFrameBytes)
			this.close();
	}
}

export class IpcServer {
	readonly #agentDir: string;
	readonly #endpoint: string;
	#socketIdentity: { dev: number; ino: number } | undefined;
	readonly #onMessage: (
		peer: JsonLinePeer<SessionMessage, BrokerMessage>,
		message: SessionMessage,
	) => Promise<void> | void;
	readonly #onClose: (
		peer: JsonLinePeer<SessionMessage, BrokerMessage>,
	) => void;
	readonly #peers = new Set<JsonLinePeer<SessionMessage, BrokerMessage>>();
	readonly #servers = new Set<Server>();
	readonly #sockets = new Set<Socket>();

	constructor(
		agentDir: string,
		onMessage: (
			peer: JsonLinePeer<SessionMessage, BrokerMessage>,
			message: SessionMessage,
		) => Promise<void> | void,
		onClose: (peer: JsonLinePeer<SessionMessage, BrokerMessage>) => void,
	) {
		this.#agentDir = agentDir;
		this.#endpoint = ipcEndpoint(agentDir);
		this.#onMessage = onMessage;
		this.#onClose = onClose;
	}

	async start(
		network: boolean | number = false,
		options: { host?: string; tls?: NetworkTlsConfig } = {},
	): Promise<void> {
		if (this.#servers.size > 0) return;
		if (network && !options.tls)
			throw new Error("TCP listening requires mutual TLS configuration");
		const material =
			network && options.tls
				? await tlsMaterial(this.#agentDir, options.tls)
				: undefined;
		await mkdir(this.#agentDir, { recursive: true, mode: 0o700 });
		if (process.platform !== "win32") await prepareUnixSocket(this.#endpoint);
		try {
			const local = this.#createServer();
			await listenServer(local, this.#endpoint);
			this.#servers.add(local);
			if (process.platform !== "win32") {
				await chmod(this.#endpoint, 0o600);
				const info = await lstat(this.#endpoint);
				this.#socketIdentity = { dev: info.dev, ino: info.ino };
			}
			if (!network) return;
			const remote = createTlsServer(
				{
					...material,
					minVersion: "TLSv1.3",
					requestCert: true,
					rejectUnauthorized: true,
					handshakeTimeout: 5000,
				},
				(socket) => this.#accept(socket),
			);
			remote.on("connection", (socket) => this.#trackSocket(socket));
			remote.maxConnections = 128;
			remote.on("tlsClientError", () => {});
			await listenServer(remote, {
				host: options.host ?? "127.0.0.1",
				port: network === true ? defaultPort : network,
			});
			this.#servers.add(remote);
		} catch (error) {
			await this.close();
			throw error;
		}
	}

	async close(): Promise<void> {
		for (const peer of this.#peers) peer.close();
		this.#peers.clear();
		for (const socket of this.#sockets) socket.destroy();
		this.#sockets.clear();
		const servers = [...this.#servers];
		this.#servers.clear();
		await Promise.all(servers.map(closeServer));
		const identity = this.#socketIdentity;
		this.#socketIdentity = undefined;
		if (identity) {
			const current = await lstat(this.#endpoint).catch(() => undefined);
			if (
				current?.isSocket() &&
				current.dev === identity.dev &&
				current.ino === identity.ino
			)
				await unlink(this.#endpoint).catch(() => {});
		}
	}

	#createServer(): Server {
		const server = createServer((socket) => this.#accept(socket));
		server.on("connection", (socket) => this.#trackSocket(socket));
		server.maxConnections = 128;
		return server;
	}

	#trackSocket(socket: Socket): void {
		this.#sockets.add(socket);
		socket.once("close", () => this.#sockets.delete(socket));
	}

	#accept(socket: Socket): void {
		if (this.#peers.size >= 128) {
			socket.destroy();
			return;
		}
		let peer: JsonLinePeer<SessionMessage, BrokerMessage>;
		peer = new JsonLinePeer(
			socket,
			(message) => this.#onMessage(peer, validateSessionMessage(message)),
			() => {
				this.#peers.delete(peer);
				this.#onClose(peer);
			},
		);
		this.#peers.add(peer);
	}
}

interface ConnectionCallbacks {
	onOpen(): Promise<void> | void;
	onMessage(message: BrokerMessage): Promise<void> | void;
	onClose(error: Error): void;
}

export class IpcClient {
	readonly #agentDir: string;
	readonly #tls: NetworkTlsConfig | undefined;
	readonly #endpoint: string;
	readonly #remote: string | undefined;
	readonly #callbacks: ConnectionCallbacks;
	#peer: JsonLinePeer<BrokerMessage, SessionMessage> | undefined;
	#opening: Promise<void> | undefined;
	#controller: AbortController | undefined;
	#retry: NodeJS.Timeout | undefined;
	#closed = false;

	constructor(
		agentDir: string,
		remote: string | undefined,
		callbacks: ConnectionCallbacks,
		tls?: NetworkTlsConfig,
	) {
		this.#agentDir = agentDir;
		this.#tls = tls;
		this.#endpoint = ipcEndpoint(agentDir);
		this.#remote = remote;
		this.#callbacks = callbacks;
	}

	get connected(): boolean {
		return this.#peer !== undefined && !this.#peer.closed;
	}

	start(): void {
		void this.connect().catch(() => {});
	}

	connect(): Promise<void> {
		if (this.#closed)
			return Promise.reject(new Error("Chappie IPC client is closed"));
		if (this.connected) return Promise.resolve();
		if (this.#opening) return this.#opening;
		clearTimeout(this.#retry);
		this.#retry = undefined;
		const controller = new AbortController();
		this.#controller = controller;
		this.#opening = this.#open(controller.signal).finally(() => {
			this.#opening = undefined;
			if (this.#controller === controller) this.#controller = undefined;
		});
		return this.#opening;
	}

	send(message: SessionMessage): Promise<void> {
		const peer = this.#peer;
		if (!peer || peer.closed)
			return Promise.reject(new Error("Chappie broker is not running"));
		return peer.send(message);
	}

	close(): void {
		this.#closed = true;
		clearTimeout(this.#retry);
		this.#retry = undefined;
		this.#controller?.abort(new Error("Chappie IPC client is closed"));
		this.#controller = undefined;
		this.#peer?.close();
		this.#peer = undefined;
	}

	async #open(signal: AbortSignal): Promise<void> {
		let socket: Socket | undefined;
		let failure = new Error("Chappie disconnected");
		try {
			const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
			if (this.#remote) {
				if (!this.#tls)
					throw new Error("Remote Chappie connections require mutual TLS");
				const target = networkEndpoint(this.#remote);
				const servername =
					this.#tls.serverName ?? (isIP(target.host) ? undefined : target.host);
				socket = connectTls({
					...target,
					...(await tlsMaterial(this.#agentDir, this.#tls)),
					...(servername ? { servername } : {}),
					minVersion: "TLSv1.3",
					rejectUnauthorized: true,
				});
				await connectSocket(socket, deadline, "secureConnect");
			} else {
				socket = createConnection(this.#endpoint);
				await connectSocket(socket, deadline);
			}
		} catch (error) {
			socket?.destroy();
			this.#scheduleReconnect();
			throw error;
		}

		let peer: JsonLinePeer<BrokerMessage, SessionMessage>;
		peer = new JsonLinePeer(
			socket,
			(message) => {
				if (this.#peer === peer)
					return this.#callbacks.onMessage(validateBrokerMessage(message));
			},
			() => {
				if (this.#peer !== peer) return;
				this.#peer = undefined;
				if (!this.#closed) {
					this.#callbacks.onClose(failure);
					this.#scheduleReconnect();
				}
			},
		);
		this.#peer = peer;
		try {
			await this.#callbacks.onOpen();
		} catch (error) {
			failure = error instanceof Error ? error : new Error(String(error));
			peer.close();
			throw failure;
		}
	}

	#scheduleReconnect(): void {
		if (this.#closed || this.#retry) return;
		this.#retry = setTimeout(() => {
			this.#retry = undefined;
			void this.connect().catch(() => {});
		}, 500);
		this.#retry.unref();
	}
}

function listenServer(
	server: Server,
	endpoint: string | number | NetworkEndpoint,
): Promise<void> {
	return new Promise<void>((resolveListen, rejectListen) => {
		const onError = (error: Error): void => {
			server.off("listening", onListening);
			rejectListen(error);
		};
		const onListening = (): void => {
			server.off("error", onError);
			resolveListen();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(endpoint);
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise<void>((resolveClose, rejectClose) =>
		server.close((error) => (error ? rejectClose(error) : resolveClose())),
	);
}

interface NetworkEndpoint {
	host: string;
	port: number;
}

function networkEndpoint(value: string): NetworkEndpoint {
	const url = new URL(`tcp://${value}`);
	if (url.username || url.password || url.pathname || url.search || url.hash)
		throw new Error(`Invalid Chappie broker address: ${value}`);
	const host = url.hostname.startsWith("[")
		? url.hostname.slice(1, -1)
		: url.hostname;
	if (!host) throw new Error(`Invalid Chappie broker address: ${value}`);
	return { host, port: url.port ? Number(url.port) : defaultPort };
}

function connectSocket(
	socket: Socket,
	signal: AbortSignal,
	event: "connect" | "secureConnect" = "connect",
): Promise<void> {
	return new Promise<void>((resolveConnect, rejectConnect) => {
		const cleanup = (): void => {
			signal.removeEventListener("abort", onAbort);
			socket.off(event, onConnect);
			socket.off("error", onError);
		};
		const onConnect = (): void => {
			cleanup();
			resolveConnect();
		};
		const onError = (error: Error): void => {
			cleanup();
			rejectConnect(error);
		};
		const onAbort = (): void => {
			cleanup();
			socket.destroy();
			rejectConnect(abortError(signal));
		};
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		socket.once(event, onConnect);
		socket.once("error", onError);
	});
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error(
				typeof signal.reason === "string" ? signal.reason : "Request cancelled",
			);
}

async function prepareUnixSocket(endpoint: string): Promise<void> {
	try {
		const info = await lstat(endpoint);
		if (!info.isSocket())
			throw new Error(`Refusing to replace a non-socket file: ${endpoint}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}

	if (await endpointAcceptsConnections(endpoint)) {
		const error = new Error(
			`Chappie broker is already listening at ${endpoint}`,
		) as NodeJS.ErrnoException;
		error.code = "EADDRINUSE";
		throw error;
	}
	await unlink(endpoint);
}

function endpointAcceptsConnections(endpoint: string): Promise<boolean> {
	return new Promise<boolean>((resolveProbe, rejectProbe) => {
		const socket = createConnection(endpoint);
		socket.once("connect", () => {
			socket.end();
			resolveProbe(true);
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			socket.destroy();
			if (error.code === "ECONNREFUSED" || error.code === "ENOENT")
				resolveProbe(false);
			else rejectProbe(error);
		});
	});
}

async function tlsMaterial(
	agentDir: string,
	config: NetworkTlsConfig,
): Promise<{ ca: Buffer; cert: Buffer; key: Buffer }> {
	const [ca, cert, key] = await Promise.all(
		[config.ca, config.cert, config.key].map((path) =>
			readFile(resolve(agentDir, path)),
		),
	);
	if (!ca || !cert || !key)
		throw new Error("Incomplete TLS certificate configuration");
	return { ca, cert, key };
}
