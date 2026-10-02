# Tools

Chappie targets native Oh My Pi (OMP) 18.4.8+ and MCP 2.0 (`2026-07-28`).
Legacy MCP handshakes and the standalone Pi host are not supported.

| Tool | Purpose |
|---|---|
| `init` | Select this ChatGPT conversation's default OMP session and return compact native-tool and Skill shortlists. |
| `history` | Read the current OMP branch with timestamps and entry IDs. |
| `sessions` | List connected OMP sessions and the current default. |
| `tools` | Read current full definitions of selected active OMP tools, including registered MCP-backed tools. |
| `chat` | Report progress without ending a turn; use `mode: "message"` for an intentional assistant turn or `replyTo` for a model request. |
| `ask` | Create a persistent question in ChatGPT. |
| `ask_assert` | Confirm that an `ask` widget loaded. |
| `call` | Run one or more OMP tools as one native batch and wait for completion. |
| `start_call` | Durably start a native OMP tool batch without keeping the ChatGPT MCP request open. |
| `get_operation` | Read operation status with `operationId`, or losslessly page a retained tool response with `resultId` and `offset`. |
| `cancel_operation` | Explicitly request cancellation of a detached native batch. |
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

History includes saved messages, tool results, summaries, image/file references and work activity. It never cuts an entry in half. A native page can stop between entries; `hasMore` means there are other entries addressable by `before`/`after`. An oversized single entry is retained intact by the final response layer and is read using `resultId` pages, whose own `hasMore` and `nextOffset` describe text-fragment continuation. Reading history does not acknowledge pending inputs or re-export files.

## Chat control loop

The current ChatGPT conversation is the planner. `turn_end` returns one native batch promptly so ChatGPT can select the next call; it does not end ChatGPT's user-facing turn. A successful batch, `operation.status=completed`, progress report or empty TODO is not proof that the requested multi-step goal is complete. `start_call` detaches one batch, not an autonomous workflow.

For a request to finish all work, keep the approved scope and acceptance conditions in the configured tracker/checkpoint. After every result: recover any `resultId` pages, handle model obligations or failures, inspect the remaining scoped work when needed, and issue the next authorized native call in the same Chat. Use interim commentary instead of a premature final answer. Stop at verified completion, an explicit stop/redirection, denied approval, or a genuine blocker; preserve the checkpoint when the host or an external dependency prevents continuation. Never expand one requested task to unrelated repository issues or shared-session TODOs.

`init`, selected tool inspection and native results may include a `work` observation with `source: "omp_todo"`, `scope: "session"`, `observedAt`, a state and counts. OMP's canonical branch reader is authoritative; Chappie does not cache, mutate or duplicate its task board. States are `actionable` (pending/in-progress), `blocked`, `settled`, `untracked`, or `unknown`. Settled includes abandoned items and does not certify tests, acceptance or user-scope completion. Retrieve the current native TODO for titles/details. A retained/replayed observation is historical, not a live tracker query.

Execution/progress results include `continuation: { scope, userGoal: "not_evaluated", nextAction }`. Cues distinguish answering a model request, inspecting an operation/failure, reconciling uncertain or cancelled work, continuing requested work, reviewing blockers and verifying the requested scope. They are observations and controller guidance, not executable commands or authorization. No server response can force ChatGPT to issue its next tool call, intercept its final answer, or wake an ended ordinary Chat.

## Participation

The executing assistant uses `chat` (default `mode: "progress"`) for intermediate updates. Progress is an acknowledged native notice, not a provider stop or a new turn. Use `mode: "message"` only for an intentional assistant message/turn; it does not certify completion of the whole user goal. When initialization directs an assistant to observe, it follows that work through `history` with `observer: true` and `wait: true`, thinks independently, and leaves the completion response to the original execution. Observers must not repeat exports or post a second completion response.

## OMP Skills and tools

Chappie applies a 32 KiB UTF-8 byte budget to final tool-result JSON, including text mirrored into `structuredContent`. This is an application policy, not a guarantee about any host/model token limit or final rendering.

`init` returns every active tool and Skill in compact form. Tool summaries and Skill descriptions contain at most 512 characters; Skills expose a normalized name and `skill://` URI rather than filesystem paths. Large catalogs are not prefix-truncated: they use the same lossless `resultId` continuation described below. This makes every name discoverable without already knowing it. Read only relevant Skills, then obtain selected live tool definitions through `tools(names)`.

