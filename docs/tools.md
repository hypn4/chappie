# Tools

Chappie targets native Oh My Pi (OMP) 18.4.8+ and MCP 2.0 (`2026-07-28`).
Legacy MCP handshakes and the standalone Pi host are not supported.
The supported peer minimum remains 18.4.8 within 18.x; the current development
and CI verification baseline is 18.5.0. These are separate support and test policies.

| Tool | Purpose |
|---|---|
| `init` | Select this ChatGPT conversation's default OMP session and return compact native-tool and Skill shortlists. |
| `history` | Read the current OMP branch with timestamps and entry IDs. |
| `sessions` | List connected OMP sessions and the current default. |
| `tools` | Read current full definitions of selected active OMP tools, including registered MCP-backed tools. |
| `chat` | Report progress without ending a turn; use `mode: "message"` for an intentional assistant turn or `replyTo` for a model request. |
| `ask` | Create a persistent question in ChatGPT. |
| `ask_assert` | Confirm that an `ask` widget loaded. |
| `call` | Run a native batch; return fast results inline or yield a durable operation after the wait budget. |
| `start_call` | Durably start a native OMP tool batch without keeping the ChatGPT MCP request open. |
| `get_operation` | Read a known `operationId`, page saved output with `resultId` and `offset`, or discover the conversation's recent receipts with `sessionId`. |
| `cancel_operation` | Explicitly request cancellation of a detached native batch. |
| `transfer` | Move files between ChatGPT and OMP, copy between OMP sessions, or export a OMP image. |

## Storage selection and upgrades

Chappie's home defaults to `~/.chappie`. Both the standalone broker and the OMP
extension resolve its `manifest.json`, whose strict `schemaVersion: 1` format
records `defaultStoreId` and `storeIds`. First initialization atomically creates
one UUID v7 store; later starts reuse it. Invalid manifests and missing registered
store directories fail without silently selecting or creating another identity.

| Setting | Effect |
|---|---|
| `CHAPPIE_HOME` | Select the Chappie home with an absolute path or a `~/`-prefixed path. |
| `CHAPPIE_STORE_ID` | Select a UUID v7 already registered in the manifest; omission uses `defaultStoreId`. |
| `CHAPPIE_PROJECT_ID` | Supply an explicit project UUID for the OMP common-history projection and its cwd alias; this does not select a broker store. |

The local broker and extension must select the same store. Configuration is
`stores/<storeId>/chappie.json`, and TLS certificate paths resolve from that
directory. State, `chappie.results`, `chappie.uncertain` and diagnostics are also
inside the selected store. Unix uses its `chappie.sock`; Windows derives a named
pipe from the resolved store path. A remote extension connects using its own
store's `connect` and mutual TLS configuration.

The broker holds an exclusive writer lock from before state loading until
shutdown finishes its writes. Another live broker cannot take over the store.
A stale lock can be recovered only after the recorded hostname matches and the
PID is confirmed absent; age, `EPERM` and a foreign hostname are not proof of
termination. OMP profiles and agent-directory settings govern native OMP files
and do not change Chappie's selected storage.

The runtime accepts only version 1 state with reference-based results. It has
no `.omp` fallback, automatic inline-result conversion or old-store merge.
Changing `CHAPPIE_HOME` or selecting another registered store does not move
existing receipts. Conversion from the earlier layout is a one-time offline
maintenance operation: stop the writers, work from a verified backup, produce
and validate a complete version 1 store, then select it through the manifest.
Preserve conversation/session ownership, logical and execution IDs, timestamps,
result bodies and hashes, protection metadata and cold replay receipts. Keep
the matched pre-conversion backup for rollback; do not point an older broker
at the converted store or discard receipts to make uncertain work retryable.

## Sessions

Call `init` at the start of local work. Without `sessionId`, it reuses the conversation's saved default when that binding has been used within the last 30 days, or selects an online OMP session with no saved ChatGPT binding. Pass a OMP session ID to resume a specific task, including from another ChatGPT conversation or branch. Read recent `history` to recover progress before continuing the current task.

