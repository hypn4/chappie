# Maintainer architecture

This document preserves design rationale that a new maintainer must not have to recover from chat history. [Tools](tools.md) is the behavioral reference; [quality](quality.md) maps its contracts to review and tests. Change these decisions explicitly, with a reason in the task checkpoint.

## Boundaries and entrypoints

Chappie connects ordinary ChatGPT Chat to native OMP. The extension entry is `src/index.omp.ts`, compiled to `dist/src/index.omp.js`; `src/cli.omp.ts` starts the separate `chappie-omp` broker. `serveMcp` uses the SDK's modern-only stdio handling. Protocol/runtime pins belong to package/config files and the tool contract, not duplicated dependency manifests.

The broker owns conversation bindings, initialization cooldowns, request routing, operation receipts and deferred-result descriptors. The OMP extension owns provider output, native execution, session input/history and the bytes of exported resources. This separation keeps native semantics at their source. Optional OMP peers describe a separate-process installation, not an older-host compatibility layer.

| Location | Responsibility |
|---|---|
| `src/server.ts`, `src/stdio.ts` | Public MCP contracts and response/commit boundary |
| `src/broker.ts`, `src/state.ts`, `src/operations.ts` | Routing, ownership, durable admission and lifecycle |
| `src/storage.ts`, `src/storage-lock.ts` | Chappie home/store identities and exclusive writer ownership |
| `src/session.ts`, `src/provider*.ts`, `src/omp-primary-context.ts` | Native execution and exact-session provider provenance |
| `src/ipc.ts`, `src/ipc-schema.ts`, `src/local.omp.ts` | Local/remote transport and explicit collaboration |
| `src/history.ts`, `src/responses.ts`, `src/resources.ts`, `src/transfer*.ts` | Native history, response recovery and source-owned bytes |
| `src/common-history.ts`, `src/history.omp.ts` | Agent-neutral public history storage and its OMP projection |
| `tests/`, `tests/helpers/` | Behavioral regressions and reusable test boundaries |
| `scripts/`, `.github/workflows/` | Verification, evidence and publishing; never an inference service |
| `.agents/skills/chappie-quality/` | Repository-only workflow entrypoint; not a shipped global Skill |
| `.quality/` | Local generated evidence, excluded from Git and npm |

Do not rearrange runtime files merely to make this table symmetrical. Keep reusable test support under `tests/helpers/`, authored documentation under `docs/`, and generated build files in `dist/`. Preserve Beads-managed files, user integration settings and caches unless an explicitly scoped cleanup authorizes changes.

## Decisions and reasons

### Native discovery, not duplicated execution tools

The public surface is a small bridge. `init` returns compact complete tool/Skill catalogs; `tools(names)` reads live native definitions. OMP owns tool-specific schemas, permissions, anchors and execution. Skills describe workflows; Chappie routes to them without copying their text. `call` and `start_call` share the JSON envelope in `native-calls.ts`.

Do not restore direct read/bash/edit/write wrappers, Base64 aliases, a native schema cache or another inference router. Those create a second source of truth. `transfer` remains direct because host-injected files and resource delivery are a distinct boundary.

### Exact-session provenance, not last-registered ownership

OMP API registration is process-wide. The provider dispatcher must remain stateless and follow each caller's request hook and exact session ID. In-process primary provenance survives context copies but is excluded from provider serialization. Recognized compaction/branch-summary generations have their own route; unrelated auxiliary prompts cannot borrow a primary output.

Transient resume context must not discard a legitimate request hook, but an explicit provider/session switch must invalidate stale work. Native completion is delivered at `turn_end`, independently of a later model request or TODO continuation. Idle remote work uses an invisible control message removed from model context. Starting another `chappie/chatgpt` agent does not create a ChatGPT conversation.

### Chat planning is separate from native turn completion

The ChatGPT controller, not OMP or this broker, decides when the user goal is satisfied. Keep returning batch results at `turn_end`: delaying them until all TODOs finish would block the very controller needed to select further tools and extend host request lifetimes. `chat` progress instead uses a native notice with an IPC response; it never resolves the provider output, schedules a turn, or cancels active work. Intentional message turns and recognized model replies remain explicit.

