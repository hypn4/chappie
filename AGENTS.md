# Chappie

Chappie connects ChatGPT MCP 2.0 tools and Events to native Oh My Pi (OMP) sessions. The standalone Pi host and pre-2026 MCP protocols are not supported.

## Architecture

The only extension entry is `src/index.omp.ts`, compiled to `dist/src/index.omp.js`. The independent `chappie-omp` executable starts the MCP broker via `src/cli.omp.ts`. `serveMcp` uses the SDK's `serveStdio` with `legacy: "reject"`; every request uses MCP `2026-07-28` metadata and discovery. OMP uses its native AI message/event types, tools, and schema conversion; there are no Pi adapters, provider-host switches or cross-host stream casts. Local IPC uses Unix sockets or Windows named pipes; remote sessions use mutually authenticated TLS.

The broker owns ChatGPT conversation bindings, initialization cooldowns, MCP request routing, deferred-result descriptors, and resource dispatch. The host extension owns provider output, native tool execution, session input, branch history, cancellation, and the bytes behind exported resources.

OMP's custom API registration is process-wide. Keep its dispatcher stateless: route each request through the caller's `onPayload` / `before_provider_request` hook and exact session ID, not the last registered extension instance. Native main-agent context keeps its original messages and carries an in-process, symbol-keyed provenance marker that is ignored by provider serialization; the Chappie provider requires that exact-session marker for primary requests, while recognized auxiliary generations use their explicit generation route and unrelated auxiliary inference is rejected before acquiring an output. Request-scoped provider hooks are authoritative when resume-time model state is temporarily unavailable, but explicit model switches remain authoritative and must tear down the Chappie session. Completed OMP results are delivered at `turn_end`, independently of later provider requests or TODO continuations.

Broker and OMP must use the same agent directory. Chappie resolves `OMP_PROFILE`, `PI_CONFIG_DIR`, and `PI_CODING_AGENT_DIR`, which are current OMP launch inputs. Do not reintroduce the removed `PI_PROFILE` alias or pull the inference host into the standalone broker runtime. Optional current OMP peers describe this separate-process layout, not support for an old runtime.

One accepted MCP tool request normally becomes one native host tool batch. `start_call` is the deliberate exception for long work: it persists an explicit operation receipt, detaches native execution from the originating ChatGPT request signal, and returns immediately; `get_operation` and deferred deliveries expose later completion. Durable operation receipts reject conflicting replays and prevent accepted work from being executed again. Export receipts retain inert resource references; a source read is not proof of ChatGPT file receipt. A `call` array requests native batch execution explicitly; Chappie does not combine separate MCP requests. Requests are ordered within a session, while different sessions operate independently.

Long-operation completion and its matching Events outbox entries must be persisted together in State before delivery. Preserve stable execution IDs and per-subscription event markers; neither transport retries nor acknowledgement may cause native re-execution. Full detached results remain repeatably readable after deferred-delivery acknowledgement. EventService owns only verified webhook subscription lifecycle and a pending/retry-driven sender; webhook.ts owns HTTPS destination validation, exact-byte Standard Webhooks signing, and bounded network I/O. Do not implement MCP heartbeat loops or advertise unsupported Tasks extension capabilities. Actual MCP 2.0 wire tests, not type casts or schemas alone, define what this SDK can serve.

`chat` completes one assistant turn. Remote work arriving while the agent is idle starts a new turn through an invisible custom control message that is removed from model context.

File bytes belong to the originating session. Resource reads retain that ownership across conversation binding changes. Session-to-session copies use the existing broker connections so the devices only need to reach the broker.

`chappie.state.json` under the selected host's agent directory stores conversation bindings, questions, operation receipts, retained detached results, webhook subscriptions, delivery markers, and the event outbox. The private file can contain callback signing secrets and must not enter logs or version control. Bindings record their last use and are pruned after 30 idle days during normal load/count/save activity. Explicit detached operation receipts are not evicted automatically; size limits fail closed. Initialization cooldowns remain broker-local guidance, not a host-side lock or a guarantee of one ChatGPT UI response.

Native messages, tool results, and activity records stay in the host session transcript. History reads the current branch through an independent IPC request and returns original entry IDs and timestamps. Its response remains separate from input and pending-result delivery, and file references are not emitted as fresh attachments.

## Development

Use `bun run format`, `bun run check`, `bun run test:omp`, and artifact verification. TypeScript targets ESNext with ESM, strict checks and native resource-management syntax. The runtime baseline is OMP 18.4.8; CI uses that pinned version rather than an old compatibility floor. Require JSON batches and native read selectors/edit input; do not recreate removed aliases. Keep platform-specific filesystem/TLS/IPC safeguards. `bunfig.toml` keeps the three-day package age policy; deliberate release-train updates follow the narrow lockfile refresh procedure in `docs/publishing.md`.

Fork releases use `@hypn4/chappie`; see `docs/publishing.md`. Keep the original license and author, publish only validated tarballs, and never include local task data or credentials.
