/**
 * OpenCode v2 server events → normalized `HarnessEvent`s (architecture §3.1, sdk-opencode.md §12.4).
 *
 * Pure apart from its own per-session state; unit-tested against the recorded fixture
 * (`test/fixtures/opencode-basic.jsonl`). Rules:
 *
 * - Only events of the session this normalizer belongs to are mapped; the session filters routing.
 * - Items are emitted WHOLE, keyed by a stable native key: text/reasoning parts by
 *   `(assistantMessageID, ordinal)`, tool calls by `(assistantMessageID, call id)`.
 * - Events with no active OpenBot turn are dropped (host catalog changes, executions OpenBot did
 *   not start). A turn ends only on `session.execution.{succeeded|failed|interrupted}`.
 * - Unknown event types and malformed payloads are skipped, never fatal.
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
import { openBotToolActivity, THINKING_ACTIVITY } from "@openbot/contracts"
import type { OpenCodeEvent } from "./client.ts"
import { parseOpenBotMcpTool } from "./config.ts"

// ---------------------------------------------------------------------------- tolerant accessors

type Rec = Readonly<Record<string, unknown>>
const isRec = (u: unknown): u is Rec => typeof u === "object" && u !== null && !Array.isArray(u)
const rec = (u: unknown): Rec => (isRec(u) ? u : {})
const str = (u: unknown): string | undefined => (typeof u === "string" ? u : undefined)
const num = (u: unknown): number | undefined => (typeof u === "number" && Number.isFinite(u) ? u : undefined)
const int = (u: unknown): number => Math.max(0, Math.round(num(u) ?? 0))

/** The session an event belongs to (`data.sessionID`, or `data.form.sessionID` for forms). */
export const eventSessionId = (event: OpenCodeEvent): string | undefined => {
  const data = rec(event.data)
  return str(data.sessionID) ?? str(rec(data.form).sessionID)
}

// ---------------------------------------------------------------------------- tool classification

/** OpenBot gateway tools (D3.2) with a more specific kind than `mcp`. */
const OPENBOT_TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
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
  message_bot: "subagent",
  handoff_task: "subagent",
}

const NATIVE_TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  shell: "shell",
  bash: "shell",
  read: "file-read",
  write: "file-write",
  edit: "file-edit",
  multiedit: "file-edit",
  patch: "file-edit",
  apply_patch: "file-edit",
  glob: "search",
  grep: "search",
  list: "search",
  ls: "search",
  codesearch: "search",
  lsp: "search",
  webfetch: "web",
  websearch: "web",
  fetch: "web",
  task: "subagent",
  subagent: "subagent",
  agent: "subagent",
  question: "question",
}

export interface ToolClass {
  readonly kind: ToolKind
  readonly mcp?: { readonly server: string; readonly tool: string } | undefined
}

export const classifyTool = (name: string): ToolClass => {
  const mcp = parseOpenBotMcpTool(name)
  if (mcp) return { kind: OPENBOT_TOOL_KINDS[mcp.tool] ?? "mcp", mcp }
  return { kind: NATIVE_TOOL_KINDS[name.toLowerCase()] ?? "other" }
}

/**
 * Owner-visible activity phrases by tool kind: human and plumbing-free (D6.4). Native helpers and
 * tools without a phrase of their own read as the generic `THINKING_ACTIVITY`.
 */
const ACTIVITY_LABELS: Readonly<Record<ToolKind, string>> = {
  shell: "Running a command",
  "file-read": "Reading files",
  "file-write": "Writing files",
  "file-edit": "Editing files",
  search: "Searching files",
  web: "Searching the web",
  mcp: THINKING_ACTIVITY,
  subagent: THINKING_ACTIVITY,
  question: "Asking you a question",
  browser: "Using the browser",
  computer: "Using the computer",
  other: THINKING_ACTIVITY,
}

/**
 * The activity row phrase of a tool: OpenBot's messaging and bookkeeping tools by name (the shared
 * contracts phrases), everything else by kind.
 */
export const activityOf = (cls: ToolClass): string =>
  cls.mcp !== undefined && (cls.kind === "mcp" || cls.kind === "subagent")
    ? openBotToolActivity(cls.mcp.tool)
    : ACTIVITY_LABELS[cls.kind]

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim()

const pathOf = (input: Rec): string | undefined =>
  str(input.path) ?? str(input.filePath) ?? str(input.file_path) ?? str(input.file)

