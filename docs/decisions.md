# OpenBot decision record

Binding decisions for the v1 design and implementation. Each one cites the research that supports it (`docs/research/*`). Where research reports disagree, the resolution here wins. Decisions marked **(reversible)** are defaults the user may change later; they are recorded so the code keeps the seam open.

Status: accepted 2026-10-15 (orchestrator), pending user review.

---

## D0. Product

- **D0.1 What OpenBot is.** An open-source, self-hosted Grok Bot. Named Bots (AI teammates) share one or more computers, chat 1:1 and in group chats, message each other, hand off work, run routines, ask for approval and questions, and keep memory and skills. Each Bot runs on a pluggable **harness**: Claude (Agent SDK), Codex (app-server) or OpenCode (v2 server). Bots can use different harnesses, so a user can mix subscriptions. (grok-bot-product.md §1–6)
- **D0.2 Single owner (v1).** One owner per brain. No multi-user tenancy: vendor terms forbid sharing subscriptions in a hosted, multi-user service. (policy-and-licensing.md)
- **D0.3 Licence: MIT.** Keep third-party notices. Never ship Grok/xAI fonts, logos, icons, avatar artwork or code; tokens and measurements only. (policy-and-licensing.md, grok-design-system.md)
- **D0.4 Differentiators over Grok Bot**, kept small in v1:
  - per-Bot harness and model;
  - visible, editable instructions and memory;
  - an explicit Compact / New session;
  - a node and computer view that shows where things run.

## D1. Brain / hands topology (the user's core requirement)

- **D1.1 Roles.**
  - The **brain** runs orchestration, the harness agent loops, persistence, the MCP gateway and the web UI (`apps/server`).
  - **Hands** are **nodes**, machines that execute tools (`apps/node` daemon).
  - The brain machine is also a node: the **local node**, built from the same `NodeHandlersLive` layer embedded in-process. It is on by default and can be disabled.
  - Brain and hands on one machine is the zero-config default.
- **D1.2 Node transport.**
  - **Control socket.** Each node dials **out** to the brain at `wss://<brain>/node`, so NAT is fine.
  - **RPC.** The control socket carries Effect RPC with `RpcSerialization.layerJsonRpc()` in both directions: `NodeRpcs` is served by the node, `BrainRpcs` by the brain. A direction mux shares the socket between them.
  - **Data streams.** Bulk data (PTY, tunnels, screencast, VNC) uses node-dialed `/node/stream/:id` sockets, each with a one-time 128-bit token that expires after 30 s.
  - **Wire rules.** The JSON-RPC wire rules are documented, so nodes can be written in other languages.
  - Sources: hands-architecture-synthesis.md §S.4; spike `vendor/scratch/hands-e2e`.
- **D1.3 Node auth.**
  - Each node generates an Ed25519 key. An 8-character pairing code (single use, 10-minute TTL) registers its public key.
  - The node signs its WebSocket upgrade. The node pins the brain's key and verifies it via `node.hello`.
  - Revoking a node closes its socket with code 4401.
  - Static bearer tokens are not used. (§S.7)
- **D1.4 Node policy (defense in depth).** The node enforces:
  - roots with realpath containment, default `~/openbot`;
  - a deny-list of sensitive paths;
  - a never/ask/always ceiling that the brain cannot raise;
  - an audit log.

  The brain's approval service always decides first. (remote-prior-art.md §4.7–4.8)
- **D1.5 Tool placement per harness** (supersedes conflicting defaults in remote-claude.md, remote-prior-art.md and hands-architecture-synthesis.md §S.2). A bot session has one **host node**. Tools on any other node the bot is bound to are reached through the gateway's node tools.

  | Harness | Host = local node | Host = remote node, v1 default | Remote, later options (seams kept) |
  |---|---|---|---|
  | Claude | native tools; `cwd` = bot workspace | **B1**: CLI on the brain, all built-ins off (`tools: []`), gateway node tools (`shell`, `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`) aimed at the host node, placement-aware system-prompt append | **R1**: CLI on the node via `spawnClaudeCodeProcess` over a `claude.cli` tunnel. Only when the node has its **own** Claude login or an API key. Never forward claude.ai tokens. |
  | Codex | native tools, explicit `environments: [{environmentId: "local", cwd}]` | **E**: app-server on the brain, `environment/add` with a relay URL to the node's `codex exec-server`; built-ins run on the node. Falls back to **B1** (`environments: []` + node tools + `baseInstructions`) when the node has no codex binary. | **H**: app-server on the node |
  | OpenCode | native tools, `opencode serve` on the brain | **B1**: deny shell/read/edit/write/glob/grep per session, gateway node tools | **H**: `opencode serve` on the node via `service.start` + TCP tunnel; **W**: WorkspaceDriver |

  Why:
  - B1 keeps the agent loop **and** the credentials on the brain. That is the user's own model ("LLM brain on one server, hands elsewhere"), it fits vendor terms (policy-and-licensing.md), and it works for every harness and every node.
  - Codex E is verified end to end and keeps the native tools, so it is worth the extra code.
  - R1 and H are opt-in, per node, later.
