/**
 * The fake harness "script language" (architecture §4.5 Fake, D2.4).
 *
 * Every line of a turn's text is matched against a directive. Lines that are not directives are
 * ignored when at least one directive is present; a text without any directive gets the friendly
 * default reply. Leading `@mentions` are skipped, so `@Scout echo: hi` works in a group chat.
 *
 * Attributed deliveries (core BotRunner, one session per bot): a turn may open with an origin tag
 * line — `[Group chat "…" · members: … ]` (followed by `[@Sender]: text` catch-up lines),
 * `[DM with the owner]`, `[Routine run "…"]` — and a bot-to-bot message arrives as `[@Sender]: text`
 * or `[Direct message from @Sender]: text`. Only the newest message that holds a directive is
 * scripted (older catch-up lines were meant for other bots), with its sender prefix removed.
 *
 * | Directive | Effect |
 * |---|---|
 * | `echo: <text>` | stream `<text>` back |
 * | `slow: <text>` | stream `<text>` back slowly (interrupt tests) |
 * | `tool: <name> <json>` | call an OpenBot tool through the real MCP gateway binding |
 * | `approve: <command>` | raise a command approval via `onRequest` (the command is never run); `approve: <command> @ /abs/dir` raises it with that cwd (default: the workspace) |
 * | `ask: <prompt> [| option | option …]` | raise a question via `onRequest` |
 * | `fail: <message>` | fail the turn (`TurnFailed`) |
 * | `think: <text>` | emit a reasoning item (extra) |
 * | `crash: <reason>` | fail the turn and close the session (`SessionClosed`, extra) |
 * | `recall:` | reply with the native session id, the session's turn count and its last reply (memory checks, extra) |
 * | `bg: <seconds> <title>` | start parallel work (`start_task {title, brief: "work: <seconds> <title>"}`) and reply at once (background tasks, D5.7) |
 * | `work: <seconds> <title>` | a slow piece of work: one step, `<seconds>` (fractions allowed) of activity, then a result reply |
 * | `upd: <title> \| <message>` | pass a change on to running work (`update_task {task, message}`) and reply at once |
 *
 * A turn whose text opens with `[Result of "<title>"]` (a finished task coming back, D5.7) gets a
 * short report of that result instead of the default reply. A background task's first turn opens
 * with its origin conversation's recent messages; only what follows its `[The brief]` line is
 * scripted. An `[Update to this work]` block (the next lines up to a blank line) is an update the
 * work takes in: the work answers again with it.
 *
 * Pure; no Effect.
 */

export type Directive =
  | { readonly _tag: "Echo"; readonly text: string }
  | { readonly _tag: "Slow"; readonly text: string }
  | { readonly _tag: "Tool"; readonly name: string; readonly args: Record<string, unknown> }
  | { readonly _tag: "ToolInvalid"; readonly name: string; readonly raw: string; readonly message: string }
  | { readonly _tag: "Approve"; readonly command: string; readonly cwd?: string | undefined }
  | { readonly _tag: "Ask"; readonly prompt: string; readonly options: ReadonlyArray<string> }
  | { readonly _tag: "Fail"; readonly message: string }
  | { readonly _tag: "Think"; readonly text: string }
  | { readonly _tag: "Crash"; readonly reason: string }
  | { readonly _tag: "Recall" }
  | { readonly _tag: "Background"; readonly seconds: number; readonly title: string }
  | { readonly _tag: "Work"; readonly seconds: number; readonly title: string }
  | { readonly _tag: "Report"; readonly title: string; readonly body: string }
  | { readonly _tag: "UpdateWork"; readonly title: string; readonly message: string }
  | { readonly _tag: "Updated"; readonly message: string }
  | { readonly _tag: "Default"; readonly text: string }

export const DIRECTIVE_NAMES = [
  "echo",
  "slow",
  "tool",
  "approve",
  "ask",
  "fail",
  "think",
  "crash",
  "recall",
  "bg",
  "work",
  "upd",
] as const
export type DirectiveName = (typeof DIRECTIVE_NAMES)[number]