const compactJson = (input: unknown): string => {
  try {
    const json = JSON.stringify(input)
    return json === undefined || json === "{}" ? "" : json
  } catch {
    return ""
  }
}

/** One-line summary of a tool input ("ls -la", "README.md"). */
export const summarizeInput = (cls: ToolClass, input: unknown): string => {
  const i = rec(input)
  let summary: string | undefined
  switch (cls.kind) {
    case "shell":
      summary = str(i.command) ?? str(i.cmd)
      break
    case "file-read":
    case "file-write":
    case "file-edit":
      summary = pathOf(i)
      break
    case "search":
      summary = str(i.pattern) ?? str(i.query) ?? pathOf(i)
      break
    case "web":
      summary = str(i.url) ?? str(i.query)
      break
    case "subagent":
      summary = str(i.description) ?? str(i.prompt) ?? str(i.to) ?? str(i.task)
      break
    case "question": {
      const first = rec(Array.isArray(i.questions) ? i.questions[0] : undefined)
      summary = str(first.question) ?? str(first.prompt)
      break
    }
    case "browser":
      summary = [str(i.action), str(i.url) ?? str(i.selector)].filter(Boolean).join(" ")
      break
    default:
      break
  }
  return clip(oneLine(summary ?? compactJson(input)), 160)
}

const toolTitle = (name: string, cls: ToolClass, input: unknown): string => {
  const i = rec(input)
  const path = pathOf(i)
  switch (cls.kind) {
    case "shell":
      return clip(oneLine(str(i.description) ?? "Run a command"), 80)
    case "file-read":
      return path ? `Read ${path}` : "Read a file"
    case "file-write":
      return path ? `Write ${path}` : "Write a file"
    case "file-edit":
      return path ? `Edit ${path}` : "Edit a file"
    case "search":
      return "Search files"
    case "web":
      return "Search the web"
    case "question":
      return "Ask a question"
    case "subagent":
      return clip(oneLine(str(i.description) ?? (cls.mcp ? cls.mcp.tool : "Delegate a task")), 80)
    default:
      return cls.mcp ? cls.mcp.tool : name
  }
}

// ---------------------------------------------------------------------------- errors

/** A turn error from an OpenCode `SessionStructuredError` (`{type, message, status?}`). */
export const turnErrorOf = (error: unknown, fallbackCode = "turn-failed"): HarnessTurnError => {
  const e = rec(error)
  const code = str(e.type) ?? fallbackCode
  const message = str(e.message) ?? "OpenCode failed to respond."
  const status = num(e.status)
  const text = `${code} ${message}`
  const auth = status === 401 || status === 403 || /auth|credential|unauthori[sz]ed|forbidden|free.?tier/i.test(text)
  const retryable =
    !auth &&
    (status === 429 ||
      (status !== undefined && status >= 500) ||
      /rate.?limit|overload|timeout|timed out|network|transport|unavailable|temporar|econn/i.test(text))
  return { code, message, retryable }
}

// ---------------------------------------------------------------------------- normalizer

export interface NormalizerOptions {
  /** The native session this normalizer belongs to. */
  readonly sessionID: string
  /** Context window of a model (from `model.list` `limit.context`), when known. */
  readonly contextWindow?:
    ((model: { readonly providerID: string; readonly id: string }) => number | undefined) | undefined
  /**
   * The session's host node: OpenBot node tools called without a `node` argument run there, so
   * their entries are attributed to it (as the Codex adapter does).
   */
  readonly hostNodeId?: NodeId | undefined
}

/** Gateway tools that execute on a node (`node` argument, default: the host node). */
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

export interface OpenCodeNormalizer {
  /** The OpenBot turn that native events are attributed to. */
  readonly activeTurn: () => TurnId | undefined
  /** Starts attributing events to `turnId`. Call BEFORE prompting (events race the HTTP reply). */
  readonly beginTurn: (turnId: TurnId) => void
  /** Forgets the active turn without events (the prompt was rejected). */
  readonly abandonTurn: () => void
  readonly apply: (event: OpenCodeEvent) => ReadonlyArray<HarnessEvent>
  /** Ends the active turn as failed (server gone, stream lost). */
  readonly failTurn: (error: HarnessTurnError) => ReadonlyArray<HarnessEvent>
  /** Ends the active turn as interrupted without a native terminal (nothing was running). */
  readonly interruptTurn: () => ReadonlyArray<HarnessEvent>
  /** Key of a tool call item (`oc:tool:<assistantMessageID>:<call id>`). */
  readonly toolKey: (assistantMessageID: string | undefined, callID: string) => string
  /** Native name and parsed input of a tool call seen in this session. */
  readonly toolInfo: (key: string) => { readonly name: string; readonly input: unknown } | undefined
  /** Last context usage (last step's tokens / model window), when known. */
  readonly contextUsage: () => ContextUsage | undefined
  /**
   * A manual compaction finished: the context is now about `estimatedTokens` (summary size; the
   * next step reports the exact value). Unknown window → context usage becomes unknown.
   */
  readonly compacted: (estimatedTokens: number, model?: { readonly providerID: string; readonly id: string }) => void
}

