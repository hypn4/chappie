# Chappie

Use ChatGPT to work through [Pi](https://github.com/earendil-works/pi) or [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi): edit local files, run commands, call agent extensions, exchange files and images, and move between sessions on one or more devices.

## Setup

Install Chappie for the host you use:

```sh
# Pi
pi install npm:@zetaloop/chappie

# OMP
omp plugin install @zetaloop/chappie
```

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

OMP uses the standalone broker executable:

```yaml
mcp:
  commands:
    - channel: main
      command: $HOME/.omp/plugins/node_modules/.bin/chappie-omp
```

On Windows, use the corresponding
`%USERPROFILE%\.omp\plugins\node_modules\.bin\chappie-omp.cmd` path.

Start the agent in a project:

```sh
# Pi
pi --provider chappie --model chatgpt

# OMP
omp --model chappie/chatgpt
```

Call `init` from ChatGPT to connect to the agent session. When using an OMP
profile or custom `PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR`, give `chappie-omp`
the same environment so the broker and session resolve the same socket.

## Development

Install dependencies and run the repository checks:

```sh
pnpm install
pnpm check
```

For a local OMP checkout, point the otunnel profile at the source broker:

```yaml
mcp:
  commands:
    - channel: main
      command: node /absolute/path/to/chappie/src/cli.omp.ts
```

Then load the source extension directly:

```sh
omp --no-extensions -e /absolute/path/to/chappie/src/index.omp.ts --model chappie/chatgpt
```

Restart otunnel after changing its broker command, then use `sessions` or
`init` from ChatGPT to verify that the OMP session is visible.

Pi and OMP use different local sockets by default: `~/.pi/agent/chappie.sock`
and `~/.omp/agent/chappie.sock`. otunnel must launch the broker for the host
being tested; a Pi broker only exposes Pi sessions, and an OMP broker only
exposes OMP sessions.

## Usage

Chappie exposes common coding tools directly and every active agent tool through `tools` and `call`. `chat` sends an assistant message to the agent, agent input accompanies later tool results, and `transfer` moves files between ChatGPT and the agent or between connected devices. `history` reads recent agent messages and activity with timestamps. `ask` can present a persistent question in ChatGPT when webpage questions are enabled.

See the [tool guide](docs/tools.md) for session selection, history, agent tools, webpage questions, and file transfer.

## Configuration

`chappie.json` lives in the selected host's agent directory:

- Pi: `~/.pi/agent/chappie.json`
- OMP: `~/.omp/agent/chappie.json`

A broker can accept sessions from other devices on the local network:

```json
{ "listen": true }
```

Remote sessions connect through the broker device's mDNS name:

```json
{ "connect": "<broker>.local" }
```

The default port is `24274`. Set `listen` to a port number or append `:port` to `connect` to use another one. Only the broker device runs otunnel; local and remote sessions appear in the same session list.

Set `ask` to `false` to disable webpage questions.

Closely spaced initializations from the same ChatGPT conversation receive guidance to observe the ongoing work through `history` and explain its results. See [participation](docs/tools.md#participation).
