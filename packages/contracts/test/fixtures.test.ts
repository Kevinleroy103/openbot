// Replay-fixture tests: recorded harness streams -> fixture reducers (test helpers) -> schema-checked
// conversation changes -> server replica -> JSON wire -> client projection reducer.
// Covers fresh, mid-stream and resumed subscribers (architecture §8 contracts).
// Ported from vendor/scratch/contracts/test/fixtures.test.ts.
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  applyConversationStreamItem,
  type BotId,
  coalesce,
  type Conversation,
  ConversationChange,
  type ConversationId,
  type ConversationState,
  ConversationStreamItem,
  emptyConversationState,
  KnownConversationChange,
  KnownConversationStreamItem,
  MAX_REPLAY_GAP,
  type TranscriptEntry,
  transcriptOf,
} from "../src/index.ts"
import { reduceClaude } from "./support/reduce/claude.ts"
import { reduceCodex } from "./support/reduce/codex.ts"
import { type Emitter, type Frame, type Ledger, readFixture } from "./support/reduce/kit.ts"
import { reduceOpenCode } from "./support/reduce/opencode.ts"
import { ServerReplica } from "./support/server-replica.ts"

const FIX = `${import.meta.dir}/fixtures`
const conversation: Conversation = {
  id: "conv_fixture" as ConversationId,
  kind: "direct",
  botId: "bot_fixture" as BotId,
  title: "Fixture bot",
  createdAt: 1_792_000_000_000,
  lastActivityAt: 1_792_000_000_000,
  unreadCount: 0,
  hiddenFromSidebar: false,
  epoch: "ep1",
}

const resp = (r: any) =>
  !r
    ? "-"
    : r.type === "decision"
      ? r.decision
      : r.type === "answers"
        ? Object.values(r.answers).flat().join("|")
        : r.type
const summarize = (e: TranscriptEntry): string => {
  switch (e.kind) {
    case "message":
      return `message:${e.role}${e.aborted ? "!" : ""}:${e.text.slice(0, 32)}`
    case "reasoning":
      return `reasoning:${e.text.slice(0, 32)}`
    case "tool-call":
      return `tool:${e.toolKind}:${e.name}:${e.status}`
    case "card":
      return `card:${e.card.type}:${e.state.status}:${resp(e.state.response)}`
    case "notice":
      return `notice:${e.code}`
    case "event":
      return `event:${e.event.type}`
    case "unknown":
      return `unknown:${e.originalTag}`
  }
}

const encodeChange = Schema.encodeSync(KnownConversationChange)
const decodeChange = Schema.decodeUnknownSync(ConversationChange)
const encodeItem = Schema.encodeSync(Schema.fromJsonString(KnownConversationStreamItem))
const decodeItem = Schema.decodeUnknownSync(Schema.fromJsonString(ConversationStreamItem))
/** Send stream items over a JSON "wire" like RpcSerialization.layerJson would. */
const wire = (items: ReadonlyArray<KnownConversationStreamItem>) => items.map((i) => decodeItem(encodeItem(i)))
const feed = (state: ConversationState, items: ReadonlyArray<KnownConversationStreamItem>) =>
  wire(items).reduce(applyConversationStreamItem, state)

type Case = {
  name: string
  file: string
  ledger: string
  reduce: (frames: Frame[]) => { em: Emitter; ledger: Ledger }
  transcript: string[]
  turns: string[]
  noHome: string[]
}

