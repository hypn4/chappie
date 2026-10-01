# Tools

Chappie targets native Oh My Pi (OMP) 18.4.8+ and MCP 2.0 (`2026-07-28`).
Legacy MCP handshakes and the standalone Pi host are not supported.

| Tool | Purpose |
|---|---|
| `init` | Select this ChatGPT conversation's default OMP session and read its environment. |
| `history` | Read the current OMP branch with timestamps and entry IDs. |
| `sessions` | List connected OMP sessions and the current default. |
| `tools` | Read full definitions of active OMP tools for `call`. |
| `chat` | Send an assistant message to OMP. |
| `ask` | Create a persistent question in ChatGPT. |
| `ask_assert` | Confirm that an `ask` widget loaded. |
| `call` | Run one or more OMP tools as one native batch and wait for completion. |
| `start_call` | Durably start a native OMP tool batch without keeping the ChatGPT MCP request open. |
| `get_operation` | Read durable operation status and the retained native result, including after acknowledgement. |
| `cancel_operation` | Explicitly request cancellation of a detached native batch. |
| `read` | Read local text or images. |
| `bash` | Run a shell command. |
| `edit` | Apply an OMP native hashline patch through `input`. |
| `write` | Write text to a file. |
| `transfer` | Move files between ChatGPT and OMP, copy between OMP sessions, or export a OMP image. |

## Sessions

Call `init` at the start of local work. Without `sessionId`, it reuses the conversation's saved default when that binding has been used within the last 30 days, or selects an online OMP session with no saved ChatGPT binding. Pass a OMP session ID to resume a specific task, including from another ChatGPT conversation or branch. Read recent `history` to recover progress before continuing the current task.

When `globalAgents` is present, read and follow the instructions at `globalAgents.path` on the selected OMP session. Follow the participation guidance in `initialization.instructions`.

`sessions` reports host `omp`, session ID, agent directory, device, cwd, name, execution status and binding count. It is a broker snapshot and does not wait for inspection. Bindings use the current timestamped object format; idle entries are pruned after 30 days. Obsolete string-only bindings are rejected without rewriting the state file. Preserve operation receipts during any offline migration; deleting them can allow duplicate side effects. An explicit `sessionId` chooses only the current operation; `init({ sessionId })` changes the saved default.

Several ChatGPT conversations can use the same OMP session. One conversation can also operate on several OMP sessions explicitly. Requests already assigned to a session continue there even if the conversation later changes its default.

Remote OMP sessions appear in the same list when they connect through `listen` and `connect` with mutual TLS configured on both devices. Their tools, global `AGENTS.md`, files, images, and OMP interfaces come from the remote device.

Host-session switches reject queued work for the old session instead of
retargeting it. Late results retain their original session and directory.
Offline selection waits at most five seconds; inspection waits at most three
seconds. An explicit target is never replaced with another project.

## History

`history` reads the current branch of a OMP session. It uses the saved default or an explicit `sessionId`, independently of default-session selection.

```json
{ "sessionId": "<session-id>", "limit": 20, "before": "<entry-id>" }
```

Omit `before` for the latest entries. Use `after` to read forward from an entry. Both fields can delimit a range, with the named entries outside the returned range. The default limit is 20 readable entries. Results follow branch order and contain each entry's original ID and timestamp. `hasMore` indicates additional entries in the requested direction.

To follow progress, pass `after` with `wait: true`. Available entries return immediately; at the end of the branch, the request waits up to 30 seconds for new readable entries. A timeout returns an empty page. Reads with `before` return immediately. Cancellation, disconnection, or an invalidated branch cursor ends the request. Waiting for history leaves the session available for other requests.

Set `observer: true` to read as an observer. New messages and work activity wake waiting readers; idle status alone does not indicate task completion.

History includes saved messages, tool calls and results, summaries, images, file references, and work activity. File references are records, not new attachments; reading history does not re-export files. Truncation notices and full-output paths are included so complete output can be read when needed. Reading history leaves new input and pending results available for normal delivery.

## Participation