const LINE = new RegExp(`^\\s*(?:@[^\\s:]+[,]?\\s+)*(${DIRECTIVE_NAMES.join("|")})\\s*:[ \\t]?(.*)$`, "i")

/** The MCP tool-name prefix harnesses use for OpenBot tools (Claude style). */
const TOOL_PREFIXES = ["mcp__openbot__", "openbot_", "openbot."]

const stripToolPrefix = (name: string): string => {
  for (const prefix of TOOL_PREFIXES) {
    if (name.startsWith(prefix)) return name.slice(prefix.length)
  }
  return name
}

const parseTool = (rest: string): Directive => {
  const trimmed = rest.trim()
  const match = /^(\S+)\s*([\s\S]*)$/.exec(trimmed)
  if (!match || match[1] === undefined) {
    return { _tag: "ToolInvalid", name: "", raw: trimmed, message: "missing tool name" }
  }
  const name = stripToolPrefix(match[1])
  const json = (match[2] ?? "").trim()
  if (json === "") return { _tag: "Tool", name, args: {} }
  try {
    const parsed: unknown = JSON.parse(json)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { _tag: "ToolInvalid", name, raw: json, message: "arguments must be a JSON object" }
    }
    return { _tag: "Tool", name, args: parsed as Record<string, unknown> }
  } catch (error) {
    return {
      _tag: "ToolInvalid",
      name,
      raw: json,
      message: `invalid JSON arguments (${error instanceof Error ? error.message : String(error)})`,
    }
  }
}

const parseAsk = (rest: string): Directive => {
  const [prompt = "", ...options] = rest.split("|").map((part) => part.trim())
  return {
    _tag: "Ask",
    prompt: prompt === "" ? "Can you help me decide?" : prompt,
    options: options.filter((o) => o !== ""),
  }
}

/** `<seconds> <title>` (seconds default 3, title default "the work"). */
const parseTimed = (rest: string): { readonly seconds: number; readonly title: string } => {
  const match = /^\s*(\d+(?:\.\d+)?)?\s*(.*)$/.exec(rest)
  const seconds = match?.[1] === undefined ? 3 : Number(match[1])
  const title = (match?.[2] ?? "").trim()
  return { seconds: Number.isFinite(seconds) ? seconds : 3, title: title === "" ? "the work" : title }
}

const parseLine = (line: string): Directive | undefined => {
  const match = LINE.exec(line)
  if (!match || match[1] === undefined) return undefined
  const name = match[1].toLowerCase() as DirectiveName
  const rest = match[2] ?? ""
  switch (name) {
    case "echo":
      return { _tag: "Echo", text: rest }
    case "slow":
      return { _tag: "Slow", text: rest }
    case "tool":
      return parseTool(rest)
    case "approve": {
      const command = rest.trim() === "" ? "echo hello" : rest.trim()
      const at = /^(.*\S)\s+@\s+(\/\S*)$/.exec(command)
      return at === null ? { _tag: "Approve", command } : { _tag: "Approve", command: at[1]!, cwd: at[2]! }
    }
    case "ask":
      return parseAsk(rest)
    case "fail":
      return { _tag: "Fail", message: rest.trim() === "" ? "Scripted failure" : rest.trim() }
    case "think":
      return { _tag: "Think", text: rest }
    case "crash":
      return { _tag: "Crash", reason: rest.trim() === "" ? "Scripted crash" : rest.trim() }
    case "recall":
      return { _tag: "Recall" }
    case "bg":
      return { _tag: "Background", ...parseTimed(rest) }
    case "work":
      return { _tag: "Work", ...parseTimed(rest) }
    case "upd": {
      const [title = "", ...message] = rest.split("|")
      return { _tag: "UpdateWork", title: title.trim(), message: message.join("|").trim() }
    }
  }
}

/** `[Result of "<title>"]` — the first line of a finished task's result (D5.7). */
const RESULT_OF = /^\[Result of "([^"\n]*)"\]\s*$/

