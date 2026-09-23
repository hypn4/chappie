# Chappie

Chappie is a TypeScript package that connects ChatGPT developer-mode tools to native Pi and Oh My Pi (OMP) sessions.

## Architecture

The package has host-specific extension entry points: `src/index.ts` for Pi and `src/index.omp.ts` for OMP. Pi can run the MCP broker through `pi --chappie`; OMP uses the standalone `chappie-omp` broker. Each host extension registers the `chappie/chatgpt` provider and connects its current session through `node:net`: locally through a Unix socket or Windows named pipe in that host's agent directory, or through TCP when `connect` targets another device.

The broker owns ChatGPT conversation bindings, initialization cooldowns, MCP request routing, deferred-result descriptors, and resource dispatch. The host extension owns provider output, native tool execution, session input, branch history, cancellation, and the bytes behind exported resources.

Pi and OMP use separate agent directories by default (`~/.pi/agent` and `~/.omp/agent`), so their local `chappie.sock` endpoints are also separate. The broker launched by otunnel must use the same host and agent-directory settings as the session under test.

One MCP tool request becomes one native host tool batch. A `call` array requests native batch execution explicitly; Chappie does not combine separate MCP requests. Requests are ordered within a session, while different sessions operate independently.

`chat` completes one assistant turn. Remote work arriving while the agent is idle starts a new turn through an invisible custom control message that is removed from model context.

File bytes belong to the originating session. Resource reads retain that ownership across conversation binding changes. Session-to-session copies use the existing broker connections so the devices only need to reach the broker.

`chappie.state.json` under the selected host's agent directory stores conversation bindings, questions, and interrupted-result descriptors. Initialization cooldowns live in broker memory and are scoped to a ChatGPT conversation and agent session. They address duplicate execution bursts during initialization or resumption after host-side widget and file interactions.

Native messages, tool results, and activity records stay in the host session transcript. History reads the current branch through an independent IPC request and returns original entry IDs and timestamps. Its response remains separate from input and pending-result delivery.

## Development

Use `pnpm format` and `pnpm check` during development. For OMP integration testing, run the source broker and source extension from the same checkout and keep their agent-directory settings aligned; see the README development section. Version tags and manual release runs check the source and produce an npm package with a release draft. Publishing the draft runs the npm publishing workflow.