const cases: Case[] = [
  {
    name: "claude",
    file: "claude-basic.jsonl",
    ledger: "claude.ledger.txt",
    reduce: (f) => reduceClaude(f),
    transcript: [
      "message:user:A: say hello",
      "reasoning:The user greets me. I should gre",
      "message:bot:Hello from the scripted Claude.",
      "message:user:B: run a shell command that prin",
      "message:bot:Running it now.",
      "tool:shell:Bash:completed",
      "card:approval:resolved:allow-once",
      "message:bot:The command printed openbot-fixt",
      "message:user:C: write a file called denied.tx",
      "tool:file-write:Write:declined",
      "card:approval:resolved:deny",
      "message:bot:Understood, I did not write the ",
      "message:user:D: ask me which avatar color to ",
      "tool:question:AskUserQuestion:completed",
      "card:question:resolved:Blue",
      "message:bot:Blue it is.",
      "message:user:E: tell me a long story",
      "message:bot!:Once upon a time there was a lig",
      "notice:interrupted",
      "message:user:F: are you still there?",
      "message:bot:Still here after the interrupt.",
    ],
    turns: ["completed", "completed", "completed", "completed", "interrupted", "completed"],
    noHome: [
      "rate_limit_event",
      "stream_event:content_block_delta:signature_delta",
      "system/thinking_tokens",
      "user:text[Request interrupted by user]",
    ],
  },
  {
    name: "codex",
    file: "codex-basic.jsonl",
    ledger: "codex.ledger.txt",
    reduce: (f) => reduceCodex(f),
    transcript: [
      "message:user:A: say hello",
      "reasoning:**Greeting** The user says hello",
      "message:bot:Hello from the scripted Codex.",
      "message:user:B: create a marker file",
      "tool:shell:exec_command:completed",
      "card:approval:resolved:allow-once",
      "message:bot:Created the marker.",
      "message:user:C: delete the marker file",
      "tool:shell:exec_command:declined",
      "card:approval:resolved:deny",
      "message:bot:OK, left it alone.",
      "message:user:D: who are you and remember I li",
      "tool:mcp:mcp__openbot__whoami:completed",
      "tool:mcp:mcp__openbot__remember:completed",
      "card:approval:resolved:allow-once",
      "message:bot:Noted.",
      "message:user:E: count the waves slowly",
      "message:bot!:wave 1, ",
      "notice:interrupted",
      "message:user:F: ask me which avatar color to ",
      "card:question:resolved:Blue (Recommended)",
      "message:bot:Blue it is.",
    ],
    turns: ["completed", "completed", "completed", "completed", "interrupted", "completed"],
    noHome: [
      "account/rateLimits/updated",
      "mcpServer/startupStatus/updated",
      "remoteControl/status/changed",
      "thread/settings/updated",
    ],
  },
  {
    name: "opencode",
    file: "opencode-basic.jsonl",
    ledger: "opencode.ledger.txt",
    reduce: (f) => reduceOpenCode(f),
    transcript: [
      "message:user:A: say hello",
      "reasoning:The user says hello. Keep it sho",
      "message:bot:Hello from the scripted OpenCode",
      "message:user:B: what does the README say?",
      "tool:file-read:read:completed",
      "message:bot:The README says the answer is 42",
      "message:user:C: create a marker file",
      "tool:shell:shell:completed",
      "card:approval:resolved:allow-once",
      "message:bot:Created the marker.",
      "message:user:D: write denied.txt",
      "tool:file-write:write:declined",
      "card:approval:resolved:deny",
      "message:bot:OK, I did not write it.",
      "message:user:E: ask me which avatar color to ",
      "tool:question:question:completed",
      "card:question:resolved:Blue",
      "message:bot:Blue it is.",
      "message:user:F: who are you (use the openbot ",
      "tool:mcp:openbot_whoami:completed",
      "message:bot:I am on the fixture node.",
      "message:user:G: count the waves slowly",
      "message:bot!:wave 1, ",
      "notice:interrupted:user",
    ],
    turns: ["completed", "completed", "completed", "completed", "completed", "completed", "interrupted"],
    noHome: [
      "agent.updated",
      "command.updated",
      "integration.updated",
      "mcp.resources.changed",
      "mcp.status.changed",
      "model.updated",
      "plugin.updated",
      "provider.updated",
      "reference.updated",
      "session.instructions.updated",
      "session.step.streamed",
      "skill.updated",
      "vcs.branch.updated",
      "websearch.updated",
    ],
  },
]

const sortById = <T extends { readonly id: string }>(xs: Iterable<T>) =>
  [...xs].sort((x, y) => x.id.localeCompare(y.id))

