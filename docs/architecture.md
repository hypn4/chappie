# Maintainer architecture

This document preserves design rationale that a new maintainer must not have to recover from chat history. [Tools](tools.md) is the behavioral reference; [quality](quality.md) maps its contracts to review and tests. Change these decisions explicitly, with a reason in the task checkpoint.

## Boundaries and entrypoints

Chappie connects ordinary ChatGPT Chat to native OMP. The extension entry is `src/index.omp.ts`, compiled to `dist/src/index.omp.js`; `src/cli.omp.ts` starts the separate `chappie-omp` broker. `serveMcp` uses the SDK's modern-only stdio handling. Protocol/runtime pins belong to package/config files and the tool contract, not duplicated dependency manifests.

The broker owns conversation bindings, initialization cooldowns, request routing, operation receipts and deferred-result descriptors. The OMP extension owns provider output, native execution, session input/history and the bytes of exported resources. This separation keeps native semantics at their source. Optional OMP peers describe a separate-process installation, not an older-host compatibility layer.

| Location | Responsibility |
|---|---|
| `src/server.ts`, `src/stdio.ts` | Public MCP contracts and response/commit boundary |
| `src/broker.ts`, `src/state.ts`, `src/operations.ts` | Routing, ownership, durable admission and lifecycle |
| `src/session.ts`, `src/provider*.ts`, `src/omp-primary-context.ts` | Native execution and exact-session provider provenance |
| `src/ipc.ts`, `src/ipc-schema.ts`, `src/local.omp.ts` | Local/remote transport and explicit collaboration |
| `src/history.ts`, `src/responses.ts`, `src/resources.ts`, `src/transfer*.ts` | History, response recovery and source-owned bytes |
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

Cancellation owns preparation before persistence yields, and is checked again before dispatch. It cannot undo prior side effects or cancel an independent model generation. Missing/uncertain completion is reconciled through history, never by inventing a new intent ID. Retention details are in the tool contract.

### Chat-only durable recovery, not proactive wake-up

There is no MCP Events/Tasks surface, webhook outbox, heartbeat daemon or assumed ability to wake ordinary Chat. Persist results and waits, then recover on a later authorized interaction. Never promise that the broker can resume the conversation by itself.

ACK follows a successful bounded response write. Oversized output is first saved as an immutable conversation-owned response snapshot, then exposed through existing `get_operation` paging. The same mechanism preserves complete catalogs and whole history entries. A reference, source read or successful transport write does not prove human/UI receipt. Resource lifetimes remain separate from snapshot retention.

### Ownership remains with the byte source

Files and images belong to their original OMP session even if the Chat binding changes. Transfers stage writes, preserve earlier destinations on failure and report per-member results. Original resource URIs and source fingerprints prevent silent regeneration or mixed bytes. Generic `call` cannot import host download URLs. Explicit file recovery uses the original reference and appropriate authorization, not repeated native side effects.

### Platform and release boundaries

Local IPC uses protected Unix sockets or Windows named pipes; remote connections require TLS with mutual authentication and hostname checks. Keep socket/path/file protections intact. The broker and extension resolve the same current OMP agent-directory/profile inputs; do not restore retired aliases.

Bun owns development, builds and verification. The release workflow publishes the already verified tarball, with fork identity and upstream attribution retained. Private task data, credentials, local evidence and generated agent settings never belong in the package. See [publishing](publishing.md) for the authoritative release steps.