Before first use of a native tool whose full definition is not already available for the current session, request it with `tools({ names: [...] })`; request several candidate definitions together when choosing between tools. Registered OMP MCP tools appear in the same native catalog and are first-class capabilities. Prefer a specialized native/MCP capability over reproducing it with `bash`, `eval`, generic text search, manual HTTP calls, or a generic web path when the specialized integration materially matches the task. Explicit user/project instructions take precedence over Skill/tool guidance.

Skills guide workflows; native definitions govern execution. Reuse a full definition while the target session and native toolset remain unchanged. Refresh after changing sessions/toolsets or after an unavailable/schema error. Definitions are read from the current session on every discovery request; there is no broker-side native schema cache. Never infer arguments from the shortlist, guess old aliases, or switch to a broader tool solely to bypass validation or approval.

Use `call` or `start_call` for every native coding tool. Chappie validates only the bounded JSON batch envelope; OMP owns each tool's arguments, validation, permissions, anchors and execution. Batch only calls whose arguments are already known and belong to the same native turn. If a later call needs an earlier result (for example, discover a path, then read it, then edit using returned anchors), use separate `call` requests. Inspect every native result before continuing; `isError` or native failure details mean the batch did not fully succeed. `transfer` remains directly exposed because ChatGPT supplies its file objects and handles exported resources. Unsupported schema conversion is reported as `schemaError`; refresh the definition instead of guessing a replacement schema or encoding a rejected command.

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
{ "names": ["read", "edit"] }
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

### Model-input waits

When OMP is waiting for a recognized compaction or branch-summary reply, a new `call` or `chat` with `mode: "message"` returns `execution: { status: "needs_input", executed: false, reason: "model_request_pending" }` and the `modelRequest` input. The native `remote_call` and `remote_chat` relay paths preserve exactly the same nonterminal state; an empty tool-results list is not completion. Reply with `chat({ sessionId, replyTo: modelRequest, text })` (or native `remote_chat`), then retry only that unexecuted batch with its original identity and unchanged arguments. Calls queued before a model request begins receive the same feedback. Reading or acknowledging input does not discharge OMP's reply obligation. This known-unexecuted wait is normal flow-control feedback (`isError: false`), not successful native execution; `execution.executed` stays false and `continuation.nextAction` requests the model reply. A progress report can be acknowledged while that obligation remains outstanding. Actual native tool failures still set `isError: true`.

For `start_call`, this feedback persists as `waiting_input`; `get_operation` returns the saved model inputs. Answer the current request and explicitly repeat the same `start_call` ID and arguments. Simultaneous identical retries dispatch one batch; conflicting arguments are rejected even during acceptance. A saved model input can be stale after a reply, reconnection, or session switch: inspect current `tools`/inputs before replying. A retry stays on its original session.

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

`operationId` is stable within the ChatGPT conversation while its receipt is retained. The broker persists the receipt before native execution begins, detaches execution from the originating MCP request signal, and returns without waiting for the native batch. Repeating the same ID with identical arguments returns the existing operation, even when its original session is offline, except that a known-unexecuted `waiting_input` attempt may be explicitly resumed on its original online session. Changing arguments or target is rejected. Terminal receipts retire as described below; unresolved receipts are not evicted, and a full store rejects new work instead of discarding unresolved execution state.

Read the state later with:

```json
{ "operationId": "build-release-2026-10-01" }
```

`get_operation` returns `running`, `waiting_input`, `completed`, `failed`, `cancelled`, or `uncertain`. `completed` means the native OMP batch returned, not that every result succeeded: inspect native `isError` and tool details. If a tool starts a separate background job or supervised process, use the host's native facilities to observe that child job. Batch completion is not child-job completion.

Full detached results remain available through `get_operation(operationId)` after pending-delivery acknowledgement. Terminal receipts and results are retained for 24 hours. Within that window, an identical logical ID replays the accepted operation and conflicting arguments are rejected. After retirement, a fresh acceptance gets a new persisted `executionId`; native requests and deferred results must match that execution, so delayed output cannot complete a successor with the same logical ID. `waiting_input` resumes the same acceptance rather than generating a new one. Unresolved running/waiting/uncertain receipts are not automatically evicted.

