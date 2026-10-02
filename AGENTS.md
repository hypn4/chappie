# Chappie contributor entrypoint

Chappie is a Chat-only bridge from ChatGPT to native Oh My Pi (OMP), not an inference service. Work must remain recoverable after a new Chat or compaction. Store decisions and evidence outside the conversation, then verify them against current source before acting.

## Start or resume

1. Confirm the intended session/cwd and inspect current Git state. Preserve unrelated and prior uncommitted changes.
2. Read the [quality standard](docs/quality.md) and the task-relevant [quality Skill](.agents/skills/chappie-quality/SKILL.md). With OMP, read `skill://chappie-quality` when registered; otherwise read that repository file. Newly added Skills may require the host's documented resource reload.
3. Run `bd prime`, then `bd show <issue-id>`; without an ID inspect in-progress work before creating a duplicate. Restore its `CHECKPOINT v1`: goal, constraints, decisions/reasons, verified subject, remaining scope and next action.
4. Revalidate evidence with `bun run quality:evidence inspect <report.json>`. A previous PASS applies only to its source, tests, lockfile, environment and exact command. A missing log or changed source is not current proof.
5. Load only relevant OMP Skills and live native/MCP definitions. Follow executor/observer guidance and current user authorization. Read-only Git inspection is allowed; commit, push, merge, deploy, global configuration and remote sync require explicit authorization.

## Source map

| Need | Authority |
|---|---|
| Review, tests, evidence, checkpoint and completion | [docs/quality.md](docs/quality.md) |
| Component boundaries and reasons for settled decisions | [docs/architecture.md](docs/architecture.md) |
| Public/native operations, ownership and recovery | [docs/tools.md](docs/tools.md) |
| Package identity, locked tools, CI and release procedure | [docs/publishing.md](docs/publishing.md), `package.json`, `.github/workflows/` |
| Current task state | Beads issue; no parallel TODO/HANDOFF/MEMORY ledger |

## Non-negotiable boundaries

Keep OMP as the source of truth for native arguments, permissions and execution. Keep logical operation IDs separate from acceptance execution IDs; uncertain work is not automatically retried. Preserve conversation/session/file ownership, mTLS and staged writes. Do not reintroduce direct native wrappers, retired host/protocol compatibility, Events/Tasks, webhooks, heartbeat processes, schema caches or auxiliary inference routers.

Use existing tests and fixtures rather than a second framework. Report implementation, local verification, review, CI, publication and live validation separately. Do not call inline review independent review or claim a host/UI check that was not performed. Follow the quality standard's stop conditions rather than repeatedly reopening work for speculative hardening.

## Before stopping

Update the issue checkpoint with reasons, exact evidence and the next authorized action. Close only satisfied scope. Keep referenced evidence accessible; do not delete another task's logs or generated resources. Repository rules and current user instructions override generic Skill defaults; remain inline unless subagents are explicitly authorized.