/**
 * The brain's one-line origin tag (`[Group chat "…" · members: …]`, `[DM with the owner]`,
 * `[Routine run "…"]`) or the reply hint leading teammates' messages in a DM (`[From teammates · …]`).
 */
const ORIGIN_TAG = /^\[(?:Group chat |DM with |Routine run |From teammates ).*\]\s*$/
const SENDER = /^\[(?:Direct message from )?@[^\]\n]+\]:[ \t]?/

/** A background task's first turn: its brief follows this line (D5.7). */
const BRIEF = /^\[The brief\]\s*$/
/** An update to running work (D5.7 `update_task`): its message follows, up to a blank line. */
const UPDATE = /^\[Update to this work\]\s*$/

const directivesOf = (text: string): Array<Directive> => {
  const directives: Array<Directive> = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (UPDATE.test(lines[i]!)) {
      const message: Array<string> = []
      while (i + 1 < lines.length && lines[i + 1]!.trim() !== "") message.push(lines[++i]!)
      directives.push({ _tag: "Updated", message: message.join(" ").trim() })
      continue
    }
    const directive = parseLine(lines[i]!)
    if (directive) directives.push(directive)
  }
  return directives
}

/**
 * The part of a turn's text to script: the text itself, or for an attributed delivery (group
 * catch-up, `[@Sender]: …` lines) the newest message holding a directive, else the newest message.
 */
export const scriptSourceOf = (text: string): string => {
  const lines = text.split(/\r?\n/)
  const brief = lines.findIndex((line) => BRIEF.test(line))
  if (brief >= 0) return lines.slice(brief + 1).join("\n")
  const grouped = ORIGIN_TAG.test(lines[0] ?? "")
  if (!grouped && !SENDER.test(lines[0] ?? "")) return text
  const blocks: Array<Array<string>> = []
  for (const line of grouped ? lines.slice(1) : lines) {
    if (SENDER.test(line)) blocks.push([line.replace(SENDER, "")])
    else if (RESULT_OF.test(line.trim())) blocks.push([line])
    else if (blocks.length > 0) blocks[blocks.length - 1]!.push(line)
    else blocks.push([line])
  }
  const messages = blocks.map((b) => b.join("\n").trim()).filter((m) => m !== "")
  for (let i = messages.length - 1; i >= 0; i--) {
    if (directivesOf(messages[i]!).length > 0 || RESULT_OF.test(messages[i]!.split(/\r?\n/)[0]!.trim()))
      return messages[i]!
  }
  return messages[messages.length - 1] ?? text
}

/** Parses a turn's text into the directives to run, in order. Never empty. */
export const parseScript = (text: string): ReadonlyArray<Directive> => {
  const source = scriptSourceOf(text)
  const [first = "", ...rest] = source.split(/\r?\n/)
  const result = RESULT_OF.exec(first.trim())
  if (result !== null) return [{ _tag: "Report", title: result[1]!, body: rest.join("\n").trim() }]
  const directives = directivesOf(source)
  return directives.length > 0 ? directives : [{ _tag: "Default", text: source }]
}

/** Splits text into streaming chunks (words with their trailing whitespace). */
export const chunksOf = (text: string): ReadonlyArray<string> => {
  if (text === "") return [""]
  const leading = /^\s*/.exec(text)?.[0] ?? ""
  const words = text.slice(leading.length).match(/\S+\s*/g) ?? []
  if (words.length === 0) return [text]
  return leading === "" ? words : [leading + words[0], ...words.slice(1)]
}

/** Rough token estimate (≈4 characters per token), never below 1 for non-empty text. */
export const estimateTokens = (text: string): number =>
  text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / 4))

/** Caps `text` at `max` characters, appending an ellipsis marker. */
export const cap = (text: string, max: number): { readonly text: string; readonly truncated: boolean } =>
  text.length <= max ? { text, truncated: false } : { text: `${text.slice(0, max)}…`, truncated: true }