- **D1.6 Node tools.**
  - One set of tools, each with a `node` parameter (optional, defaulting to the host node), plus a `list_nodes` tool. No per-node prefixes.
  - Tools return MCP `content` (text plus optional images) and **never `structuredContent`**.
  - Error text reads as an error on its own (`ERROR: …`).
  - Results stay under about 10 KB; larger output is spilled to a file on the node, and the tool returns the path plus paging.
  - Schemas avoid tuples and `prefixItems`.
  - Sources: mcp-conformance.md R1–R5; §S.10.
- **D1.7 Live view.** Per node capability:
  - Nodes that offer a `browser` capability expose CDP: per-bot browser windows, screencast thumbnails and full view, plus takeover via a server-side control lease.
  - Nodes that offer a `desktop` capability (Xvfb/x11vnc) add the noVNC full-desktop view. Watchers connect to a `-viewonly` x11vnc, and the controlling port needs the lease.
  - **v1 must implement the CDP browser path**, because it is testable on this host. The VNC path is designed in the protocol and implemented if capacity allows (remote-computer-control.md; grok-bot-ui-activity.md).
- **D1.8 Listeners.**
  - **Public listener** (`127.0.0.1:<port>` by default): web, `/rpc`, `/ws/computer/:botId`, `/node`, `/node/stream/:id`.
  - **Internal listener** (loopback, ephemeral port): `/mcp/:botId`, `/relay/:nodeId/:kind`.
  - Remote access goes through `tailscale serve` or a TLS reverse proxy. (§S.6, §S.8)

## D2. Harness adapters

