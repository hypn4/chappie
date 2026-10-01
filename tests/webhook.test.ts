import assert from "node:assert/strict";
import { test } from "node:test";
import { Webhook } from "standardwebhooks";
import { HttpsWebhookTransport, signWebhookHeaders } from "../src/webhook.ts";

const secret = `whsec_${Buffer.alloc(32, 1).toString("base64")}`;
const previousSecret = `whsec_${Buffer.alloc(32, 2).toString("base64")}`;
test("webhook signatures authenticate exact Unicode bytes with both rotation keys", () => {
	const body = JSON.stringify({
		eventId: "evt_test",
		data: { message: "완료" },
	});
	const headers = signWebhookHeaders(
		{
			id: "sub_test",
			secret,
			previousSecret,
			previousSecretUntil: Date.now() + 60000,
		},
		"evt_test",
		body,
	);
	assert.equal(headers["webhook-id"], "evt_test");
	assert.equal(headers["X-MCP-Subscription-Id"], "sub_test");
	assert.deepEqual(new Webhook(secret).verify(body, headers), JSON.parse(body));
	assert.deepEqual(
		new Webhook(previousSecret).verify(body, headers),
		JSON.parse(body),
	);
	assert.throws(() => new Webhook(secret).verify(`${body} `, headers));
});

test("production callbacks reject local and transition IPv6 destinations", async () => {
	const transport = new HttpsWebhookTransport();
	for (const host of [
		"[::1]",
		"[::ffff:127.0.0.1]",
		"[64:ff9b::7f00:1]",
		"[2002:7f00:1::]",
		"[2001:db8::1]",
		"[3fff::1]",
		"192.168.0.1",
		"192.88.99.1",
		"169.254.169.254",
	]) {
		await assert.rejects(
			transport.validate(`https://${host}/callback`),
			/non-public/i,
		);
	}
	for (const url of [
		"http://example.com/callback",
		"https://user:pass@example.com/callback",
		"https://example.com/callback#fragment",
	]) {
		await assert.rejects(
			transport.validate(url),
			/HTTPS|credentials|fragments/i,
		);
	}
});