When `globalAgents` is present, read and follow the instructions at `globalAgents.path` on the selected OMP session. Follow the participation guidance in `initialization.instructions`.

`sessions` reports host `omp`, session ID, native agent directory, device, cwd, name, execution status and binding count. The native agent directory is host provenance, not the Chappie storage location. This is a broker snapshot and does not wait for inspection. Bindings use timestamped objects in the strict version 1 state format; idle entries are pruned after 30 days. Incompatible state is rejected without rewriting it. An explicit `sessionId` chooses only the current operation; `init({ sessionId })` changes the saved default.

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

### Common project history

The OMP extension separately publishes public text snapshots of the current
branch to `projects/<projectId>/sessions/<sessionId>.json` under the Chappie home.
`project-catalog.json` maps stable project UUIDs to canonical cwd aliases.
New project IDs use UUID v7. Supplying `CHAPPIE_PROJECT_ID` records that explicit
project identity for the current cwd, or adds an alias to the same project;
a cwd already assigned to another project is rejected without reassignment.

The JSON format is independent of OMP. `source.agent` records the originating
agent, and `source.sourceSessionId` preserves its native session identity.
Agent names and device names do not partition the directory layout. Each
snapshot keeps original source entry IDs and timestamps, public message/tool
text, summaries, lifecycle times and coverage. The OMP projection omits hidden
control messages, reasoning blocks and private tool metadata, and represents
images with a source-session notice instead of embedding their binary data.
Native transcripts, artifacts, images and session management remain OMP-owned.

| Default saved-history budget | Limit |
|---|---|
| One session snapshot | 16 MiB |
| One project's snapshots | 128 MiB / 512 sessions |
| Snapshots across the Chappie home | 512 MiB / 4,096 sessions |
| Generic publication queue | 64 MiB / 128 pending session snapshots |

The OMP projection supplies at most 2,048 newest whole entries / 16 MiB and
bounds large text and tool arguments before queueing. The generic writer
coalesces progress and keeps newest whole entries that fit the saved-session
budget, including its identity metadata. It does not split a public entry to
make it fit. A large entry can be omitted while other whole entries remain
readable. The coverage fields make that boundary explicit:

| Coverage field | Meaning |
|---|---|
| `sourceEntryCount` | Source-reported number of eligible entries in the captured branch |
| `suppliedEntries` | Entries supplied to the generic history writer |
| `retainedEntries` | Whole entries saved in this snapshot |
| `omittedEntries` | Source entries absent from this snapshot |
| `oversizedEntries` | Entries reported as omitted by source projection limits, plus individually oversized entries rejected by the writer |
| `complete` | Whether the reported source entries were all retained |
| `newestEntryRetained` | Whether the declared newest source entry was retained; without a source ID, this refers to the newest supplied entry |

The OMP publisher carries `sourceNewestEntryId` and `sourceOversizedEntries`
through projection so omitting a large final entry cannot make an older entry
look like the source's latest work. Independent publishers should preserve
these fields when they omit source entries before calling the generic writer.

Quota pressure reclaims eligible finished, non-current histories oldest first.
Active/current records remain protected while the owner is alive or cannot be
confirmed dead. A same-host `ESRCH` permits reclamation of an orphan; a foreign
hostname or failed liveness probe does not. Commits and GC share a writer lock,
and a failed new write preserves previous snapshots. A previous process cannot
finish a session now owned by its successor. Taking over an active record
requires confirmed owner death; an explicitly finished, non-current record can
be resumed by a new writer.

A full protected budget or history error is reported without stopping native
execution. The last successful snapshot can therefore lag behind the live
session. These history budgets are separate from conversation-owned response
caches and operation receipts; reading common history does not acknowledge
results, restore execution or create attachment receipts.