`work.omp.ts` reads the current native TODO branch with OMP's canonical helper. `work.ts` owns only its small observation schema and advisory continuation cues; it does not import the inference host into the standalone broker. Capture observations with results, preserve them through detached delivery/recovery, and label their session scope/time. Do not infer user authorization from shared TODOs or label a settled board as verified completion. Do not add a hidden planner, stop-hook shim, second task database or host-cancellation bypass.

Ordinary native calls have a one-shot response-wait budget, not a heartbeat. A durably reserved call can yield its recovery ID while the same execution continues. Preserve request-scope keys and cancellation ownership; an auto-ID is an alias, not a second acceptance. Before yielding, the last caller's cancellation still stops native execution; afterwards cancellation is explicit. Fast calls keep inline results, and only yielded completions enter retained delivery. A budget does not certify a host timeout or prevent every network/UI interruption. Direct file transfers and deliberate message turns keep their existing contracts.

### Logical retry identity and execution identity are different

A logical operation ID identifies caller intent; a random persisted execution ID identifies one acceptance. Reusing a logical ID after terminal retention must not authorize delayed results from the old acceptance. IPC and deferred deliveries carry the execution ID and validate it before mutation. Known-unexecuted `waiting_input` resumes preserve the same acceptance; unresolved work remains fail-closed across restart.

New Chappie-generated identifiers use UUID v7 (RFC 9562, section 5.7), with a 48-bit Unix millisecond timestamp and 74 cryptographically random bits. Existing UUIDs and native OMP session IDs remain unchanged. Content-addressed response IDs and logical retry keys remain hashes: replacing those with fresh UUIDs would break deduplication. Retention uses recorded lifecycle timestamps, not the timestamp embedded in an identifier; allocations within a millisecond and clock corrections do not define a total event order.

Cancellation owns preparation before persistence yields, and is checked again before dispatch. It cannot undo prior side effects or cancel an independent model generation. Missing/uncertain completion is reconciled through history, never by inventing a new intent ID. Retention details are in the tool contract.

Cold replay protection is distinct from hot response state. Old uncertainty without pending output is archived before hot removal; it remains owner-checked and blocks duplicate execution. Recovery aliases preserve the original request and failed intentional-message receipts. A valid late result restores that same acceptance; expiry never silently authorizes an uncertain retry.

### Chat-only durable recovery, not proactive wake-up

There is no MCP Events/Tasks surface, webhook outbox, heartbeat daemon or assumed ability to wake ordinary Chat. Persist results and waits, then recover on a later authorized interaction. Never promise that the broker can resume the conversation by itself.

ACK follows a successful bounded response write. Oversized output is first saved as an immutable conversation-owned response snapshot, then exposed through existing `get_operation` paging. The same mechanism preserves complete catalogs and whole history entries. A reference, source read or successful transport write does not prove human/UI receipt. Resource lifetimes remain separate from snapshot retention.

ACK callbacks are owned by both the JSON-RPC ID and its original AbortSignal. Cancellation releases staged closures without consuming unread input. The snapshot store budgets both total and per-conversation usage while preserving the immutable reread window. Bounded asynchronous diagnostics record local handler/native/write/ACK boundaries without response contents; they neither heartbeat the host nor turn missing local evidence into proof of a host failure.

### Chappie owns its storage namespace

`resolveChappieStorage` selects `CHAPPIE_HOME` or `~/.chappie`, then reads a strict `schemaVersion: 1` manifest. First initialization atomically records a UUID v7 default store under `stores/<storeId>`. `CHAPPIE_STORE_ID` selects only an existing registered UUID v7; a malformed manifest, missing registered directory or unknown selection fails without silently assigning another identity. The manifest has a 64 KiB limit and at most 1,024 registered stores.

