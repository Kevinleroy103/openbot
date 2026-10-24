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
  - `ask <Bot name>`: a bot-to-bot message ("Messaged …" event line) and a reply in that Bot's chat;
  - `ui-comparison`, `ui-chart`, `ui-plan`, `ui-choice`, `ui-agenda`, `ui-compact`, `ui-progress`,
    `ui-everything`, `ui-hostile` (checked first): a `ui` card from `dev/mock/uiCards.ts`. A card with
    actions waits for `cards.act`, then the Bot echoes the answer; `ui-progress` updates its card in place.
- Group chats route to `@mentioned` members, `@everyone`, the replied-to Bot, or the lead Bot.
- `turns.interrupt`, `requests.respond` (all card kinds, "Always allow" saves a rule),
  `bots.create` (the new Bot introduces itself with a question card), `conversations.createGroup`,
  `attachments.upload` (served at `/api/attachments/:id`), `bots.compact` / `bots.newSession`,
  routines (`runNow` streams a briefing), memory, skills, rules, nodes, pairing codes and settings.
- Computers (D1.7): "This computer" offers full desktops (`desktop@1`). `/ws/computer/:botId` serves a
  fake RFB (VNC) desktop per viewer (`dev/mock/rfb.ts`: a 1920×1200 desktop of flat rectangles, RRE
  encoded), so the noVNC view, Take control (control sockets need the lease: 403 otherwise) and I'm done
  (closes control sockets with 1000) run end to end; in control, clicks leave a marker and typing fills
  the focused field. `computer.reset` closes viewers with 1012 and puts the desktop to sleep. Travel
  Desk's desktop starts asleep (Wake), Data Analyst's screen can't be reached (1011 + reason), and
  Expense Clerk runs on `vps-1`, which lacks the desktop programs (`missing`).
- Research Scout has a pending **Action needed** hand-off card (`request_takeover`); handing control back
  answers it "done", like the brain. `POST /api/mock/takeover/:botId` asks again;
  `GET /api/mock/desktop` counts the input the fake desktops received and the open viewers.
- The mock counts only blocking requests in `pendingRequestCount`; browser-only nodes have no screencast.

## Screenshots and smoke test

```sh
bun apps/web/test/shoot.ts [scene…] [--dark|--light]   # → apps/web/test/screenshots/
bun test apps/web/test                                  # unit + Playwright smoke (needs /usr/bin/chromium)
```
