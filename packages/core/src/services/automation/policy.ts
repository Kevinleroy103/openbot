/**
 * Approval policy (D5.6, architecture §4.3.4): pure rule evaluation shared by `ApprovalService`
 * and previews.
 *
 * Precedence: bot deny > bot ask > bot allow > global deny > global ask > global allow > default ask.
 *
 * Matching (`ApprovalRuleMatch`, all present fields must match; an empty match covers the surface):
 * - `toolName`: exact.
 * - `commandPrefix`: whitespace-normalized; the command equals the prefix or continues with a space.
 *   An ALLOW rule matches a plain command starting with the prefix, or a chain whose every segment
 *   is either the prefixed command, a leading `cd <dir> &&`, or a read-only filter after a pipe
 *   (`cd app && bun test 2>&1 | tail -20`). Any other control (`;`, `||`, `$`, backticks,
 *   `<`, `>` except `2>&1` / `>/dev/null`, parentheses, newlines) never matches, so "Always allow
 *   `git status`" cannot be stretched into `git status; rm -rf ~`. Deny/ask rules match when ANY
 *   segment of a chained command starts with the prefix (`echo hi && rm -rf /` hits a deny rule
 *   for `rm`).
 * - `pathPrefix`: a path matches when it equals the prefix or lies below it (segment boundary). An
 *   ALLOW rule needs EVERY path to match and never matches paths with `..` segments; a deny/ask rule
 *   needs ANY path to match.
 */
import type {
  ApprovalAction,
  ApprovalRule,
  ApprovalRuleMatch,
  ApprovalSurface,
  BotId,
  HarnessApprovalRequest,
  SuggestedRule,
} from "@openbot/contracts"

/** What a rule check needs to know about a request. */
export interface PolicySubject {
  readonly surface: ApprovalSurface
  readonly toolName?: string | undefined
  readonly command?: string | undefined
  readonly paths?: ReadonlyArray<string> | undefined
}

export interface PolicyDecision {
  readonly action: ApprovalAction
  /** The deciding rule; absent for the default (ask). */
  readonly rule?: ApprovalRule | undefined
}

/** Surface of a harness approval: the adapter's classification, else derived from `kind`. */
export const surfaceOf = (request: Pick<HarnessApprovalRequest, "kind" | "surface">): ApprovalSurface => {
  if (request.surface !== undefined) return request.surface
  switch (request.kind) {
    case "command-approval":
      return "shell"
    case "file-approval":
      return "file-edit"
    case "mcp-approval":
      return "mcp"
    default:
      return "other"
  }
}

export const normalizeCommand = (command: string): string => command.trim().replace(/\s+/g, " ")

const SHELL_CONTROL = /[;&|`$<>()\n\r]/

const startsWithCommand = (command: string, prefix: string): boolean =>
  command === prefix || command.startsWith(`${prefix} `)

/**
 * Allow: the whole command (free of control characters) starts with the prefix. Deny / ask: ANY
 * segment of a chained command (`a; b && c | d $(e)`) starts with it.
 */
export const commandMatches = (prefix: string, command: string, action: ApprovalAction): boolean => {
  const p = normalizeCommand(prefix)
  const c = normalizeCommand(command)
  if (p.length === 0) return false
  if (action === "allow") return !SHELL_CONTROL.test(c) ? startsWithCommand(c, p) : chainAllowed(p, c)
  return c
    .split(/[;&|`()\n\r]|\$\(/)
    .map(normalizeCommand)
    .some((segment) => startsWithCommand(segment, p))
}

/** Read-only filters an allow rule tolerates after a pipe (`… | tail -20`). */
const PIPE_FILTERS: ReadonlySet<string> = new Set([
  "head",
  "tail",
  "grep",
  "rg",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "nl",
  "column",
  "cat",
  "less",
  "more",
])
/** Redirections an allow rule tolerates (they only route output to the terminal or nowhere). */
const HARMLESS_REDIRECT = /(^| )(?:2>&1|1>&2|>&2|[12]?>\/dev\/null|&>\/dev\/null)(?= |$)/g

/**
 * Allow-rule matching of a chained command: `cd <dir> && … && <prefix …> [| filter]…`, nothing
 * else. Every segment must be the prefixed command, a leading `cd <one arg>`, or a pipe filter.
 */
