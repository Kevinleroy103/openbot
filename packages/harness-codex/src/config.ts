/**
 * Per-bot isolation config and thread/turn parameters (architecture §4.5 Codex; D1.5, D2.2;
 * harness-context-isolation.md §2; mcp-conformance.md R8–R10; hands-architecture-synthesis.md G3).
 *
 * Every thread gets:
 * - `developerInstructions` = the rendered OpenBot instructions (persona, team, memory, placement);
 * - `config` with the FULL `mcp_servers` map (it replaces the profile's), connectors and plugins
 *   off, and OpenBot's tools first-class (`features.code_mode.direct_only_tool_namespaces`);
 * - **explicit `environments` always** (G3: an implicit selection would expose every registered
 *   environment, including other nodes, to a colocated bot):
 *   - `native-local` → `[{environmentId: "local", cwd: workspacePath}]`;
 *   - `codex-environment` → `[{environmentId, cwd}]` after `environment/add` (relay URL);
 *   - `brain-mcp-hands` → `[]` (no built-in machine tools) plus `baseInstructions` that describe the
 *     OpenBot node tools (the default prompt would still advertise `exec_command`/`apply_patch`).
 */
import type { NodeId } from "@openbot/contracts"
import type { HarnessError, McpBinding, OpenSessionInput, ResolvedPlacement, TurnInput } from "@openbot/core"
import { harnessError } from "./errors.ts"

export const LOCAL_ENVIRONMENT_ID = "local"

export interface TurnEnvironment {
  readonly environmentId: string
  readonly cwd: string
}

export interface EnvironmentRegistration {
  readonly environmentId: string
  readonly execServerUrl: string
  readonly authBearerToken: string
  readonly connectTimeoutMs?: number | undefined
}

export interface ThreadPlan {
  /** Explicit environments for `thread/start` and every `turn/start` (sticky, lost on resume). */
  readonly environments: ReadonlyArray<TurnEnvironment>
  /** `environment/add` to run before the thread starts (`codex-environment`). */
  readonly register?: EnvironmentRegistration | undefined
  /** Brain-side thread cwd (must exist on the brain). */
  readonly cwd: string
  readonly sandbox: "workspace-write" | "read-only"
  readonly baseInstructions?: string | undefined
  /** The OpenBot node a Codex environment id runs on. */
  readonly nodeIdForEnvironment: (environmentId: string | undefined) => NodeId | undefined
}

/**
 * Replaces Codex's built-in prompt when the thread has no environment (B1 fallback), so the model
 * is not told about `exec_command`/`apply_patch` it does not have (remote-codex.md §2.3, L2).
 */
export const mcpHandsBaseInstructions = (placement: ResolvedPlacement): string =>
  [
    "You are Codex, an AI teammate working inside OpenBot.",
    "In this session you have NO local shell, file or patch tools. You reach the computer ONLY through the openbot MCP tools:",
    "- shell: run a command and get its output;",
    "- read_file, write_file, edit_file: read, create and change files;",
    "- list_dir, glob, grep: find files and text.",
    `Each of them takes an optional \`node\` argument; leave it out to use your own computer. Your workspace there is ${placement.workspacePath}; paths are paths on that computer.`,
    "Work in small, verifiable steps: inspect before you change, run commands to check your work, and report what you did.",
    'Tool results that start with "ERROR:" failed; read the message and adapt.',
    "Ask the user with ask_user when a decision is theirs, and use request_approval before destructive or irreversible actions.",
  ].join("\n")

/** Placement → environments, cwd, sandbox (fails when a `codex-environment` lacks its relay). */
export const planThread = (placement: ResolvedPlacement): ThreadPlan | HarnessError => {
  const host = placement.hostNodeId
  switch (placement.mode) {
    case "native-local":
      return {
        environments: [{ environmentId: LOCAL_ENVIRONMENT_ID, cwd: placement.workspacePath }],
        cwd: placement.harnessCwd,
        sandbox: "workspace-write",
        nodeIdForEnvironment: () => host,
      }
    case "codex-environment": {
      const env = placement.codexEnvironment
      if (!env) {
        return harnessError(
          "open-failed",
          "The codex-environment placement has no exec-server relay for the host node.",
        )
      }
      if (!isValidEnvironmentId(env.environmentId) || env.environmentId === LOCAL_ENVIRONMENT_ID) {
        return harnessError("open-failed", `"${env.environmentId}" is not a valid Codex environment id.`)
      }
      return {
        environments: [{ environmentId: env.environmentId, cwd: env.cwd }],
        register: {
          environmentId: env.environmentId,
          execServerUrl: env.execServerUrl,
          authBearerToken: env.authBearerToken,
          connectTimeoutMs: 10_000,
        },
        cwd: placement.harnessCwd,
        sandbox: "workspace-write",
        nodeIdForEnvironment: (environmentId) =>
          environmentId === undefined || environmentId === env.environmentId ? host : undefined,
      }
    }
    case "brain-mcp-hands":
      return {
        environments: [],
        cwd: placement.harnessCwd,
        sandbox: "read-only",
        baseInstructions: mcpHandsBaseInstructions(placement),
        nodeIdForEnvironment: () => host,
      }
  }
}