const loaded = await Promise.all(cases.map(async (c) => ({ c, frames: await readFixture(`${FIX}/${c.file}`) })))
for (const { c, frames } of loaded) {
  describe(c.name, () => {
    const { em, ledger } = c.reduce(frames)
    const changes = em.changes

    test("every emitted change encodes with the server schema and decodes with the client schema", () => {
      for (const ch of changes) expect(decodeChange(encodeChange(ch))).toEqual(ch as any)
    })

    test("final transcript", () => {
      const server = new ServerReplica(conversation)
      for (const ch of changes) server.apply(ch)
      const { entries, requests, turns } = server.state
      expect(transcriptOf(server.state).map(summarize)).toEqual(c.transcript)
      expect([...turns.values()].map((t): string => t.status)).toEqual(c.turns)
      expect([...requests.values()].every((r) => r.status === "resolved")).toBe(true)
      // no entry left streaming, every tool call terminal, every card resolved
      for (const e of entries.values()) {
        if (e.kind === "message" || e.kind === "reasoning") expect(e.streaming).toBe(false)
        if (e.kind === "tool-call") expect(["completed", "failed", "declined", "interrupted"]).toContain(e.status)
        if (e.kind === "card") expect(e.state.status).toBe("resolved")
      }
      // every request links to an existing card; decision requests always offer allow-once AND deny
      for (const r of requests.values()) {
        expect(entries.has(r.cardEntryId)).toBe(true)
        if (r.responseCapability.type === "decision") {
          const ids = r.responseCapability.options.map((o) => o.id)
          expect(ids).toContain("allow-once")
          expect(ids).toContain("deny")
        }
      }
      for (const e of entries.values())
        if (e.kind === "tool-call" && e.requestId) expect(requests.has(e.requestId)).toBe(true)
    })

    test("projection: fresh, mid-stream + live, resumed with `after`, stale epoch", () => {
      const server = new ServerReplica(conversation)
      const half = Math.floor(changes.length / 2)
      for (const ch of changes.slice(0, half)) server.apply(ch)

      // A and B both load mid-stream (snapshot + synchronized); A stays connected, B disconnects.
      let a = feed(emptyConversationState, server.subscribe())
      let b = feed(emptyConversationState, server.subscribe())
      expect(a.synchronized && b.synchronized).toBe(true)
      const mid = b.cursor!

      a = feed(
        a,
        changes.slice(half).map((ch) => server.apply(ch)),
      )

      // B resumes with `after`: gets only the missed changes (replay path), then synchronized.
      const resume = server.subscribe(mid)
      expect(resume[0]!.kind).toBe("change")
      expect(resume.length).toBe(server.sequence - mid.sequence + 1)
      b = feed(b, resume)

      // C is a fresh client after everything; a stale epoch or a cursor ahead of the head gets a snapshot.
      const c2 = feed(emptyConversationState, server.subscribe())
      expect(server.subscribe({ epoch: "old", sequence: 1 })[0]!.kind).toBe("snapshot")
      expect(server.subscribe({ epoch: server.epoch, sequence: server.sequence + 5 })[0]!.kind).toBe("snapshot")
      expect(MAX_REPLAY_GAP).toBeGreaterThan(server.sequence - mid.sequence)

      const want = transcriptOf(server.state)
      for (const r of [a, b, c2]) {
        expect(r.gap).toBe(false)
        expect(r.synchronized).toBe(true)
        expect(transcriptOf(r)).toEqual(want as any)
        expect(sortById(r.requests.values())).toEqual(sortById(server.state.requests.values()) as any)
        expect(sortById(r.turns.values())).toEqual(sortById(server.state.turns.values()) as any)
        expect(r.cursor).toEqual(server.head)
      }
    })

    test("a skipped change is detected as a gap and not applied; resuming from the cursor heals it", () => {
      const server = new ServerReplica(conversation)
      let client = feed(emptyConversationState, server.subscribe())
      const items = changes.slice(0, 6).map((ch) => server.apply(ch))
      client = feed(client, [items[0]!, items[2]!])
      expect(client.gap).toBe(true)
      expect(client.cursor!.sequence).toBe(1)
      client = feed(client, server.subscribe(client.cursor))
      expect(client.gap).toBe(false)
      expect(transcriptOf(client)).toEqual(transcriptOf(server.state) as any)
    })

    test("maximal live coalescing keeps the same final state", () => {
      const full = new ServerReplica(conversation)
      for (const ch of changes) full.apply(ch)
      const coalesced = coalesce(changes)
      const small = new ServerReplica(conversation)
      for (const ch of coalesced) small.apply(ch)
      expect(sortById(small.state.entries.values())).toEqual(sortById(full.state.entries.values()) as any)
      expect(coalesced.length).toBeLessThan(changes.length)
    })

    test("native events with no home in the contract are pinned (review when this list changes)", async () => {
      expect(ledger.keys("no-home")).toEqual(c.noHome)
      const rows = [...ledger.rows].map(
        ([k, r]) => `${r.disposition.padEnd(9)} ${String(r.count).padStart(3)}  ${k}${r.note ? `  -- ${r.note}` : ""}`,
      )
      const text = rows.join("\n") + "\n"
      const path = `${FIX}/${c.ledger}`
      if (process.env.OPENBOT_UPDATE_LEDGERS === "1") await Bun.write(path, text)
      expect(text).toBe(await Bun.file(path).text())
    })
  })
}