Independent consumers can use [CommonHistoryStore](../src/common-history.ts)
without importing OMP or starting a broker:

| Read API | Result |
|---|---|
| `new CommonHistoryStore({ homeDir }).listProjects()` | Registered project IDs, names and cwd aliases |
| `store.listSessions(projectId)` | Session summaries, lifecycle, coverage and saved byte counts |
| `store.readSession(projectId, sessionId)` | Validated JSON snapshot, or `undefined` if absent |

Readers reject incompatible schemas and mismatched identities rather than
repairing them. This format and its OMP publisher provide shared project
history; they do not add execution adapters for other native agents or automatic
synchronization between devices. The existing MCP `history` tool continues to
query its selected live OMP session.

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

OMP 18.5.0 displays reports such as `/tools`, `/jobs`, `/context` and selected
`/mcp` views outside the transcript. Do not assume that invoking a report makes
its contents recoverable through `history`. Use Chappie's `tools` discovery for
live definitions and the host's discovered native facilities for current job state.

Use `call` or `start_call` for every native coding tool. Chappie validates only the bounded JSON batch envelope; OMP owns each tool's arguments, validation, permissions, anchors and execution. Batch only calls whose arguments are already known and belong to the same native turn. If a later call needs an earlier result (for example, discover a path, then read it, then edit using returned anchors), use separate `call` requests. Inspect every native result before continuing; `isError` or native failure details mean the batch did not fully succeed. `transfer` remains directly exposed because ChatGPT supplies its file objects and handles exported resources. Unsupported schema conversion is reported as `schemaError`; refresh the definition instead of guessing a replacement schema or encoding a rejected command.

### Focused file changes and delivery recovery

For existing files, discover the active editing capability and read the target
before editing. Prefer focused native `edit` operations with current anchors,
or `ast_edit` when a structural transformation fits. Use `write` for new files
or an explicitly intended whole-file replacement. These are native examples,
not fixed broker wrappers; the selected session's definitions remain authoritative.
Break large changes into coherent edits, inspect each result and refresh anchors.
Dependent writes and checks must use separate batches; known arguments alone do
not make those operations independent.

Do not generate a large patch program in a separate analysis tool, print its
Base64 representation, and copy it into a shell command. A giant heredoc or
whole-file replacement is not a remedy for a rejected native edit. Where a real
programmatic transformation is needed, use the discovered native `eval` or
specialized tool with local files and focused inputs rather than an encoded
round trip. Ordinary encoded data remains valid when the native tool supports
it. This is controller guidance, not a new input-size limit or content filter.

A message-delivery timeout alone does not establish whether a tool ran or where
delivery failed. Recover a known operation/result ID and inspect relevant history
and the current target before deciding what remains. Never blindly resubmit a
possibly applied mutation or create a fresh ID around an uncertain receipt.
Only the existing known-unexecuted input-wait path permits same-ID resume.
Denials remain denials; smaller requests, encodings and different tools must not
bypass them. The native wait budget does not bound host-side argument generation
or delivery before Chappie receives a request. This guidance does not add a
heartbeat, autonomous wake-up or forced end to a long controller turn.

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

`call` waits up to a 25-second application budget after session selection, including native queueing. Fast results remain inline. Once a receipt is durably reserved, exceeding the budget yields `operation` with its caller-visible `operationId` and current state, without cancelling or restarting the native batch. Use `get_operation` for completion or input-wait recovery and `cancel_operation` for explicit cancellation. The budget is not a documented ChatGPT deadline or a hard real-time guarantee: storage, scheduling and session selection can add latency.

