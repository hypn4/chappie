# Chappie contributor entrypoint

Chappie is a Chat-only bridge to native Oh My Pi sessions, not an inference service. Preserve unrelated work and verify current source instead of relying on remembered state.

## Authority

Current user scope and higher-priority safety rules govern the task. Read-only Git inspection is allowed. Commits, push, merge, deployment, live service replacement, global configuration and remote sync require explicit authorization. Beads records work; it does not grant Git authority. Stay inline unless subagents are explicitly authorized.

## Start or resume

Confirm session/cwd and Git state. Read the task's Beads issue; without an ID, inspect in-progress work before creating one. Use `bd prime` for the project's compact command reference. Reuse unchanged instructions and valid evidence already read; do not reload every document on every tool call.

| Need | Source |
|---|---|
| Task workflow | [.agents/skills/chappie-quality/SKILL.md](.agents/skills/chappie-quality/SKILL.md), also `skill://chappie-quality` |
| Review, verification and checkpoint | [docs/quality.md](docs/quality.md), relevant sections only |
| Architecture and settled decisions | [docs/architecture.md](docs/architecture.md) |
| Bridge tools, ownership and recovery | [docs/tools.md](docs/tools.md) |
| Release procedure | [docs/publishing.md](docs/publishing.md), `package.json`, workflows |

## Boundaries and handoff

OMP owns native arguments, permissions and execution. Preserve conversation, session and file ownership, accepted-operation identity, mTLS and staged writes. Bridge tool-surface or compatibility-hint changes need a recorded design decision; do not copy native schemas or treat annotations as authorization. Current execution remains Chat-only; do not add auxiliary inference or automatic replay.

Keep one Beads checkpoint with decisions, evidence and remaining scope. Report code, tests, publication and live behavior separately. Close only completed scope; neither a batch result nor a counter proves user acceptance.