export interface ThreadConfigOptions {
  /** `mcp_servers.<id>.tool_timeout_sec` (Codex default 300 s; long node tools need more, R8). */
  readonly mcpToolTimeoutSec?: number | undefined
  /** `mcp_servers.<id>.startup_timeout_sec` (Codex default 30 s). */
  readonly mcpStartupTimeoutSec?: number | undefined
  /** Per-thread skill rules (`skills.config`): disables discovered skills outside the library. */
  readonly skillRules?: ReadonlyArray<{ readonly path: string; readonly enabled: boolean }> | undefined
  /**
   * The thread's default reasoning effort (`model_reasoning_effort`). `thread/start` has no effort
   * parameter; without this a thread would use the model's (or a profile's) default between
   * turns, e.g. for compaction. Every `turn/start` also passes it.
   */
  readonly effort?: string | undefined
  /** Merged last, shallowly (tests: a mock model provider; advanced users). */
  readonly extra?: Readonly<Record<string, unknown>> | undefined
}

/** Environment ids Codex accepts (`[A-Za-z0-9_-]{1,64}`; `local`/`none` are reserved). */
export const isValidEnvironmentId = (id: string): boolean => /^[A-Za-z0-9_-]{1,64}$/.test(id) && id !== "none"

/**
 * The thread `config` (dotted keys and nested objects are both accepted; sdk-codex.md §4.4).
 * Tokens stay in `http_headers`: never on argv, never in `config.toml` (D3.1, §7).
 */
export const threadConfig = (
  mcp: ReadonlyArray<McpBinding>,
  options: ThreadConfigOptions = {},
): Record<string, unknown> => {
  const servers: Record<string, unknown> = {}
  for (const binding of mcp) {
    servers[binding.name] = {
      url: binding.url,
      http_headers: { ...binding.headers },
      // OpenBot's own approval layer decides (gateway → Orchestrator.approveToolCall); §8.3, R10.
      default_tools_approval_mode: "approve",
      // Fail the thread loudly instead of silently dropping the bot tools (sdk-codex.md §7.9).
      required: true,
      startup_timeout_sec: options.mcpStartupTimeoutSec ?? 30,
      tool_timeout_sec: options.mcpToolTimeoutSec ?? 900,
    }
  }
  const namespaces = mcp.map((binding) => `mcp__${binding.name}`)
  return {
    // One nested table (the form verified live for `code_mode`, mcp-conformance.md R9); mixing it
    // with dotted `features.*` keys would make two writers of the same table.
    features: {
      apps: false,
      plugins: false,
      memories: false,
      // Catalog models are Code-Mode-only: without this they only reach OpenBot's tools through
      // the `exec` JS host (images and errors get lost). With it they are first-class functions
      // (`mcp__openbot` namespace). `enabled` is deliberately NOT set: it would switch Code Mode
      // (an under-development feature) on for models that use direct tools anyway; the e2e test
      // checks that the namespace stays direct for a catalog model without it.
      ...(namespaces.length > 0 ? { code_mode: { direct_only_tool_namespaces: namespaces } } : {}),
    },
    mcp_servers: servers,
    ...(options.effort ? { model_reasoning_effort: options.effort } : {}),
    ...(options.skillRules && options.skillRules.length > 0 ? { "skills.config": options.skillRules } : {}),
    ...options.extra,
  }
}

const APPROVAL_POLICY = "on-request"