Fast ordinary calls also return `operation.operationId` and `operation.resultId`, while keeping their native output inline. The snapshot contains public native output and historical work observations, not raw private tool details or live model-input requests. An ID on a successful inline result does not require an extra fetch. If the transport response is lost, recover the saved output with `get_operation({ resultId, offset: 0 })`; this never repeats execution or queues a duplicate deferred delivery. These snapshots share the [bounded result continuation](#bounded-result-continuation) limits. If persistence fails after execution, Chappie reports that fact with the completed receipt's handle; reconcile history instead of resubmitting the batch.

When the original response and all of its IDs were lost, use `get_operation({ sessionId, limit: 10 })`. Supply exactly one of `sessionId`, `operationId`, or `resultId`; `limit` is optional (1–20) and applies only to `sessionId`, while `offset` applies only to `resultId`. Recent discovery works from broker state even while OMP is offline, does not change the default binding, and neither executes work nor acknowledges pending delivery. It returns a bounded newest-first list with `scope: "recent"`, `observedAt`, and `hasOlder`; this is not a paginated or exhaustive task ledger and does not scan the cold uncertainty archive. `init.recovery` contains the same default recent summary for the selected session.

Discovery is scoped to the originating ChatGPT conversation and OMP session. A different Chat must use authorized OMP history and the project checkpoint, not another Chat's result IDs. Known archived receipt IDs remain recoverable through the existing operation selector. Empty recent lists, expired snapshots and successful reads never imply that native work did not happen or that the model/UI received an earlier response. Always reconcile the current task and pending inputs before continuing.

For a known long-running batch, use `start_call`:

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

Detached results are saved as public snapshots and exposed through `get_operation(operationId)` after pending-delivery acknowledgement. Small bodies remain inline; large bodies use the existing `resultId` pages. Terminal receipts retain replay protection for 24 hours, while unread and pending result bodies stay protected. Fully transmitted result bodies may retire earlier under cache pressure; the completed receipt remains available even if its body cache was reclaimed. Within receipt retention, an identical logical ID replays the accepted operation and conflicting arguments are rejected. After retirement, a fresh acceptance gets a new UUID v7 `executionId`; native requests and deferred results must match that execution, so delayed output cannot complete a successor with the same logical ID. Existing UUIDs are still accepted and never rewritten. `waiting_input` resumes the same acceptance rather than generating a new one. Unresolved running/waiting/uncertain receipts are not automatically evicted.

Retained receipts require `executionId`. Tracked native requests and results require both `operationKey` and `executionId`; calls without tracking carry neither. Recovery lookup accepts the canonical public `operationId`, including generated `receipt-<hash>` IDs, within the owning conversation. Internal replay keys are not implicit recovery aliases.

Uncertain receipts without pending or retained output leave the hot JSON state after 24 hours, but their replay protection is not deleted. They move atomically into the private `chappie.uncertain` archive (256 MiB / 131,072 files maximum). The original owner can query the canonical `operationId`, including a generated `receipt-…` handle; aliases cannot be reassigned to another acceptance. A matching late result restores the original execution before the cold record is removed. Running/input-wait operations and undelivered results remain live. Archive admission fails closed when its explicit disk budget is exhausted; never delete the archive to make a possibly executed operation retryable.

Failed intentional `chat` requests also report a deterministic recovery handle. Recover that receipt instead of assuming a delivery error means the message was never applied. This does not start another ChatGPT turn.

Automatic recovery IDs are derived from the originating request identity and scoped to its conversation/session. The internal request key is preserved, so retries keep the original acceptance. A host retry without a stable request identity cannot be deduplicated by inference; prefer an explicit `start_call` ID for consequential long operations. Reuse the returned auto-ID with `start_call` only to resume its known-unexecuted `waiting_input` state after answering the model request. Assigning a recovery alias preserves that acceptance's execution ID; completed receipts are not re-executed. Direct `transfer` and deliberate `chat(mode=message)` retain their separate lifetime contracts.

Before a call yields, aborting its last waiting request still cancels native work. After yielding, ending that transport request does not cancel the accepted operation. A failed response send does not authorize repetition: recover with the original request identity or known operation ID. Broker loss leaves unfinished work `uncertain`, not automatically resumed. Native `isError` remains a failed tool result even when the operation is `completed` as a batch.

`cancel_operation` owns cancellation from the start of initial acceptance or a `waiting_input` reclaim, including while the receipt is being persisted. Cancellation before dispatch prevents later native execution. Cancelling a waiting operation does not abort its independent model request. Ending the original MCP request does not cancel accepted detached work. Cancellation cannot undo side effects or promise to stop independent child processes. Request-cancel notices report `executionPhase`: queued work was removed before dispatch; in-flight/result-pending work may already have effects. A reason such as `Request ended` is the upstream abort reason, not proof of edit rollback or a diagnosis of why the host ended the request. Inspect history and files before deciding whether any further action is safe. Broker recovery marks interrupted running receipts `uncertain`; known-unexecuted waits stay resumable. Reconcile uncertain work rather than re-executing it.

Do not send periodic heartbeat or rapidly poll to extend a ChatGPT tool request. MCP progress needs a request token and client handling; timeout renewal is optional and does not remove maximum-total limits. The current `2026-07-28` protocol also removed `ping`. Chappie owns a stdio JSON-RPC boundary, not the upstream HTTP/SSE stream, so arbitrary stdout/SSE keepalives are invalid. `chat(mode=progress)` records an OMP notice, not transport keepalive. No verified ChatGPT timeout-renewal guarantee is assumed. Detach the native batch, and use persistent process supervision separately when the process itself must survive the agent or broker exiting. See [MCP lifecycle timeouts](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-03-26/basic/lifecycle.mdx#timeouts), [progress semantics](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress), and the [current protocol's ping removal](https://github.com/modelcontextprotocol/go-sdk/blob/main/docs/protocol.md#ping).

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

Staged acknowledgement callbacks belong to the request's original cancellation signal, not just its reusable JSON-RPC ID. Cancellation, failed writes and transport shutdown discard these callbacks without consuming pending data. A later response using the same request ID cannot acknowledge the cancelled request's input.

If cancellation or a broken broker connection interrupts ordinary result delivery, late results can accompany a later response to the originating ChatGPT conversation. A broker restart reloads operation receipts, but an agent process exit cannot recover unfinished in-memory work automatically. Check history before retrying a state-changing operation. Use `start_call` for a native batch that may outlive one ChatGPT MCP request; use the environment's persistent process facilities when the underlying process itself must outlive the agent session.

OMP now also retains ordinary completed native batches until Chappie explicitly confirms durable snapshot and receipt storage. If that confirmation is lost, the same result is resent through the existing outbox; tools are not re-executed. Storage acknowledgement is independent of ChatGPT response acknowledgement and does not stop the next native batch from running.

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

Lossless here describes the response Chappie actually received. OMP applies its
own retention limits before that boundary: since 18.4.9, saved bash and eval
output artifacts are capped at 16 MB by default (`tools.artifactMaxBytes`),
preserving their beginning and latest output. Paging a Chappie result cannot
recover bytes already discarded by OMP. When complete command output is required,
explicitly preserve it in an appropriately managed native file; do not silently
disable host limits or promise that a retained result contains unlimited output.

Snapshots live in the selected broker store's private `chappie.results` directory, are scoped to the originating Chat conversation, and are checked against their content hash. Unprotected snapshots expire 24 hours after first creation; re-reading does not renew that clock. Pending and unread results have named protection pins and remain available beyond that interval. Explicitly unread results also keep their operation receipt discoverable through `operationId` and recent-receipt queries until the full body is consumed. Missing consumption evidence does not make a snapshot eligible for pressure reclamation. Broker capacity is 4,096 snapshots / 256 MiB total; one conversation is limited to 2,048 snapshots / 128 MiB, with a 128 MiB serialized per-snapshot ceiling. These are conversation-owned response budgets, separate from common project history.

When a new save needs space, Chappie automatically reclaims the oldest fully transmitted, unpinned snapshot cache first. It never discards pending or unread output for capacity. Successful final inline writes and contiguous `get_operation` page writes establish transport consumption; merely returning a reference, reading a file internally, or requesting the last page out of order does not. Consumption is not proof of human/UI inspection. If no sufficient reclaimable cache exists, admission fails without deleting old cache or acknowledging pending data. Native work may already have executed, so recover its original receipt rather than repeat it.

Version 1 hot metadata stores result references and rejects inline deliveries; conversion of an earlier store is an offline upgrade step. The metadata limit is 128 MiB. A failed candidate is rolled back so another conversation can continue saving metadata once storage is available. Both count and serialized-byte pressure trigger metadata reclamation. If a candidate exceeds 128 MiB, acknowledged secondary references retire first, followed by the oldest safe terminal receipts moving to the cold archive, with a best-effort target of 96 MiB. Archived terminal receipts retain their original 24-hour deadline; running, input-wait, uncertain and explicitly unread work remains protected. Successful body consumption is committed to state before its unread pin is released. A model-input request is bounded at 4 MiB per operation before it can change shared state; an oversized request remains at OMP for reconciliation. Storage bounds do not promise survival of a physical disk or power failure.

Large image blocks are preserved in the saved JSON rather than silently discarded, but a JSON-fragment page is not an inline image renderer. Use the recovered original `piImage`/resource URI with the existing `transfer` path when the host needs the original attachment. Resource lifetimes and source-session ownership remain separate from response-snapshot retention. Small widget state remains inline when unrelated pending text is paged; oversized widget metadata fails clearly rather than exceeding the response limit.

## Bounded local diagnostics and long sessions

The broker records content-free boundary events in `chappie.diagnostics.jsonl`, with one rotated `.1` file. Each file is limited to 1 MiB; the asynchronous writer admits at most 256 queued events. A burst or disk failure drops diagnostic events rather than delaying execution. `dropped` is cumulative for that broker run. Set `diagnostics: false` in `chappie.json` to disable recording; no configuration is changed automatically.

`rpc.received` means the SDK entered the tool handler. `native.dispatch` / `native.result` / `native.failed` identify the local IPC boundary. `rpc.ready` precedes the actual transport write, while `stdio.written` means only that the local transport's send completed. `ack.*` records local acknowledgement ownership. Snapshot persistence has separate `snapshot.*` events. None of these is a host/UI receipt, and absence of a log event is not proof that no upstream request existed, especially with dropped events or before the handler boundary.

Conversation, request and session identifiers are HMAC-pseudonymized using an ephemeral per-run key. Logs never contain native arguments, source code, message bodies, exception text, credentials or signed file URLs. A run UUID separates process lifetimes; no controller-turn identity or timeout is inferred from request-ID formatting. Transport traces and a time-correlated host screenshot are needed to investigate a Chat interruption; a successful native result alone cannot locate the failure.

OMP owns transcript, artifact and TUI retention. Do not delete historical session files or reduce native output limits automatically. Prefer bounded native search/read operations over recursive shell searches through generated HTML or embedded data. A large raw artifact on disk is not proof that cmux keeps those bytes in scrollback, and an increasing process RSS alone is not proof of a leak. The optional real-OMP soak in the quality standard measures repeated work and native output caps in an isolated session, not the current cmux UI or autonomous ChatGPT continuation.

IPC outbound admission is also bounded: each peer allows at most 256 queued frames and 128 MiB of queued UTF-8 data by default, independently of its inbound limits. Backpressure rejects excess sends promptly without discarding already-admitted frames; completion, write failure and close release their queue reservations. This bounds retained output while a receiver is stalled; it does not certify delivery to ChatGPT.

## Contributor quality standard

Review/test coverage, completion stages, decision records and cold-start recovery are maintained in the repository's [quality standard](quality.md). The [maintainer architecture](architecture.md) records why the execution, ownership and response boundaries exist. This tool guide remains the source for observable product behavior, not a second task ledger.
