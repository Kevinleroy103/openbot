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
  editor and file manager; on a Mac, bots use the Mac's own screen while you're away from it.
  Watch it live, take over with your own mouse and keyboard, and hand it back. Bots also get a
  shell and files on any computer you connect.
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
--desktop-idle <min>    Put an unused bot desktop to sleep after this many minutes (default 10; 0 = never)
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

## Updating a running OpenBot

`bun run deploy` ships the working tree to the OpenBot that is running, without losing your Bots'
work:

```sh
bun run deploy              # bots get up to 3 minutes to finish, then the rest is saved and resumed
bun run deploy --grace 10m  # wait longer for running work
bun run deploy --now        # restart right away (work is still saved and resumed)
```

It copies the repo into a new release under `~/.local/share/openbot-releases` (unchanged files are
hard links, so it is quick), checks that it loads, and asks the running OpenBot to drain: no new
reply or task starts (your messages wait, shown as queued), running ones get the grace period. Then
it backs up the database, starts the new release with the same arguments and switches over in about
a second. Messages that waited are answered, and Bots that were cut off mid-reply or mid-task pick
up where they were. If the new release does not start, the previous one is started again.

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
Computers shows anything that is still missing.

On macOS, bots use the Mac's own screen instead, with its apps and your logins: one bot at a time,
and only while you are away from it (no keyboard or mouse use for 20 seconds). Turn on **This
Mac's screen** for the computer in Settings › Computers, then allow Screen Recording and
Accessibility for `openbot-node` in System Settings › Privacy & Security.

## Connect other computers

The machine running OpenBot is a computer your bots can use. You can add more, such as a server or
another laptop:

1. In the web app, open Settings › Computers and click **Pair a computer**.
2. Run the command it shows on the other machine (Linux or macOS):

   ```sh
   curl -fsSL https://<your-openbot>/node/install.sh | sh -s -- <code>
   ```

   It downloads the node from your OpenBot (built from the same source, so they always match), puts
   it in `~/.local/bin`, pairs it with the one-time code, and keeps it running as a user service
   (systemd on Linux, launchd on macOS).

To update the node later, run the same command without the code: it replaces the program and
restarts it, and the pairing stays.

The other machine must be able to reach OpenBot, for example over the address you set up in
[Use it from your phone](#use-it-from-your-phone). Run `openbot-node --help` there for the options:
workspace folders, read-only folders, how much the computer allows without asking, and the browser.

Without the installer, from a clone of this repository: `bun apps/node/src/main.ts pair <openbot-url> <code>`,
then `bun apps/node/src/main.ts run`.

## iPhone app

`apps/mobile` is a native iPhone app (Expo) with the same chats, cards and live updates, in iOS's
liquid glass look. To try it without building anything, install **Expo Go** from the App Store and
start the dev server where your iPhone can reach it, for example over Tailscale. Expo Go on an
iPhone only opens projects from a dev server signed in to the same (free) Expo account as Expo Go,
so sign in once with `expo login` (or set `EXPO_TOKEN` to an access token from expo.dev):

```sh
tailscale serve --bg --https=8445 http://127.0.0.1:8081
cd apps/mobile && bunx expo login
EXPO_PACKAGER_PROXY_URL=https://<machine>.<tailnet>.ts.net:8445 bunx expo start
```

Open `exps://<machine>.<tailnet>.ts.net:8445` on the iPhone (or scan the QR code Expo prints), then
connect with the code under Settings › iPhone app in OpenBot.

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
