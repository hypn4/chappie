import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { Webhook } from "standardwebhooks";
import type { EventSubscription } from "./event-types.ts";

export const MAX_EVENT_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
type Destination = Pick<
	EventSubscription,
	"id" | "url" | "secret" | "previousSecret" | "previousSecretUntil"
>;
export interface WebhookResponse {
	status: number;
	body: string;
}
export interface WebhookTransport {
	validate(url: string, signal?: AbortSignal): Promise<void>;
	post(
		subscription: Destination,
		webhookId: string,
		body: string,
		signal?: AbortSignal,
	): Promise<WebhookResponse>;
}

const blocked = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const)
	blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["3fff::", 20],
] as const)
	blocked.addSubnet(address, prefix, "ipv6");

export function validateSigningSecret(secret: string): void {
	const encoded = secret.startsWith("whsec_") ? secret.slice(6) : "";
	const valid =
		/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
	const decoded = Buffer.from(encoded, "base64");
	if (
		!valid.test(encoded) ||
		decoded.length < 24 ||
		decoded.length > 64 ||
		decoded.toString("base64") !== encoded
	)
		throw new Error(
			"Webhook signing secret must be whsec_ plus canonical base64 encoding of 24–64 bytes",
		);
}

function publicAddress(address: string): boolean {
	const family = isIP(address);
	return family === 4
		? !blocked.check(address, "ipv4")
		: family === 6 &&
				globalV6.check(address, "ipv6") &&
				!blocked.check(address, "ipv6");
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		work
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const deadline = AbortSignal.timeout(10000);
	return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

async function resolvePublicCallback(url: URL, signal: AbortSignal) {
	signal.throwIfAborted();
	if (url.protocol !== "https:")
		throw new Error("Webhook callback must use HTTPS");
	if (url.username || url.password || url.hash)
		throw new Error(
			"Webhook callback must not include credentials or fragments",
		);
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	const family = isIP(hostname);
	const addresses = family
		? [{ address: hostname, family }]
		: await abortable(lookup(hostname, { all: true, verbatim: true }), signal);
	signal.throwIfAborted();
	const address = addresses[0];
	if (!address || addresses.some((value) => !publicAddress(value.address)))
		throw new Error("Webhook callback resolves to a non-public address");
	return { ...address, hostname };
}

export function signWebhookHeaders(
	subscription: Omit<Destination, "url">,
	webhookId: string,
	body: string,
) {
	validateSigningSecret(subscription.secret);
	const signedAt = new Date();
	const signatures = [
		new Webhook(subscription.secret).sign(webhookId, signedAt, body),
	];
	if (
		subscription.previousSecret &&
		(subscription.previousSecretUntil ?? 0) > Date.now()
	) {
		validateSigningSecret(subscription.previousSecret);
		signatures.push(
			new Webhook(subscription.previousSecret).sign(webhookId, signedAt, body),
		);
	}
	return {
		"Content-Type": "application/json",
		"Content-Length": String(Buffer.byteLength(body)),
		"webhook-id": webhookId,
		"webhook-timestamp": String(Math.floor(signedAt.getTime() / 1000)),
		"webhook-signature": signatures.join(" "),
		"X-MCP-Subscription-Id": subscription.id,
	};
}

export class HttpsWebhookTransport implements WebhookTransport {
	async validate(url: string, signal?: AbortSignal): Promise<void> {
		await resolvePublicCallback(new URL(url), requestSignal(signal));
	}
	async post(
		subscription: Destination,
		webhookId: string,
		body: string,
		signal?: AbortSignal,
	): Promise<WebhookResponse> {
		if (Buffer.byteLength(body) > MAX_EVENT_BYTES)
			throw new Error("Webhook payload exceeds 256 KiB");
		const combined = requestSignal(signal);
		const url = new URL(subscription.url);
		const resolved = await resolvePublicCallback(url, combined);
		const headers = {
			...signWebhookHeaders(subscription, webhookId, body),
			Host: url.host,
		};
		combined.throwIfAborted();
		return new Promise((resolve, reject) => {
			// Pin the checked address; retain the DNS hostname for SNI/certificate validation.
			// node:https does not follow redirects. A redirect is returned to the delivery policy.
			const req = request(
				{
					protocol: "https:",
					hostname: resolved.address,
					port: url.port || 443,
					...(isIP(resolved.hostname) === 0
						? { servername: resolved.hostname }
						: {}),
					path: `${url.pathname}${url.search}`,
					method: "POST",
					headers,
					signal: combined,
					rejectUnauthorized: true,
				},
				(response) => {
					const chunks: Buffer[] = [];
					let bytes = 0;
					response.on("error", reject);
					response.on("aborted", () =>
						reject(new Error("Webhook response ended prematurely")),
					);
					response.on("data", (chunk: Buffer) => {
						bytes += chunk.length;
						if (bytes > MAX_RESPONSE_BYTES) {
							req.destroy(new Error("Webhook response exceeds 64 KiB"));
							return;
						}
						chunks.push(chunk);
					});
					response.on("end", () =>
						resolve({
							status: response.statusCode ?? 0,
							body: Buffer.concat(chunks).toString("utf8"),
						}),
					);
				},
			);
			req.on("error", reject);
			req.end(body);
		});
	}
}
