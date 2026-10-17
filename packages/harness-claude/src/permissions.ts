/**
 * `canUseTool` ⇄ OpenBot runtime requests (architecture §3.1, §5.2; domain-contract.md §F.8;
 * sdk-claude.md §10.3-10.4).
 *
 * - Ordinary tools → `HarnessApprovalRequest` (`command-` / `file-` / `mcp-` / `tool-approval`).
 * - `AskUserQuestion` → `HarnessQuestionRequest`; answers return through `updatedInput.answers`
 *   keyed by question text.
 *
 * Decision mapping (§F.8):
 * | resolution     | PermissionResult                                                             |
 * |----------------|------------------------------------------------------------------------------|
 * | allow-once     | allow + `updatedInput` (always echoed)                                       |
 * | allow-session  | allow + `updatedPermissions` = suggestions rewritten to `destination:session` |
 * | allow-always   | same as allow-session natively; the durable rule is OpenBot's (ApprovalService) |
 * | deny           | deny + message                                                               |
 * | cancel         | deny + `interrupt: true`                                                     |
 * | answers        | allow + `updatedInput {questions, answers}`                                  |
 *
 * The CLI is never allowed to write `.claude/settings.local.json` into the workspace: every
 * permission update is rewritten to the `session` destination.
 */
import type {
  HarnessApprovalKind,
  HarnessApprovalRequest,
  HarnessDecisionSuggestion,
  HarnessQuestionRequest,
  HarnessRequest,
  HarnessRequestResolution,
  Question,
} from "@openbot/contracts"
import { isAnswersResolution } from "@openbot/contracts"
import { classifyTool, oneLine } from "./tools.ts"

/** The subset of `canUseTool`'s third argument OpenBot reads (SDK-free). */
export interface CanUseToolOptions {
  readonly signal?: AbortSignal | undefined
  readonly suggestions?: ReadonlyArray<unknown> | undefined
  readonly blockedPath?: string | undefined
  readonly decisionReason?: string | undefined
  readonly title?: string | undefined
  readonly displayName?: string | undefined
  readonly description?: string | undefined
  readonly suppressAlwaysAllowRule?: boolean | undefined
  readonly toolUseID: string
  readonly agentID?: string | undefined
  readonly requestId?: string | undefined
  readonly mcpServer?: { readonly name: string; readonly source: string } | undefined
}

/** SDK `PermissionResult`, structurally. */
export type ClaudePermissionResult =
  | {
    readonly behavior: "allow"
    readonly updatedInput: Record<string, unknown>
    readonly updatedPermissions?: ReadonlyArray<Record<string, unknown>>
    readonly toolUseID?: string
    readonly decisionClassification?: "user_temporary" | "user_permanent"
  }
  | {
    readonly behavior: "deny"
    readonly message: string
    readonly interrupt?: boolean
    readonly toolUseID?: string
    readonly decisionClassification?: "user_reject"
  }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const ASK_USER_QUESTION = "AskUserQuestion"

interface NativeQuestion {
  readonly question: string
  readonly header?: string
  readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>
  readonly multiSelect: boolean
}

const nativeQuestions = (input: Record<string, unknown>): ReadonlyArray<NativeQuestion> => {
  const raw = Array.isArray(input.questions) ? input.questions : []
  return raw.flatMap((entry): ReadonlyArray<NativeQuestion> => {
    if (!isRecord(entry) || typeof entry.question !== "string") return []
    const options = Array.isArray(entry.options)
      ? entry.options.flatMap((option) =>
        isRecord(option) && typeof option.label === "string"
          ? [{ label: option.label, ...(typeof option.description === "string" ? { description: option.description } : {}) }]
          : []
      )
      : []
    return [{
      question: entry.question,
      ...(typeof entry.header === "string" ? { header: entry.header } : {}),
      options,
      multiSelect: entry.multiSelect === true,
    }]
  })
}

/** Stable question ids: `q0`, `q1`, … (answers come back keyed by these ids). */
export const questionId = (index: number): string => `q${index}`

const approvalKind = (kind: string): HarnessApprovalKind => {
  switch (kind) {
    case "shell":
      return "command-approval"
    case "file-edit":
    case "file-write":
      return "file-approval"
    case "mcp":
    case "browser":
    case "computer":
      return "mcp-approval"
    default:
      return "tool-approval"
  }
}

const inputDetail = (input: Record<string, unknown>): string => {
  try {
    const json = JSON.stringify(input, null, 2)
    return json.length > 2000 ? `${json.slice(0, 1999)}…` : json
  } catch {
    return ""
  }
}

