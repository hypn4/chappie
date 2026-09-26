# Tools

> Chappie supports both Pi and Oh My Pi (OMP). This guide uses the existing
> "Pi session/tool" terminology for the selected local agent host; the same
> Chappie tools and session semantics apply to OMP unless noted otherwise.

| Tool | Purpose |
|---|---|
| `init` | Select this ChatGPT conversation's default Pi session and read its environment. |
| `history` | Read the current Pi branch with timestamps and entry IDs. |
| `sessions` | List connected Pi sessions and the current default. |
| `tools` | Read full definitions of active Pi tools for `call`. |
| `chat` | Send an assistant message to Pi. |
| `ask` | Create a persistent question in ChatGPT. |
| `ask_assert` | Confirm that an `ask` widget loaded. |
| `call` | Run one or more Pi tools as one native batch. |
| `read` | Read local text or images. |
| `bash` | Run a shell command. |
| `edit` | Apply Pi text replacements or an OMP native patch. |
| `write` | Write text to a file. |
| `transfer` | Move files between ChatGPT and Pi, copy between Pi sessions, or export a Pi image. |

## Sessions

Call `init` at the start of local work. Without `sessionId`, it reuses the conversation's saved default or selects an online Pi session with no saved ChatGPT binding. Pass a Pi session ID to resume a specific task, including from another ChatGPT conversation or branch. Read recent `history` to recover progress before continuing the current task.

When `globalAgents` is present, read and follow the instructions at `globalAgents.path` on the selected Pi session. Follow the participation guidance in `initialization.instructions`.

`sessions` lists connected sessions with their ID, host (`pi` or `omp`), agent directory, device, working directory, name, execution status, and binding count. The list is a broker snapshot and does not wait for a host inspection. The first execution tool call establishes the default using its `sessionId` or an online session with no saved bindings. Once a default exists, another tool's `sessionId` selects only that operation's target; `init({ sessionId })` changes the default.

Several ChatGPT conversations can use the same Pi session. One conversation can also operate on several Pi sessions explicitly. Requests already assigned to a session continue there even if the conversation later changes its default.

Remote Pi sessions appear in the same list when they connect through `listen` and `connect` with mutual TLS configured on both devices. Their tools, global `AGENTS.md`, files, images, and Pi interfaces come from the remote device.

Host-session switches reject queued work for the old session instead of
retargeting it. Late results retain their original session and directory.
Offline selection waits at most five seconds; inspection waits at most three
seconds. An explicit target is never replaced with another project.

## History

`history` reads the current branch of a Pi session. It uses the saved default or an explicit `sessionId`, independently of default-session selection.

```json
{ "sessionId": "<session-id>", "limit": 20, "before": "<entry-id>" }
```

Omit `before` for the latest entries. Use `after` to read forward from an entry. Both fields can delimit a range, with the named entries outside the returned range. The default limit is 20 readable entries. Results follow branch order and contain each entry's original ID and timestamp. `hasMore` indicates additional entries in the requested direction.

To follow progress, pass `after` with `wait: true`. Available entries return immediately; at the end of the branch, the request waits up to 30 seconds for new readable entries. A timeout returns an empty page. Reads with `before` return immediately. Cancellation, disconnection, or an invalidated branch cursor ends the request. Waiting for history leaves the session available for other requests.

Set `observer: true` to read as an observer. New messages and work activity wake waiting readers; idle status alone does not indicate task completion.

History includes saved messages, tool calls and results, summaries, images, file references, and work activity. File references are records, not new attachments; reading history does not re-export files. Truncation notices and full-output paths are included so complete output can be read when needed. Reading history leaves new input and pending results available for normal delivery.

## Participation

The executing assistant uses `chat` to share progress and completion in Pi. When initialization directs an assistant to observe, it follows that work through `history` with `observer: true` and `wait: true`, thinks independently, and leaves the completion response to the original execution. Observers must not repeat exports or post a second completion response.

## Pi tools

ChatGPT truncates tool responses exceeding 10,000 tokens.

`read`, `bash`, `edit`, `write`, and `transfer` are available directly. `init` includes a short catalog of the active Pi tools; use `tools` for their complete definitions and `call` to invoke extension tools.

For OMP, direct `read` translates `offset`/`limit` and preserves native snapshot
anchors. Direct `edit` accepts `patch` containing the exact native patch format
returned by `read`/`tools`; it does not synthesize anchors from Pi text edits.
`call` always takes native arguments. Tool definitions that cannot be converted
to JSON Schema report `schemaError` instead of silently omitting their contract.

Chappie is a ChatGPT-controlled transport, not a general-purpose inference API.
OMP requests must belong to a live session through its request hook and session
ID. Auxiliary model prompts, such as title generation, cannot borrow that
session's pending response. No other model is selected automatically. Creating
an OMP task does not create a ChatGPT conversation or provide autonomous child
inference; each Chappie session still needs an explicit ChatGPT controller.

For example:

```json
{ "names": ["ask_user", "ctx_search"] }
```

A `call` array is one Pi tool batch:

```json
{
  "calls": [
    { "name": "read", "arguments": { "path": "package.json" } },
    { "name": "read", "arguments": { "path": "src/index.ts" } }
  ]
}
```

Pi controls execution inside that batch. Separate requests run in order within one Pi session, while different Pi sessions can work independently. Extension tools retain their native Pi behavior, including interactive interfaces.

`chat` creates a normal assistant message in Pi:

```json
{ "text": "Updated the parser and its callers." }
```

Pi user input consumed during the work accompanies later Chappie results, including images.

