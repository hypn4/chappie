# Chappie

Use ChatGPT to work through [Pi](https://github.com/earendil-works/pi) or [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi): edit local files, run commands, call agent extensions, exchange files and images, and move between sessions on one or more devices.

This is the maintained [hypn4/chappie](https://github.com/hypn4/chappie) fork of
[zetaloop/chappie](https://github.com/zetaloop/chappie), published as
`@hypn4/chappie`. It includes OMP support and connection and file-transfer fixes.
The original MIT license and attribution are retained.

## Setup

Install Chappie for the host you use:

```sh
# Pi
pi install npm:@hypn4/chappie

# OMP
omp plugin install @hypn4/chappie
```

Untagged installation selects `latest`. Use `@hypn4/chappie@latest` explicitly
for the same release, or pin `@hypn4/chappie@0.6.0`. Release candidates remain
available through `next`. Remove the upstream Chappie package or stop loading
the source extension before enabling this package; both register the same
`chappie/chatgpt` provider. Keep the broker and extension on the same version.

`omp --chappie` requires an OMP host with the `omp.cli` manifest interface.
The maintained host build `@hypn4/oh-my-pi@18.3.2-chappie.1` provides it;
unmodified upstream OMP 18.3.2 does not. Install that host with the package
manager that owns your `omp` command and avoid competing global OMP binaries.
The existing standalone `chappie-omp` remains available with upstream OMP.
See [host compatibility](docs/publishing.md#host-compatibility) before switching.

Run the broker through [otunnel](https://github.com/zetaloop/otunnel). Use
`otunnel profiles list` to find the active profile; it is typically
`~/.config/tunnel-client/chappie.yaml`.

```yaml
# Pi
mcp:
  commands:
    - channel: main
      command: pi --chappie
```

For a host supporting plugin CLI modes:

```yaml
# OMP
mcp:
  commands:
    - channel: main
      command: omp --chappie
```

With unmodified upstream OMP, use the **absolute path** to the installed
`chappie-omp` executable instead. Do not put `$HOME`, `~`, or `%USERPROFILE%`
in the otunnel command: environment expansion depends on its launcher, not
YAML. On Windows, the standalone executable is `chappie-omp.cmd`.

Add the tunnel as a developer-mode app in ChatGPT, then start the agent in a project:

```sh
# Pi
pi --provider chappie --model chatgpt

# OMP
omp --model chappie/chatgpt
```

Call `init` from ChatGPT to connect to the agent session. When using an OMP
profile or custom `PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR`, give the broker
the same environment so the broker and session resolve the same socket.

## Development

Install dependencies and run the repository checks:

```sh
pnpm install
pnpm check
pnpm build
```

For a local OMP checkout, point the otunnel profile at the built broker:

```yaml
mcp:
  commands:
    - channel: main
      command: node /absolute/path/to/chappie/dist/src/cli.omp.js
```

Then load the source extension directly:

```sh
omp --no-extensions -e /absolute/path/to/chappie/src/index.omp.ts --model chappie/chatgpt
```

Restart otunnel after changing its broker command, then use `sessions` or
`init` from ChatGPT to verify that the OMP session is visible.
After changing tool schemas, refresh the plugin connection in ChatGPT and test
in a new conversation. Restarting the broker alone does not refresh cached tools.

Pi and OMP use different local sockets by default: `~/.pi/agent/chappie.sock`
and `~/.omp/agent/chappie.sock` (named pipes on Windows). The broker and agent
must use the same endpoint; the host name alone does not filter sessions.

`pnpm check` includes installed-layout Node CLI and pinned Pi runtime tests. With OMP on `PATH`,
`pnpm test:omp` also checks a temporary OMP session without using a model API.
The packaged broker is JavaScript; direct TypeScript execution is only for
source checkouts outside `node_modules`.

For the fork release process, see [publishing](docs/publishing.md).

## Usage

Chappie exposes common coding tools directly and every active agent tool through `tools` and `call`. `chat` sends an assistant message to the agent, agent input accompanies later tool results, and `transfer` moves files between ChatGPT and the agent or between connected devices. `history` reads recent agent messages and activity with timestamps. `ask` can present a persistent question in ChatGPT when webpage questions are enabled.

See the [tool guide](docs/tools.md) for session selection, history, agent tools, webpage questions, and file transfer.

## Configuration

`chappie.json` lives in the selected host's agent directory:

- Pi: `~/.pi/agent/chappie.json`
- OMP: `~/.omp/agent/chappie.json`

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

Closely spaced initializations from the same ChatGPT conversation receive guidance to observe through `history` without repeating exports or the completion response. See [participation](docs/tools.md#participation).
