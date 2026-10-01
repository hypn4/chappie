import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type {
	EventSubscription,
	OPERATION_FINISHED_EVENT,
} from "./event-types.ts";
import type { State } from "./state.ts";
import {
	HttpsWebhookTransport,
	MAX_EVENT_BYTES,
	validateSigningSecret,
	type WebhookTransport,
} from "./webhook.ts";

export {
	HttpsWebhookTransport,
	type WebhookResponse,
	type WebhookTransport,
} from "./webhook.ts";

const VERIFY_CACHE_MS = 5 * 60 * 1000;
const SECRET_ROTATION_MS = 5 * 60 * 1000;
const DEFAULT_SUBSCRIPTION_MS = 24 * 60 * 60 * 1000;
const MAX_SUBSCRIPTION_MS = 30 * DEFAULT_SUBSCRIPTION_MS;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000] as const;

export function subscriptionId(
	chatId: string,
	url: string,
	name: string,
	args: { operation_id: string },
): string {
	// The filter has one schema-defined field, so its canonical representation is unambiguous.
	return `sub_${createHash("sha256")
		.update(
			JSON.stringify([chatId, url, name, { operation_id: args.operation_id }]),
		)
		.digest("hex")}`;
}

export class EventService {
	readonly #state: State;
	readonly #transport: WebhookTransport;
	readonly #verified = new Map<string, number>();
	readonly #lifetime = new AbortController();
	readonly #inFlight = new Map<string, AbortController>();
	#unlisten: (() => void) | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#timerAt = Infinity;
	#draining: Promise<void> | undefined;

