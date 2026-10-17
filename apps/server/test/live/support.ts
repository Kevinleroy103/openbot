/**
 * Live (real harness) scenario support. Everything here spends real model tokens, so it is only
 * used by the `test/live/*.test.ts` suites, gated by `OPENBOT_LIVE=1` (skipped in default `bun test` runs).
 *
 * The brain is the real `ServerLive` with the real harness drivers (claude/codex/opencode) and the
 * real local node; the test talks to it over `/rpc` exactly like the web app does. A background
 * auto-approver answers every pending approval with `allow-once` (and logs it), so turns that ask
 * for a shell command or a file write go through.
 */
import {
  type Bot,
  type ConversationId,
  type ConversationState,
  type HarnessKindName,
  type NodeId,
  pendingRequestsOf,
  type RuntimeRequest,
  type TranscriptEntry,
  transcriptOf,
  type Turn,
  type TurnId,
} from "@openbot/contracts"
import { Effect, Ref, Schedule, type Scope, Stream } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { harnessDrivers } from "../../src/server.ts"
import { login, type OpenBotClient, rpcClient, startServer, testConfig, type TestServer, watchConversation } from "../helpers.ts"

export const LIVE = process.env["OPENBOT_LIVE"] === "1"

/** The cheapest models per harness (overridable). Prompts stay tiny. */
export const CHEAP = {
  claude: { kind: "claude", model: process.env["OPENBOT_LIVE_CLAUDE_MODEL"] ?? "haiku", effort: "low" },
  codex: { kind: "codex", model: process.env["OPENBOT_LIVE_CODEX_MODEL"] ?? "gpt-5.6-luna", effort: "low" },
  opencode: { kind: "opencode", model: process.env["OPENBOT_LIVE_OPENCODE_MODEL"] ?? "openai/gpt-5.6-luna", effort: "low" },
} as const satisfies Record<string, { kind: HarnessKindName; model: string; effort: string }>
export type CheapHarness = keyof typeof CHEAP

export interface LiveBrain {
  readonly server: TestServer
  readonly cookie: string
  readonly run: <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Promise<A>
  readonly approvals: Array<RuntimeRequest>
  readonly close: () => Promise<void>
}

const log = (...args: ReadonlyArray<unknown>) => console.log("[live]", ...args)

/** Boots the real brain (all harnesses, the local node with its browser) and an auto-approver. */
export const startLiveBrain = async (options?: { readonly dataDir?: string }): Promise<LiveBrain> => {
  const dataDir = options?.dataDir ?? mkdtempSync(join(tmpdir(), "openbot-live-"))
  const config = { harnesses: ["fake", "claude", "codex", "opencode"] as const }
  const server = await startServer({
    dataDir,
    config,
    server: { drivers: harnessDrivers(testConfig(dataDir, config)), localNode: undefined, quiet: true },
  })
  const cookie = await login(server.base, server.ownerToken)
  log("brain", server.base, "data", dataDir)
  const approvals: Array<RuntimeRequest> = []
  const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))
  // the auto-approver: allow-once every pending approval (questions are left alone)
  const stop = new AbortController()
  void run(Effect.gen(function*() {
    const client = yield* connect(server, cookie)
    yield* Effect.gen(function*() {
      const pending = yield* client["requests.listPending"]({})
      for (const request of pending) {
        if (request.kind === "question" || request.kind === "form" || request.kind === "secret") continue
        approvals.push(request)
        log("approve", request.kind, JSON.stringify(request.subject).slice(0, 300))
        yield* client["requests.respond"]({ requestId: request.id, response: { type: "decision", decision: "allow-once" } })
          .pipe(Effect.ignore)
      }
    }).pipe(Effect.catchCause(() => Effect.void), Effect.repeat(Schedule.spaced("300 millis")))
  }).pipe(Effect.raceFirst(Effect.callback<void>((resume) => {
    stop.signal.addEventListener("abort", () => resume(Effect.void))
  }))))
  return {
    server,
    cookie,
    run,
    approvals,
    close: async () => {
      stop.abort()
      await server.close({ keepData: process.env["OPENBOT_LIVE_KEEP"] === "1" })
    },
  }
}

export const connect = (server: TestServer, cookie: string) =>
  rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })

let nonce = 0
export const nextNonce = (prefix: string) => `${prefix}-${Date.now()}-${++nonce}`

export const createBot = (
  client: OpenBotClient,
  name: string,
  harness: CheapHarness,
  options?: { readonly hostNodeId?: NodeId; readonly instructions?: string },
) =>
  client["bots.create"]({
    name,
    harness: { kind: CHEAP[harness].kind, model: CHEAP[harness].model, effort: CHEAP[harness].effort },
    ...(options?.hostNodeId !== undefined ? { hostNodeId: options.hostNodeId } : {}),
    instructions: options?.instructions ?? "Be extremely brief. Never ask clarifying questions; act.",
    clientNonce: nextNonce(`bot-${name}`),
  })

const terminal = (turn: Turn) => turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted"