All three adapters implement one `HarnessDriver` / `HarnessSession` port (t3code's two-level SPI, trimmed). Adapters keep SDK types inside their own package and emit normalized, whole-entity upserts. Capabilities are declared, never faked. (t3code-architecture.md; domain-contract.md)

- **D2.1 Claude.**
  - **Session.** `@anthropic-ai/claude-agent-sdk` `query()` in streaming-input mode, one long-lived query per bot (D5.0). We generate the `sessionId` and reopen with `resume`.
  - **Steering** pushes `priority: "next"`, never `"now"`: the CLI preempts the running turn for a "now" message (`turn_preempted`, `aborted_streaming`), which cut bots off mid-task whenever a teammate wrote (2026-10-16). An abort OpenBot did not request, with steered input pending, keeps the OpenBot turn open.
  - **Turns the CLI starts itself** (2026-10-17: after a resume the CLI first ran a `<task-notification>` of a background shell of its previous process as a transcript-only turn; its `result` completed the owner's turn 0.5 s in, with no reply, and the answer landed in the next turn). A `result` ends an OpenBot turn only if its CLI turn took that turn's input (`command_lifecycle` `started` or `user_message_uuid(s)` echoes naming its uuids); a result with a non-`human` `origin`, or while the CLI reports the input still `queued`, ends nothing (no signal at all: FIFO order, for older CLIs). Output of such a turn goes to the running OpenBot turn; with none running the adapter emits a harness-initiated turn (`TurnStarted.initiator: "harness"`), which core runs as a "system" turn in the conversation of the bot's latest turn (one turn at a time: deliveries queue behind it or steer into it; Stop interrupts it). So "a background command finished" reaches the owner in the bot's words.
  - **Approvals.** `permissionMode: 'default'` and `canUseTool`, bridged to a RuntimeRequest.
  - **Prompt.** `systemPrompt: {type: 'preset', preset: 'claude_code', append: persona}`.
  - **Clean-room settings.**
    - `settingSources: []`, `strictMcpConfig: true`, `autoMemoryEnabled: false` (or `autoMemoryDirectory` pointing at the bot's memory directory).
    - Disallow the overlapping native tools (SendMessage, Cron*, ScheduleWakeup, RemoteTrigger, PushNotification).
    - Gateway registered via `setMcpServers` with `alwaysLoad`.
    - The user's own claude binary when available (`pathToClaudeCodeExecutable`), otherwise the SDK's bundled CLI.
    - Never change `HOME`. The default account never changes `CLAUDE_CONFIG_DIR`; an account the owner added (D2.7) runs the CLI with `CLAUDE_CONFIG_DIR=<that account's config dir>` (amended 2026-10-16 at the user's request).
  - Sources: sdk-claude.md; harness-context-isolation.md §2.
- **D2.2 Codex.**
  - **Transport.** `codex app-server` (v2 JSON-RPC over stdio). Not `@openai/codex-sdk`.
  - **Process model.** One app-server per OpenBot `CODEX_HOME` (`<data>/codex-home`, with `auth.json` symlinked to the user's `~/.codex/auth.json` and a hermetic `config.toml`). One thread per bot (D5.0).
  - **Per-thread settings.** `developerInstructions` (persona), `config.mcp_servers` (the full map, because it replaces the global one), `features.apps = false`, `features.plugins = false`, `code_mode.direct_only_tool_namespaces`, and **explicit `environments` always** (G3).
  - **Approvals.** Approval server requests map to RuntimeRequests. Deny is always offered.
  - **Binary.** The `@openai/codex` npm package is pinned (0.162.1); the version is checked against `initialize`.
  - Sources: sdk-codex.md; remote-codex.md; harness-context-isolation.md.
- **D2.3 OpenCode.**
  - **Transport.** Server mode: spawn the user's `opencode serve` and use `@opencode/client` 2.0.29 over HTTP+SSE, with root `overrides.effect = 4.0.4` (verified fix).
  - **Persona.** Session instruction entries, never `agent.system`.
  - **Tools.** Directory-scoped `mcp.add` with `codemode: false`, re-added after every server start.
  - **Events.** One event subscription per server, routed by `sessionID`. A turn ends on `session.execution.*`.
  - **Approvals.** `permission.asked` / `permission.reply`.
  - **Isolation env.** `OPENCODE_DISABLE_PROJECT_CONFIG=1` plus an OpenBot `OPENCODE_CONFIG_DIR`. The user's data dir is kept, so their logins work.
  - Sources: sdk-opencode.md; harness-context-isolation.md.
- **D2.4 Fake harness.** `harness-fake` is a deterministic scripted harness. It streams text, calls OpenBot tools through the real gateway, raises approvals and questions, and fails on cue. It powers tests and an "offline demo" without any credentials.
- **D2.5 Process lifetime (v1).**
  - Brain-owned children run in their own process groups. Their PIDs are recorded and killed at brain boot.
  - On restart, every in-flight turn becomes `interrupted` and every pending RuntimeRequest `expired` (`not_resumable`).
  - Detached, supervised harness processes that survive restarts are v1.1 (recovery-matrix.md).
- **D2.7 Harness accounts (profiles).** (user request 2026-10-16: several Claude logins on one machine)
  - A profile is a login/config home on the brain machine: Claude = a `CLAUDE_CONFIG_DIR`; Codex = the `CODEX_HOME` whose `auth.json` backs one OpenBot codex home (`<data>/codex-home/<profileId>`, its own app-server); OpenCode = default only for now.
  - Every harness has an implicit default profile (`"default"`, today's behavior). `Bot.harness.profileId` absent = default. The registry holds one driver per (kind, profile) and never falls back to another account.
  - Profiles are stored in the settings repo (`brain.harnessProfiles`). On a harness's first boot the brain adds the config dirs it discovers (`~/.claude-*`, `~/.codex-*` with a login); afterwards the owner adds/removes them in Settings › Harnesses.
  - Removing a profile is refused while a bot uses it (moving bots silently would bill another account). Switching a bot's account starts a new native session.
  - OpenBot only points the owner's own CLI at the owner's own config dir; it never reads, copies or forwards credentials (discovery reads only Claude's non-secret `.claude.json` account metadata).
- **D2.6 Probes.** Each driver reports install, version and auth status without a model call:
  - Claude: `initializationResult()`.
  - Codex: `account/read`.
  - OpenCode: `/api/info` plus `model.list`.

## D3. OpenBot tools (product behaviour, harness-agnostic)

- **D3.1 One MCP gateway** (MCP SDK 1.32.1 Streamable HTTP on the internal listener).
  - Endpoint `/mcp/:botId` with a per-run bearer token, stored SHA-256 hashed.
  - Stateful sessions; GET returns 405.
  - `idleTimeout: 0`; progress notifications at least every 5 s on long tools.
- **D3.2 Tool sets.**
  - **Bot tools:** `message_bot` (async; `urgent` reaches the recipient as soon as possible — steered into its running turn in the same conversation, else right after it; bots never interrupt each other — `background` waits for its next turn), `post_to_group`, `handoff_task`, `react` (one emoji on a message instead of an acknowledgement), `list_bots`, `ask_user` (question card), `request_approval`, `notify_user`, `send_file` (shares a file the bot produced — image, video, audio, PDF, archive — as its message in the current conversation, or with `to` with another Bot / a group; streamed from the node over a `transfer` data stream under the node's path policy; 200 MB default cap, `--max-file-mb`; every file a bot receives is copied into its workspace `inbox/` before its turn), `remember` / `forget` / `recall_memory`, `create_routine` / `update_routine` / `list_routines`, `save_skill`, `list_nodes`.
  - **Node tools:** `shell`, `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`.
  - **Computer and browser tools:** `browser` (navigate, snapshot, click, type, screenshot, tabs; via CDP or a proxied Playwright MCP on the node) and `computer` (Anthropic action names, fixed 1280-wide coordinate space; only when the node has `desktop`).
  - **Gating.** Which sets a bot gets depends on its placement (D1.5) and on node capabilities.
- **D3.3 Long waits never block a tool call.** `ask_user` and `request_approval` return `{status: pending, id}` immediately. The answer is delivered as a new message into the bot's conversation, which wakes it. Tools are idempotent, keyed on the harness tool-call id. (recovery-matrix.md)

## D4. Domain, persistence, transport

- **D4.1 Domain contract.** Seeded from `vendor/scratch/contracts`.
  - **Transcript entries.** Whole-entry upserts with a version. Six kinds: message, reasoning, tool-call, card, event, notice. Unknown kinds render as a placeholder.
  - **Runtime requests.** Approval, question, form, secret and handoff are each a `RuntimeRequest`, linked to their card and answered by one `requests.respond` RPC.
  - **Conversations.** `direct` (one bot), `group` (2–6 bots), `routine-run`.
  - Source: domain-contract.md §F.4.
- **D4.2 Persistence.**
  - Group chats can be deleted (`conversations.delete`, groups only): their transcript, turns, requests and replica go; member bots stay (their single session keeps what it saw).
  - `@effect/sql-sqlite-bun` 4.0.4 with WAL and migrations via `SqliteMigrator.fromRecord`.
  - Projection tables (bots, conversations, members, entries, requests, routines, runs, nodes, memory, skills, settings) and an `events` log with a global sequence.
  - Writes commit before publishing. `Reactivity.mutation` drives live queries.
- **D4.3 Brain ↔ client transport.**
  - Effect RPC over WebSocket at `/rpc` with `RpcSerialization.layerJson`.
  - `conversations.subscribe` and `roster.subscribe` send a snapshot, then upserts, with an `{epoch, sequence}` resume cursor. A gap of 256 changes or fewer is replayed; a larger gap gets a snapshot. A synchronized marker follows. Clients re-subscribe with backoff.
  - Sources: domain-contract.md §F.4; effect4-platform.md; recovery-matrix.md.
- **D4.4 Web auth (single owner).**
  - On first start the brain prints a one-time login URL with a token, which is exchanged for an HttpOnly session cookie.
  - Every cookie-authenticated upgrade checks an Origin allow-list.
  - `wsTicket` serves non-cookie clients.
  - The MCP gateway accepts bearer tokens only.
- **D4.5 Effect.** All packages pin `effect` and `@effect/*` to exactly `4.0.4`. Root `overrides` covers `effect` and `@effect/platform-node-shared`. The API reference is `vendor/effect-4.0.4` (the local `vendor/effect` is rc.117). Idioms follow effect4-core.md: `Context.Service`, `Layer`, `Schema.TaggedError`, `Effect.fn`, scoped resources.

## D5. Group chats, handoffs, routines, memory, skills

- **D5.0 One mind per bot.** (user decision 2026-10-16; replaces the per-(bot, conversation) native sessions of D2.1/D2.2/D5.1)
  - **One native harness session per bot**, shared by all of its conversations: its DM with the owner, every group it is in, routine runs and bot-to-bot DMs. Before, each conversation had its own session, so a bot in its DM did not remember what it had just done in a group (bots concluded there was "a second Codex session").
  - **One runner per bot** (`BotRunner`) owns that session. Deliveries from every conversation queue FIFO there; different bots still run in parallel.
  - **Every turn belongs to exactly one conversation** (its delivery's): its replies, tool calls, cards, activity and usage land there. A delivery for another conversation never steers the running turn; it queues (the owner's message shows `queued`). Steering only into a running turn of the same conversation (`capabilities.steer`). Background bot messages are batched only with the next turn of their own conversation. Bot messages never interrupt a turn.
  - **Origin tags** in the turn text tell the one session where a message comes from: the group header (`[Group chat "…" · members: …]` + the group messages it has not seen), `[DM with the owner]` when the previous turn was elsewhere, `[Routine run "…"]`, `[Direct message from @Ada]: …`. The instructions say the bot is one teammate across conversations, its reply is posted where the message came from, and `post_to_group` / `message_bot` reach other conversations.
  - **Gateway:** the MCP token is per bot session (home = the bot's DM); each tool call resolves the conversation of the bot's CURRENT turn (`Orchestrator.activeTurn(botId)`), falling back to the DM.
  - **Session controls are per bot:** New session / Compact / the context ring (kept on the DM) apply to the one session; `Conflict` while the bot works anywhere. `turns.interrupt` in a conversation stops the running turn only if it belongs to that conversation; otherwise it cancels that conversation's queued turns.
  - **Storage:** `bot_sessions` (one row per bot, with per-conversation `seen` cursors for group catch-up) replaces `native_sessions`. Upgrade (migration `0002_one_mind_per_bot`): each bot adopts its DM's native session; its other sessions are dropped.
  - **Never dropped:** a delivery steered into a turn that then ends early without the owner's Stop runs again as its own turn, and the next turn is told its previous reply may not have reached the conversation.

- **D5.1 Group chats.**
  - 2–6 bots per group. A message goes to `@mentioned` bots, `@everyone` goes to all, and a reply goes to the bot being replied to.
  - Otherwise a **router** picks the responders: v1 uses the group's designated lead bot, or else the first bot; a cheap model-based router comes later.
  - Each member bot works in the group through its single session (D5.0). Messages are fanned out with sender attribution; each group turn opens with a one-line header (title, members, "your reply is posted here; @mention a teammate only when you need them; nothing to add → react or NO_REPLY") followed by the group messages the bot has not seen yet (each once).
  - **Quiet acknowledgements.** A bot reply that is exactly `NO_REPLY` is not posted (the turn completes silently, steps kept); a bot may `react` with an emoji instead. Instructions: only @mention a teammate when you need them to act or answer, never to thank. Each member is woken at most once per reply, with the final message rather than mid-turn commentary.
  - Approval and question cards raised during a group turn are shown in the group, next to the work (revised: they used to go to the bot's DM, which split the conversation).
  - Source: grok-bot-product.md §6.8.
- **D5.2 Bot-to-bot.**
  - `message_bot` writes into the recipient's DM as a message from the sender bot. The sender's chat shows an event line ("Messaged X").
  - Exception: from a group turn to a fellow member, `message_bot` / `handoff_task` stay in the group without a separate post: the member is noted and woken by the turn's reply when it @mentions them (no near-identical double posts); if the reply does not @mention them (or there is no reply), the tool's text is posted as `@Recipient …`. The team never splits into private side channels. A reply that mentions an already-addressed member does not wake it again.
  - Delivery is queued per recipient bot (D5.0). Messages are delivered at turn boundaries or steered into a running turn of the same conversation; they wake an idle bot. A bot message never interrupts a turn; only the owner can.
  - In the recipient's DM, its replies to another bot's message (a turn triggered by that message) are labelled "to @Sender" above the bubble group, so the owner sees they are not addressed to them.
  - Hop limit 8 per causal chain, plus a global kill switch in Settings.
- **D5.3 Routines.**
  - Owned by one bot. Triggers in v1: cron schedule with timezone, interval (5 minutes minimum) and once; webhooks come later.
  - Each run posts into the owning bot's DM as an event, followed by the bot's turn.
  - Each routine has Active / Paused state, a test run, and the last 20 runs kept.
- **D5.4 Memory.**
  - Stored per bot in Claude auto-memory format: a `MEMORY.md` index plus one file per fact under `<data>/bots/<id>/memory`.
  - Claude reads and writes it natively via `autoMemoryDirectory`. Codex and OpenCode receive the index in their instructions plus the `remember` / `forget` tools.
  - Viewable and editable in the details pane. Source: harness-context-isolation.md.
- **D5.5 Skills** (revised 2026-10-17 with the owner: a library plus per-Bot skills, so a community catalog fits).
  - **Library:** one at `<data>/skills-lib` in Claude plugin layout (`.claude-plugin/plugin.json` + `skills/<name>/SKILL.md`, plus any other files of a skill: scripts, references). Agent Skills format, so community skills work unchanged.
  - **Per-Bot skills:** `Bot.skills` lists the library skills a Bot has; it sees no others. The owner creates skills and turns them on or off per Bot (Settings › Skills, Details › Library). A Bot's `save_skill` saves and gives the skill to itself; it may update only skills it has. `enable_skill` (for itself or a teammate) and taking a skill from a teammate (`disable_skill`) wait for the owner on an approval card (surface `skills`): autonomy never decides it, only a rule or the owner. Dropping its own skill needs no approval. Deleting a library skill takes it from every Bot.
  - **Mounting:** Claude gets a per-Bot plugin (`<bot>/skills-plugin/<hash>/`, symlinks into the library: verified that the CLI loads symlinked skill folders); Codex mounts the library root and disables, per thread, every skill the Bot does not have (`skills.config`); OpenCode denies the `skill` permission except for the Bot's skills (skill id = folder name). A change to a Bot's skills reopens its session on the next turn (it is part of the session signature).
  - **Community import:** skills.sh first (`/api/search`, `/api/download/<owner>/<repo>/<skill>`, the endpoints of its `skills` CLI): search, preview (nothing written), install into the library with `metadata.source` (`skills.sh:<id>`) and given to chosen Bots, by the owner (Settings) or by a Bot (`find_skills`, `preview_skill`, `install_skill`; installing waits for the owner's approval card). Paths are checked (relative, inside the folder) and size-capped (200 files, 5 MB). An OpenBot community catalog can come later behind the same `SkillDirectory` port.
- **D5.6 Approval policy.**
  - Allow once / Always allow (saved as a rule) / Deny.
  - "Ask first" rules beat "Allow automatically" rules.
  - Unattended requests expire after 10 minutes. Expired cards offer "Always allow next time".
  - Rules live on the brain. Nodes enforce their own ceiling on top.
  - Per-bot **autonomy** (Grok "Allow automatically") applies when no rule matches: `ask` (cards), `workspace` (default; allow what provably stays in the bot's workspace on its host node, ask otherwise), `full` (allow every harness approval). Rules always win; a node's own `ask` ceiling is never overridden. Only the owner sets autonomy (bot tools cannot).
  - **Project folders** (user feedback 2026-10-16: bots working in `~/projects/…` asked for everything under "workspace", so the owner switched to Full auto). Settings › Permissions "Shared project folders" (all bots) ∪ Details › Brain "Project folders" (`Bot.projectFolders`) count as workspace for autonomy `workspace`. They are absolute paths on the bot's host computer (`~` allowed; never `/`, `~` or a whole home); `~` expands with the node's home when known (`HostPaths`: the local node uses the brain's `HOME`; remote nodes report none yet, so their `~` folders keep asking). Pure path math, as for the workspace (symlinks are not resolved). Owner-only: bot tools cannot change them. Bots are told their folders in the instructions ("Where you run").
  - The **local node**'s path policy gets the same folders as per-bot roots (live, from the roster), so gateway node tools can work there. **Remote nodes keep their own roots** (their owner's `--root` flags): the brain never widens a remote node's policy.
  - **"Allow in ‹folder›"**: when autonomy `workspace` asks because a shell / file request works in a directory outside every root, the card also offers that directory's git repo root (else the directory; never the home, its ancestors, system or secret dirs). Answering `{decision: "allow-once", scope: "project-folder"}` allows it and adds the folder to the bot's project folders. Allow once / Always allow / Deny stay.
  - **Default for new bots**: Settings `defaultAutonomy` (default `workspace`) preselects New Bot; `create_bot` gives min(creator's autonomy, default).
  - `auto-decided` events stay in the transcript (audit) with their turn and the gated tool call's key, but **allowed** ones are not chat lines: they fold into the turn's "N steps" (an "auto-allowed · rule / workspace / full auto" badge on the step). Denials by rule stay visible lines.
- **D5.7 Background tasks.** (user request 2026-10-16, like Grok Bot: a long job no longer blocks the bot; before, the owner's messages queued behind it — "Busy · queued")
  - **What.** A bot hands long work to a separate, short-lived harness session of its own and stays free to chat. `start_task {title, brief}` records a Task (`queued → running → succeeded | failed | cancelled`; origin = the conversation of the calling turn) and returns at once: the turn that started it ends normally and its reply is posted.
  - **The task's session.** Same driver, account, model, effort, placement (computer, workspace), autonomy and project folders as the bot; a fresh native session (never resumed) with driver key `<botId>:<taskId>`; instructions = the bot's rendered instructions + a "Right now" section (do this one piece of work, the final answer goes back to yourself, you cannot ask the owner — say what you need in the result); the first turn's text is the recent messages of the origin conversation (≤ 30 messages / 12 KB, newest kept, compact with speakers `[Owner]` / `[You]` / `[@Name]`; each ≤ 4 KB) followed by `[The brief]` and the brief (user feedback 2026-10-17: a bot wrote a 6,911-character brief and starting took ~30 s; with the context the brief stays short). Its MCP token carries `taskId`: the gateway keeps the origin conversation (no current-turn lookup) and offers neither the task tools nor `ask_user` / `request_approval`.
  - **Limits.** At most 3 tasks of one bot run at once (`BackgroundTasksOptions.maxPerBot`); more wait in line (FIFO).
  - **Steps are not chat bubbles.** The task's harness events are stored as its steps (`task_steps`, `TaskRepo.putStep`), never as conversation entries; usage counts for the bot. Auto-allowed approvals of a task are steps too.
  - **Result.** When a task ends, a `task-result` delivery brings `[Result of "<title>"]` + the result (or why it could not be finished, or that the owner stopped it, with what it had so far) to the bot's MAIN session in the origin conversation (its DM if it left that conversation): it wakes an idle bot, or waits for the current turn (never steered). The bot reports in its own words. Files: the task uses `send_file` (posted in the origin conversation) or names paths in its result.
  - **Tools.** `start_task`, `list_tasks` (title, state, elapsed), `check_task {task}` (state, latest progress, partial output / result), `cancel_task {task}` (by title or id; stops only that work), `update_task {task, message}` (passes feedback or changes on to running work). Descriptions say: work likely to take more than about a minute or many tool steps → `start_task`; quick things directly; the brief is short — one to a few sentences: what to do and what done looks like — because the work sees the recent conversation, its files and memory; feedback or changes for running work go through `update_task` instead of waiting for it or starting over.
  - **Updates.** (user request 2026-10-17: a bot answered the owner's correction with "I'll fix it as soon as it finishes") `update_task` → `BackgroundTasks.update`: steered into the task's running turn when its driver can steer (`capabilities.steer`), otherwise its session's next turn (the work goes on with it after the current turn and answers again; the run loop picks pending updates up when a turn completes), or its first turn when it has not started. Never dropped: work that is already over (or being stopped) answers plainly so the bot can start it again. Model-facing frame: `[Update to this work]` + the message (the task section says to apply it to the work in progress, without starting over unless required). Each update is one of the task's steps (a `message` entry with `role: "user"`); the Tasks tab shows it as an "Update" row among the steps.
  - **Bots talk like people (product rule).** Never "background task", "worker", "session", "subagent", "spawn", "tool" or ids to the owner. No example phrases in any prompt or tool text (models repeat them verbatim): the instructions state the principle only ("acknowledge briefly in your own words only when it helps, then deliver the result; never describe how you work unless the owner explicitly asks"). Tool results are plain content without plumbing words (`start_task`'s ends with the rule, stated plainly: talk about the work itself, not about how it is run — Claude otherwise called it "a background task" in live checks). Status is the UI's job. A gated live check (`apps/server/test/live/tasks.test.ts`) scans the bot's visible replies for plumbing words.
  - **Approvals.** A task's approvals (native and gateway tools) follow the bot's rules and autonomy; their cards land in the origin conversation labelled with the task title (`taskTitle`, card subtitle; `RuntimeRequest.taskId`) and the answer goes back to the task's session. A task's native questions are refused.
  - **Stop.** The owner's Stop (`tasks.cancel`) stops only that task and tells the bot; the bot's own `cancel_task` is not reported back. The owner's Stop on a turn never stops tasks. Deleting the bot stops its tasks and deletes their records; deleting a group stops the tasks started there (nobody is told).
  - **Restart.** Boot recovery fails queued/running tasks ("interrupted by a restart"); once the drivers are registered the brain tells each bot (`BackgroundTasks.recover`).
  - **UI.** ONE status line per bot above the composer, in the activity row's look (avatar + shimmering phrase; user feedback 2026-10-17: two status lines in two styles were confusing): its turn here → the turn's phrase; else busy in another conversation while a message here waits → "Busy in … · your message is queued"; else background work started here runs → "Handling…" (no titles, no counts); else busy elsewhere → "Busy in …". The sidebar preview follows the same order for the bot's DM ("Handling…" also for work started elsewhere when the bot is otherwise idle). "Handling…" opens the details pane's **Tasks** tab (Details | Tasks | Library | Computer): in progress and finished rows with status pill, time and origin chat, expandable to steps and result, Stop on running work. Live through roster `task.upserted` / `task.removed` (progress throttled to 1.5 s).

## D6. UI

- **D6.1 Stack.**
  - React 19 via Bun HTML imports, served by `BunHttpServer.layer` routes (HMR in dev).
  - Tailwind 4 via `bun-plugin-tailwind`; `@effect/atom-react` for server state.
  - `lucide-react` icons (ISC); Inter Variable and Geist Mono fonts.
- **D6.2 Look.** Replicate Grok Bot v0.70.2 (grok-bot-ui.md, grok-bot-ui-activity.md, grok-design-system.md):
  - a three-pane grid: sidebar 280 px | chat (max 960) | details pane 320 px;
  - the floating header pill;
  - pinned bot tiles and sections;
  - bubbles with 18 px corners (6 px where grouped), the bot bubble at 6 % ink, the user bubble in the bot's color;
  - event lines; typed cards; the pill composer;
  - the segmented Details | Library | Computer tabs (OpenBot adds Tasks, D5.7);
  - Settings dialog 900×702;
  - dark and light themes from the token generator (`vendor/scratch/grok-ds/proto`).
- **D6.3 Avatars.** An original set of SVG blob characters (about 13 shapes × 11 colors) with two capsule eyes and a few expressions. Defaults come from an FNV-1a hash of the bot id. The avatar animates while the bot works.
- **D6.4 Tool activity.**
  - As in Grok, tool calls do not appear as chat bubbles. One activity row (animated avatar plus a shimmering phrase) is shown while the bot works.
  - Its phrases are human and plumbing-free in every adapter (shared in `contracts/activity.ts`, user feedback 2026-10-17: the row said "Start task"): never a tool name; real work keeps its phrase ("Running a command", "Reading files", "Searching the web", "Using the browser"); messaging teammates or a group (`message_bot`, `handoff_task`, `post_to_group`) → "Sending a message"; the bot's own bookkeeping (task, memory, routine, section, skill tools, `react`, `create_bot`/`update_bot`, `list_*`), native helpers/subagents and tools without a phrase → the generic "Thinking…"; another MCP server → "Working in a connected app".
  - OpenBot addition: a collapsed "N steps ›" disclosure under finished turns, using Grok's Full-conversation row tokens. It is on by default and can be turned off in Settings.
- **D6.5 OpenBot-only screens.** Harness picker in New Bot, Settings › Harnesses, Settings › Computers (pairing, capabilities), a context ring with Compact / New session, and node selection per bot. All use Grok tokens (grok-bot-ui-activity.md F.10).

## D7. Engineering

- **D7.1 Monorepo.** Bun workspaces with a catalog, turbo, TypeScript 7 (`tsc`), oxlint and oxfmt. Packages export source entry points. `vendor/` is never imported.
- **D7.2 Dependency direction.** `contracts` → `core` (ports and services) → adapters and infrastructure → `apps/*` (composition roots). Core imports no SDK, SQL or React.
- **D7.3 Tests.**
  - `bun test` throughout.
  - Adapters are tested against recorded transcripts (`vendor/scratch/contracts` fixtures, copied into the repo) and fake SDK transports.
  - Live harness tests are gated by environment variables.
  - The end-to-end UI test uses `harness-fake` with Playwright.