	constructor(
		state: State,
		transport: WebhookTransport = new HttpsWebhookTransport(),
	) {
		this.#state = state;
		this.#transport = transport;
	}
	start(): void {
		this.#lifetime.signal.throwIfAborted();
		if (this.#unlisten) return;
		this.#unlisten = this.#state.onEventsPending(() => this.#schedule());
		this.#schedule();
	}
	async close(): Promise<void> {
		this.#unlisten?.();
		this.#unlisten = undefined;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#lifetime.abort(new Error("Event service stopped"));
		this.#verified.clear();
		await this.#draining;
	}

	async subscribe(input: {
		chatId: string;
		name: typeof OPERATION_FINISHED_EVENT;
		operationId: string;
		url: string;
		secret: string;
		ttlMs?: number | null;
		signal?: AbortSignal;
	}): Promise<EventSubscription> {
		validateSigningSecret(input.secret);
		if (
			input.ttlMs !== undefined &&
			input.ttlMs !== null &&
			(!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0)
		)
			throw new Error("ttlMs must be a positive safe integer or null");
		this.#state.operation(input.chatId, input.operationId);
		const signal = input.signal
			? AbortSignal.any([input.signal, this.#lifetime.signal])
			: this.#lifetime.signal;
		signal.throwIfAborted();
		const url = new URL(input.url).href;
		await this.#transport.validate(url, signal);
		const id = subscriptionId(input.chatId, url, input.name, {
			operation_id: input.operationId,
		});
		const now = Date.now();
		for (const [key, expiry] of this.#verified)
			if (expiry <= now) this.#verified.delete(key);
		const verifiedKey = JSON.stringify([input.chatId, url]);
		if (!this.#verified.has(verifiedKey)) {
			await this.#verify({ id, url, secret: input.secret }, signal);
			if (this.#verified.size >= 2048)
				this.#verified.delete(this.#verified.keys().next().value ?? "");
			this.#verified.set(verifiedKey, Date.now() + VERIFY_CACHE_MS);
		}
		signal.throwIfAborted();
		const previous = this.#state.eventSubscription(id);
		const updatedAt = Date.now();
		const ttl =
			input.ttlMs === null
				? null
				: Math.min(input.ttlMs ?? DEFAULT_SUBSCRIPTION_MS, MAX_SUBSCRIPTION_MS);
		const rotation =
			previous && previous.secret !== input.secret
				? {
						previousSecret: previous.secret,
						previousSecretUntil: updatedAt + SECRET_ROTATION_MS,
					}
				: previous?.previousSecret &&
						(previous.previousSecretUntil ?? 0) > updatedAt
					? {
							previousSecret: previous.previousSecret,
							previousSecretUntil: previous.previousSecretUntil,
						}
					: {};
		const subscription: EventSubscription = {
			id,
			chatId: input.chatId,
			name: input.name,
			operationId: input.operationId,
			url,
			secret: input.secret,
			...rotation,
			expiresAt: ttl === null ? null : updatedAt + ttl,
			updatedAt,
		};
		// State queues an already-terminal result atomically with subscription creation.
		await this.#state.upsertEventSubscription(subscription);
		return subscription;
	}

	async unsubscribe(input: {
		chatId: string;
		name: typeof OPERATION_FINISHED_EVENT;
		operationId: string;
		url: string;
	}): Promise<void> {
		const id = subscriptionId(
			input.chatId,
			new URL(input.url).href,
			input.name,
			{ operation_id: input.operationId },
		);
		this.#inFlight.get(id)?.abort(new Error("Subscription stopped"));
		await this.#state.removeEventSubscription(id, input.chatId);
	}

	async #verify(
		subscription: Pick<EventSubscription, "id" | "url" | "secret">,
		signal: AbortSignal,
	): Promise<void> {
		const challenge = randomUUID();
		const body = JSON.stringify({ type: "verification", challenge });
		const response = await this.#transport.post(
			subscription,
			`msg_verification_${randomUUID()}`,
			body,
			signal,
		);
		if (response.status < 200 || response.status >= 300)
			throw new Error(
				`Webhook verification failed with HTTP ${response.status}`,
			);
		let echoed: unknown;
		try {
			echoed = JSON.parse(response.body);
		} catch {
			throw new Error("Webhook verification returned invalid JSON");
		}
		const value =
			echoed &&
			typeof echoed === "object" &&
			"challenge" in echoed &&
			typeof echoed.challenge === "string"
				? echoed.challenge
				: "";
		const actual = Buffer.from(value);
		const expected = Buffer.from(challenge);
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
			throw new Error("Webhook verification challenge mismatch");
	}

	#schedule(): void {
		if (!this.#unlisten || this.#lifetime.signal.aborted || this.#draining)
			return;
		const next = this.#state.nextEventTime();
		if (next === undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
			this.#timerAt = Infinity;
			return;
		}
		if (this.#timer && this.#timerAt <= next) return;
		clearTimeout(this.#timer);
		this.#timerAt = next;
		this.#timer = setTimeout(
			() => {
				this.#timer = undefined;
				this.#timerAt = Infinity;
				let fault = false;
				this.#draining = this.#drain()
					.catch(() => {
						fault = true;
						// No secret, callback URL or user payload is logged. A later successful state write wakes the pump.
						console.error(
							"Chappie Events delivery paused after a durable-state error",
						);
					})
					.finally(() => {
						this.#draining = undefined;
						if (!fault) this.#schedule();
					});
			},
			Math.max(0, Math.min(next - Date.now(), 2147483647)),
		);
		this.#timer.unref();
	}

	async #drain(): Promise<void> {
		while (!this.#lifetime.signal.aborted) {
			// Never transmit an outbox entry whose state write is still pending or failed.
			await this.#state.flush();
			if (this.#lifetime.signal.aborted) return;
			const event = this.#state.nextEvent(Date.now());
			if (!event) return;
			const sub = this.#state.eventSubscription(event.subscriptionId);
			if (!sub || (sub.expiresAt !== null && sub.expiresAt <= Date.now())) {
				await this.#state.removeEvent(event.eventId, "subscription_expired");
				continue;
			}
			try {
				this.#state.operation(sub.chatId, sub.operationId);
			} catch {
				await this.#state.removeEventSubscription(sub.id, sub.chatId);
				continue;
			}
			const body = JSON.stringify({
				eventId: event.eventId,
				name: event.name,
				timestamp: event.timestamp,
				data: event.data,
				cursor: null,
			});
			if (Buffer.byteLength(body) > MAX_EVENT_BYTES) {
				await this.#state.removeEvent(event.eventId, "payload_too_large");
				continue;
			}
			const controller = new AbortController();
			this.#inFlight.set(sub.id, controller);
			const remaining =
				sub.expiresAt === null
					? 10000
					: Math.max(1, Math.min(10000, sub.expiresAt - Date.now()));
			const signal = AbortSignal.any([
				this.#lifetime.signal,
				controller.signal,
				AbortSignal.timeout(remaining),
			]);
			let status = 0;
			try {
				status = (await this.#transport.post(sub, event.eventId, body, signal))
					.status;
			} catch {
				/* Network failures get the bounded retry policy below. */
			} finally {
				this.#inFlight.delete(sub.id);
			}
			if (this.#lifetime.signal.aborted) return;
			if (!this.#state.eventSubscription(sub.id)) continue;
			if (status >= 200 && status < 300) {
				await this.#state.removeEvent(event.eventId);
				continue;
			}
			if (status === 410) {
				await this.#state.removeEventSubscription(sub.id, sub.chatId);
				continue;
			}
			if (status >= 300 && status < 500 && ![408, 425, 429].includes(status)) {
				await this.#state.removeEvent(event.eventId, `HTTP ${status}`);
				continue;
			}
			const delay = RETRY_DELAYS_MS[event.attempts];
			if (delay === undefined) {
				await this.#state.removeEvent(event.eventId, "retry_limit_reached");
				continue;
			}
			await this.#state.rescheduleEvent(
				event.eventId,
				event.attempts + 1,
				Date.now() + delay + Math.floor(Math.random() * delay * 0.2),
			);
		}
	}
}
