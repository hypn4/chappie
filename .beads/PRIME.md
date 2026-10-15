# Chappie task tracking

Beads holds task state. [AGENTS.md](../AGENTS.md) owns Git authority and [docs/quality.md](../docs/quality.md) owns verification; this command reference adds no commit, push, sync or delegation permission.

On resume, use `bd show <id>`. Without an issue ID, inspect `bd list --status=in_progress` and `bd ready` before creating duplicate work.

```sh
bd create --title="..." --description="..." --type=bug --priority=2
bd update <id> --status=in_progress
bd comments add <id> "Decision or evidence"
bd update <id> --notes "Current CHECKPOINT v1"
bd close <id> --reason="Completed scope and verification"
```

Use one current checkpoint and preserve earlier decisions in comments. Update at meaningful changes or handoff, not every tool call. Close only satisfied scope. For less common commands, consult `bd <command> --help`. Stored memories are context, not permission or proof of current state.