If cancellation or a broken broker connection interrupts result delivery, late results can accompany a later response to the originating ChatGPT conversation. A broker restart reloads operation receipts, but an agent process exit cannot recover unfinished in-memory work automatically. Check history before retrying a state-changing operation. Long-running local work is better run through the environment's persistent process facilities instead of occupying one tool request.

The active model remains the current ChatGPT conversation. Starting another `chappie/chatgpt` agent inside Pi does not create another browser conversation; tools that need another model should use a separately configured provider.

## Webpage questions

When enabled, `ask` saves a question and requests a widget in ChatGPT, returning its ID immediately. Display depends on the host:

```json
{
  "header": "Export format",
  "question": "Which export format should the command use?",
  "context": "Both preserve the required data.",
  "options": [
    { "title": "JSON", "description": "Convenient for programs.", "recommended": true },
    { "title": "CSV", "description": "Convenient for spreadsheets." }
  ]
}
```

Call `ask_assert` with the returned ID to confirm that the widget loaded:

```json
{ "questionId": "<question-id>" }
```

If the widget has not loaded within 10 seconds, `ask_assert` fails and saves the unanswered question as skipped. Use a Pi interactive tool when an answer is needed. The user can still answer or edit the saved question when its widget is available.

Answers, revisions, and skips arrive later as `webAnswer` in normal Chappie results. `options` can be omitted for a text answer, and `allowMultiple: true` allows several choices. `sessionId` associates the question with a Pi session using the session selection rules above.

Questions remain available after the assistant response and across broker restarts. Pi's own interactive tools remain ordinary Pi tools and can be invoked through `call`.

## Files

Supply a stable `operationId` when calling `transfer` from ChatGPT. Keep it
unchanged when the same operation resumes after approval or a connection retry;
use a new ID for a new user request. Replays return a receipt without repeating
execution or attaching files again. An uncertain receipt requires checking the
original work, not automatically retrying it. Completed receipts are retained for
24 hours; unresolved receipts are not evicted automatically. ChatGPT still owns
approval prompts and final response rendering. The broker does not suppress or bypass host approvals. Each state file retains at most 16,384 operation receipts and fails closed when unresolved work fills that limit.

`transfer.paths` always names paths or image references on the Pi side. Relative paths resolve from the selected Pi session's working directory; absolute paths and `~/` are accepted.

A completed replay receipt confirms native execution, not attachment receipt.
Its `delivery.resources` preserves the original references without attaching them
again. `sourceReadAt`, when present, records a successful broker-side source read;
`hostReceipt` remains `unconfirmed` because that does not prove ChatGPT saved it.
Older receipts may lack references; inspect history instead of recreating work.

For an explicitly requested missing-file recovery, pass the original resource URI
to `transfer.paths`, with a stable `operationId` for that separate delivery request.
This reuses the registered resource, not the source command or a new export of the
path. Approval resumes reuse that same ID. Do not do this automatically or after
an approval denial. If the reference expired or its source changed, recovery fails
without regenerating the file or repeating the original task.

### ChatGPT to Pi

Pair Pi destinations with ChatGPT files:

```json
{
  "operationId": "import-reference-and-data-1",
  "paths": ["assets/reference.png", "data/input.csv"],
  "files": ["/mnt/data/reference.png", "/mnt/data/input.csv"]
}
```

The ChatGPT host turns the cloud paths or attachment references into downloadable file objects before the call reaches Chappie. Use the direct `transfer` tool for these imports; nesting cloud file references inside `call` does not apply the same file conversion. Parent directories are created as needed.

Existing targets produce an error by default. Use `overwrite: true` when replacement is intended:

```json
{
  "operationId": "replace-reference-1",
  "paths": ["assets/reference.png"],
  "files": ["/mnt/data/reference.png"],
  "overwrite": true
}
```

Downloads are staged before replacement. A failed or cancelled member leaves its previous destination untouched. Multi-file results retain each success or error and set `isError`/`details.failed` when any member failed; successful files are not rolled back. Transfers accept at most 128 paths.

### Pi to ChatGPT

Omit `files` to export existing Pi files:

```json
{ "operationId": "export-build-1", "paths": ["build/output.zip", "renders/preview.png"] }
```

Chappie returns MCP resource links. ChatGPT retrieves the bytes when it materializes those resources, which can require user confirmation. A resource remains associated with the Pi session that exported it, so that Pi process and source file need to remain available until the bytes are read.

If an exported source changes, reading it fails rather than returning mixed or
truncated bytes. A new export requires a new user intent and operation ID.
History and delayed results contain references, not new download attachments.
Full reads are limited to 32 MiB; session copies use 1 MiB chunks. Registrations
expire after one hour without access and share a 512-entry budget. Cached image
bytes are limited to 64 MiB. Expired or evicted references must be re-exported
explicitly. For a directory, create an archive with a Pi tool first.

### Pi to Pi

Supply `to` to copy files to another connected Pi session:

```json
{
  "operationId": "copy-build-1",
  "sessionId": "<source-session>",
  "paths": ["build/output.zip"],
  "to": {
    "sessionId": "<destination-session>",
    "paths": ["downloads/output.zip"]
  }
}
```

Source and destination paths correspond by position. Each session resolves its own relative paths, absolute paths, and `~/`. Image references can also be copied. `files` and `to` select different sources and are mutually exclusive.

Both Pi sessions need to stay connected during the transfer. `overwrite: true` replaces an existing destination. Cancellation or failure discards the incomplete file; successfully copied files remain available.

### Images

`read` and Pi tool results send images directly to ChatGPT for visual inspection. Chappie also returns a `chappie://` image reference with Pi images. Pass that reference to `transfer.paths` when the same bytes are needed as a file in ChatGPT's cloud environment.

Use the original local path with `transfer` when the original image file is required; Pi can resize or convert images used only for display.
