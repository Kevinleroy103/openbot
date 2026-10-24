/**
 * Test support: fixture loading, a scripted fake `query()` and `OpenSessionInput` builders.
 */
import type { HarnessEvent, HarnessRequest, HarnessRequestResolution, TurnId } from "@openbot/contracts"
import { LOCAL_NODE_ID } from "@openbot/contracts"
import type { OpenSessionInput, ResolvedPlacement } from "@openbot/core"
import { makeBot } from "@openbot/core/testing"
import { Effect, Fiber, Stream } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ClaudeQueryHandle, ClaudeQueryParams } from "../src/sdk.ts"

// ---------------------------------------------------------------------------- fixtures

export interface FixtureFrame {
  readonly seq: number
  readonly source: string
  readonly payload: Record<string, unknown>
}

export const loadJsonl = async <A>(path: string): Promise<Array<A>> =>
  (await Bun.file(path).text())
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as A)

export const CONTRACT_FIXTURES = join(import.meta.dir, "../../contracts/test/fixtures")
export const LOCAL_FIXTURES = join(import.meta.dir, "fixtures")

export const tempDir = (prefix = "openbot-claude-"): string => mkdtempSync(join(tmpdir(), prefix))

// ---------------------------------------------------------------------------- fake query

/** An async FIFO of frames feeding `next()`. */
class FrameChannel {
  private readonly buffer: Array<unknown> = []
  private waiters: Array<(r: IteratorResult<unknown, void>) => void> = []
  private failWaiters: Array<(e: unknown) => void> = []
  private done = false
  private error: unknown = undefined

  push(frame: unknown) {
    if (this.done) return
    const waiter = this.waiters.shift()
    this.failWaiters.shift()
    if (waiter) waiter({ value: frame, done: false })
    else this.buffer.push(frame)
  }
  end(error?: unknown) {
    if (this.done) return
    this.done = true
    this.error = error
    const waiters = this.waiters
    const failWaiters = this.failWaiters
    this.waiters = []
    this.failWaiters = []
    waiters.forEach((w, i) => (error === undefined ? w({ value: undefined, done: true }) : failWaiters[i]!(error)))
  }
  next(): Promise<IteratorResult<unknown, void>> {
    if (this.buffer.length > 0) return Promise.resolve({ value: this.buffer.shift(), done: false })
    if (this.done)
      return this.error === undefined ? Promise.resolve({ value: undefined, done: true }) : Promise.reject(this.error)
    return new Promise((resolve, reject) => {
      this.waiters.push(resolve)
      this.failWaiters.push(reject)
    })
  }
}

export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options: Record<string, unknown>,
) => Promise<Record<string, unknown>>

export interface UserInput {
  readonly uuid: string
  readonly text: string
  readonly content: unknown
  readonly priority?: string
}

export type Script = (fake: FakeQuery, input: UserInput) => Promise<void> | void

/** A fake `Query`: consumes the streaming prompt and answers with scripted frames. */
export interface FakeQueryOptions {
  /** Replaces the default `setMcpServers` (which records the call and reports success). */
  readonly setMcpServers?: (servers: Record<string, unknown>) => Promise<unknown>
}

export class FakeQuery implements ClaudeQueryHandle {
  readonly frames = new FrameChannel()
  readonly received: Array<UserInput> = []
  /** The streaming-input messages exactly as the session pushed them. */
  readonly raw: Array<Record<string, unknown>> = []
  readonly mcpCalls: Array<Record<string, unknown>> = []
  interrupts = 0
  closed = false
  promptEnded = false
  private interruptHandler: (() => void) | undefined
  readonly options: Record<string, unknown>

  private readonly sessionId: string

  constructor(
    params: ClaudeQueryParams,
    private readonly script: Script,
    fallbackSessionId: string,
    private readonly fakeOptions: FakeQueryOptions = {},
  ) {
    this.options = params.options as Record<string, unknown>
    // Like the CLI: the session id is the requested one (new) or the resumed one.
    this.sessionId =
      (this.options.sessionId as string | undefined) ?? (this.options.resume as string | undefined) ?? fallbackSessionId
    void this.consume(params.prompt)
  }

  get canUseTool(): CanUseToolFn {
    return this.options.canUseTool as CanUseToolFn
  }

  private async consume(prompt: AsyncIterable<unknown>) {
    for await (const raw of prompt) {
      this.raw.push(raw as Record<string, unknown>)
      const msg = raw as { uuid: string; message: { content: unknown }; priority?: string }
      const content = msg.message.content
      const text =
        typeof content === "string"
          ? content
          : (content as Array<{ type: string; text?: string }>)
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("")
      const input: UserInput = { uuid: msg.uuid, text, content, ...(msg.priority ? { priority: msg.priority } : {}) }
      this.received.push(input)
      void Promise.resolve(this.script(this, input)).catch((e) => this.frames.end(e))
    }
    this.promptEnded = true
  }

