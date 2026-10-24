/**
 * Codex app-server v2 notifications → normalized `HarnessEvent`s (architecture §3.1, sdk-codex.md
 * §6.5). Pure and synchronous: the session feeds it every notification of its thread, in wire
 * order, and forwards what it returns. Recorded fixtures drive its tests.
 *
 * Rules:
 * - items are emitted WHOLE, keyed by `<nativeTurnId>:<itemId>` (item ids are unique in practice;
 *   the turn prefix is cheap insurance, sdk-codex.md §6.5);
 * - OpenBot turn ids are bound to native turn ids either by the `turn/start` response
 *   (`bindTurn`) or by the first notification of an unknown native turn while a turn is expected
 *   (`expectTurn`), whichever comes first. Native turns nobody expected (manual compaction) are
 *   "internal": their items are not shown;
 * - usage is reported once per turn (`Usage` at the turn end) from the deltas of the thread's
 *   cumulative `total`, so repeated notifications never double count; the context meter is
 *   `last.totalTokens / modelContextWindow` (harness-context-isolation.md §6);
 * - a turn's end finalizes every streaming item of the turn (interrupted text is `aborted`).
 */
import type {
  ContextUsage,
  HarnessEvent,
  HarnessItem,
  HarnessTurnError,
  NodeId,
  ToolKind,
  TurnId,
  Usage,
} from "@openbot/contracts"
import { CONNECTED_APP_ACTIVITY, openBotToolActivity, THINKING_ACTIVITY } from "@openbot/contracts"

type ToolCallItem = Extract<HarnessItem, { readonly _tag: "ToolCall" }>
type ToolStatus = ToolCallItem["status"]
type FileChangeDraft = NonNullable<ToolCallItem["fileChanges"]>[number]

export type TurnOutcome =
  | { readonly _tag: "completed" }
  | { readonly _tag: "interrupted" }
  | { readonly _tag: "failed"; readonly error: HarnessTurnError }

export interface CodexNormalizerOptions {
  /** The node where Codex's built-in tools run (the placement's host node). */
  readonly hostNodeId?: NodeId | undefined
  /** `outputPreview` size in characters (≈2 KB). */
  readonly previewChars?: number | undefined
  /** Called when an OpenBot turn gets its native id. */
  readonly onTurnBound?: ((turnId: TurnId, nativeTurnId: string) => void) | undefined
  /** Called when a native turn nobody expected (a manual compaction) ends. */
  readonly onInternalTurnEnd?: ((nativeTurnId: string, outcome: TurnOutcome) => void) | undefined
}

interface MessageState {
  readonly kind: "message"
  readonly key: string
  readonly turnId: TurnId
  text: string
  phase: "commentary" | "final" | undefined
  emitted: boolean
  done: boolean
}

interface ReasoningState {
  readonly kind: "reasoning"
  readonly key: string
  readonly turnId: TurnId
  summary: Array<string>
  content: Array<string>
  emitted: boolean
  done: boolean
}

interface ToolState {
  readonly kind: "tool"
  readonly key: string
  readonly turnId: TurnId
  readonly itemType: string
  item: ToolCallItem
  output: string
  done: boolean
  readonly server?: string | undefined
  readonly tool?: string | undefined
  readonly args?: unknown
}

type ItemState = MessageState | ReasoningState | ToolState

/** What request mapping needs to know about a tool item. */
export interface ToolInfo {
  readonly key: string
  readonly itemType: string
  readonly toolName: string
  readonly fileChanges: ReadonlyArray<FileChangeDraft>
  readonly server?: string | undefined
  readonly tool?: string | undefined
  readonly args?: unknown
}

interface TokenBreakdown {
  readonly totalTokens: number
  readonly inputTokens: number
  readonly cachedInputTokens: number
  readonly outputTokens: number
  readonly reasoningOutputTokens: number
}

// ============================================================================ text helpers

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

/** Caps `text` at `max` characters (head), with an ellipsis. */
export const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

/** Keeps the last `max` characters (command output is most useful at the end). */
const tail = (text: string, max: number): string =>
  text.length <= max ? text : `…${text.slice(text.length - max + 1)}`

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim()