The executing assistant uses `chat` to share progress and completion in OMP. When initialization directs an assistant to observe, it follows that work through `history` with `observer: true` and `wait: true`, thinks independently, and leaves the completion response to the original execution. Observers must not repeat exports or post a second completion response.

## OMP tools

ChatGPT truncates tool responses exceeding 10,000 tokens.

`read`, `bash`, `edit`, `write`, and `transfer` are available directly. `init` includes a short catalog of the active OMP tools; use `tools` for their complete definitions and `call` to invoke extension tools.

Direct tools use native OMP arguments without host translation. `read` accepts selectors in `path`, such as `file.ts:20-40`; its preview and snapshot anchors are OMP's own. `edit` requires the native hashline string in `input`. The `patch` alias, Pi exact-text replacements, and `offset`/`limit` read aliases are removed. `call` and `start_call` require JSON `calls`; there is no Base64 alternative. Invalid native schema conversion is reported as `schemaError`, never silently omitted.

Chappie is a ChatGPT-controlled transport, not a general-purpose inference API.
OMP provider requests must belong to a live session through its request hook and
session ID. Chappie relays the recognized OMP compaction and branch-summary
requests as `modelRequest` input with an independent request ID; answer those
with `chat({ replyTo: modelRequest, ... })`. Unrecognized auxiliary prompts
cannot borrow the session's primary response. No other model is selected
automatically. Creating an OMP task does not create a ChatGPT conversation or
provide autonomous child inference; each Chappie session still needs an explicit
ChatGPT controller.

For example:

```json
{ "names": ["ask_user", "ctx_search"] }
```

A `call` array is one OMP tool batch:

```json
{
  "calls": [
    { "name": "read", "arguments": { "path": "package.json" } },
    { "name": "read", "arguments": { "path": "src/index.omp.ts" } }
  ]
}
```


OMP controls execution inside that batch. Separate requests run in order within one OMP session, while different OMP sessions can work independently. Extension tools retain their native OMP behavior, including interactive interfaces.

### Long-running operations

`call` keeps the ChatGPT MCP request open until the native OMP batch completes. For work that may outlive a host request deadline, use `start_call` instead:

```json
{
  "operationId": "build-release-2026-10-01",
  "calls": [
    { "name": "bash", "arguments": { "command": "./long-running-build" } }
  ]
}
```

`operationId` is stable within the ChatGPT conversation. The broker persists its receipt before native execution begins, detaches execution from the originating MCP request signal, and returns without waiting for the native batch. Repeating the same ID with identical arguments returns the existing operation, even when the original session is offline; changing arguments or an explicitly selected session is rejected. Explicit operation IDs are not automatically forgotten: a full receipt store rejects new work rather than silently allowing a side effect to run twice.

Read the state later with:

```json
{ "operationId": "build-release-2026-10-01" }
```

`get_operation` returns `running`, `completed`, `failed`, `cancelled`, or `uncertain`. `completed` means the native OMP/OMP tool batch returned, not that every result was successful: inspect native `isError` and tool details. If a tool starts a separate background job or supervised process, observe or wait for that child job with the host's facilities. Batch completion must not be reported as child-job completion.

Full detached results remain available through `get_operation` after their first deferred delivery is acknowledged. They are retained for at least 24 hours after completion and while an associated subscription remains active; execution receipts are kept separately to prevent re-execution after result expiry. Retained results are bounded to 2,048 entries and the complete state file to 32 MiB. A source resource reference does not make the broker the owner of its file bytes.

`cancel_operation` is an explicit request to cancel the native batch. Ending the original ChatGPT MCP request does not cancel accepted detached work. Cancellation does not roll back side effects already performed or promise to stop independently supervised child processes. A broker or agent process exit can still interrupt native work: restart reloads unfinished receipts as `uncertain`, and retained native completion can reconcile them. Check history rather than re-running an uncertain state-changing operation.

Do not send heartbeat or rapidly poll to extend a ChatGPT tool request. Detach the native batch, and use persistent process supervision separately when the process itself must survive the agent or broker exiting.