const chainAllowed = (prefix: string, command: string): boolean => {
  const c = normalizeCommand(command.replace(HARMLESS_REDIRECT, "$1"))
  if (/[;`$<>()\n\r]|\|\|/.test(c)) return false
  const parts = c.split(/(&&|\|)/).map((x) => x.trim())
  let matched = false
  let leading = true
  for (let i = 0; i < parts.length; i += 2) {
    const segment = parts[i]!
    const separator = i === 0 ? "" : parts[i - 1]!
    if (segment.length === 0 || segment.includes("&")) return false
    if (startsWithCommand(segment, prefix)) {
      matched = true
      leading = false
      continue
    }
    const words = segment.split(" ")
    if (leading && separator !== "|" && words[0] === "cd" && words.length === 2 && parts[i + 1] === "&&") continue
    if (matched && separator === "|" && PIPE_FILTERS.has(words[0]!)) continue
    return false
  }
  return matched
}

const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path)

const hasDotDot = (path: string): boolean => path.split(/[\\/]/).includes("..")

export const pathMatches = (prefix: string, path: string): boolean => {
  const p = trimSlash(prefix)
  const x = trimSlash(path)
  if (p.length === 0) return false
  if (p === "/") return x.startsWith("/")
  return x === p || x.startsWith(`${p}/`)
}

/** True when `rule` covers `subject` (ignoring the bot scope). */
export const ruleMatches = (rule: ApprovalRule, subject: PolicySubject): boolean => {
  if (rule.surface !== subject.surface) return false
  const m = rule.match
  if (m.toolName !== undefined && m.toolName !== subject.toolName) return false
  if (m.commandPrefix !== undefined) {
    if (subject.command === undefined || !commandMatches(m.commandPrefix, subject.command, rule.action)) return false
  }
  if (m.pathPrefix !== undefined) {
    const paths = subject.paths ?? []
    if (paths.length === 0) return false
    const prefix = m.pathPrefix
    if (rule.action === "allow") {
      if (!paths.every((p) => !hasDotDot(p) && pathMatches(prefix, p))) return false
    } else if (!paths.some((p) => pathMatches(prefix, p))) {
      return false
    }
  }
  return true
}

const ORDER: ReadonlyArray<readonly [scope: "bot" | "global", action: ApprovalAction]> = [
  ["bot", "deny"],
  ["bot", "ask"],
  ["bot", "allow"],
  ["global", "deny"],
  ["global", "ask"],
  ["global", "allow"],
]

/**
 * Evaluates `rules` for `botId` and `subject`. Rules of other bots are ignored. Within one
 * precedence class the oldest rule wins (rules are expected in `createdAt` order).
 */
export const evaluateRules = (
  rules: ReadonlyArray<ApprovalRule>,
  botId: BotId,
  subject: PolicySubject,
): PolicyDecision => {
  const applicable = rules.filter((r) => (r.botId === undefined || r.botId === botId) && ruleMatches(r, subject))
  for (const [scope, action] of ORDER) {
    const rule = applicable.find(
      (r) => r.action === action && (scope === "bot" ? r.botId !== undefined : r.botId === undefined),
    )
    if (rule !== undefined) return { action, rule }
  }
  return { action: "ask" }
}

const SUBCOMMAND = /^[a-z][\w.-]*$/i

/** `NAME=value` (a shell variable / environment assignment, never a program). */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * Wrappers that only change HOW a program runs; the program is the next word after their options
 * (each with the options that take a separate argument).
 */
const PREFIX_WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(["-u", "--unset", "-C", "--chdir"]),
  time: new Set(["-o", "--output", "-f", "--format"]),
  nice: new Set(["-n", "--adjustment"]),
  nohup: new Set(),
  command: new Set(),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  ionice: new Set(["-c", "-n", "-p", "-P", "-u"]),
}

/** Segments that set up the shell rather than run a program (`cd dir && …`, `export X=1; …`). */
const SETUP_SEGMENTS: ReadonlySet<string> = new Set(["cd", "pushd", "export", "unset", "set", "true", ":"])

/** A word that can name a program: a bare name, or an explicit path (`./run.sh`, `/usr/bin/git`, `~/bin/x`). */
const isProgramWord = (word: string): boolean => {
  if (!/^[\w@%+.,:~/-]+$/.test(word) || word.includes("=")) return false
  if (!word.includes("/")) return true
  return /^(?:\.{1,2}\/|\/|~\/)/.test(word) && !word.endsWith("/")
}

/**
 * "git status --short" → "git status"; "ls -la /tmp" → "ls"; "npm run build" → "npm run";
 * "cd /w/app && bun test 2>&1 | tail" → "bun test" (leading `cd …&&` and the rest of a chain are
 * dropped: the rule names the program, never a directory). Environment assignments
 * (`FOO=1 bun test`, `f=src/main.rs; wc -l $f`) and wrappers (`env`, `time`, `nice -n 5`,
 * `timeout 30`, …) are skipped. `undefined` when no word can name a program (never a word with `=`
 * or a bare relative path such as `src/main.rs`).
 */
export const suggestCommandPrefix = (command: string): string | undefined => {
  const segments = normalizeCommand(command).split(/&&|\|\||[;&|\n\r]/)
  for (const raw of segments) {
    // redirections and substitutions end the words that can name the program
    const words = normalizeCommand(raw.split(/[`<>()]|\$\(/)[0] ?? "")
      .split(" ")
      .filter((w) => w.length > 0)
    let i = 0
    while (i < words.length && ASSIGNMENT.test(words[i]!)) i++
    if (i >= words.length) continue // only assignments (`f=x;`): the program comes later
    if (SETUP_SEGMENTS.has(words[i]!)) continue
    for (;;) {
      const word = words[i]
      const wrapper = word === undefined ? undefined : (word.split("/").pop() ?? word)
      const options = wrapper === undefined ? undefined : PREFIX_WRAPPERS[wrapper]
      if (wrapper === undefined || options === undefined) break
      i++
      while (i < words.length) {
        const w = words[i]!
        if (wrapper === "env" && ASSIGNMENT.test(w)) i++
        else if (w.startsWith("-")) i += options.has(w) ? 2 : 1
        else {
          if (wrapper === "timeout" && /^\d+(?:\.\d+)?[smhd]?$/.test(w)) i++
          break
        }
      }
    }
    const program = words[i]
    if (program === undefined || !isProgramWord(program)) return undefined
    const second = words[i + 1]
    return second !== undefined && SUBCOMMAND.test(second) ? `${program} ${second}` : program
  }
  return undefined
}