The broker and local extension resolve the same store for configuration and IPC. State, response snapshots, receipt archives and diagnostics live inside that store. OMP's agent directory remains a native-host concern and does not select Chappie storage. There is no `.omp` fallback, runtime inline-state converter or merge of old stores. An upgrade from the earlier layout requires a separate one-time offline conversion against a verified backup, preserving ownership, execution IDs, result references and replay protection before the new runtime starts.

The broker acquires `StorageLock` before reading configuration or loading state and releases it after transport shutdown and pending state/diagnostic writes settle. The lock publishes complete hostname/PID/UUID v7 ownership atomically. A same-host `ESRCH` permits recovery; `EPERM`, a live PID, a foreign hostname or invalid owner metadata does not. There is no TTL or heartbeat takeover. Catalog initialization takes a short lock on the Chappie home; a broker's lifetime lock applies to its selected store. This prevents two startup paths from rewriting the same storage before IPC can detect a conflict.

### Bounded storage during continuous work

The hot `chappie.state.json` limit is 128 MiB. Its strict `schemaVersion: 1` format stores both pending and retained deliveries as small public-snapshot references. Inline native result bodies and incompatible state formats are rejected without a runtime migration. Private tool details do not enter the public snapshot; resource descriptors, failure state, work observations and acceptance ownership are extracted separately.

Every retained operation receipt requires an execution UUID. New acceptances allocate UUID v7; an already assigned UUID keeps its identity. A tracked request or result carries both its internal operation key and execution UUID. Public recovery resolves the owner-scoped canonical operation ID; an internal replay key does not create an implicit public alias.

State mutations are serialized through durable commit or rollback so one failed result cannot leave an oversized candidate in memory and poison another conversation's next write. Oversized model-input requests are rejected before mutation at a 4 MiB per-operation bound and remain at the native source. This bound does not relocate OMP conversation history into Chappie state.

Native completion uses a separate durability ACK: OMP keeps the completed batch in its existing outbox until the broker has saved its public snapshot and acceptance metadata. Sending a socket frame alone is insufficient. Missing ACKs resend the same result identity without running tools again, and ACK waiting does not block the next native batch. The outbox remains process-local; a native process exit is not a substitute for durable broker storage.

Snapshot sidecar metadata stores named protection pins and contiguous, successfully transmitted page progress. Pending deliveries survive the usual 24-hour TTL. Handing off a reference keeps an unread pin and a discoverable acceptance receipt until its full body is transmitted inline or in consecutive pages; requesting only an arbitrary last page does not consume it. Only the final bounded response write registers consumption. Its durable delivery ACK runs before inline consumption, and consumption records read evidence, commits the receipt's read state, then releases the unread pin. A failed state write preserves both protection and recovery identity. A larger outer response wrapper cannot accidentally acknowledge bodies that were not sent inline.

When disk snapshot quotas need space, unpinned, fully transmitted results retire oldest first. Admission plans enough eligible space before replacing files, and failed new writes do not delete the old cache first. Pending or unread output is never removed to admit new work. Acknowledged secondary result metadata can retire while receipt-level replay protection remains. Hot state is bounded by both count and actual serialized bytes: a candidate over 128 MiB first removes eligible secondary references, then archives the oldest terminal receipts without pending or unread results, aiming for 96 MiB. That lower target is best-effort; once the state fits the hard limit, optional further archival failure does not block the request. Archived terminal receipts retain their original 24-hour deadline; uncertain receipts retain their existing protection. Explicitly unread receipts remain discoverable until their body is consumed. Reclamation cannot manufacture space when all remaining data is protected or the physical disk cannot accept writes.

Fast native batches save their public output in the existing bounded disk snapshot store before returning a completion receipt with its result ID. The hot state retains only that pointer; ordinary success does not queue a duplicate deferred delivery. `init.recovery` and the session-scoped recent-receipt selector of `get_operation` make recovery possible even if the original response containing the IDs is lost. Discovery exposes only the current conversation's receipts and does not dispatch or acknowledge another execution. The recent query does not bind a session; `init` keeps its existing binding semantics. Known IDs remain the route to cold uncertainty records. No new inference loop or per-call body cache is introduced.

