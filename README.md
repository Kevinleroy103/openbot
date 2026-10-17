# OpenBot

A self-hosted take on Grok Bot. You create bots, chat with them one to one or in groups, and they
work for you in the background: they run tasks, follow routines, remember things, and use real
computers. Each bot runs on the coding agent of your choice: **Claude Code**, **Codex** or
**OpenCode**.

- **Bots** with their own name, instructions, memory and skills. New bots introduce themselves and
  ask what you want to do first.
- **Direct messages and group chats.** Bots also message each other.
- **Background tasks and routines** (scheduled or recurring work), with approvals for what you want
  to sign off on.
- **Skills:** a shared library you assign to bots, with imports from [skills.sh](https://skills.sh).
- **Computer use:** on Linux, every bot gets its own virtual desktop with a browser, terminal,
  editor and file manager. Watch it live, take over with your own mouse and keyboard, and hand it
  back. Bots also get a shell and files on any computer you connect.
- A web app that works on desktop and phone.

## Requirements

- [Bun](https://bun.com) 1.4.2 or newer.
- At least one coding agent, signed in on the machine that runs OpenBot:
  - **Claude:** `claude auth login` (Claude Code CLI). OpenBot uses the Claude Agent SDK.
  - **Codex:** install the `codex` CLI and run `codex login`.
  - **OpenCode:** install [OpenCode](https://opencode.ai) and connect a provider.

  Settings › Harnesses shows which ones are ready and what's missing.
- **Optional:** Google Chrome or Chromium, so bots can use a browser.
- **Optional, Linux only:** the desktop programs listed under [Bot desktops](#bot-desktops-linux).

## Quick start

```sh
git clone https://github.com/Leka74/openbot.git
cd openbot
bun install
bun run start
```

OpenBot prints a login link such as `http://127.0.0.1:7420/?token=…`. Open it and create your first
bot. The token is created on the first run and stays the same afterwards.

Data lives in `~/.local/share/openbot` (or `$XDG_DATA_HOME/openbot`). Bot workspaces default to
`~/openbot`.

### Options

```text
--data-dir <path>       Data directory
--port <n>              Port (default 7420)
--host <host>           Bind address (default 127.0.0.1)
--public-origin <url>   Extra origin OpenBot is reached at, e.g. https://box.tailnet.ts.net (repeatable)
--harness <list>        Coding agents to enable, comma separated (default: claude,codex,opencode)
--no-local-node         Don't let bots use this machine
--dev                   Hot reload for development
```

Every option also reads an environment variable (`OPENBOT_PORT`, `OPENBOT_DATA_DIR`, …). Run
`bun apps/server/src/main.ts --help` for the full list.

## Use it from your phone

OpenBot listens on `127.0.0.1` only. To reach it from other devices, put it behind something that
adds HTTPS, and pass that address as `--public-origin`. With [Tailscale](https://tailscale.com):

```sh
tailscale serve --bg --https=8444 http://127.0.0.1:7420
bun run start -- --public-origin https://<machine>.<tailnet>.ts.net:8444
```

Then open the printed login link on your phone.

## Bot desktops (Linux)

On Linux, each bot can have its own virtual screen, 1920×1200 by default. Bots see it through
screenshots and drive it with the mouse and keyboard. You watch it in the web app, and can take
control whenever you want. When a bot needs you, for example to sign in somewhere, it hands the
screen over to you.

Install the required programs, plus the optional ones for a complete desktop:

| | Arch | Debian / Ubuntu |
|---|---|---|
| Required | `xorg-server-xvfb x11vnc xdotool xfwm4 imagemagick` | `xvfb x11vnc xdotool xfwm4 imagemagick` |
| Optional | `plank dbus xfce4-terminal thunar mousepad xorg-xsetroot` | `plank dbus xfce4-terminal thunar mousepad x11-xserver-utils` |

`openbox` works in place of `xfwm4`, and `xterm` in place of `xfce4-terminal`. Settings ›
Computers shows anything that is still missing. Without these programs (on macOS, for example),
bots still get a browser, a terminal and files on the machine.

## Connect other computers

The machine running OpenBot is a computer your bots can use. You can add more, such as a server or
another laptop:

1. In the web app, open Settings › Computers and click **Pair a computer**. You get a one-time
   code.
2. On the other machine, with Bun installed and this repository cloned (run `bun install` first):

   ```sh
   bun apps/node/src/main.ts pair <openbot-url> <code>
   bun apps/node/src/main.ts run
   ```

   The other machine must be able to reach OpenBot, for example over the address you set up in
   [Use it from your phone](#use-it-from-your-phone).

Run `bun apps/node/src/main.ts --help` for the options: workspace folders, read-only folders, how
much the computer allows without asking, and the browser. `bun run --filter @openbot/node build`
compiles the node into a single `apps/node/dist/openbot-node` binary.

## Development

```sh
bun run dev          # hot reload
bun run typecheck
bun run lint
bun run test
```

| Path | What it is |
|---|---|
| `apps/server` | The brain: orchestration, coding agents, storage, the MCP tool gateway and the web server |
| `apps/web` | The web app (React) |
| `apps/node` | The node daemon that connects another computer |
| `packages/core` | Bots, conversations, tasks, routines, approvals, memory and skills |
| `packages/contracts` | Shared schemas and the RPC API |
| `packages/persistence` | SQLite storage and file stores |
| `packages/gateway` | The tools bots get, served over MCP |
| `packages/harness-*` | Claude, Codex and OpenCode adapters, plus a scripted fake for tests |
| `packages/node-daemon`, `packages/node-protocol`, `packages/brain-nodes` | Computers: shell, files, browser, desktops, and how they talk to the brain |
| `packages/client`, `packages/ui` | Web client state and UI components |

Design notes are in [`docs/`](docs): [architecture](docs/architecture.md),
[decisions](docs/decisions.md), [interfaces](docs/interfaces.md) and the
[node protocol](docs/node-protocol.md). If you work on the code with an agent, start with
[`AGENTS.md`](AGENTS.md).
