import { homedir } from "node:os";
import { join, resolve } from "node:path";

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED_BASENAME_RE =
	/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

function normalizeProfileName(profile: string | undefined): string | undefined {
	const normalized = profile?.trim();
	if (!normalized || normalized === "default") return undefined;
	if (
		normalized === "." ||
		normalized === ".." ||
		normalized.endsWith(".") ||
		!PROFILE_NAME_RE.test(normalized) ||
		WINDOWS_RESERVED_BASENAME_RE.test(normalized)
	) {
		throw new Error(
			`Invalid OMP profile "${profile}". Profile names must match ${PROFILE_NAME_RE.source}, ` +
				'cannot be "." or "..", cannot end with ".", and cannot be a Windows reserved device name.',
		);
	}
	return normalized;
}

function safeProfileName(profile: string | undefined): string | undefined {
	try {
		return normalizeProfileName(profile);
	} catch {
		return undefined;
	}
}

function profileAgentDir(
	home: string,
	configDir: string,
	profile: string,
): string {
	return join(home, configDir, "profiles", profile, "agent");
}

export function resolveOmpAgentDir(
	env: NodeJS.ProcessEnv = process.env,
	home = homedir(),
): string {
	const configDir = env.PI_CONFIG_DIR || ".omp";
	const selectedProfile = normalizeProfileName(
		env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE,
	);
	if (selectedProfile) {
		return profileAgentDir(home, configDir, selectedProfile);
	}

	const legacyProfile = safeProfileName(env.PI_PROFILE);
	const override =
		legacyProfile &&
		env.PI_CODING_AGENT_DIR === profileAgentDir(home, configDir, legacyProfile)
			? undefined
			: env.PI_CODING_AGENT_DIR;
	return override ? resolve(override) : join(home, configDir, "agent");
}
