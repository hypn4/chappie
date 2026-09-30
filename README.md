# Chappie

Use ChatGPT to work through [Pi](https://github.com/earendil-works/pi) or [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi): edit local files, run commands, call agent extensions, exchange files and images, and move between sessions on one or more devices.

This is the maintained [hypn4/chappie](https://github.com/hypn4/chappie) fork of
[zetaloop/chappie](https://github.com/zetaloop/chappie), published as
`@hypn4/chappie`. It includes OMP support and connection and file-transfer fixes.
The original MIT license and attribution are retained.

## Setup

The broker requires Node.js 26 or newer. Use npm's `npx`, or install Bun to
use `bun x`; both launch the published `chappie-omp` executable with Node.js.

Install Chappie for the host you use:

```sh
# Pi
pi install npm:@hypn4/chappie

# OMP
omp plugin install @hypn4/chappie
```

Omitting the version selects npm's `latest` tag. To install or update that
version explicitly, run `omp plugin install @hypn4/chappie@latest`; use
`omp plugin list` to inspect installed plugins. Release candidates are also
available on `next`. Pin a version, such as `@hypn4/chappie@0.6.0-rc.1`,
for reproducible installations, and pin the same version in the broker command.

Remove the upstream package or stop loading the source extension before enabling
this package; both register the same `chappie/chatgpt` provider. Updating the
broker does not update the OMP plugin: keep both on the same version.

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

For OMP, choose one of these commands. The standalone broker works with
unmodified OMP; it does not require `omp --chappie` or an OMP fork.

[npx](https://docs.npmjs.com/cli/v11/commands/npx/):

```yaml
mcp:
  commands:
    - channel: main
      command: npx --yes --package @hypn4/chappie@latest chappie-omp
```

Or [Bun (`bun x`)](https://bun.sh/docs/pm/bunx):

```yaml
mcp:
  commands:
    - channel: main
      command: bun x --package @hypn4/chappie@latest chappie-omp
```

`bunx` is Bun's documented alias for `bun x`; both accept the same arguments.
Prefer `bun x` in configuration so a separate `bunx` command is not required
on `PATH`, including Windows installations that expose only `bun`. If `bunx`
is available, it remains an equivalent alternative.

`--package` selects the package that provides `chappie-omp`. The npx `--yes`
option accepts package installation without prompting on the MCP input stream.
The first run may download dependencies; later runs can use the package cache.
Neither command installs the OMP plugin for you. Bun respects the broker's
Node.js shebang, so no `--bun` override is needed.

Make sure the chosen runner and Node.js are on otunnel's `PATH`. If necessary,
use the runner's actual absolute path, not a `$HOME` or `%USERPROFILE%` placeholder.
This avoids depending on shell expansion or the plugin's internal install path.

Start the tunnel with the updated profile:

```sh
otunnel run --profile chappie
```

Add the tunnel as a developer-mode app in ChatGPT, then start the agent in a project:

```sh
# Pi
pi --provider chappie --model chatgpt

# OMP
omp --model chappie/chatgpt
```

Call `sessions` or `init` from ChatGPT to connect to the agent session. When using
an OMP profile or custom `PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR`, launch otunnel
and OMP with the same environment so the broker and session resolve the same socket.

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

GitHub Actions publishes releases to npm using OIDC and the committed
`publishConfig.tag`; routine releases do not require an npm login.
See [publishing](docs/publishing.md) for the release process.

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

Set `cooldown` to the participation cooldown in seconds. The default is `10`;
`0` disables observer reuse for closely spaced initializations.

OMP users can set `localTools` to `true` to register the opt-in
`sessions`, `remote_tools`, `remote_call`, `remote_chat`, and
`history` collaboration tools. They are active only while the OMP session is
using a non-Chappie model; selecting the Chappie provider keeps ChatGPT-driven
execution isolated. The default is `false`.

Closely spaced initializations from the same ChatGPT conversation receive guidance to observe through `history` without repeating exports or the completion response. See [participation](docs/tools.md#participation).