/** Waits until `predicate(state)` holds and no turn of the conversation is active. */
export const settle = (
  state: Ref.Ref<ConversationState>,
  predicate: (s: ConversationState) => boolean,
  options?: { readonly timeout?: number; readonly label?: string },
) =>
  Effect.gen(function*() {
    const deadline = Date.now() + (options?.timeout ?? 180_000)
    while (Date.now() < deadline) {
      const s = yield* Ref.get(state)
      const active = [...s.turns.values()].some((t) => !terminal(t))
      if (!active && predicate(s)) return s
      yield* Effect.sleep("250 millis")
    }
    const s = yield* Ref.get(state)
    log(`TIMEOUT ${options?.label ?? ""}\n${describe(transcriptOf(s))}\n turns: ${JSON.stringify([...s.turns.values()])}`)
    return yield* Effect.fail(new Error(`timed out waiting for ${options?.label ?? "condition"}`))
  })

/** Sends `text` into a conversation and waits until the started turns are terminal. */
export const converse = (
  client: OpenBotClient,
  conversationId: ConversationId,
  text: string,
  options?: {
    readonly addressEveryone?: boolean
    readonly timeout?: number
    readonly until?: (s: ConversationState) => boolean
  },
) =>
  Effect.gen(function*() {
    const convo = yield* watchConversation(client, conversationId)
    yield* settleSync(convo.state)
    const sent = yield* client["messages.send"]({
      conversationId,
      text,
      clientNonce: nextNonce("send"),
      ...(options?.addressEveryone === true ? { addressEveryone: true } : {}),
    })
    log("sent", JSON.stringify(text).slice(0, 120), sent.disposition, sent.turnIds)
    const turnIds = new Set<TurnId>(sent.turnIds)
    const final = yield* settle(convo.state, (s) => {
      const mine = [...s.turns.values()].filter((t) => turnIds.has(t.id))
      return mine.length === turnIds.size && mine.every(terminal) && (options?.until?.(s) ?? true)
    }, { timeout: options?.timeout, label: `turns ${[...turnIds].join(",")}` })
    return { state: final, entries: transcriptOf(final), turns: [...final.turns.values()].filter((t) => turnIds.has(t.id)) }
  })

const settleSync = (state: Ref.Ref<ConversationState>) =>
  Effect.gen(function*() {
    for (let i = 0; i < 200; i++) {
      if ((yield* Ref.get(state)).synchronized) return
      yield* Effect.sleep("25 millis")
    }
  })

/** Current transcript of a conversation (one subscribe). */
export const snapshot = (client: OpenBotClient, conversationId: ConversationId) =>
  Effect.gen(function*() {
    const convo = yield* watchConversation(client, conversationId)
    yield* settleSync(convo.state)
    return yield* Ref.get(convo.state)
  })

/** Watches a conversation for the whole scope (bot-to-bot waits). */
export const watch = (client: OpenBotClient, conversationId: ConversationId) =>
  Effect.gen(function*() {
    const convo = yield* watchConversation(client, conversationId)
    yield* settleSync(convo.state)
    return convo.state
  })

const short = (value: unknown, max = 160) => {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text === undefined ? "" : text.length > max ? `${text.slice(0, max)}…` : text
}

/** One line per entry: what a reviewer needs as evidence. */
export const describe = (entries: ReadonlyArray<TranscriptEntry>): string =>
  entries.map((e) => {
    switch (e.kind) {
      case "message":
        return `  [${e.role}${e.author.kind === "bot" ? ` ${e.author.botId}` : ""}] ${short(e.text, 300)}`
      case "tool-call":
        return `  [tool ${e.status}] ${e.name}${e.nodeId !== undefined ? ` @${e.nodeId}` : ""} ${short(e.inputSummary ?? e.input)}${
          e.error !== undefined ? ` ERROR ${short(e.error)}` : ""
        }${e.output !== undefined ? ` → ${short(e.output, 200)}` : ""}`
      case "card":
        return `  [card ${e.card.type} ${e.state.status}] ${short(e.card)}`
      case "event":
        return `  [event] ${short(e.event, 300)}`
      case "notice":
        return `  [notice ${e.level}] ${e.code}: ${short(e.text, 300)}`
      case "reasoning":
        return `  [reasoning] ${short(e.text, 80)}`
      default:
        return `  [${e.kind}]`
    }
  }).join("\n")

export const botTexts = (entries: ReadonlyArray<TranscriptEntry>, botId?: Bot["id"]) =>
  entries.flatMap((e) =>
    e.kind === "message" && e.role === "bot" && !e.streaming && (botId === undefined || (e.author.kind === "bot" && e.author.botId === botId))
      ? [e.text]
      : []
  )

export const toolCalls = (entries: ReadonlyArray<TranscriptEntry>) =>
  entries.flatMap((e) => (e.kind === "tool-call" ? [e] : []))

export const pending = pendingRequestsOf

export const report = (label: string, entries: ReadonlyArray<TranscriptEntry>, turns?: ReadonlyArray<Turn>) => {
  log(`=== ${label}\n${describe(entries)}`)
  if (turns !== undefined) {
    for (const t of turns) {
      log(`  turn ${t.id} ${t.status}${t.failure !== undefined ? ` ${JSON.stringify(t.failure)}` : ""} usage=${JSON.stringify(t.usage)}`)
    }
  }
}

/** Collects roster activity labels (for "computer.status shows a screen" style checks). */
export const rosterLog = (client: OpenBotClient) =>
  Effect.gen(function*() {
    const items = yield* Ref.make<ReadonlyArray<string>>([])
    yield* client["roster.subscribe"]({}).pipe(
      Stream.runForEach((item) => Ref.update(items, (all) => [...all, short(item, 400)])),
      Effect.forkScoped,
    )
    return items
  })