/** Maps a `canUseTool` call to the request OpenBot's ApprovalService evaluates. */
export const toHarnessRequest = (
  toolName: string,
  input: Record<string, unknown>,
  options: CanUseToolOptions,
  cwd?: string,
): HarnessRequest => {
  const common = {
    toolKey: options.toolUseID,
    ...(options.requestId ? { nativeRequestId: options.requestId } : {}),
  }
  if (toolName === ASK_USER_QUESTION) {
    const questions: Array<Question> = nativeQuestions(input).map((q, index) => ({
      id: questionId(index),
      ...(q.header ? { header: q.header } : {}),
      prompt: q.question,
      options: q.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
      multiSelect: q.multiSelect,
      allowFreeText: true,
    }))
    const request: HarnessQuestionRequest = {
      kind: "question",
      ...(questions[0]?.header ? { title: questions[0].header } : {}),
      ...common,
      questions,
    }
    return request
  }
  const tool = classifyTool(toolName, input)
  const label = options.displayName ?? tool.title
  const title = options.title ?? `Claude wants to use ${label}`
  const detail = options.description ?? options.decisionReason ??
    (tool.command ?? (tool.inputSummary.length > 0 ? tool.inputSummary : inputDetail(input)))
  const suggestions: Array<HarnessDecisionSuggestion> = options.suppressAlwaysAllowRule === true
    ? []
    : [
      { decision: "allow-session", label: "Allow for this conversation", native: options.suggestions ?? [] },
      { decision: "allow-always", label: "Always allow", native: options.suggestions ?? [] },
    ]
  const paths = tool.paths ?? (options.blockedPath ? [options.blockedPath] : undefined)
  const request: HarnessApprovalRequest = {
    kind: approvalKind(tool.kind),
    toolName,
    title: oneLine(title, 200),
    detail,
    surface: tool.surface,
    ...common,
    ...(tool.command !== undefined ? { command: tool.command } : {}),
    ...(cwd !== undefined && tool.kind === "shell" ? { cwd } : {}),
    ...(paths ? { paths } : {}),
    ...(tool.mcp ? { server: tool.mcp.server } : {}),
    input,
    ...(tool.nodeId ? { nodeId: tool.nodeId } : {}),
    ...(suggestions.length > 0 ? { suggestions } : {}),
  }
  return request
}

/** Rewrites CLI permission suggestions to the `session` destination (t3code `toSessionPermissionUpdates`). */
export const toSessionPermissionUpdates = (
  toolName: string,
  suggestions: unknown,
): ReadonlyArray<Record<string, unknown>> => {
  const list = Array.isArray(suggestions) ? suggestions.filter(isRecord) : []
  const updates = list
    .filter((s) => s.type !== "setMode") // never let a tool approval change the permission mode
    .map((s) => ({ ...s, destination: "session" }))
  return updates.length > 0 ? updates : [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" }]
}

const answerText = (value: string | ReadonlyArray<string>): string =>
  typeof value === "string" ? value : value.join(", ")

/** Maps OpenBot's resolution to the native `canUseTool` result (domain-contract §F.8). */
export const toPermissionResult = (
  toolName: string,
  input: Record<string, unknown>,
  options: CanUseToolOptions,
  resolution: HarnessRequestResolution,
): ClaudePermissionResult => {
  const toolUseID = options.toolUseID
  if (isAnswersResolution(resolution)) {
    if (toolName !== ASK_USER_QUESTION) {
      return { behavior: "allow", updatedInput: input, toolUseID, decisionClassification: "user_temporary" }
    }
    const questions = nativeQuestions(input)
    const answers: Record<string, string> = {}
    questions.forEach((q, index) => {
      const value = resolution.answers[questionId(index)] ?? resolution.answers[q.question]
      if (value !== undefined) answers[q.question] = answerText(value)
    })
    return {
      behavior: "allow",
      updatedInput: { ...input, questions: input.questions, answers },
      toolUseID,
      decisionClassification: "user_temporary",
    }
  }
  const updatedInput = isRecord(resolution.updatedInput) ? resolution.updatedInput : input
  switch (resolution.decision) {
    case "allow-once":
      return { behavior: "allow", updatedInput, toolUseID, decisionClassification: "user_temporary" }
    case "allow-session":
    case "allow-always": {
      const native = Array.isArray(resolution.native) ? resolution.native : options.suggestions
      return {
        behavior: "allow",
        updatedInput,
        updatedPermissions: toSessionPermissionUpdates(toolName, native),
        toolUseID,
        decisionClassification: resolution.decision === "allow-always" ? "user_permanent" : "user_temporary",
      }
    }
    case "cancel":
      return {
        behavior: "deny",
        message: resolution.message ?? "The user cancelled this action. Stop and wait for further instructions.",
        interrupt: true,
        toolUseID,
        decisionClassification: "user_reject",
      }
    case "deny":
    default:
      return {
        behavior: "deny",
        message: resolution.message ??
          (toolName === ASK_USER_QUESTION ? "The user dismissed the question." : "The user denied this action."),
        toolUseID,
        decisionClassification: "user_reject",
      }
  }
}
