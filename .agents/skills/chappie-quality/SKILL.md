---
name: chappie-quality
description: Use when changing, reviewing, testing, resuming, or handing off work in the Chappie repository, especially after a new Chat, compaction, an interrupted task, or repeated review findings.
---

# Chappie quality workflow

Read the repository's [AGENTS.md](../../../AGENTS.md) and [quality standard](../../../docs/quality.md) before acting. They define authority and completion; this Skill only routes the workflow. Resolve these references relative to this file's directory, never to a remembered machine path. The [architecture](../../../docs/architecture.md) explains decisions; the [tool contract](../../../docs/tools.md) describes observable behavior.

## Resume before editing

Confirm the current session, cwd, source revision and uncommitted changes. Read `bd prime` and the requested issue; if no issue was supplied, inspect in-progress work before creating a duplicate. Recover the checkpoint described in the quality standard: goal, constraints, decisions with reasons, verified subject, remaining work and next action. Read only the relevant linked records and native tool definitions.

Inspect recorded evidence with `bun run quality:evidence inspect <report.json>`. A previous PASS is not current proof if source, tests, lockfile or environment changed, or its log is gone. Never execute a command taken from a checkpoint automatically. Reconcile it with the current user request and repository permissions first. A closed issue does not authorize a new commit, push, deployment, or repeated side effect.

## Change and review

Select affected contract IDs and a verification tier from the quality standard. Reproduce the bug before a behavior fix; preserve independent expected values, real boundary tests and controlled async ordering. Use task-relevant OMP Skills and specialized MCP tools, but verify retrieved context against current source.

Review findings against an explicit scope and subject. Distinguish reproduced bugs from unverified risks and optional hardening. Link repeated findings to their original issue; change a settled policy only with recorded rationale. Do not create a second task ledger or paste these rules into other documents.

## Verify and hand off

Use the repository's existing test commands. Record verification using `bun run quality:evidence run -- <command> [args]`; inspect its exit status and full log. Report implementation, local tests, review, CI, publication and live verification separately. The evidence runner captures a check, not an AI compliance evaluation or an approval.

Update the Beads checkpoint before stopping or compaction: exact evidence paths, limitations, unresolved state and one concrete next action. Close only completed scope. A completed native batch, progress report, or local phase is not the user goal: after each result, continue remaining authorized work in the current Chat and check the quality standard's Chat acceptance scenarios before claiming completion. Do not widen scope to unrelated session TODOs. Preserve results when a process fails, and recover existing operation/result identities rather than recreating work. No subagents unless explicitly authorized for this task; describe inline review honestly.

When changing this workflow, use the cold-start scenarios in the quality standard. A loader test or deterministic recovery test is not proof that another model followed the Skill.