/** `/usr/bin/bash -lc 'touch a && echo b'` → `touch a && echo b`. */
export const stripShellWrapper = (command: string): string => {
  const match = /^(?:\S*\/)?(?:bash|zsh|sh)\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command.trim())
  if (!match || match[2] === undefined) return command
  return match[1] === "'" ? match[2].replace(/'\\''/g, "'") : match[2].replace(/\\(["\\$`])/g, "$1")
}

/** JSON.stringify with sorted keys, for argument equality. */
export const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

const basename = (path: string): string =>
  path
    .split(/[\\/]/)
    .filter((part) => part !== "")
    .pop() ?? path

/** `message_bot` → `Message bot`. */
const humanize = (name: string): string => {
  const words = name.replace(/[_-]+/g, " ").trim()
  return words === "" ? name : words[0]!.toUpperCase() + words.slice(1)
}

// ============================================================================ OpenBot tools over MCP

const OPENBOT_SERVER = "openbot"

const OPENBOT_TOOL_KIND: Readonly<Record<string, ToolKind>> = {
  shell: "shell",
  read_file: "file-read",
  write_file: "file-write",
  edit_file: "file-edit",
  list_dir: "search",
  glob: "search",
  grep: "search",
  browser: "browser",
  computer: "computer",
  ask_user: "question",
}

const NODE_TOOLS = new Set([
  "shell",
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "glob",
  "grep",
  "browser",
  "computer",
])

/**
 * Owner-visible activity phrases by tool kind: human and plumbing-free (D6.4). Native helpers and
 * tools without a phrase of their own read as the generic `THINKING_ACTIVITY`.
 */
const ACTIVITY_BY_KIND: Readonly<Partial<Record<ToolKind, string>>> = {
  shell: "Running a command",
  "file-read": "Reading files",
  "file-write": "Writing files",
  "file-edit": "Editing files",
  search: "Searching files",
  web: "Searching the web",
  browser: "Using the browser",
  computer: "Using the computer",
  subagent: THINKING_ACTIVITY,
  question: "Asking you a question",
  other: THINKING_ACTIVITY,
}

const summarizeArgs = (tool: string, args: unknown): string => {
  if (isRecord(args)) {
    const pick =
      tool === "shell"
        ? str(args.command)
        : tool === "grep" || tool === "glob"
          ? str(args.pattern)
          : (str(args.path) ?? str(args.url) ?? str(args.to) ?? str(args.title) ?? str(args.query))
    if (pick !== undefined) return truncate(oneLine(pick), 200)
    if (Object.keys(args).length === 0) return ""
  }
  return truncate(oneLine(stableStringify(args ?? {})), 200)
}

const mcpText = (result: unknown): { readonly text: string; readonly isError: boolean } => {
  if (!isRecord(result)) return { text: "", isError: false }
  const parts: Array<string> = []
  for (const block of Array.isArray(result.content) ? result.content : []) {
    if (!isRecord(block)) continue
    if (typeof block.text === "string") parts.push(block.text)
    else if (typeof block.type === "string") parts.push(`[${block.type}]`)
  }
  return { text: parts.join("\n"), isError: result.isError === true }
}

// ============================================================================ error mapping

const ERROR_CODES: Readonly<Record<string, { readonly code: string; readonly retryable: boolean }>> = {
  usageLimitExceeded: { code: "usage-limit", retryable: false },
  sessionBudgetExceeded: { code: "usage-limit", retryable: false },
  rateLimitExceeded: { code: "rate-limit", retryable: true },
  contextWindowExceeded: { code: "context-window", retryable: false },
  unauthorized: { code: "auth", retryable: false },
  serverOverloaded: { code: "server", retryable: true },
  internalServerError: { code: "server", retryable: true },
  flexUnavailable: { code: "server", retryable: true },
  httpConnectionFailed: { code: "network", retryable: true },
  responseStreamConnectionFailed: { code: "network", retryable: true },
  responseStreamDisconnected: { code: "network", retryable: true },
  responseTooManyFailedAttempts: { code: "network", retryable: true },
  cyberPolicy: { code: "policy", retryable: false },
  misalignmentPolicyViolation: { code: "policy", retryable: false },
  badRequest: { code: "bad-request", retryable: false },
  sandboxError: { code: "sandbox", retryable: false },
  tooManyDenials: { code: "denied", retryable: false },
  threadRollbackFailed: { code: "turn-failed", retryable: false },
}

/** `TurnError {message, codexErrorInfo}` → `HarnessTurnError` (`usage-limit` drives "out of credits"). */
export const turnErrorOf = (error: unknown): HarnessTurnError => {
  const record = isRecord(error) ? error : {}
  const info = record.codexErrorInfo
  const infoKey = typeof info === "string" ? info : isRecord(info) ? Object.keys(info)[0] : undefined
  const mapped = infoKey === undefined ? undefined : ERROR_CODES[infoKey]
  return {
    code: mapped?.code ?? "turn-failed",
    message: str(record.message) ?? "Codex failed to respond.",
    retryable: mapped?.retryable ?? false,
  }
}

// ============================================================================ normalizer

const emptyBreakdown = (): TokenBreakdown => ({
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
})

const breakdownOf = (value: unknown): TokenBreakdown | undefined => {
  if (!isRecord(value)) return undefined
  return {
    totalTokens: num(value.totalTokens) ?? 0,
    inputTokens: num(value.inputTokens) ?? 0,
    cachedInputTokens: num(value.cachedInputTokens) ?? 0,
    outputTokens: num(value.outputTokens) ?? 0,
    reasoningOutputTokens: num(value.reasoningOutputTokens) ?? 0,
  }
}

const minus = (a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown => ({
  totalTokens: Math.max(0, a.totalTokens - b.totalTokens),
  inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
  cachedInputTokens: Math.max(0, a.cachedInputTokens - b.cachedInputTokens),
  outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
  reasoningOutputTokens: Math.max(0, a.reasoningOutputTokens - b.reasoningOutputTokens),
})

const plus = (a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown => ({
  totalTokens: a.totalTokens + b.totalTokens,
  inputTokens: a.inputTokens + b.inputTokens,
  cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
})

/** Codex numbers as reported: `inputTokens` includes the cached part. */
const toUsage = (b: TokenBreakdown): Usage => ({
  inputTokens: b.inputTokens,
  outputTokens: b.outputTokens,
  ...(b.cachedInputTokens > 0 ? { cachedInputTokens: b.cachedInputTokens } : {}),
  ...(b.reasoningOutputTokens > 0 ? { reasoningTokens: b.reasoningOutputTokens } : {}),
})

const toolStatus = (status: unknown): ToolStatus =>
  status === "completed" ? "completed" : status === "failed" ? "failed" : status === "declined" ? "declined" : "running"

export const itemKeyOf = (nativeTurnId: string, itemId: string): string => `${nativeTurnId}:${itemId}`

export class CodexNormalizer {
  private readonly hostNodeId: NodeId | undefined
  private readonly previewChars: number
  private readonly onTurnBound: ((turnId: TurnId, nativeTurnId: string) => void) | undefined
  private readonly onInternalTurnEnd: ((nativeTurnId: string, outcome: TurnOutcome) => void) | undefined

  private expected: TurnId | undefined
  private active: TurnId | undefined
  private readonly turnByNative = new Map<string, TurnId>()
  private readonly nativeByTurn = new Map<TurnId, string>()
  private readonly started = new Set<TurnId>()
  private readonly finished = new Set<TurnId>()
  private readonly internal = new Set<string>()
  private readonly items = new Map<string, ItemState>()
  private readonly turnUsage = new Map<TurnId, TokenBreakdown>()
  private readonly lastErrors = new Map<string, unknown>()
  private lastTotal: TokenBreakdown | undefined
  private context: ContextUsage | undefined

  constructor(options: CodexNormalizerOptions = {}) {
    this.hostNodeId = options.hostNodeId
    this.previewChars = options.previewChars ?? 2000
    this.onTurnBound = options.onTurnBound
    this.onInternalTurnEnd = options.onInternalTurnEnd
  }

  /** The OpenBot turn that is running (started and not finished). */
  get activeTurn(): TurnId | undefined {
    return this.active ?? this.expected
  }

  get contextUsage(): ContextUsage | undefined {
    return this.context
  }

  nativeTurnOf(turnId: TurnId): string | undefined {
    return this.nativeByTurn.get(turnId)
  }

  isInternalTurn(nativeTurnId: string): boolean {
    return this.internal.has(nativeTurnId)
  }

  /** The next unknown native turn belongs to `turnId` (set right before `turn/start`). */
  expectTurn(turnId: TurnId): void {
    this.expected = turnId
  }

  /** `turn/start` failed: nothing is expected any more. */
  cancelExpected(turnId: TurnId): void {
    if (this.expected === turnId) this.expected = undefined
  }

  /** Binds from the `turn/start` response. Emits `TurnStarted` unless a notification did already. */
  bindTurn(nativeTurnId: string, turnId: TurnId): ReadonlyArray<HarnessEvent> {
    const out: Array<HarnessEvent> = []
    const known = this.turnByNative.get(nativeTurnId)
    // Unknown, or still owned by a turn OpenBot already ended locally (a forced interrupt): Codex
    // folds a `turn/start` into a native turn that is still running, so the new turn takes it over.
    if (known === undefined || (known !== turnId && this.finished.has(known))) {
      if (this.expected === turnId) this.expected = undefined
      this.internal.delete(nativeTurnId)
      this.link(nativeTurnId, turnId)
    }
    this.ensureStarted(turnId, out)
    return out
  }

  /** Normalizes one notification of the thread. */
  handle(method: string, params: Record<string, unknown>): ReadonlyArray<HarnessEvent> {
    const out: Array<HarnessEvent> = []
    switch (method) {
      case "turn/started": {
        const turn = isRecord(params.turn) ? params.turn : {}
        const native = str(turn.id)
        if (native) this.resolveTurn(native, out, true)
        break
      }
      case "turn/completed": {
        const turn = isRecord(params.turn) ? params.turn : {}
        const native = str(turn.id)
        if (!native) break
        const status = turn.status
        const outcome: TurnOutcome =
          status === "interrupted"
            ? { _tag: "interrupted" }
            : status === "failed"
              ? { _tag: "failed", error: turnErrorOf(turn.error ?? this.lastErrors.get(native)) }
              : { _tag: "completed" }
        this.lastErrors.delete(native)
        if (this.turnByNative.has(native)) {
          // An OpenBot turn (`resolveTurn` is undefined when it already ended locally).
          const owned = this.resolveTurn(native, out, true)
          if (owned) out.push(...this.finishTurn(owned, outcome))
          break
        }
        const turnId = this.internal.has(native) ? undefined : this.resolveTurn(native, out, true)
        if (!turnId) {
          // An internal turn (or one nobody expected): nothing to show, but compaction waits on it.
          this.internal.delete(native)
          this.onInternalTurnEnd?.(native, outcome)
          break
        }
        out.push(...this.finishTurn(turnId, outcome))
        break
      }
      case "item/started":
      case "item/completed": {
        const native = str(params.turnId)
        const item = isRecord(params.item) ? params.item : undefined
        if (!native || !item) break
        const turnId = this.resolveTurn(native, out, true)
        if (!turnId) break
        this.item(turnId, native, item, method === "item/completed", out)
        break
      }
      case "item/agentMessage/delta": {
        const state = this.deltaTarget(params, out, "message")
        if (state?.kind !== "message") break
        state.text += str(params.delta) ?? ""
        this.emitMessage(state, out)
        break
      }
      case "item/reasoning/summaryPartAdded": {
        const state = this.deltaTarget(params, out, "reasoning")
        if (state?.kind !== "reasoning") break
        const index = num(params.summaryIndex) ?? state.summary.length
        if (state.summary[index] === undefined) state.summary[index] = ""
        break
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const state = this.deltaTarget(params, out, "reasoning")
        if (state?.kind !== "reasoning") break
        const delta = str(params.delta) ?? ""
        if (method === "item/reasoning/summaryTextDelta") {
          const index = num(params.summaryIndex) ?? 0
          state.summary[index] = (state.summary[index] ?? "") + delta
        } else {
          const index = num(params.contentIndex) ?? 0
          state.content[index] = (state.content[index] ?? "") + delta
        }
        this.emitReasoning(state, out)
        break
      }
      case "item/commandExecution/outputDelta": {
        const state = this.deltaTarget(params, out, "tool")
        if (state?.kind !== "tool" || state.done) break
        state.output = tail(state.output + (str(params.delta) ?? ""), this.previewChars * 4)
        state.item = { ...state.item, outputPreview: tail(state.output, this.previewChars) }
        out.push(this.toolEvent(state))
        break
      }
      case "item/fileChange/patchUpdated": {
        const state = this.deltaTarget(params, out, "tool")
        if (state?.kind !== "tool" || state.done) break
        const changes = this.fileChanges(params.changes)
        state.item = { ...state.item, ...this.fileChangeSummary(changes) }
        out.push(this.toolEvent(state))
        break
      }
      case "thread/tokenUsage/updated":
        this.tokenUsage(params, out)
        break
      case "error": {
        const native = str(params.turnId)
        if (params.willRetry === true) {
          if (native && this.turnByNative.has(native)) out.push({ _tag: "Activity", label: "Reconnecting…" })
        } else if (native) {
          this.lastErrors.set(native, params.error)
        }
        break
      }
      default:
        break
    }
    return out
  }

  /**
   * Ends `turnId`: finalizes its streaming items, reports its usage, then emits the terminal event.
   * Used for `turn/completed` and when the session must end a turn itself (process died,
   * interrupt watchdog).
   */
  finishTurn(turnId: TurnId, outcome: TurnOutcome): ReadonlyArray<HarnessEvent> {
    const out: Array<HarnessEvent> = []
    if (this.finished.has(turnId)) return out
    this.ensureStarted(turnId, out)
    for (const [id, state] of this.items) {
      if (state.turnId !== turnId) continue
      this.items.delete(id)
      if (state.done) continue
      state.done = true
      if (state.kind === "message") {
        if (state.emitted || state.text !== "") {
          out.push(
            this.upsert(state.key, turnId, {
              _tag: "Message",
              role: "bot",
              text: state.text,
              streaming: false,
              ...(state.phase ? { phase: state.phase } : {}),
              ...(outcome._tag === "interrupted" ? { aborted: true } : {}),
            }),
          )
        }
      } else if (state.kind === "reasoning") {
        if (state.emitted) this.emitReasoning(state, out)
      } else {
        state.item = {
          ...state.item,
          status: "failed",
          error:
            outcome._tag === "interrupted"
              ? "Interrupted"
              : outcome._tag === "failed"
                ? outcome.error.message
                : "Codex did not report a result for this tool.",
        }
        out.push(this.toolEvent(state))
      }
    }
    const usage = this.turnUsage.get(turnId)
    this.turnUsage.delete(turnId)
    if (usage && usage.totalTokens + usage.inputTokens + usage.outputTokens > 0) {
      out.push({ _tag: "Usage", usage: toUsage(usage), turnId })
    }
    out.push(
      outcome._tag === "completed"
        ? { _tag: "TurnCompleted", turnId }
        : outcome._tag === "interrupted"
          ? { _tag: "TurnInterrupted", turnId }
          : { _tag: "TurnFailed", turnId, error: outcome.error },
    )
    this.finished.add(turnId)
    this.started.delete(turnId)
    if (this.active === turnId) this.active = undefined
    if (this.expected === turnId) this.expected = undefined
    return out
  }

  // -------------------------------------------------------------------------- lookups (requests)

  /** Info about a tool item of a native turn (for approval requests). */
  toolInfo(nativeTurnId: string, itemId: string): ToolInfo | undefined {
    const state = this.items.get(itemKeyOf(nativeTurnId, itemId))
    return state?.kind === "tool" ? this.info(state) : undefined
  }

  /** The newest running MCP call of `server`, preferring an exact argument match. */
  runningMcp(server: string, args: unknown): ToolInfo | undefined {
    const wanted = args === undefined ? undefined : stableStringify(args)
    let fallback: ToolState | undefined
    let exact: ToolState | undefined
    for (const state of this.items.values()) {
      if (state.kind !== "tool" || state.itemType !== "mcpToolCall" || state.done || state.server !== server) continue
      fallback = state
      if (wanted !== undefined && stableStringify(state.args ?? {}) === wanted) exact = state
    }
    const found = exact ?? fallback
    return found ? this.info(found) : undefined
  }

  // -------------------------------------------------------------------------- internals

  private info(state: ToolState): ToolInfo {
    return {
      key: state.key,
      itemType: state.itemType,
      toolName: state.item.toolName,
      fileChanges: state.item.fileChanges ?? [],
      server: state.server,
      tool: state.tool,
      args: state.args,
    }
  }

  private link(nativeTurnId: string, turnId: TurnId): void {
    this.turnByNative.set(nativeTurnId, turnId)
    this.nativeByTurn.set(turnId, nativeTurnId)
    this.onTurnBound?.(turnId, nativeTurnId)
  }

  private ensureStarted(turnId: TurnId, out: Array<HarnessEvent>): void {
    if (this.started.has(turnId) || this.finished.has(turnId)) return
    this.started.add(turnId)
    this.active = turnId
    out.push({ _tag: "TurnStarted", turnId })
  }

  /** Maps a native turn to its OpenBot turn, binding the expected turn on first sight. */
  private resolveTurn(nativeTurnId: string, out: Array<HarnessEvent>, bind: boolean): TurnId | undefined {
    const known = this.turnByNative.get(nativeTurnId)
    if (known) {
      if (this.finished.has(known)) return undefined
      this.ensureStarted(known, out)
      return known
    }
    if (this.internal.has(nativeTurnId) || !bind) return undefined
    const expected = this.expected
    if (expected === undefined) {
      this.internal.add(nativeTurnId)
      return undefined
    }
    this.expected = undefined
    this.link(nativeTurnId, expected)
    this.ensureStarted(expected, out)
    return expected
  }

  private deltaTarget(
    params: Record<string, unknown>,
    out: Array<HarnessEvent>,
    kind: ItemState["kind"],
  ): ItemState | undefined {
    const native = str(params.turnId)
    const itemId = str(params.itemId)
    if (!native || !itemId) return undefined
    const turnId = this.resolveTurn(native, out, true)
    if (!turnId) return undefined
    const key = itemKeyOf(native, itemId)
    const existing = this.items.get(key)
    if (existing) return existing
    // A delta before its item/started: create the item so no text is lost.
    if (kind === "message") {
      const state: MessageState = { kind, key, turnId, text: "", phase: undefined, emitted: false, done: false }
      this.items.set(key, state)
      return state
    }
    if (kind === "reasoning") {
      const state: ReasoningState = { kind, key, turnId, summary: [], content: [], emitted: false, done: false }
      this.items.set(key, state)
      return state
    }
    return undefined
  }

  private upsert(key: string, turnId: TurnId, item: HarnessItem): HarnessEvent {
    return { _tag: "ItemUpserted", turnId, key, item }
  }

  private emitMessage(state: MessageState, out: Array<HarnessEvent>): void {
    if (state.text === "" && !state.emitted) return
    state.emitted = true
    out.push(
      this.upsert(state.key, state.turnId, {
        _tag: "Message",
        role: "bot",
        text: state.text,
        streaming: !state.done,
        ...(state.phase ? { phase: state.phase } : {}),
      }),
    )
  }

  private emitReasoning(state: ReasoningState, out: Array<HarnessEvent>): void {
    const summary = state.summary.filter((part) => part.trim() !== "")
    const content = state.content.filter((part) => part.trim() !== "")
    const text = summary.length > 0 ? summary.join("\n\n") : content.join("\n\n")
    if (text === "" && !state.emitted) return
    state.emitted = true
    out.push(
      this.upsert(state.key, state.turnId, {
        _tag: "Reasoning",
        text,
        streaming: !state.done,
        source: summary.length > 0 || content.length === 0 ? "summary" : "thinking",
      }),
    )
  }

  private toolEvent(state: ToolState): HarnessEvent {
    return this.upsert(state.key, state.turnId, state.item)
  }

  private fileChanges(value: unknown): ReadonlyArray<FileChangeDraft> {
    const changes: Array<FileChangeDraft> = []
    for (const change of Array.isArray(value) ? value : []) {
      if (!isRecord(change) || typeof change.path !== "string") continue
      const kindValue = isRecord(change.kind) ? change.kind.type : change.kind
      const kind = kindValue === "add" ? "add" : kindValue === "delete" ? "delete" : "update"
      const diff = str(change.diff)
      changes.push({ path: change.path, kind, ...(diff ? { diff: truncate(diff, 20_000) } : {}) })
    }
    return changes
  }

  private fileChangeSummary(changes: ReadonlyArray<FileChangeDraft>) {
    const first = changes[0]
    const title =
      changes.length === 1 && first
        ? `${first.kind === "add" ? "Create" : first.kind === "delete" ? "Delete" : "Edit"} ${basename(first.path)}`
        : `Edit ${changes.length} files`
    return {
      title,
      inputSummary: truncate(changes.map((change) => change.path).join(", "), 200),
      fileChanges: changes,
    }
  }

  private item(turnId: TurnId, native: string, item: Record<string, unknown>, done: boolean, out: Array<HarnessEvent>) {
    const itemId = str(item.id)
    const type = str(item.type)
    if (!itemId || !type) return
    const key = itemKeyOf(native, itemId)
    const existing = this.items.get(key)
    if (existing?.done) return
    switch (type) {
      case "agentMessage": {
        const state: MessageState =
          existing?.kind === "message"
            ? existing
            : { kind: "message", key, turnId, text: "", phase: undefined, emitted: false, done: false }
        this.items.set(key, state)
        const phase = item.phase === "commentary" ? "commentary" : item.phase === "final_answer" ? "final" : undefined
        if (phase) state.phase = phase
        const text = str(item.text)
        if (done) {
          if (text !== undefined && (text !== "" || state.text === "")) state.text = text
          state.done = true
          this.emitMessage(state, out)
        } else {
          if (text) state.text = text
          out.push({ _tag: "Activity", label: "Typing…" })
          this.emitMessage(state, out)
        }
        return
      }
      case "reasoning": {
        const state: ReasoningState =
          existing?.kind === "reasoning"
            ? existing
            : { kind: "reasoning", key, turnId, summary: [], content: [], emitted: false, done: false }
        this.items.set(key, state)
        const strings = (value: unknown) =>
          Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
        if (done) {
          const summary = strings(item.summary)
          const content = strings(item.content)
          if (summary.length > 0) state.summary = summary
          if (content.length > 0) state.content = content
          state.done = true
          this.emitReasoning(state, out)
        } else {
          out.push({ _tag: "Activity", label: THINKING_ACTIVITY })
        }
        return
      }
      case "contextCompaction":
        if (done) {
          out.push(
            this.upsert(key, turnId, {
              _tag: "Notice",
              level: "info",
              text: "Compacted the conversation to free up context.",
              code: "compacted",
            }),
          )
        }
        return
      case "userMessage":
      case "plan":
      case "hookPrompt":
      case "functionCallOutput":
      case "enteredReviewMode":
      case "exitedReviewMode":
      case "subAgentActivity":
      case "sleep":
        return
      default:
        break
    }
    const draft = this.toolDraft(type, item, existing?.kind === "tool" ? existing : undefined, done)
    if (!draft) return
    const state: ToolState =
      existing?.kind === "tool"
        ? existing
        : {
            kind: "tool",
            key,
            turnId,
            itemType: type,
            item: draft.item,
            output: "",
            done: false,
            server: draft.server,
            tool: draft.tool,
            args: draft.args,
          }
    state.item = draft.item
    state.done = done
    this.items.set(key, state)
    if (!done) {
      const label = draft.activity ?? ACTIVITY_BY_KIND[draft.item.kind]
      if (label) out.push({ _tag: "Activity", label, toolKind: draft.item.kind })
    }
    out.push(this.toolEvent(state))
  }

  private toolDraft(
    type: string,
    item: Record<string, unknown>,
    previous: ToolState | undefined,
    done: boolean,
  ):
    | {
        readonly item: ToolCallItem
        readonly server?: string | undefined
        readonly tool?: string | undefined
        readonly args?: unknown
        readonly activity?: string | undefined
      }
    | undefined {
    const hostNode = this.hostNodeId ? { nodeId: this.hostNodeId } : {}
    switch (type) {
      case "commandExecution": {
        const raw = str(item.command) ?? ""
        const actions = Array.isArray(item.commandActions) ? item.commandActions.filter(isRecord) : []
        const display =
          actions.length === 1 && typeof actions[0]?.command === "string" ? actions[0].command : stripShellWrapper(raw)
        const cwd = str(item.cwd)
        const exitCode = num(item.exitCode)
        const aggregated = str(item.aggregatedOutput)
        const outputText = aggregated ?? previous?.output ?? ""
        const status = toolStatus(done ? item.status : (previous?.item.status ?? "running"))
        return {
          item: {
            _tag: "ToolCall",
            toolName: "exec_command",
            title: truncate(oneLine(display), 120) || "Command",
            kind: "shell",
            status,
            inputSummary: truncate(oneLine(display), 200),
            input: { command: raw, ...(cwd ? { cwd } : {}) },
            command: { command: display, ...(cwd ? { cwd } : {}), ...(exitCode !== undefined ? { exitCode } : {}) },
            ...(outputText !== "" ? { outputPreview: tail(outputText, this.previewChars) } : {}),
            ...(done && aggregated !== undefined
              ? {
                  output: {
                    text: tail(aggregated, 16_000),
                    ...(aggregated.length > 16_000 ? { truncated: true } : {}),
                  },
                }
              : {}),
            ...(done && status === "failed" && exitCode !== undefined ? { error: `Exited with code ${exitCode}` } : {}),
            ...hostNode,
          },
        }
      }
      case "fileChange": {
        const changes = this.fileChanges(item.changes)
        return {
          item: {
            _tag: "ToolCall",
            toolName: "apply_patch",
            kind: "file-edit",
            status: toolStatus(done ? item.status : "running"),
            ...this.fileChangeSummary(changes),
            ...hostNode,
          },
        }
      }
      case "mcpToolCall": {
        const server = str(item.server) ?? "mcp"
        const tool = str(item.tool) ?? "tool"
        const args = item.arguments
        const isOpenBot = server === OPENBOT_SERVER
        const kind: ToolKind = isOpenBot ? (OPENBOT_TOOL_KIND[tool] ?? "mcp") : "mcp"
        const result = mcpText(item.result)
        const errorMessage = isRecord(item.error) ? str(item.error.message) : str(item.error)
        let status = toolStatus(done ? item.status : "running")
        if (done && status === "completed" && result.isError) status = "failed"
        const nodeArg = isRecord(args) ? str(args.node) : undefined
        const nodeId =
          isOpenBot && NODE_TOOLS.has(tool) ? ((nodeArg as NodeId | undefined) ?? this.hostNodeId) : undefined
        return {
          server,
          tool,
          args,
          // OpenBot's own tools: the computer tools by kind, the rest (messaging, bookkeeping) by name.
          activity: isOpenBot ? (ACTIVITY_BY_KIND[kind] ?? openBotToolActivity(tool)) : CONNECTED_APP_ACTIVITY,
          item: {
            _tag: "ToolCall",
            toolName: `mcp__${server}__${tool}`,
            title: isOpenBot ? humanize(tool) : `${server}: ${tool}`,
            kind,
            status,
            inputSummary: summarizeArgs(tool, args),
            input: args ?? {},
            mcp: { server, tool },
            ...(result.text !== "" ? { outputPreview: truncate(result.text, this.previewChars) } : {}),
            ...(done && result.text !== ""
              ? {
                  output: {
                    text: truncate(result.text, 16_000),
                    ...(result.text.length > 16_000 ? { truncated: true } : {}),
                  },
                }
              : {}),
            ...(done && status === "failed" ? { error: errorMessage ?? (result.text || "The tool call failed.") } : {}),
            ...(nodeId ? { nodeId } : {}),
          },
        }
      }
      case "dynamicToolCall": {
        const tool = str(item.tool) ?? "tool"
        return {
          item: {
            _tag: "ToolCall",
            toolName: tool,
            title: humanize(tool),
            kind: "other",
            status: done ? (item.success === false ? "failed" : toolStatus(item.status)) : "running",
            inputSummary: summarizeArgs(tool, item.arguments),
            input: item.arguments ?? {},
          },
        }
      }
      case "webSearch": {
        const query = str(item.query) ?? ""
        return {
          item: {
            _tag: "ToolCall",
            toolName: "web_search",
            title: query ? `Search: ${truncate(oneLine(query), 100)}` : "Web search",
            kind: "web",
            status: done ? "completed" : "running",
            inputSummary: truncate(oneLine(query), 200),
            input: { query },
          },
        }
      }
      case "imageView": {
        const path = str(item.path) ?? ""
        return {
          item: {
            _tag: "ToolCall",
            toolName: "view_image",
            title: path ? `View ${basename(path)}` : "View image",
            kind: "file-read",
            status: done ? "completed" : "running",
            inputSummary: path,
            input: { path },
            ...hostNode,
          },
          activity: "Looking at an image",
        }
      }
      case "imageGeneration": {
        const prompt = str(item.revisedPrompt) ?? str(item.prompt) ?? ""
        return {
          item: {
            _tag: "ToolCall",
            toolName: "image_generation",
            title: "Generate an image",
            kind: "other",
            status: done ? toolStatus(item.status ?? "completed") : "running",
            inputSummary: truncate(oneLine(prompt), 200),
          },
          activity: "Generating an image",
        }
      }
      case "collabAgentToolCall": {
        const tool = str(item.tool) ?? "agent"
        const prompt = str(item.prompt) ?? ""
        return {
          item: {
            _tag: "ToolCall",
            toolName: tool,
            title: humanize(tool),
            kind: "subagent",
            status: done ? toolStatus(item.status) : "running",
            inputSummary: truncate(oneLine(prompt), 200),
          },
        }
      }
      default:
        return undefined
    }
  }

  private tokenUsage(params: Record<string, unknown>, out: Array<HarnessEvent>): void {
    const usage = isRecord(params.tokenUsage) ? params.tokenUsage : undefined
    if (!usage) return
    const total = breakdownOf(usage.total)
    const last = breakdownOf(usage.last)
    const delta = total && this.lastTotal ? minus(total, this.lastTotal) : (last ?? emptyBreakdown())
    if (total) this.lastTotal = total
    const native = str(params.turnId)
    const turnId = native ? this.turnByNative.get(native) : undefined
    if (turnId && !this.finished.has(turnId)) {
      this.turnUsage.set(turnId, plus(this.turnUsage.get(turnId) ?? emptyBreakdown(), delta))
    } else if (native && this.internal.has(native) && delta.totalTokens > 0) {
      out.push({ _tag: "Usage", usage: toUsage(delta) })
    }
    const window = num(usage.modelContextWindow)
    if (window !== undefined && window > 0 && last) {
      this.context = { usedTokens: Math.max(0, Math.round(last.totalTokens)), windowTokens: Math.round(window) }
      out.push({ _tag: "ContextUsage", ...this.context })
    }
  }
}