  /** Emits a frame stamped with the session id. */
  emit(frame: Record<string, unknown>) {
    this.frames.push({ session_id: this.sessionId, ...frame })
  }

  onInterrupt(handler: () => void) {
    this.interruptHandler = handler
  }

  next() {
    return this.frames.next()
  }
  async return(): Promise<IteratorResult<unknown, void>> {
    this.frames.end()
    return { value: undefined, done: true }
  }
  interrupt = async () => {
    this.interrupts++
    const handler = this.interruptHandler
    this.interruptHandler = undefined
    handler?.()
    return { still_queued: [] }
  }
  close = () => {
    this.closed = true
    this.frames.end()
  }
  setMcpServers = async (servers: Record<string, unknown>) => {
    this.mcpCalls.push(servers)
    if (this.fakeOptions.setMcpServers) return this.fakeOptions.setMcpServers(servers)
    return { added: Object.keys(servers), removed: [], errors: {} }
  }
  initializationResult = async () => ({})
  getContextUsage = async () => ({ totalTokens: 1234, maxTokens: 200_000 })
}

/** A fake `query` factory; `last` is the most recent query. */
export const fakeQueryFactory = (
  script: Script,
  sessionId = "11111111-2222-3333-4444-555555555555",
  options: FakeQueryOptions = {},
) => {
  const state: { last: FakeQuery | undefined; all: Array<FakeQuery> } = { last: undefined, all: [] }
  const query = (params: ClaudeQueryParams) => {
    const fake = new FakeQuery(params, script, sessionId, options)
    state.last = fake
    state.all.push(fake)
    return fake
  }
  return { query, state }
}

// ---------------------------------------------------------------------------- scripted frames

let msgCounter = 0
export const nextMsgId = () => `msg_test_${++msgCounter}`

export const frames = {
  init: () => ({ type: "system", subtype: "init", tools: [], mcp_servers: [] }),
  status: (status: string | null) => ({ type: "system", subtype: "status", status }),
  messageStart: (id: string) => ({
    type: "stream_event",
    parent_tool_use_id: null,
    api_message_id: id,
    event: {
      type: "message_start",
      message: { id, usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 50 } },
    },
  }),
  blockStart: (id: string, index: number, block: Record<string, unknown>) => ({
    type: "stream_event",
    parent_tool_use_id: null,
    api_message_id: id,
    event: { type: "content_block_start", index, content_block: block },
  }),
  textDelta: (id: string, index: number, text: string) => ({
    type: "stream_event",
    parent_tool_use_id: null,
    api_message_id: id,
    event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  }),
  assistant: (id: string, block: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    type: "assistant",
    parent_tool_use_id: null,
    message: { id, role: "assistant", content: [block] },
    ...extra,
  }),
  toolResult: (toolUseId: string, content: unknown, isError = false) => ({
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] },
  }),
  result: (extra: Record<string, unknown> = {}) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "completed",
    stop_reason: "end_turn",
    total_cost_usd: 0.001,
    usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
    modelUsage: { "claude-haiku-5-5": { contextWindow: 200_000 } },
    ...extra,
  }),
}

/** CLI 2.1.300 frames around its own turns (live transcript 2026-10-17; sdk.d.ts `SDKResultSuccess`, `origin`). */
export const cliFrames = {
  /** Undocumented delivery receipt for a client send (sdk-claude.md §4). */
  lifecycle: (uuid: string, state: "queued" | "started" | "completed" | "cancelled") => ({
    type: "command_lifecycle",
    command_uuid: uuid,
    state,
  }),
  /** `status: requesting` naming the client sends the CLI turn took. */
  requesting: (...uuids: ReadonlyArray<string>) => ({
    type: "system",
    subtype: "status",
    status: "requesting",
    ...(uuids.length > 0 ? { user_message_uuids: [...uuids] } : {}),
  }),
  /**
   * The result of a transcript-only task-notification turn (a background shell of the previous
   * process, restored on resume): no model call, no echo, `origin: task-notification`.
   */
  notificationResult: (extra: Record<string, unknown> = {}) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_api_ms: 0,
    num_turns: 0,
    result: "",
    stop_reason: null,
    total_cost_usd: 0.001,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    origin: { kind: "task-notification" },
    ...extra,
  }),
  /** A complete text reply of a CLI turn that took no client send (a task notification answered). */
  notificationReply: (
    fake: { emit: (frame: Record<string, unknown>) => void },
    text: string,
    extra: Record<string, unknown> = {},
  ) => {
    const id = nextMsgId()
    fake.emit(frames.init())
    fake.emit(cliFrames.requesting())
    fake.emit(frames.messageStart(id))
    fake.emit(frames.blockStart(id, 0, { type: "text", text: "" }))
    fake.emit(frames.textDelta(id, 0, text))
    fake.emit(frames.assistant(id, { type: "text", text }))
    fake.emit(frames.result({ origin: { kind: "task-notification" }, ...extra }))
  },
}