Snapshot identity is attached only to its acceptance's execution ID, and cannot be replaced by a delayed predecessor or renewed by reads. Persistence failure is reported with the completed batch's recovery handle and history reconciliation guidance, not as permission to repeat work. A subsequent request can be concurrent, unrelated or itself retried, so it cannot confirm delivery of an earlier response. Keep ACK semantics unchanged and never label absence of continuation as a proven disconnect.

The maintained otunnel fork retires canceled stdio relays and scopes admission-time cancellation to the existing channel, session and request ID. Cancellation has a bounded control reserve outside ordinary work slots; queued work canceled before dispatch is not executed. This does not create a new model turn, impose an assumed call-count limit, or guarantee that a control message still waiting upstream has already reached the local queue.

### Common history follows stable project identity

`CommonHistoryStore` owns an agent-neutral schema and filesystem reader with no OMP dependency. `project-catalog.json` maps UUID project identities to explicit, canonical cwd aliases. A newly encountered cwd gets a UUID v7 unless the caller supplies an explicit project UUID; the OMP extension passes `CHAPPIE_PROJECT_ID` when configured. A cwd cannot be silently reassigned to another project. The path is `projects/<projectId>/sessions/<sessionId>.json`, independent of agent name and device. `source.agent` and `source.sourceSessionId` record provenance; they do not select execution adapters.

`history.omp.ts` projects the current branch's visible public message/tool text and summaries, retaining original native entry IDs and timestamps. It bounds the projection to 2,048 entries / 16 MiB before queueing it and carries the source entry count, newest entry identity and projection omissions forward. Hidden control entries, reasoning blocks, private tool details and inline image bytes are excluded from this text projection. OMP retains the authoritative transcript, artifacts and session management. Broker response snapshots remain conversation-owned recovery data; their TTL and transport ACKs do not govern common-history text.

Saved history defaults to 16 MiB per session, 128 MiB per project and 512 MiB across the Chappie home, with 512 sessions per project and 4,096 globally. The generic publication queue coalesces per-session snapshots and admits at most 64 MiB / 128 pending sessions. Newest whole entries are selected within the saved-session budget; explicit coverage records source, supplied, retained and omitted counts, oversized entries, completeness and whether the newest entry survived. Publication and observer failures are reported without rejecting native execution.

History commits and GC share a cross-process lock. Finished, non-current histories retire oldest first under quota pressure; active/current records remain protected unless their same-host owner is proven dead. A foreign or unconfirmed owner is not inferred dead from a local PID. A late finish or finished publication cannot change a successor's ownership; active takeover requires a released history or confirmed owner death. Admission validates available eligible space before committing a replacement and removing victims. If protected records occupy the budget, the update fails with prior history preserved.

This implements project history accounting with a shared history budget. Broker operation receipts and response caches retain their separate conversation ownership and limits. Independent consumers can use `listProjects`, `listSessions` and `readSession` without loading OMP. Additional native execution adapters and cross-device automatic synchronization are outside the implemented contract.

### Ownership remains with the byte source

Files and images belong to their original OMP session even if the Chat binding changes. Transfers stage writes, preserve earlier destinations on failure and report per-member results. Original resource URIs and source fingerprints prevent silent regeneration or mixed bytes. Generic `call` cannot import host download URLs. Explicit file recovery uses the original reference and appropriate authorization, not repeated native side effects.

### Platform and release boundaries

Local IPC uses the selected Chappie store's protected Unix socket or a Windows named pipe derived from its resolved path. The local broker and extension must agree on `CHAPPIE_HOME` and the manifest-selected store. Remote connections require TLS with mutual authentication and hostname checks; certificate paths resolve from each side's Chappie store. Keep socket/path/file protections intact. OMP profile settings continue to select native OMP data and do not provide an alternate Chappie storage path.

Bun owns development, builds and verification. The release workflow publishes the already verified tarball, with fork identity and upstream attribution retained. Private task data, credentials, local evidence and generated agent settings never belong in the package. See [publishing](publishing.md) for the authoritative release steps.
