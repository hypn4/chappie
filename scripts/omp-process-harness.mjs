import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

function quoteWindowsArg(value) {
	if (/["%\r\n]/.test(value))
		throw new Error("Unsafe Windows launcher argument");
	return `"${value}"`;
}

export function createOmpProcessHarness({
	work,
	env,
	baseArgs,
	ompEntry = process.env.OMP_ENTRY,
	ompBinary = process.env.OMP_BINARY || "omp",
}) {
	const command = ompEntry ? process.execPath : ompBinary;
	const commandArgs = ompEntry ? [ompEntry] : [];
	let child;
	let logs = "";
	let processError;

	function launch(extraArgs = []) {
		if (child && child.exitCode === null)
			throw new Error("OMP process is already running");
		processError = undefined;
		const args = [...baseArgs, ...extraArgs];
		if (process.platform === "win32" && !ompEntry) {
			child = spawn(
				process.env.ComSpec || "cmd.exe",
				[
					"/d",
					"/s",
					"/v:off",
					"/c",
					`"${[command, ...commandArgs, ...args].map(quoteWindowsArg).join(" ")}"`,
				],
				{
					cwd: work,
					env,
					windowsVerbatimArguments: true,
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
		} else {
			child = spawn(command, [...commandArgs, ...args], {
				cwd: work,
				env,
				stdio: ["pipe", "pipe", "pipe"],
			});
		}
		child.on("error", (error) => {
			processError = error;
		});
		for (const stream of [child.stdout, child.stderr])
			stream.on("data", (bytes) => {
				logs = (logs + bytes.toString()).slice(-10000);
			});
		return child;
	}

	function assertHealthy() {
		if (!child) throw new Error("OMP process is not running");
		if (processError) throw processError;
		if (child.exitCode !== null)
			throw new Error(`OMP exited with status ${child.exitCode}`);
	}

	async function waitForSession(sessions, signal, expectedId) {
		while (true) {
			signal.throwIfAborted();
			assertHealthy();
			const found = sessions().find(
				(session) => expectedId === undefined || session.id === expectedId,
			);
			if (found) return found;
			await delay(20);
		}
	}

	async function waitForNoSessions(sessions, signal) {
		while (sessions().length > 0) {
			signal.throwIfAborted();
			await delay(20);
		}
	}

	async function stop() {
		const running = child;
		if (!running || running.exitCode !== null) return;
		if (process.platform === "win32" && running.pid) {
			spawnSync("taskkill", ["/PID", String(running.pid), "/T", "/F"], {
				stdio: "ignore",
				timeout: 5000,
			});
		} else {
			running.kill("SIGTERM");
		}
		await Promise.race([
			new Promise((resolve) => running.once("exit", resolve)),
			delay(1000),
		]);
		if (running.exitCode === null) running.kill("SIGKILL");
	}

	return {
		launch,
		assertHealthy,
		waitForSession,
		waitForNoSessions,
		stop,
		get child() {
			return child;
		},
		get logs() {
			return logs;
		},
	};
}
