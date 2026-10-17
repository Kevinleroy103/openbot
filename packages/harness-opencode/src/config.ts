/**
 * Per-brain and per-bot isolation config for OpenCode (harness-context-isolation.md §5, D2.3).
 *
 * - Server environment: `OPENCODE_DISABLE_PROJECT_CONFIG=1` (no walk-up into the user's repos and
 *   home), an OpenBot `OPENCODE_CONFIG_DIR` (no global `opencode.json`, `AGENTS.md`, MCP or skills),
 *   `OPENCODE_TEST_HOME=<empty dir>` (no `~/.claude` / `~/.agents` skills). `XDG_DATA_HOME` stays
 *   untouched so the user's OpenCode logins (`opencode.db`) keep working.
 * - Session permission rules: native-tool approvals are asked (OpenBot's ApprovalService decides),
 *   B1 (`brain-mcp-hands`) denies the built-in tools, and OpenBot MCP servers are isolated per
 *   session (an MCP server is registered per DIRECTORY, so two conversations of one bot share it).
 * - Persona: session instruction entries, never `agent.system` (it replaces OpenCode's base prompt).
 */
import type { RenderedInstructions } from "@openbot/core"
import { createHash } from "node:crypto"
import type { ModelRef, PermissionRule } from "./client.ts"

/** Inline config (`OPENCODE_CONFIG_CONTENT`, layer 7: overrides user files, not admin policy). */
export const serverConfigContent = (options: { readonly skillsDirs: ReadonlyArray<string> }): string =>
  JSON.stringify({
    // The OpenBot skills library (D5.5), Claude plugin layout: `<lib>/skills/<name>/SKILL.md`.
    skills: options.skillsDirs,
    // No git snapshots of bot workspaces in the user's data dir; OpenBot never reverts.
    snapshots: false,
    // Never share sessions to opencode.ai (third-party telemetry off by default, architecture §7).
    share: "disabled",
  })

/** Variables that would let the user's own config leak into OpenBot sessions. */
const DROPPED_ENV = ["OPENCODE_SERVER_PASSWORD", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT"] as const

export interface ServerEnvInput {
  readonly baseEnv: Readonly<Record<string, string | undefined>>
  readonly password: string
  /** OpenBot `OPENCODE_CONFIG_DIR` (`DataDir.opencodeConfig`). */
  readonly configDir: string
  /** Empty directory used as `OPENCODE_TEST_HOME`; `undefined` keeps the user's `~/.claude` / `~/.agents`. */
  readonly testHome: string | undefined
  readonly configContent: string
  readonly extra?: Readonly<Record<string, string>> | undefined
}

/** Environment of the spawned `opencode serve` (the user's env plus the isolation recipe). */
export const serverEnv = (input: ServerEnvInput): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(input.baseEnv)) {
    if (value !== undefined && !(DROPPED_ENV as ReadonlyArray<string>).includes(key)) env[key] = value
  }
  env.OPENCODE_PASSWORD = input.password
  env.OPENCODE_CLIENT = "openbot"
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
  env.OPENCODE_CONFIG_DIR = input.configDir
  env.OPENCODE_CONFIG_CONTENT = input.configContent
  if (input.testHome !== undefined) env.OPENCODE_TEST_HOME = input.testHome
  return { ...env, ...input.extra }
}

/** Arguments of the spawned server: random loopback port; exits when stdin closes (`--stdio`). */
export const serverArgs = (binary: string): ReadonlyArray<string> => [
  binary,
  "serve",
  "--stdio",
  "--port",
  "0",
  "--hostname",
  "127.0.0.1",
]

// ---------------------------------------------------------------------------- MCP

/** Prefix of every OpenBot MCP server registered in OpenCode. */
export const MCP_SERVER_PREFIX = "openbot"

/**
 * Per-session OpenCode MCP server name for a binding, e.g. `openbot-3f9a1c2b7d`. OpenCode registers
 * MCP servers per directory, so conversations of the same bot (same workspace) would otherwise
 * overwrite each other's bearer. Tools are exposed as `<name>_<tool>` (≤ 64-char namespace).
 */
export const mcpServerName = (sessionKey: string, bindingName: string): string => {
  const digest = createHash("sha256").update(`${bindingName}\u0000${sessionKey}`).digest("hex").slice(0, 10)
  return `${MCP_SERVER_PREFIX}-${digest}`
}

/**
 * Splits a native tool name into an OpenBot MCP reference: `openbot_whoami` (static name) or
 * `openbot-3f9a1c2b7d_message_bot` (per-session name) → `{server: "openbot", tool}`.
 */
export const parseOpenBotMcpTool = (toolName: string): { readonly server: string; readonly tool: string } | undefined => {
  const match = /^openbot(?:-[a-z0-9]+)?_(.+)$/.exec(toolName)
  return match?.[1] ? { server: "openbot", tool: match[1] } : undefined
}

// ---------------------------------------------------------------------------- permissions

const rule = (action: string, effect: PermissionRule["effect"], resource = "*"): PermissionRule => ({ action, resource, effect })

/**
 * Native permission actions of OpenCode's built-in file-system and shell tools (sdk-opencode.md
 * §8.1; `write`, `patch` and `edit` all assert `edit`). Denied for B1 (`brain-mcp-hands`).
 */
export const BUILTIN_TOOL_ACTIONS = ["shell", "read", "edit", "write", "glob", "grep", "list", "external_directory"] as const

