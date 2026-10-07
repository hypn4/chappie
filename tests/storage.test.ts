import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import { uuidV7 } from "../src/ids.ts";
import { resolveChappieStorage } from "../src/storage.ts";

const run = promisify(execFile);
const uuidV7Pattern =
	/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "ch-storage-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return realpath(root);
}

test("the neutral home creates one stable UUID v7 store without native agent settings", async (t) => {
	const home = await fixture(t);
	const first = await resolveChappieStorage({}, home);
	assert.equal(first.homeDir, join(home, ".chappie"));
	assert.match(first.storeId, uuidV7Pattern);
	assert.equal(first.storeDir, join(first.homeDir, "stores", first.storeId));
	const manifestPath = join(first.homeDir, "manifest.json");
	const original = await readFile(manifestPath, "utf8");
	assert.deepEqual(JSON.parse(original), {
		schemaVersion: 1,
		defaultStoreId: first.storeId,
		storeIds: [first.storeId],
	});
	assert.deepEqual(
		await resolveChappieStorage(
			{
				OMP_PROFILE: "another-profile",
				PI_CODING_AGENT_DIR: join(home, "another-agent"),
				PI_CONFIG_DIR: "another-config",
			},
			home,
		),
		first,
	);
	assert.equal(await readFile(manifestPath, "utf8"), original);
	assert.deepEqual(await readdir(join(first.homeDir, "stores")), [
		first.storeId,
	]);
});

test("CHAPPIE_HOME selects an absolute or home-relative root independently of cwd", async (t) => {
	const home = await fixture(t);
	const chosen = join(home, "chosen");
	assert.equal(
		(await resolveChappieStorage({ CHAPPIE_HOME: chosen }, home)).homeDir,
		chosen,
	);
	assert.equal(
		(await resolveChappieStorage({ CHAPPIE_HOME: "~/chosen" }, home)).homeDir,
		chosen,
	);
	assert.equal(
		(await resolveChappieStorage({ CHAPPIE_HOME: "~" }, home)).homeDir,
		home,
	);
	for (const path of ["", "relative", "../sibling"])
		await assert.rejects(
			resolveChappieStorage({ CHAPPIE_HOME: path }, home),
			/absolute path/,
		);
});

test("an unrelated existing root state remains byte-for-byte unchanged", async (t) => {
	const homeDir = await fixture(t);
	const unrelated = '{"unknownSchema":"preserve"}\n'.padEnd(570, " ");
	const path = join(homeDir, "state.json");
	await writeFile(path, unrelated);
	const result = await resolveChappieStorage({ CHAPPIE_HOME: homeDir });
	assert.equal(await readFile(path, "utf8"), unrelated);
	assert.deepEqual((await readdir(homeDir)).sort(), [
		"manifest.json",
		"state.json",
		"stores",
	]);
	assert.deepEqual(await readdir(result.storeDir), []);
});

test("an explicit registered store does not change the default or create another store", async (t) => {
	const homeDir = await fixture(t);
	const first = await resolveChappieStorage({ CHAPPIE_HOME: homeDir });
	const selected = uuidV7();
	const selectedDir = join(homeDir, "stores", selected);
	await mkdir(selectedDir);
	const manifestPath = join(homeDir, "manifest.json");
	const manifest = JSON.stringify({
		schemaVersion: 1,
		defaultStoreId: first.storeId,
		storeIds: [first.storeId, selected],
	});
	await writeFile(manifestPath, manifest);
	assert.deepEqual(
		await resolveChappieStorage({
			CHAPPIE_HOME: homeDir,
			CHAPPIE_STORE_ID: selected.toUpperCase(),
		}),
		{ homeDir, storeDir: selectedDir, storeId: selected },
	);
	assert.deepEqual(
		await resolveChappieStorage({ CHAPPIE_HOME: homeDir }),
		first,
	);
	assert.equal(await readFile(manifestPath, "utf8"), manifest);
	assert.equal((await readdir(join(homeDir, "stores"))).length, 2);
});