const dirname = (path: string): string => {
  const x = trimSlash(path)
  const i = x.lastIndexOf("/")
  return i <= 0 ? "/" : x.slice(0, i)
}

/** Deepest directory containing every path (absolute paths only). */
export const commonDirectory = (paths: ReadonlyArray<string>): string | undefined => {
  const absolute = paths.filter((p) => p.startsWith("/") && !hasDotDot(p))
  if (absolute.length === 0 || absolute.length !== paths.length) return undefined
  const split = absolute.map((p) =>
    dirname(p)
      .split("/")
      .filter((s) => s.length > 0),
  )
  const first = split[0]!
  let n = first.length
  for (const parts of split.slice(1)) {
    let i = 0
    while (i < n && i < parts.length && parts[i] === first[i]) i++
    n = i
  }
  return `/${first.slice(0, n).join("/")}`
}

/**
 * The rule "Always allow" saves (D5.6; bot-scoped by the caller): surface + tool name, narrowed by a
 * command prefix (shell: program + subcommand, never a directory) or a directory (file surfaces:
 * the bot's `workspace` when every path is inside it, else the paths' common directory).
 */
export const suggestRule = (subject: PolicySubject, workspace?: string): SuggestedRule => {
  const match: { -readonly [K in keyof ApprovalRuleMatch]: ApprovalRuleMatch[K] } = {}
  if (subject.toolName !== undefined && subject.toolName.length > 0) match.toolName = subject.toolName
  if (subject.surface === "shell" && subject.command !== undefined) {
    const prefix = suggestCommandPrefix(subject.command)
    if (prefix !== undefined) match.commandPrefix = prefix
  }
  if (
    (subject.surface === "file-edit" || subject.surface === "file-read") &&
    subject.paths !== undefined &&
    subject.paths.length > 0
  ) {
    // Files inside the bot's workspace: the whole workspace, not the one folder this request touched.
    const dir =
      workspace !== undefined &&
      workspace.startsWith("/") &&
      subject.paths.every((p) => !hasDotDot(p) && pathMatches(workspace, p))
        ? trimSlash(workspace)
        : commonDirectory(subject.paths)
    if (dir !== undefined && dir !== "/") match.pathPrefix = dir
  }
  return { surface: subject.surface, match }
}

/** One-line human description of a rule (event lines, card details). */
export const describeRule = (
  rule: Pick<ApprovalRule, "surface" | "match"> & { readonly action?: ApprovalAction },
): string => {
  const parts: Array<string> = []
  if (rule.match.toolName !== undefined) parts.push(rule.match.toolName)
  if (rule.match.commandPrefix !== undefined) parts.push(`\`${rule.match.commandPrefix}\``)
  if (rule.match.pathPrefix !== undefined) parts.push(`in ${rule.match.pathPrefix}`)
  const what = parts.length > 0 ? parts.join(" ") : `any ${rule.surface} action`
  const verb = rule.action === "deny" ? "Deny" : rule.action === "ask" ? "Ask first for" : "Allow"
  return `${verb} ${what}`
}

/** Validation of a rule's match for `rules.upsert` (returns an error message or undefined). */
export const validateRuleMatch = (match: ApprovalRuleMatch): string | undefined => {
  if (match.toolName !== undefined && match.toolName.trim().length === 0) return "toolName must not be blank"
  if (match.commandPrefix !== undefined && normalizeCommand(match.commandPrefix).length === 0) {
    return "commandPrefix must not be blank"
  }
  if (match.pathPrefix !== undefined) {
    if (match.pathPrefix.trim().length === 0) return "pathPrefix must not be blank"
    if (hasDotDot(match.pathPrefix)) return "pathPrefix must not contain '..'"
  }
  return undefined
}
