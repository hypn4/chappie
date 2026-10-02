import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	getLatestTodoPhasesFromEntries,
	isTodoPhase,
} from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { SessionWork } from "./work.ts";

/** Reuse OMP's branch-aware reader; do not scrape tool text or keep a cached TODO copy. */
export function observeSessionWork(entries: SessionEntry[]): SessionWork {
	const observation = {
		source: "omp_todo" as const,
		scope: "session" as const,
		observedAt: Date.now(),
	};
	try {
		const phases = getLatestTodoPhasesFromEntries(entries);
		if (!phases.every(isTodoPhase)) return { ...observation, state: "unknown" };
		const counts = {
			pending: 0,
			inProgress: 0,
			blocked: 0,
			completed: 0,
			abandoned: 0,
		};
		for (const phase of phases) {
			for (const task of phase.tasks) {
				if (task.status === "in_progress") counts.inProgress++;
				else counts[task.status]++;
			}
		}
		const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
		const state =
			counts.pending + counts.inProgress > 0
				? "actionable"
				: counts.blocked > 0
					? "blocked"
					: total > 0
						? "settled"
						: "untracked";
		return { ...observation, state, counts };
	} catch {
		// Broken optional metadata must not turn an executed batch into a retryable failure.
		return { ...observation, state: "unknown" };
	}
}