/**
 * Extra actions denied for B1: Code Mode `execute` reaches OpenCode's own namespace tools
 * (`opencode.worktree_create`, `session_move`, …) that act on the brain's file system.
 */
export const B1_EXTRA_DENIED_ACTIONS = ["execute"] as const

/**
 * Session permission rules (`agent.permissions ++ session.permissions`, last match wins). A rule
 * whose last match is `deny` on resource `*` also removes the tool from the model's tool list
 * (`core/src/tool.ts` `whollyDisabled`).
 *
 * 1. Side-effecting native tools ask, so OpenBot's ApprovalService (rules, cards) decides.
 * 2. `subagent` is denied: a child session is created WITHOUT the parent's session rules and runs
 *    under the subagent's own `*: allow` defaults (`tool/plugin/subagent.ts`), so it would bypass
 *    these approvals and the B1 denies. OpenBot's own `handoff_task` / `message_bot` cover delegation.
 * 3. `grants` are "allow for this chat" answers, appended later.
 * 4. B1 (`disableBuiltinTools`): every built-in file-system/shell tool (and Code Mode) is denied;
 *    the gateway node tools run on the host node instead (D1.5).
 * 5. OpenBot MCP isolation: every OpenBot server is denied, then this session's own servers are
 *    allowed (pre-approved; the gateway runs OpenBot's own approval, interfaces.md §8.3).
 */
export const sessionRules = (input: {
  readonly disableBuiltinTools: boolean
  readonly mcpServerNames: ReadonlyArray<string>
  readonly grants?: ReadonlyArray<PermissionRule> | undefined
}): ReadonlyArray<PermissionRule> => [
  rule("shell", "ask"),
  rule("edit", "ask"),
  rule("external_directory", "ask"),
  rule("subagent", "deny"),
  ...(input.grants ?? []),
  ...(input.disableBuiltinTools
    ? [...BUILTIN_TOOL_ACTIONS, ...B1_EXTRA_DENIED_ACTIONS].map((action) => rule(action, "deny"))
    : []),
  rule(`${MCP_SERVER_PREFIX}-*`, "deny"),
  ...input.mcpServerNames.map((name) => rule(`${name}_*`, "allow")),
]

/**
 * Grants for "allow for this chat": one allow rule per `save` pattern of the request.
 * {@link sessionRules} places them before the B1 denies, so a grant never re-enables a denied tool.
 */
export const sessionGrants = (action: string, save: ReadonlyArray<string> | undefined): ReadonlyArray<PermissionRule> =>
  (save && save.length > 0 ? save : ["*"]).map((resource) => rule(action, "allow", resource))

// ---------------------------------------------------------------------------- models

/**
 * Parses OpenBot's model string into an OpenCode `ModelRef`: `provider/model`, optionally with a
 * `#variant` suffix (OpenCode's config shorthand). `effort` selects the variant when no suffix is
 * given (variants are `low…max`, each with `settings.reasoningEffort`).
 */
export const parseModel = (model: string | undefined, effort: string | undefined): ModelRef | undefined => {
  if (model === undefined) return undefined
  const trimmed = model.trim()
  const hash = trimmed.indexOf("#")
  const base = hash >= 0 ? trimmed.slice(0, hash) : trimmed
  const variant = hash >= 0 ? trimmed.slice(hash + 1) : effort
  const slash = base.indexOf("/")
  if (slash < 1 || slash === base.length - 1) return undefined
  return {
    providerID: base.slice(0, slash),
    id: base.slice(slash + 1),
    ...(variant !== undefined && variant.length > 0 ? { variant } : {}),
  }
}

/** OpenBot's model id for an OpenCode model (`provider/model`). */
export const modelId = (ref: { readonly providerID: string; readonly id: string }): string => `${ref.providerID}/${ref.id}`

// ---------------------------------------------------------------------------- instructions

/** Instruction-entry keys (`^[a-z0-9][a-z0-9._-]*$`), rendered as `<context key="…">` in the system prompt. */
export const INSTRUCTION_KEYS = {
  base: "openbot.base",
  persona: "openbot.persona",
  team: "openbot.team",
  memoryIndex: "openbot.memory",
  placement: "openbot.placement",
} as const

export const INSTRUCTION_KEY_PREFIX = "openbot."

/** Max value size of one entry is 256 KiB (`schema/src/instruction-entry.ts:30`); stay well below. */
const MAX_ENTRY_CHARS = 200_000

/**
 * The instruction entries for rendered instructions (§4.3.7 order). Empty sections are omitted, so
 * stale ones are removed. Each section is its own entry: a change re-sends only that section and
 * OpenCode keeps its base prompt and prompt cache.
 */
export const instructionEntries = (
  instructions: RenderedInstructions,
): ReadonlyArray<{ readonly key: string; readonly value: string }> => {
  const entries = (Object.keys(INSTRUCTION_KEYS) as ReadonlyArray<keyof typeof INSTRUCTION_KEYS>)
    .map((section) => ({ key: INSTRUCTION_KEYS[section], value: (instructions.sections[section] ?? "").trim().slice(0, MAX_ENTRY_CHARS) }))
    .filter((entry) => entry.value.length > 0)
  // A renderer that fills only `text` still reaches the model.
  const text = instructions.text.trim()
  return entries.length > 0 || text.length === 0 ? entries : [{ key: "openbot.instructions", value: text.slice(0, MAX_ENTRY_CHARS) }]
}
