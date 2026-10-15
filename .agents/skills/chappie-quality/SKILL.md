---
name: chappie-quality
description: Use when changing, reviewing or resuming work in the Chappie repository, including after context loss or an interrupted task.
---

# Chappie workflow

Follow [AGENTS.md](../../../AGENTS.md) for authority and navigation. Reuse instructions already read and unchanged.

Recover the current Beads issue, source state and checkpoint. Select the affected contracts and verification tier from the [quality standard](../../../docs/quality.md); read only the relevant sections of the [architecture](../../../docs/architecture.md) and [tool contract](../../../docs/tools.md).

Reproduce behavior defects, make scoped changes and use existing tests. Inspect prior reports with `bun run quality:evidence inspect <report.json>` before reuse; record new verification with `bun run quality:evidence run -- <command>`. Inspect the log as well as the exit status.

Update the issue at meaningful boundaries and handoff. Continue remaining authorized work; distinguish code and wire tests from actual ChatGPT behavior. Loader tests show that this Skill is available, not that another model followed it.
