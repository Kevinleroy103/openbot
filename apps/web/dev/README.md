# Web dev mock

A dev-only backend for the web UI while `apps/server` is being built. It serves `index.html`
through a Bun HTML import (Tailwind, HMR) and implements every `OpenBotRpcs` method over Effect RPC
on `/rpc` (WebSocket, `RpcSerialization.layerJson`) with an in-memory brain.

```sh
bun apps/web/dev/mock-server.ts            # http://127.0.0.1:4321
bun apps/web/dev/mock-server.ts --port 5000 --fast   # 4x faster simulated turns
bun apps/web/dev/mock-server.ts --empty    # no Bots: first-run onboarding
```

It re-runs itself from `apps/web` because Bun reads the Tailwind plugin from the working
directory's `bunfig.toml`, and only `apps/web` declares `bun-plugin-tailwind`.

## What it simulates

- Seed data like the Grok Bot reference renders: eight Bots (pinned tiles, Revenue / Engineering
  sections, Unassigned, one hidden), a Chief of Staff chat with a question card, an approval card
  and event lines, an expired approval, a failed turn (error tray), forms and secrets, a group chat,
  routines, memory, skills, rules, nodes and harness statuses, and a long Sales Outreach ↔ Research
  Scout bot-to-bot exchange (`conversations.exchange` pages it in the exchange dialog).
- `messages.send` starts a scripted turn: thinking, tool steps, then a streamed reply. Keywords pick
  other scripts:
  - `run`, `approve`, `deploy`, `delete`, `push`, `archive`: an approval card that blocks the turn
    until you answer it;
  - `which`, `choose`, `pick`, `options`: a question card;
  - `fail`, `error`: a failed turn ("Bot failed to respond");
  - `ask <Bot name>`: a bot-to-bot message ("Messaged …" event line) and a reply in that Bot's chat.
- Group chats route to `@mentioned` members, `@everyone`, the replied-to Bot, or the lead Bot.
- `turns.interrupt`, `requests.respond` (all card kinds, "Always allow" saves a rule),
  `bots.create` (the new Bot introduces itself with a question card), `conversations.createGroup`,
  `attachments.upload` (served at `/api/attachments/:id`), `bots.compact` / `bots.newSession`,
  routines (`runNow` streams a briefing), memory, skills, rules, nodes, pairing codes and settings.
- The mock counts only blocking requests in `pendingRequestCount`; there is no live computer view.

## Screenshots and smoke test

```sh
bun apps/web/test/shoot.ts [scene…] [--dark|--light]   # → apps/web/test/screenshots/
bun test apps/web/test                                  # unit + Playwright smoke (needs /usr/bin/chromium)
```