/** `thread/start` params. */
export const threadStartParams = (
  input: OpenSessionInput,
  plan: ThreadPlan,
  config: Record<string, unknown>,
): Record<string, unknown> => ({
  ...(input.model ? { model: input.model } : {}),
  cwd: plan.cwd,
  approvalPolicy: APPROVAL_POLICY,
  sandbox: plan.sandbox,
  config,
  developerInstructions: input.instructions.text,
  ...(plan.baseInstructions ? { baseInstructions: plan.baseInstructions } : {}),
  environments: plan.environments,
  ephemeral: false,
  serviceName: "openbot",
})

/**
 * `thread/resume` params. Instructions and config are re-sent (they are not guaranteed to persist,
 * sdk-codex.md §8); environments cannot be set here and go on the next `turn/start` (E8).
 */
export const threadResumeParams = (
  threadId: string,
  input: OpenSessionInput,
  plan: ThreadPlan,
  config: Record<string, unknown>,
): Record<string, unknown> => ({
  threadId,
  ...(input.model ? { model: input.model } : {}),
  cwd: plan.cwd,
  approvalPolicy: APPROVAL_POLICY,
  sandbox: plan.sandbox,
  config,
  developerInstructions: input.instructions.text,
  ...(plan.baseInstructions ? { baseInstructions: plan.baseInstructions } : {}),
  excludeTurns: true,
})

const IMAGE_MIME = /^image\//i

/** OpenBot turn input → Codex `UserInput[]`: images as `localImage`, other files referenced in text. */
export const userInputOf = (turn: TurnInput): ReadonlyArray<Record<string, unknown>> => {
  const images = turn.attachments.filter((a) => IMAGE_MIME.test(a.mime))
  const files = turn.attachments.filter((a) => !IMAGE_MIME.test(a.mime))
  const text =
    files.length === 0
      ? turn.text
      : `${turn.text}\n\nAttached files (readable on the brain):\n${files.map((f) => `- ${f.name} (${f.mime}): ${f.path}`).join("\n")}`
  return [
    { type: "text", text, text_elements: [] },
    ...images.map((image) => ({ type: "localImage", path: image.path })),
  ]
}

export interface TurnOptions {
  readonly model?: string | undefined
  readonly effort?: string | undefined
}

/** `turn/start` params: explicit environments EVERY turn (sticky; restores them after resume). */
export const turnStartParams = (
  threadId: string,
  turn: TurnInput,
  plan: ThreadPlan,
  options: TurnOptions,
): Record<string, unknown> => ({
  threadId,
  input: userInputOf(turn),
  environments: plan.environments,
  ...(options.model ? { model: options.model } : {}),
  ...(options.effort ? { effort: options.effort } : {}),
  summary: "auto",
})

/** `turn/steer` params (the precondition is the running native turn). */
export const turnSteerParams = (threadId: string, nativeTurnId: string, turn: TurnInput): Record<string, unknown> => ({
  threadId,
  expectedTurnId: nativeTurnId,
  input: userInputOf(turn),
})

/**
 * `skills/list` result → rules disabling every skill outside OpenBot's library and every library
 * skill the Bot does not have (`skills.config`; D5.5). `enabled` absent: the whole library stays on.
 */
export const skillRulesFor = (
  listResult: unknown,
  libraryRoot: string | undefined,
  enabled?: ReadonlyArray<string> | undefined,
): ReadonlyArray<{ readonly path: string; readonly enabled: boolean }> => {
  const library = libraryRoot?.replace(/\/+$/, "")
  const rules: Array<{ path: string; enabled: boolean }> = []
  const seen = new Set<string>()
  const data =
    typeof listResult === "object" && listResult !== null && "data" in listResult
      ? (listResult as { data: unknown }).data
      : undefined
  for (const entry of Array.isArray(data) ? data : []) {
    const skills =
      typeof entry === "object" && entry !== null && "skills" in entry ? (entry as { skills: unknown }).skills : []
    for (const skill of Array.isArray(skills) ? skills : []) {
      if (typeof skill !== "object" || skill === null) continue
      const path = (skill as { path?: unknown }).path
      if (typeof path !== "string" || path === "" || seen.has(path)) continue
      seen.add(path)
      if (library && (path === library || path.startsWith(`${library}/`))) {
        // `<library>/<name>/SKILL.md`: on only when the Bot has `<name>`
        const name = path.slice(library.length + 1).split("/")[0] ?? ""
        if (enabled === undefined || enabled.includes(name)) continue
      }
      rules.push({ path, enabled: false })
    }
  }
  return rules
}
