import * as z from "zod";

const count = z.int().nonnegative();

/** An observation of a shared OMP board, never a second task store or authorization. */
export const sessionWorkSchema = z.strictObject({
	source: z.literal("omp_todo"),
	scope: z.literal("session"),
	observedAt: z.number().nonnegative(),
	state: z.enum(["untracked", "actionable", "blocked", "settled", "unknown"]),
	counts: z
		.strictObject({
			pending: count,
			inProgress: count,
			blocked: count,
			completed: count,
			abandoned: count,
		})
		.optional(),
});

export type SessionWork = z.infer<typeof sessionWorkSchema>;
export type ChatMode = "progress" | "message";

/** These are controller cues, not commands, proof of completion, or permission to act. */
export function continuationFor({
	work,
	needsInput = false,
	failed = false,
	operationStatus,
	scope = "native_batch",
}: {
	work?: SessionWork | undefined;
	needsInput?: boolean;
	failed?: boolean;
	operationStatus?: string | undefined;
	scope?: "native_batch" | "progress" | "message";
}) {
	const nextAction =
		needsInput || operationStatus === "waiting_input"
			? "answer_model_request"
			: operationStatus === "running"
				? "inspect_operation"
				: ["uncertain", "cancelled", "failed"].includes(operationStatus ?? "")
					? "reconcile_operation"
					: failed
						? "inspect_failure"
						: work?.state === "actionable"
							? "continue_requested_work"
							: work?.state === "blocked"
								? "review_blockers"
								: "verify_requested_scope";
	return { scope, userGoal: "not_evaluated" as const, nextAction };
}
