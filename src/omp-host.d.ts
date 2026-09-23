/**
 * OMP injects its coding-agent package while loading extensions.
 * Chappie only imports getAgentDir at runtime; the extension API subset used by
 * Chappie is kept in omp-api.ts and verified by packaged OMP integration tests.
 */
declare module "@oh-my-pi/pi-coding-agent" {
	export function getAgentDir(): string;
}