### ChatGPT completion events

Chappie implements the [OpenAI MCP Events webhook profile](https://developers.openai.com/plugins/build/mcp-events), requiring MCP 2.0 (`2026-07-28`). Modern `server/discover` advertises `events`; the same authenticated endpoint implements `events/list`, `events/subscribe`, and `events/unsubscribe`. Legacy clients retain ordinary tool calls and `get_operation`, without a false Events capability claim.

The event is `operation.finished`, filtered by `{"operation_id":"<start_call operationId>"}`. It contains a bounded terminal-state summary, not the entire tool result. The subscribed ChatGPT conversation retrieves the full output with `get_operation`. The first subscription to an already-finished operation queues its retained terminal snapshot so a fast completion cannot race subscription creation.

The state store records terminal completion and matching outbox entries in the same snapshot. A persisted per-subscription event marker prevents refresh, replay, or restart from recreating an acknowledged event. HTTP delivery remains **at least once**, not exactly once: failed responses can cause retries with the same event ID. A `2xx` response acknowledges webhook receipt, not completion of ChatGPT's processing.

Callbacks require HTTPS, public destination validation on every connection, checked-address pinning with the original TLS hostname, and no redirects. Verification uses a signed random challenge. Standard Webhooks signatures cover exact serialized bytes; key replacement has a five-minute dual-signing window. Transient failures use bounded exponential retries with jitter. `410` stops the subscription; `413` and permanent failures are not retried and retain a delivery-failure record. The delivery pump runs only for pending events or scheduled retries, not as a heartbeat.

Subscriptions default to 24 hours, grant at most 30 days for a finite `ttlMs`, and allow `ttlMs: null` without expiration. Expiry, unsubscribe, or loss of operation access stops delivery; an HTTP request whose bytes were already sent cannot be retracted. Callback secrets live only in the private host state file and must never be logged or committed.

This is separate from the optional [MCP Tasks extension](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks). The installed TypeScript SDK's actual protocol boundary rejected the attempted Tasks V2 methods/results. Chappie therefore does **not** advertise `io.modelcontextprotocol/tasks`, return a pretend Task handle, or bypass SDK validation. `start_call` is an application tool returning a normal supported MCP result; completion notification uses the documented ChatGPT Events path.

After deployment, rescan the plugin, confirm `operation.finished` appears, and create an authorized subscription in ChatGPT. Only then can completion arrive without another user message. Server/protocol tests and a successful callback response alone do not verify ChatGPT wake-up or subsequent model behavior; that final subscription lifecycle must be tested in the deployed host. No callback URL or signing secret should be invented by a model.

`chat` creates a normal assistant message in OMP:

```json
{ "text": "Updated the parser and its callers." }
```

When a result contains `modelRequest`, use its ID as `replyTo` instead of
starting a normal OMP turn:

```json
{ "text": "Compacted summary...", "replyTo": "<modelRequest-id>" }
```

OMP user input consumed during the work accompanies later Chappie results, including images.

If cancellation or a broken broker connection interrupts ordinary result delivery, late results can accompany a later response to the originating ChatGPT conversation. A broker restart reloads operation receipts, but an agent process exit cannot recover unfinished in-memory work automatically. Check history before retrying a state-changing operation. Use `start_call` for a native batch that may outlive one ChatGPT MCP request; use the environment's persistent process facilities when the underlying process itself must outlive the agent session.

The active model remains the current ChatGPT conversation. Starting another `chappie/chatgpt` agent inside OMP does not create another browser conversation; tools that need another model should use a separately configured provider.

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

If the widget has not loaded within 10 seconds, `ask_assert` fails and saves the unanswered question as skipped. Use a OMP interactive tool when an answer is needed. The user can still answer or edit the saved question when its widget is available.

Answers, revisions, and skips arrive later as `webAnswer` in normal Chappie results. `options` can be omitted for a text answer, and `allowMultiple: true` allows several choices. `sessionId` associates the question with a OMP session using the session selection rules above.

Questions remain available after the assistant response and across broker restarts. OMP's own interactive tools remain ordinary OMP tools and can be invoked through `call`.

## Files

Supply a stable `operationId` when calling `transfer` from ChatGPT. Keep it
unchanged when the same operation resumes after approval or a connection retry;
use a new ID for a new user request. Retries never repeat an already accepted
native operation. Concurrent retries in the same broker process share the
in-flight result; later completed retries return a machine-readable replay
receipt and normal conversation may continue. An uncertain receipt requires
checking the original work instead of automatically retrying it. Completed
receipts are retained for 24 hours; unresolved receipts are not evicted
automatically. ChatGPT still owns approval prompts and final response rendering.
Each state file retains at most 16,384 operation receipts and fails closed when
unresolved work fills that limit.

ChatGPT file download URLs are accepted only through the direct host-provided
`transfer.files` boundary. Generic `call` and session-to-session relay paths
cannot inject arbitrary download URLs; remote collaboration uses broker-owned
session identity and stable operation receipts instead.

`transfer.paths` always names paths or image references on the OMP side. Relative paths resolve from the selected OMP session's working directory; absolute paths and `~/` are accepted.

A completed replay confirms native execution, not attachment receipt. Its
`delivery.resources` preserves the original resource descriptors. If the host
has not read an exported resource yet, Chappie may expose the same original
resource link again on replay without rerunning the export. `sourceReadAt`, when
present, records a successful broker-side source read; after that point Chappie
stops automatic replay attachment. `hostReceipt` remains `unconfirmed` because
a source read does not prove ChatGPT saved or displayed the file. Older receipts
may lack references; inspect history instead of recreating work.

For an explicitly requested missing-file recovery, pass the original resource URI
to `transfer.paths`, with a stable `operationId` for that separate delivery request.
This reuses the registered resource, not the source command or a new export of the
path. Approval resumes reuse that same ID. Do not do this automatically or after
an approval denial. If the reference expired or its source changed, recovery fails
without regenerating the file or repeating the original task.

### ChatGPT to OMP

Pair OMP destinations with ChatGPT files:

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

### OMP to ChatGPT

Omit `files` to export existing OMP files:

```json
{ "operationId": "export-build-1", "paths": ["build/output.zip", "renders/preview.png"] }
```

Chappie returns MCP resource links. ChatGPT retrieves the bytes when it materializes those resources, which can require user confirmation. A resource remains associated with the OMP session that exported it, so that OMP process and source file need to remain available until the bytes are read.

If an exported source changes, reading it fails rather than returning mixed or
truncated bytes. A new export requires a new user intent and operation ID.
History and delayed results contain references, not new download attachments.
Full reads are limited to 32 MiB; session copies use 1 MiB chunks. Registrations
expire after one hour without access and share a 512-entry budget. Cached image
bytes are limited to 64 MiB. Expired or evicted references must be re-exported
explicitly. For a directory, create an archive with a OMP tool first.

### OMP to OMP

Supply `to` to push files from the selected source session to another
connected session:

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

Or select the destination session and use `from` to pull files from another
connected session:

```json
{
  "operationId": "pull-build-1",
  "sessionId": "<destination-session>",
  "paths": ["downloads/output.zip"],
  "from": {
    "sessionId": "<source-session>",
    "paths": ["build/output.zip"]
  }
}
```

Source and destination paths correspond by position. Each session resolves its
own relative paths, absolute paths, and `~/`. Image references can also be
copied. `files`, `from`, and `to` select different transfer directions and
are mutually exclusive.

Both OMP sessions need to stay connected during the transfer. `overwrite: true`
replaces an existing destination. Cancellation or failure discards the
incomplete file; successfully copied files remain available.

### Images

`read` and OMP tool results send images directly to ChatGPT for visual inspection. Chappie also returns a `chappie://` image reference with OMP images. Pass that reference to `transfer.paths` when the same bytes are needed as a file in ChatGPT's cloud environment.

Use the original local path with `transfer` when the original image file is required; OMP can resize or convert images used only for display.
