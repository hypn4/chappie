import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Resolve the current OMP launch contract without loading an inference host. */
export function resolveOmpAgentDir(
	env: NodeJS.ProcessEnv = process.env,
	home = homedir(),
): string {
	const configDir = env.PI_CONFIG_DIR || ".omp";
	const profile = env.OMP_PROFILE?.trim();
	if (profile && profile !== "default") {
		if (
			!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) ||
			profile.endsWith(".") ||
			/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(profile)
		)
			throw new Error("Invalid OMP_PROFILE");
		return join(home, configDir, "profiles", profile, "agent");
	}
	return env.PI_CODING_AGENT_DIR
		? resolve(env.PI_CODING_AGENT_DIR)
		: join(home, configDir, "agent");
}
