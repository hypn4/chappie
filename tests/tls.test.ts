import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { connect } from "node:tls";
import { Broker } from "../src/broker.ts";
import { IpcClient } from "../src/ipc.ts";
import { until } from "./helpers/session-fixture.ts";

const opensslAvailable =
	spawnSync("openssl", ["version"], { timeout: 3000, stdio: "ignore" })
		.status === 0;

async function fixture(t: TestContext) {
	const root = await mkdtemp(
		join(process.platform === "win32" ? tmpdir() : "/tmp", "chtls-"),
	);
	t.after(() => rm(root, { recursive: true, force: true }));
	const config = join(root, "test.cnf");
	await writeFile(
		config,
		"[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign,cRLSign\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n",
	);
	const tls = {
		ca: join(root, "test.crt"),
		cert: join(root, "test.crt"),
		key: join(root, "test.key"),
	};
	const generated = spawnSync(
		"openssl",
		[
			"req",
			"-new",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"1",
			"-config",
			config,
			"-keyout",
			tls.key,
			"-out",
			tls.cert,
		],
		{ encoding: "utf8", timeout: 15000 },
	);
	assert.equal(generated.status, 0, generated.stderr);
	const probe = createServer();
	probe.listen(0, "127.0.0.1");
	await once(probe, "listening");
	const address = probe.address();
	if (!address || typeof address === "string") throw new Error("missing port");
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	await writeFile(
		join(root, "chappie.json"),
		JSON.stringify({ listen: address.port, tls }),
	);
	const broker = new Broker(root);
	await broker.start();
	t.after(() => broker.close());
	return { root, tls, broker, port: address.port };
}

test("TCP accepts authenticated clients but rejects clients without certificates", {
	skip: !opensslAvailable,
}, async (t) => {
	const f = await fixture(t);
	const client = new IpcClient(
		f.root,
		`127.0.0.1:${f.port}`,
		{
			onOpen: () =>
				client.send({
					type: "sync",
					id: 1,
					session: {
						id: "authenticated",
						cwd: f.root,
						device: "test",
						status: "idle",
					},
				}),
			onMessage() {},
			onClose() {},
		},
		f.tls,
	);
	t.after(() => client.close());
	await client.connect();
	await until(() => f.broker.listSessions().length === 1);
	const stranger = connect({
		host: "127.0.0.1",
		port: f.port,
		ca: await readFile(f.tls.ca),
		rejectUnauthorized: true,
		minVersion: "TLSv1.3",
	});
	stranger.on("error", () => {});
	t.after(() => {
		stranger.destroy();
	});
	await Promise.race([
		new Promise<void>((resolve) => stranger.once("close", resolve)),
		delay(2000).then(() => {
			throw new Error("Unauthenticated TLS connection was not rejected");
		}),
	]);
	assert.deepEqual(
		f.broker.listSessions().map((s) => s.id),
		["authenticated"],
	);
});

test("TLS hostname verification cannot be disabled by the client configuration", {
	skip: !opensslAvailable,
}, async (t) => {
	const f = await fixture(t);
	const client = new IpcClient(
		f.root,
		`127.0.0.1:${f.port}`,
		{ onOpen() {}, onMessage() {}, onClose() {} },
		{ ...f.tls, serverName: "not-localhost.invalid" },
	);
	t.after(() => client.close());
	await assert.rejects(client.connect(), /hostname|altname|certificate/i);
	assert.deepEqual(f.broker.listSessions(), []);
});

test("shutdown also closes incomplete TLS handshakes", {
	skip: !opensslAvailable,
}, async (t) => {
	const f = await fixture(t);
	const stalled = createConnection({ host: "127.0.0.1", port: f.port });
	stalled.on("error", () => {});
	t.after(() => {
		stalled.destroy();
	});
	await once(stalled, "connect");
	await delay(20);
	const closed = f.broker.close();
	const timely = await Promise.race([
		closed.then(() => true),
		delay(400).then(() => false),
	]);
	stalled.destroy();
	await closed;
	assert.equal(timely, true);
});
