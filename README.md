# Chappie

Use ChatGPT to work through [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi): edit local files, run commands, call agent extensions, exchange files and images, and move between sessions on one or more devices.

This is the maintained [hypn4/chappie](https://github.com/hypn4/chappie) fork of
[zetaloop/chappie](https://github.com/zetaloop/chappie), published as
`@hypn4/chappie`. It targets native OMP, MCP 2.0, durable operations, and completion events.
The original MIT license and attribution are retained.

## Setup

The broker requires Bun 1.4.2 or newer. The repository, standalone broker,
build, tests, package installation, and CI all use Bun.

Use OMP 18.4.8 or newer within the supported 18.x release line. Install the extension:

```sh
omp plugin install @hypn4/chappie
```

Omitting the version selects npm's `latest` tag. Install once with the command
above, then update an existing OMP installation in place with
`omp plugin upgrade @hypn4/chappie`; `omp plugin list` shows the resolved
version. Pin the same released version in the plugin and broker command for
reproducible installations. Uncommitted branch changes are not part of npm latest.

Remove the upstream package or stop loading the source extension before enabling
this package; both register the same `chappie/chatgpt` provider. Updating the
broker does not update the OMP plugin: keep both on the same version.

Run the broker through [otunnel](https://github.com/zetaloop/otunnel). Use
`otunnel profiles list` to find the active profile; it is typically
`~/.config/tunnel-client/chappie.yaml`.

Run the standalone broker with [Bun](https://bun.sh/docs/pm/bunx).
It works with unmodified OMP; it does not require `omp --chappie` or an OMP fork.

```yaml
mcp:
  commands:
    - channel: main
      command: bun x --package @hypn4/chappie@latest chappie-omp
```

`bunx` is Bun's alias for `bun x`; prefer `bun x` in shared configuration
so the same command works on macOS, Linux, and Windows. `--package` selects
the package that provides `chappie-omp`. The first run may download
dependencies; later runs use Bun's package cache. This command does not install
the OMP plugin for you.

Make sure `bun` is on otunnel's `PATH`. If necessary, use Bun's actual
absolute path rather than a `$HOME` or `%USERPROFILE%` placeholder. This
avoids relying on shell expansion or the plugin's internal install path.

Start the tunnel with the updated profile:

```sh
otunnel run --profile chappie
```

Add the tunnel as a developer-mode app in ChatGPT, then start the agent in a project:

```sh
omp --model chappie/chatgpt
```

Call `sessions` or `init` from ChatGPT to connect to the agent session. When using
an OMP profile or custom `PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR`, launch otunnel
and OMP with the same environment so the broker and session resolve the same socket.

## Modern-only contract

This branch is a breaking update from RC.9. The server only accepts MCP `2026-07-28`: it opens with `server/discover` and request-scoped metadata, and rejects legacy `initialize` with `-32022`. A tunnel/client that sends only the old handshake must be upgraded before deployment. Refresh the ChatGPT plugin tool/event catalog after deployment; an active old session is not hot-patched.

Native `read`, `bash`, `edit`, and `write` are no longer duplicated as MCP tools. Discover their active OMP definitions with `tools({ names: [...] })` and invoke them through `call` or `start_call`, both of which require a JSON `calls` array. Only the ChatGPT file boundary retains a direct `transfer` tool. Native argument names, hashline anchors, validation and execution belong to OMP. The standalone Pi host, input aliases and Base64 alternative are not supported. Preserve timestamped state and operation receipts; never discard receipts to force a retry.

OMP host packages remain optional peers because the standalone MCP broker runs in a different process and does not require an inference host installation. This is process separation, not support for an older OMP runtime. Use `OMP_PROFILE`; `PI_CONFIG_DIR` and `PI_CODING_AGENT_DIR` retain their current OMP-defined names. The historical `PI_PROFILE` alias is no longer interpreted by Chappie.

## Development

Install dependencies and run the repository checks:

```sh
bun install
bun run check
bun run build
```

For a local OMP checkout, point the otunnel profile at the built broker:

```yaml
mcp:
  commands:
    - channel: main
      command: bun /absolute/path/to/chappie/dist/src/cli.omp.js
```

Then load the source extension directly:

```sh
omp --no-extensions -e /absolute/path/to/chappie/src/index.omp.ts --model chappie/chatgpt
```

Restart otunnel after changing its broker command, then use `sessions` or
`init` from ChatGPT to verify that the OMP session is visible.
After changing tool schemas, refresh the plugin connection in ChatGPT and test
in a new conversation. Restarting the broker alone does not refresh cached tools.

The broker and extension use `~/.omp/agent/chappie.sock` or the corresponding Windows named pipe. They must use the same OMP profile and agent-directory configuration. OMP is the only accepted IPC host.

`bun run check` runs formatting, type checks, and the Bun test suite.
`bun run test:omp` builds the package and checks a temporary native OMP session
without model inference. CI tests the pinned OMP 18.4.8 runtime and its packaged installation, including Windows process/path behavior. No old-runtime floor is installed.

GitHub Actions publishes releases to npm using OIDC and the committed
`publishConfig.tag`; routine releases do not require an npm login.
See [publishing](docs/publishing.md) for the release process.

## Usage

Chappie exposes a small session bridge instead of copying native tool schemas. `init` returns a short active-tool catalog; `tools` returns selected current definitions and `call` executes the explicit native batch. Choose the tool suited to the task rather than translating everything into a shell command. Use `start_call` with a stable `operationId` for long batches, `get_operation` for repeatable status/output retrieval, and `cancel_operation` for explicit cancellation. Only an OMP-confirmed unexecuted `waiting_input` operation can be resumed with the same ID after answering its model request; completed, cancelled and uncertain work is never automatically re-executed.

On MCP 2.0, Chappie exposes `operation.finished` and `operation.input_required` through the OpenAI MCP Events webhook profile. Subscribe to both for unattended continuation: a model-input wait is nonterminal and cannot produce completion. Each transition and its notification outbox are persisted together; input notifications contain only bounded identifiers/counts, not model prompts. Retrieve authoritative state before responding to an event. Deploy and rescan before testing ChatGPT delivery; no heartbeat or fake MCP Tasks capability is required.

`chat` sends assistant messages to the agent, `history` reads native progress, and `transfer` moves files between connected environments. See the [tool guide](docs/tools.md) for session selection, operation lifetime, completion events, and file transfer.

## Configuration

`chappie.json` lives in the OMP agent directory, normally `~/.omp/agent/chappie.json`.

Local-only use needs no network settings. For sessions on another device,
configure mutual TLS with a private CA and a separate certificate/key per
device. The server certificate must cover the broker's hostname. Certificate
paths are relative to the agent directory; absolute paths are also accepted.

Broker:

```json
{
  "listen": true,
  "listenHost": "192.168.1.10",
  "tls": { "ca": "ca.pem", "cert": "broker.pem", "key": "broker-key.pem" }
}
```

Remote agent:

```json
{
  "connect": "broker.local",
  "tls": { "ca": "ca.pem", "cert": "client.pem", "key": "client-key.pem" }
}
```

Replace the address and hostname with the broker's actual values. TCP defaults
to port `24274` and a loopback listener unless `listenHost` is set. A numeric
`listen` or `connect` host with `:port` selects another port. Only the broker
runs otunnel. Authenticated devices share local-agent privileges; use a CA
trusted only for those devices. Never distribute the CA's private key.

Existing plaintext `listen`/`connect` configurations must add `tls` on both
sides. Plaintext fallback is deliberately not supported. Local Unix sockets
and Windows named pipes do not require certificates.

Set `ask` to `false` to disable webpage questions.

Set `cooldown` to the participation cooldown in seconds. The default is `10`;
`0` disables observer reuse for closely spaced initializations.

OMP users can set `localTools` to `true` to register the opt-in
`sessions`, `remote_tools`, `remote_call`, `remote_chat`, and
`history` collaboration tools. They are active only while the OMP session is
using a non-Chappie model; selecting the Chappie provider keeps ChatGPT-driven
execution isolated. The broker also requires `localTools=true` before it will
relay `remote_call` or `remote_chat`; remote deployments therefore enable
it on both the source OMP side and the broker side. `remote_call` and
`remote_chat` require a stable `operationId`; reuse it only when retrying
the same remote operation so the broker can prevent duplicate native execution.
The default is `false`.

Closely spaced initializations from the same ChatGPT conversation receive guidance to observe through `history` without repeating exports or the completion response. See [participation](docs/tools.md#participation).