test("invalid or unregistered store selection cannot manufacture a fresh identity", async (t) => {
	const root = await fixture(t);
	const homeDir = join(root, "new-root");
	for (const id of ["../other", "", "00000000-0000-4000-8000-000000000000"])
		await assert.rejects(
			resolveChappieStorage({ CHAPPIE_HOME: homeDir, CHAPPIE_STORE_ID: id }),
			/UUID v7/,
		);
	assert.deepEqual(await readdir(root), []);
	await assert.rejects(
		resolveChappieStorage({
			CHAPPIE_HOME: homeDir,
			CHAPPIE_STORE_ID: uuidV7(),
		}),
		/not registered/,
	);
	assert.deepEqual(await readdir(homeDir), []);
	const initial = await resolveChappieStorage({ CHAPPIE_HOME: homeDir });
	const before = await readFile(join(homeDir, "manifest.json"), "utf8");
	await assert.rejects(
		resolveChappieStorage({
			CHAPPIE_HOME: homeDir,
			CHAPPIE_STORE_ID: uuidV7(),
		}),
		/not registered/,
	);
	assert.equal(await readFile(join(homeDir, "manifest.json"), "utf8"), before);
	assert.deepEqual(await readdir(join(homeDir, "stores")), [initial.storeId]);
});

test("unknown or malformed manifests are preserved instead of replaced", async (t) => {
	const homeDir = await fixture(t);
	const id = uuidV7();
	const other = uuidV7();
	const manifestPath = join(homeDir, "manifest.json");
	for (const contents of [
		"{incomplete",
		JSON.stringify({ schemaVersion: 2, defaultStoreId: id, storeIds: [id] }),
		JSON.stringify({ schemaVersion: 1, defaultStoreId: id, storeIds: [other] }),
		JSON.stringify({
			schemaVersion: 1,
			defaultStoreId: id,
			storeIds: [id, id],
		}),
		" ".repeat(64 * 1024 + 1),
	]) {
		await writeFile(manifestPath, contents);
		await assert.rejects(
			resolveChappieStorage({ CHAPPIE_HOME: homeDir }),
			/Invalid Chappie storage manifest/,
		);
		assert.equal(await readFile(manifestPath, "utf8"), contents);
		assert.deepEqual(await readdir(homeDir), ["manifest.json"]);
	}
});

test("a missing registered store is reported without recreating its directory", async (t) => {
	const homeDir = await fixture(t);
	const first = await resolveChappieStorage({ CHAPPIE_HOME: homeDir });
	const manifest = await readFile(join(homeDir, "manifest.json"), "utf8");
	await rm(first.storeDir, { recursive: true });
	await assert.rejects(
		resolveChappieStorage({ CHAPPIE_HOME: homeDir }),
		/ENOENT|no such file/i,
	);
	assert.deepEqual(await readdir(join(homeDir, "stores")), []);
	assert.equal(
		await readFile(join(homeDir, "manifest.json"), "utf8"),
		manifest,
	);
});

test("simultaneous catalog callers share exactly one default identity", async (t) => {
	const homeDir = join(await fixture(t), "simultaneous");
	const results = await Promise.all(
		Array.from({ length: 8 }, () =>
			resolveChappieStorage({ CHAPPIE_HOME: homeDir }),
		),
	);
	const first = results[0];
	assert.ok(first);
	for (const result of results) assert.deepEqual(result, first);
	assert.deepEqual(await readdir(join(homeDir, "stores")), [first.storeId]);
	assert.deepEqual((await readdir(homeDir)).sort(), [
		"manifest.json",
		"stores",
	]);
});

test("independent processes initialize the same root without losing its identity", async (t) => {
	const homeDir = join(await fixture(t), "processes");
	const source = new URL("../src/storage.ts", import.meta.url).href;
	const code = `import(${JSON.stringify(source)}).then(m => m.resolveChappieStorage()).then(value => process.stdout.write(JSON.stringify(value))).catch(error => { console.error(error); process.exitCode = 1; });`;
	const env: NodeJS.ProcessEnv = { ...process.env, CHAPPIE_HOME: homeDir };
	delete env.CHAPPIE_STORE_ID;
	const results = await Promise.all(
		Array.from({ length: 4 }, () =>
			run(process.execPath, ["--eval", code], {
				env,
				timeout: 15000,
				maxBuffer: 128 * 1024,
			}),
		),
	);
	const stores = results.map((result) => JSON.parse(result.stdout));
	for (const store of stores) assert.deepEqual(store, stores[0]);
	assert.match(stores[0].storeId, uuidV7Pattern);
	assert.deepEqual(await readdir(join(homeDir, "stores")), [stores[0].storeId]);
	assert.deepEqual((await readdir(homeDir)).sort(), [
		"manifest.json",
		"stores",
	]);
});