const OUTPUT_PREVIEW_CHARS = 2_000
const OUTPUT_TEXT_CHARS = 32_000

type ToolCallItem = Extract<HarnessItem, { _tag: "ToolCall" }>
type MessageItem = Extract<HarnessItem, { _tag: "Message" }>
type ReasoningItem = Extract<HarnessItem, { _tag: "Reasoning" }>

const TERMINAL_TYPES = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

export const makeNormalizer = (options: NormalizerOptions): OpenCodeNormalizer => {
  let turnId: TurnId | undefined
  /** Items of the active turn (finalized at the terminal). */
  let items = new Map<string, HarnessItem>()
  /** Text/reasoning keys per assistant message (aborted steps). */
  let partsByMessage = new Map<string, Array<string>>()
  let usage = { input: 0, output: 0, cacheRead: 0, reasoning: 0, cost: 0, steps: 0 }
  let currentModel: { providerID: string; id: string } | undefined
  let lastContext: ContextUsage | undefined
  /** Session-lifetime maps (tools may be referenced by approvals after the turn moved on). */
  const toolInfos = new Map<string, { name: string; input: unknown }>()
  const permissionTools = new Map<string, string>()
  const declined = new Set<string>()

  const toolKey = (assistantMessageID: string | undefined, callID: string) =>
    `oc:tool:${assistantMessageID ?? "_"}:${callID}`
  const partKey = (kind: "text" | "reasoning", data: Rec) =>
    `oc:${kind}:${str(data.assistantMessageID) ?? "_"}:${num(data.ordinal) ?? 0}`

  const resetTurn = () => {
    turnId = undefined
    items = new Map()
    partsByMessage = new Map()
    usage = { input: 0, output: 0, cacheRead: 0, reasoning: 0, cost: 0, steps: 0 }
  }

  const upsert = (key: string, item: HarnessItem): HarnessEvent => {
    items.set(key, item)
    return { _tag: "ItemUpserted", turnId: turnId!, key, item }
  }

  const rememberPart = (assistantMessageID: string | undefined, key: string) => {
    if (!assistantMessageID) return
    const list = partsByMessage.get(assistantMessageID) ?? []
    if (!list.includes(key)) list.push(key)
    partsByMessage.set(assistantMessageID, list)
  }

  const activity = (label: string, toolKind?: ToolKind): HarnessEvent =>
    toolKind ? { _tag: "Activity", label, toolKind } : { _tag: "Activity", label }

  const usageEvent = (): ReadonlyArray<HarnessEvent> => {
    if (usage.steps === 0) return []
    const u: Usage = {
      inputTokens: int(usage.input),
      outputTokens: int(usage.output),
      ...(usage.cacheRead > 0 ? { cachedInputTokens: int(usage.cacheRead) } : {}),
      ...(usage.reasoning > 0 ? { reasoningTokens: int(usage.reasoning) } : {}),
      ...(usage.cost > 0 ? { costUsd: usage.cost } : {}),
    }
    return [{ _tag: "Usage", usage: u, turnId: turnId! }]
  }

  /** Closes every open item of the turn. */
  const finalize = (mode: "completed" | "failed" | "interrupted"): Array<HarnessEvent> => {
    const out: Array<HarnessEvent> = []
    for (const [key, item] of items) {
      if (item._tag === "Message" && item.streaming) {
        out.push(upsert(key, { ...item, streaming: false, ...(mode === "interrupted" ? { aborted: true } : {}) }))
      } else if (item._tag === "Reasoning" && item.streaming) {
        out.push(upsert(key, { ...item, streaming: false }))
      } else if (item._tag === "ToolCall" && (item.status === "pending" || item.status === "running")) {
        out.push(
          upsert(key, {
            ...item,
            status: "failed",
            error: mode === "interrupted" ? "Interrupted" : "The tool call did not finish.",
          }),
        )
      }
    }
    return out
  }

  const terminal = (event: HarnessEvent, mode: "completed" | "failed" | "interrupted"): ReadonlyArray<HarnessEvent> => {
    const out = [...finalize(mode), ...usageEvent(), event]
    resetTurn()
    return out
  }

  const textLike = (
    kind: "text" | "reasoning",
    data: Rec,
    phase: "started" | "delta" | "ended",
  ): ReadonlyArray<HarnessEvent> => {
    const key = partKey(kind, data)
    const messageID = str(data.assistantMessageID)
    rememberPart(messageID, key)
    const prev = items.get(key)
    const prevText = prev && (prev._tag === "Message" || prev._tag === "Reasoning") ? prev.text : ""
    const text =
      phase === "started"
        ? prevText
        : phase === "delta"
          ? prevText + (str(data.delta) ?? "")
          : (str(data.text) ?? prevText)
    const streaming = phase !== "ended"
    if (kind === "text") {
      const item: MessageItem = { _tag: "Message", role: "bot", text, streaming }
      const events: Array<HarnessEvent> = []
      if (!prev) events.push(activity("Typing…"))
      events.push(upsert(key, item))
      return events
    }
    const item: ReasoningItem = { _tag: "Reasoning", text, streaming, source: "thinking" }
    const events: Array<HarnessEvent> = []
    if (!prev) events.push(activity("Thinking…"))
    events.push(upsert(key, item))
    return events
  }

  const toolItem = (key: string): ToolCallItem | undefined => {
    const item = items.get(key)
    return item?._tag === "ToolCall" ? item : undefined
  }

  const baseTool = (key: string, name: string, input: unknown): ToolCallItem => {
    const cls = classifyTool(name)
    const nodeId = cls.mcp && NODE_TOOLS.has(cls.mcp.tool) ? (str(rec(input).node) ?? options.hostNodeId) : undefined
    return {
      _tag: "ToolCall",
      toolName: name,
      title: toolTitle(name, cls, input),
      kind: cls.kind,
      status: "pending",
      inputSummary: summarizeInput(cls, input),
      ...(cls.mcp ? { mcp: cls.mcp } : {}),
      ...(nodeId ? { nodeId: nodeId as NodeId } : {}),
      ...(toolItem(key)?.parentKey ? { parentKey: toolItem(key)!.parentKey! } : {}),
    }
  }

  const toolCalled = (data: Rec): ReadonlyArray<HarnessEvent> => {
    const callID = str(data.id)
    if (!callID) return []
    const key = toolKey(str(data.assistantMessageID), callID)
    const prev = toolItem(key)
    const name = prev?.toolName ?? toolInfos.get(key)?.name ?? "tool"
    const input = data.input ?? {}
    toolInfos.set(key, { name, input })
    const cls = classifyTool(name)
    const base = baseTool(key, name, input)
    const i = rec(input)
    const path = pathOf(i)
    const command = cls.kind === "shell" ? (str(i.command) ?? str(i.cmd)) : undefined
    const item: ToolCallItem = {
      ...prev,
      ...base,
      status: prev && prev.status !== "pending" ? prev.status : "running",
      input,
      ...(command !== undefined
        ? { command: { command, ...((str(i.workdir) ?? str(i.cwd)) ? { cwd: (str(i.workdir) ?? str(i.cwd))! } : {}) } }
        : {}),
      ...(path && (cls.kind === "file-write" || cls.kind === "file-edit") && !prev?.fileChanges
        ? { fileChanges: [{ path, kind: cls.kind === "file-write" ? ("add" as const) : ("update" as const) }] }
        : {}),
    }
    return [upsert(key, item)]
  }

  const toolFinished = (data: Rec, ok: boolean): ReadonlyArray<HarnessEvent> => {
    const callID = str(data.id)
    if (!callID) return []
    const key = toolKey(str(data.assistantMessageID), callID)
    const info = toolInfos.get(key)
    const prev = toolItem(key) ?? baseTool(key, info?.name ?? "tool", info?.input ?? {})
    const parts = Array.isArray(data.content) ? data.content.map(rec) : []
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => str(p.text) ?? "")
      .join("\n")
    const images = parts
      .filter((p) => p.type === "file" && (str(p.mime) ?? "").startsWith("image/") && str(p.uri))
      .map((p) => ({ mime: str(p.mime)!, url: str(p.uri)! }))
    const otherFiles = parts.filter((p) => p.type === "file" && !(str(p.mime) ?? "").startsWith("image/"))
    const fileNote = otherFiles.map((p) => `[file ${str(p.name) ?? str(p.uri) ?? ""}]`).join("\n")
    const fullText = [text, fileNote].filter((t) => t.length > 0).join("\n")
    const metadata = rec(data.metadata)
    const truncated = metadata.truncated === true || fullText.length > OUTPUT_TEXT_CHARS
    const exit = num(metadata.exit)
    const error = ok ? undefined : (str(rec(data.error).message) ?? "The tool call failed.")
    const item: ToolCallItem = {
      ...prev,
      status: ok ? "completed" : declined.has(key) ? "declined" : "failed",
      ...(fullText.length > 0 ? { outputPreview: clip(fullText, OUTPUT_PREVIEW_CHARS) } : {}),
      ...(fullText.length > 0 || images.length > 0
        ? {
            output: {
              ...(fullText.length > 0 ? { text: fullText.slice(0, OUTPUT_TEXT_CHARS) } : {}),
              ...(images.length > 0 ? { images } : {}),
              ...(truncated ? { truncated: true } : {}),
            },
          }
        : {}),
      ...(error !== undefined ? { error } : {}),
      ...(prev.command && exit !== undefined ? { command: { ...prev.command, exitCode: exit } } : {}),
    }
    return [upsert(key, item)]
  }

  const permissionAsked = (data: Rec): ReadonlyArray<HarnessEvent> => {
    const source = rec(data.source)
    const callID = source.type === "tool" ? str(source.id) : undefined
    const permID = str(data.id)
    if (!callID) return []
    const key = toolKey(str(source.messageID), callID)
    if (permID) permissionTools.set(permID, key)
    const prev = toolItem(key)
    const files = Array.isArray(rec(data.metadata).files)
      ? (rec(data.metadata).files as ReadonlyArray<unknown>).map(rec)
      : []
    if (!prev || files.length === 0) return []
    const fileChanges = files
      .filter((f) => str(f.file))
      .map((f) => ({
        path: str(f.file)!,
        kind:
          f.status === "added" ? ("add" as const) : f.status === "deleted" ? ("delete" as const) : ("update" as const),
        ...(str(f.patch) ? { diff: str(f.patch)! } : {}),
      }))
    return fileChanges.length > 0 ? [upsert(key, { ...prev, fileChanges })] : []
  }

  const stepEnded = (data: Rec): ReadonlyArray<HarnessEvent> => {
    const tokens = rec(data.tokens)
    const cache = rec(tokens.cache)
    usage = {
      input: usage.input + int(tokens.input),
      output: usage.output + int(tokens.output),
      cacheRead: usage.cacheRead + int(cache.read),
      reasoning: usage.reasoning + int(tokens.reasoning),
      cost: usage.cost + (num(data.cost) ?? 0),
      steps: usage.steps + 1,
    }
    const used = int(tokens.input) + int(cache.read) + int(cache.write) + int(tokens.output)
    const window = currentModel ? options.contextWindow?.(currentModel) : undefined
    if (window === undefined || window <= 0 || used === 0) return []
    lastContext = { usedTokens: used, windowTokens: int(window) }
    return [{ _tag: "ContextUsage", usedTokens: lastContext.usedTokens, windowTokens: lastContext.windowTokens }]
  }

  const stepFailed = (data: Rec): ReadonlyArray<HarnessEvent> => {
    if (str(rec(data.error).type) !== "aborted") return []
    // text.ended arrives BEFORE the abort: mark this step's bot text as cut short.
    const out: Array<HarnessEvent> = []
    for (const key of partsByMessage.get(str(data.assistantMessageID) ?? "") ?? []) {
      const item = items.get(key)
      if (item?._tag === "Message" && item.aborted !== true)
        out.push(upsert(key, { ...item, streaming: false, aborted: true }))
    }
    return out
  }

  const apply = (event: OpenCodeEvent): ReadonlyArray<HarnessEvent> => {
    const data = rec(event.data)
    const type = event.type
    // Approval bookkeeping is session-scoped, independent of the turn.
    if (type === "permission.replied") {
      const toolKeyForPermission = permissionTools.get(str(data.requestID) ?? "")
      if (toolKeyForPermission && data.reply === "reject") declined.add(toolKeyForPermission)
      return []
    }
    if (eventSessionId(event) !== options.sessionID) return []
    if (type === "session.step.started") {
      const model = rec(data.model)
      if (str(model.providerID) && str(model.id))
        currentModel = { providerID: str(model.providerID)!, id: str(model.id)! }
    }
    if (type === "session.tool.input.started" || type === "session.tool.called") {
      const callID = str(data.id)
      if (callID) {
        const key = toolKey(str(data.assistantMessageID), callID)
        const prev = toolInfos.get(key)
        toolInfos.set(key, { name: str(data.name) ?? prev?.name ?? "tool", input: data.input ?? prev?.input ?? {} })
      }
    }
    if (turnId === undefined) return []

    switch (type) {
      case "session.execution.started":
        return [activity("Thinking…")]
      case "session.execution.succeeded":
        return terminal({ _tag: "TurnCompleted", turnId, stopReason: "succeeded" }, "completed")
      case "session.execution.failed":
        return terminal({ _tag: "TurnFailed", turnId, error: turnErrorOf(data.error) }, "failed")
      case "session.execution.interrupted": {
        const reason = str(data.reason) ?? "user"
        return reason === "user"
          ? terminal({ _tag: "TurnInterrupted", turnId }, "interrupted")
          : terminal(
              {
                _tag: "TurnFailed",
                turnId,
                error: {
                  code: `interrupted:${reason}`,
                  message: `OpenCode stopped the turn (${reason}).`,
                  retryable: true,
                },
              },
              "interrupted",
            )
      }
      case "session.text.started":
        return textLike("text", data, "started")
      case "session.text.delta":
        return textLike("text", data, "delta")
      case "session.text.ended":
        return textLike("text", data, "ended")
      case "session.reasoning.started":
        return textLike("reasoning", data, "started")
      case "session.reasoning.delta":
        return textLike("reasoning", data, "delta")
      case "session.reasoning.ended":
        return textLike("reasoning", data, "ended")
      case "session.tool.input.started": {
        const callID = str(data.id)
        const name = str(data.name)
        if (!callID || !name) return []
        const key = toolKey(str(data.assistantMessageID), callID)
        const item = baseTool(key, name, {})
        return [activity(activityOf(classifyTool(name)), item.kind), upsert(key, { ...item, inputSummary: "" })]
      }
      case "session.tool.called":
        return toolCalled(data)
      case "session.tool.success":
        return toolFinished(data, true)
      case "session.tool.failed":
        return toolFinished(data, false)
      case "permission.asked":
        return permissionAsked(data)
      case "session.step.ended":
        return stepEnded(data)
      case "session.step.failed":
        return stepFailed(data)
      case "session.retry.scheduled":
        return [activity(`Retrying (attempt ${int(data.attempt)})…`)]
      case "session.status": {
        const status = rec(data.status)
        return status.type === "retry" ? [activity(`Retrying (attempt ${int(status.attempt)})…`)] : []
      }
      case "session.compaction.ended":
        return [
          upsert(`oc:compaction:${event.id ?? "_"}`, {
            _tag: "Notice",
            level: "info",
            text: "Conversation compacted.",
            code: "compacted",
          }),
        ]
      case "session.compaction.failed":
        return [
          upsert(`oc:compaction:${event.id ?? "_"}`, {
            _tag: "Notice",
            level: "warning",
            text: `Compaction failed: ${str(rec(data.error).message) ?? "unknown error"}`,
            code: "compaction-failed",
          }),
        ]
      default:
        return []
    }
  }

  return {
    activeTurn: () => turnId,
    beginTurn: (id) => {
      resetTurn()
      turnId = id
    },
    abandonTurn: resetTurn,
    apply,
    failTurn: (error) => (turnId === undefined ? [] : terminal({ _tag: "TurnFailed", turnId, error }, "failed")),
    interruptTurn: () => (turnId === undefined ? [] : terminal({ _tag: "TurnInterrupted", turnId }, "interrupted")),
    toolKey,
    toolInfo: (key) => toolInfos.get(key),
    contextUsage: () => lastContext,
    compacted: (estimatedTokens, model) => {
      if (model) currentModel = { providerID: model.providerID, id: model.id }
      const window = currentModel ? options.contextWindow?.(currentModel) : undefined
      lastContext =
        window !== undefined && window > 0
          ? { usedTokens: Math.min(int(estimatedTokens), int(window)), windowTokens: int(window) }
          : undefined
    },
  }
}

/** True for the three native turn terminals. */
export const isTerminalEvent = (event: OpenCodeEvent): boolean => TERMINAL_TYPES.has(event.type)