/** The consumed-send echo the CLI stamps on results (`user_message_uuid(s)`). */
export const echo = (...uuids: ReadonlyArray<string>) =>
  uuids.length === 0 ? {} : { user_message_uuid: uuids.at(-1), user_message_uuids: [...uuids] }

/** Emits a complete text reply turn; `consumed` are the client uuids its result echoes. */
export const replyText = (fake: FakeQuery, text: string, ...consumed: ReadonlyArray<string>) => {
  const id = nextMsgId()
  fake.emit(frames.init())
  fake.emit(frames.status("requesting"))
  fake.emit(frames.messageStart(id))
  fake.emit(frames.blockStart(id, 0, { type: "text", text: "" }))
  fake.emit(frames.textDelta(id, 0, text))
  fake.emit(frames.assistant(id, { type: "text", text }))
  fake.emit(frames.result(echo(...consumed)))
}

// ---------------------------------------------------------------------------- session input

export const makePlacement = (cwd: string, overrides: Partial<ResolvedPlacement> = {}): ResolvedPlacement => ({
  mode: "native-local",
  hostNodeId: LOCAL_NODE_ID,
  workspacePath: cwd,
  harnessCwd: cwd,
  env: {},
  disableBuiltinTools: false,
  toolsets: ["bot"],
  promptAppend: "Your tools run on this computer.",
  release: Effect.void,
  ...overrides,
})

export const makeSessionInput = (
  cwd: string,
  onRequest: (request: HarnessRequest) => Effect.Effect<HarnessRequestResolution>,
  overrides: Partial<OpenSessionInput> = {},
): OpenSessionInput => {
  const bot = makeBot({ harness: { kind: "claude" } })
  return {
    bot,
    conversationId: bot.directConversationId,
    sessionKey: `${bot.id}:${bot.directConversationId}`,
    nativeSessionId: undefined,
    placement: makePlacement(cwd),
    instructions: {
      text: "You are Scout, an OpenBot.",
      sections: { base: "You are Scout, an OpenBot.", persona: "", team: "", memoryIndex: "", placement: "" },
      hash: "h1",
    },
    mcp: [
      {
        name: "openbot",
        url: "http://127.0.0.1:4555/mcp/bot_test",
        headers: { authorization: "Bearer secret-token-xyz" },
      },
    ],
    model: "haiku",
    effort: undefined,
    onRequest,
    ...overrides,
  }
}

export const turnId = (n: number) => `trn_${String(n).padStart(6, "0")}` as TurnId

// ---------------------------------------------------------------------------- event collection

export interface Collector {
  readonly events: Array<HarnessEvent>
  readonly waitFor: (predicate: (events: ReadonlyArray<HarnessEvent>) => boolean, label?: string) => Effect.Effect<void>
  readonly done: Effect.Effect<void>
}

/** Collects a session's events in a background fiber (scoped). */
export const collect = (events: Stream.Stream<HarnessEvent>) =>
  Effect.gen(function* () {
    const seen: Array<HarnessEvent> = []
    const fiber = yield* Stream.runForEach(events, (e) => Effect.sync(() => seen.push(e))).pipe(
      Effect.forkScoped({ startImmediately: true }),
    )
    const waitFor = (predicate: (events: ReadonlyArray<HarnessEvent>) => boolean, label = "condition") =>
      Effect.gen(function* () {
        for (let i = 0; i < 400; i++) {
          if (predicate(seen)) return
          yield* Effect.sleep(5)
        }
        return yield* Effect.die(
          new Error(`timed out waiting for ${label}; events: ${seen.map((e) => e._tag).join(",")}`),
        )
      })
    return { events: seen, waitFor, done: Fiber.join(fiber) } satisfies Collector
  })

export const has =
  (tag: HarnessEvent["_tag"], predicate: (e: HarnessEvent) => boolean = () => true) =>
  (events: ReadonlyArray<HarnessEvent>) =>
    events.some((e) => e._tag === tag && predicate(e))