`cancel_operation` owns cancellation from the start of initial acceptance or a `waiting_input` reclaim, including while the receipt is being persisted. Cancellation before dispatch prevents later native execution. Cancelling a waiting operation does not abort its independent model request. Ending the original MCP request does not cancel accepted detached work. Cancellation cannot undo side effects or promise to stop independent child processes. Request-cancel notices report `executionPhase`: queued work was removed before dispatch; in-flight/result-pending work may already have effects. A reason such as `Request ended` is the upstream abort reason, not proof of edit rollback or a diagnosis of why the host ended the request. Inspect history and files before deciding whether any further action is safe. Broker recovery marks interrupted running receipts `uncertain`; known-unexecuted waits stay resumable. Reconcile uncertain work rather than re-executing it.

Do not send heartbeat or rapidly poll to extend a ChatGPT tool request. Detach the native batch, and use persistent process supervision separately when the process itself must survive the agent or broker exiting.

### Chat continuation

Chappie targets ordinary ChatGPT Chat and does not advertise MCP Events or Tasks. The broker cannot proactively wake a Chat after the current turn ends. Long-running work therefore relies on durable operation receipts, retained results, pending delivery on later Chappie interactions, and explicit `get_operation`/`history` recovery.

If a detached operation reaches `waiting_input` after the initiating turn has ended, the next Chat interaction must retrieve the saved model input, answer it with `chat.replyTo`, and explicitly resume the unchanged operation. Never create heartbeat loops, webhook callbacks, or a new operation ID to simulate proactive continuation.

`chat` defaults to a non-terminating progress notice in OMP:

```json
{ "text": "Updated the parser; continuing the remaining checks.", "mode": "progress" }
```

Use `{ "text": "Requested scope verified.", "mode": "message" }` for an intentional assistant turn after checking the current scope. `replyTo` implies message mode; combining it with progress is rejected. Existing native OMP-to-OMP `remote_chat` remains a message by default. Broker and extension must be updated together, and the public tool schema refreshed after deployment.

When a result contains `modelRequest`, use its ID as `replyTo` instead of
starting a normal OMP turn:

```json
{ "text": "Compacted summary...", "replyTo": "<modelRequest-id>" }
```

OMP user input, deferred results and webpage answers accompany later Chappie responses. Acknowledgement happens only after a successful bounded response write. For oversized data, the full response must first be atomically persisted; a small durable reference can then be delivered and acknowledged without losing the original content. A failed write or failed snapshot save leaves pending data unacknowledged. Transport success is not proof that a person or model inspected the content.

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

## Bounded result continuation

A large response from any core tool returns a reference rather than losing text:

```json
{ "resultId": "<64-hex-id>", "next": { "resultId": "<64-hex-id>", "offset": 0 } }
```

Call `get_operation({ resultId, offset: 0 })`, then use each returned `nextOffset` while `hasMore` is true. Concatenate the `text` fragments in order and parse the resulting JSON to recover the original tool result, including its original content blocks and native resource references. Offsets count JavaScript string code units, not bytes; follow the returned offsets rather than calculating them. Pages do not execute OMP tools, change session ownership, acknowledge new input, or recreate attachments. The same page is repeatably readable.

Snapshots live in the broker's private `chappie.results` directory, are scoped to the originating Chat conversation, and are checked against their content hash. They expire 24 hours after first creation; re-reading does not renew them. Capacity is 128 snapshots / 256 MiB total, with a 128 MiB per-snapshot ceiling. New saves remove expired snapshots, never unexpired ones to make room. Capacity or persistence errors fail without acknowledging pending data. These bounds do not imply survival of a power failure or receipt by ChatGPT's UI.

Large image blocks are preserved in the saved JSON rather than silently discarded, but a JSON-fragment page is not an inline image renderer. Use the recovered original `piImage`/resource URI with the existing `transfer` path when the host needs the original attachment. Resource lifetimes and source-session ownership remain separate from response-snapshot retention. Small widget state remains inline when unrelated pending text is paged; oversized widget metadata fails clearly rather than exceeding the response limit.

## Contributor quality standard

Review/test coverage, completion stages, decision records and cold-start recovery are maintained in the repository's [quality standard](quality.md). The [maintainer architecture](architecture.md) records why the execution, ownership and response boundaries exist. This tool guide remains the source for observable product behavior, not a second task ledger.
