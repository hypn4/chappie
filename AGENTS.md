# Chappie

Chappie is a TypeScript package that connects ChatGPT developer-mode tools to native Pi and Oh My Pi (OMP) sessions.

## Architecture

The package has host-specific extension entry points: `src/index.ts` for Pi and `src/index.omp.ts` for OMP. Pi can run the MCP broker through `pi --chappie`; OMP uses the standalone `chappie-omp` broker compiled to `dist/src/cli.omp.js`. Each host extension registers the `chappie/chatgpt` provider and connects its current session through `node:net`: locally through a Unix socket or Windows named pipe in that host's agent directory, or through mutually authenticated TLS when `connect` targets another device.

The broker owns ChatGPT conversation bindings, initialization cooldowns, MCP request routing, deferred-result descriptors, and resource dispatch. The host extension owns provider output, native tool execution, session input, branch history, cancellation, and the bytes behind exported resources.

OMP's custom API registration is process-wide. Keep its dispatcher stateless: route each request through the caller's `onPayload` / `before_provider_request` hook and exact session ID, not the last registered extension instance. Native Chappie requests have an empty model context; auxiliary inference is rejected before acquiring an output. Completed OMP results are delivered at `turn_end`, independently of later provider requests or TODO continuations.

Pi and OMP use separate agent directories by default (`~/.pi/agent` and `~/.omp/agent`), so their local `chappie.sock` endpoints are also separate. The broker launched by otunnel must use the same host and agent-directory settings as the session under test.

One accepted MCP tool request becomes one native host tool batch. Durable operation receipts reject conflicting replays and prevent accepted work from being executed again; replay replies contain no repeated tool output or attachments. Export receipts retain inert resource references; a source read is not proof of ChatGPT file receipt. A `call` array requests native batch execution explicitly; Chappie does not combine separate MCP requests. Requests are ordered within a session, while different sessions operate independently.

`chat` completes one assistant turn. Remote work arriving while the agent is idle starts a new turn through an invisible custom control message that is removed from model context.

File bytes belong to the originating session. Resource reads retain that ownership across conversation binding changes. Session-to-session copies use the existing broker connections so the devices only need to reach the broker.

`chappie.state.json` under the selected host's agent directory stores conversation bindings, questions, operation receipts, and interrupted-result descriptors. Initialization cooldowns live in broker memory and are scoped to a ChatGPT conversation and agent session. They provide observer guidance after closely spaced initializations. They are not a host-side lock or a guarantee of a single ChatGPT UI response.

Native messages, tool results, and activity records stay in the host session transcript. History reads the current branch through an independent IPC request and returns original entry IDs and timestamps. Its response remains separate from input and pending-result delivery, and file references are not emitted as fresh attachments.

## Development

Use `bun run format` and `bun run check` during development. `bun run build` compiles the broker and copies its runtime assets; `bun pm pack` creates the release tarball after an explicit build. `bun run test:omp` runs the native OMP integration suite with temporary files and no model inference. The repository commits `bun.lock`, pins Bun through `.bun-version`, and uses `bun ci` in CI. For OMP integration testing, run the source broker and source extension from the same checkout and keep their agent-directory settings aligned; see the README development section. The reusable check workflow tests source, actual OMP runtime behavior, and one tarball on Linux, macOS, and Windows. Release and publish workflows wait for those checks; npm CLI is retained only for npm Trusted Publishing/OIDC of the already-tested tarball because Bun does not currently document an equivalent trusted-publisher exchange. See docs/publishing.md.

Fork releases use `@hypn4/chappie`; see `docs/publishing.md`. Keep the original license and author, publish only validated tarballs, and never include local task data or credentials.
