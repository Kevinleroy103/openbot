/**
 * OpenCode approvals and questions ↔ OpenBot `HarnessRequest`s (domain-contract.md §F.8,
 * sdk-opencode.md §8.2).
 *
 * - `permission.asked` → tool/command/file/mcp approval → `permission.reply`:
 *   allow-once → `once`; allow-session → session allow rules for the request's `save` patterns,
 *   then `once`; allow-always → the same as allow-session natively (OpenBot owns the durable rule,
 *   D5.6; native `always` would persist a project-wide grant in the user's `opencode.db` that OpenBot
 *   can neither show nor revoke); deny → `reject` WITH a message (the tool fails, the model
 *   continues); cancel → `reject` WITHOUT a message (OpenCode stops the whole execution).
 * - `form.created` → question → `session.form.reply` (answers) or `session.form.cancel`.
 */
import type {
  ApprovalSurface,
  HarnessApprovalKind,
  HarnessApprovalRequest,
  HarnessDecisionSuggestion,
  HarnessQuestionRequest,
  HarnessRequestResolution,
  NodeId,
  Question,
} from "@openbot/contracts"
import { isAnswersResolution } from "@openbot/contracts"
import { parseOpenBotMcpTool } from "./config.ts"

type Rec = Readonly<Record<string, unknown>>
const rec = (u: unknown): Rec => (typeof u === "object" && u !== null && !Array.isArray(u) ? (u as Rec) : {})
const str = (u: unknown): string | undefined => (typeof u === "string" ? u : undefined)
const strings = (u: unknown): ReadonlyArray<string> =>
  Array.isArray(u) ? u.filter((x): x is string => typeof x === "string") : []

/** A native permission request (`permission.asked.data`), decoded tolerantly. */
export interface NativePermission {
  readonly id: string
  readonly sessionID: string
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly save: ReadonlyArray<string> | undefined
  readonly message: string | undefined
  readonly metadata: Rec
  /** The tool call it gates: `{messageID, id}`. */
  readonly tool: { readonly messageID: string | undefined; readonly id: string } | undefined
}

export const decodePermission = (data: unknown): NativePermission | undefined => {
  const d = rec(data)
  const id = str(d.id)
  const sessionID = str(d.sessionID)
  const action = str(d.action)
  if (!id || !sessionID || !action) return undefined
  const source = rec(d.source)
  const toolId = source.type === "tool" ? str(source.id) : undefined
  return {
    id,
    sessionID,
    action,
    resources: strings(d.resources),
    save: Array.isArray(d.save) ? strings(d.save) : undefined,
    message: str(d.message),
    metadata: rec(d.metadata),
    tool: toolId ? { messageID: str(source.messageID), id: toolId } : undefined,
  }
}

interface ApprovalShape {
  readonly kind: HarnessApprovalKind
  readonly surface: ApprovalSurface
}

const shapeOf = (action: string): ApprovalShape => {
  if (parseOpenBotMcpTool(action)) return { kind: "mcp-approval", surface: "mcp" }
  switch (action) {
    case "shell":
    case "bash":
      return { kind: "command-approval", surface: "shell" }
    case "edit":
    case "write":
      return { kind: "file-approval", surface: "file-edit" }
    case "read":
    case "glob":
    case "grep":
    case "list":
    case "external_directory":
      return { kind: "file-approval", surface: "file-read" }
    case "webfetch":
    case "websearch":
      return { kind: "tool-approval", surface: "network" }
    default:
      return { kind: "tool-approval", surface: "other" }
  }
}

const TITLES: Readonly<Record<string, string>> = {
  shell: "Run this command?",
  edit: "Apply these file changes?",
  write: "Write this file?",
  read: "Read this file?",
  external_directory: "Access files outside the workspace?",
  webfetch: "Fetch this URL?",
  websearch: "Search the web?",
}

export interface ToolContext {
  /** Native tool name of the gated call, when known. */
  readonly name: string | undefined
  /** Parsed input of the gated call, when known. */
  readonly input: unknown
  /** Normalizer key of the gated ToolCall item. */
  readonly key: string | undefined
}

/** `permission.asked` → `HarnessApprovalRequest`. */
export const permissionToRequest = (
  permission: NativePermission,
  tool: ToolContext,
  options: { readonly cwd?: string | undefined } = {},
): HarnessApprovalRequest => {
  const { action, resources } = permission
  const shape = shapeOf(action)
  const mcp = parseOpenBotMcpTool(action)
  const input = rec(tool.input)
  const files = Array.isArray(permission.metadata.files) ? permission.metadata.files.map(rec) : []
  const diff = files
    .map((f) => str(f.patch))
    .filter((p): p is string => p !== undefined && p.length > 0)
    .join("\n")
  const command =
    shape.kind === "command-approval"
      ? (str(input.command) ?? (resources.length > 0 ? resources.join(" && ") : undefined))
      : undefined
  const paths =
    shape.kind === "file-approval"
      ? files.length > 0
        ? files.map((f) => str(f.file)).filter((p): p is string => p !== undefined)
        : resources
      : undefined
  const toolName = mcp ? `openbot.${mcp.tool}` : (tool.name ?? action)
  const title = permission.message ?? (mcp ? `Allow the ${mcp.tool} tool?` : (TITLES[action] ?? `Allow ${action}?`))
  const detail = [
    command ?? (paths && paths.length > 0 ? paths.join("\n") : resources.join("\n")),
    str(input.description),
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n\n")
  const nodeId = mcp ? str(input.node) : undefined
  // "Always allow" is OpenBot's own option (ApprovalService adds it when a rule can be saved).
  const suggestions: Array<HarnessDecisionSuggestion> = [
    { decision: "allow-session", label: "Allow for this chat", native: { save: permission.save ?? ["*"] } },
  ]
  return {
    kind: mcp ? "mcp-approval" : shape.kind,
    toolName,
    title,
    detail,
    surface: mcp ? "mcp" : shape.surface,
    nativeRequestId: permission.id,
    ...(tool.key ? { toolKey: tool.key } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(command !== undefined && (str(input.workdir) ?? options.cwd)
      ? { cwd: (str(input.workdir) ?? options.cwd)! }
      : {}),
    ...(paths && paths.length > 0 ? { paths } : {}),
    ...(diff.length > 0 ? { diff } : {}),
    ...(mcp ? { server: mcp.server } : {}),
    ...(tool.input !== undefined ? { input: tool.input } : {}),
    ...(nodeId ? { nodeId: nodeId as NodeId } : {}),
    suggestions,
  }
}

export const DECLINED_MESSAGE =
  "The user declined this request. Do not retry it; continue without it or ask the user how to proceed."

/**
 * The native reply for a resolution. `grant` = add session allow rules first ("allow for this
 * chat"). OpenBot never replies `always` (see the module header).
 */
export interface PermissionReplyPlan {
  readonly decision: "once" | "reject"
  readonly message?: string | undefined
  readonly grant: boolean
}

export const permissionReply = (resolution: HarnessRequestResolution): PermissionReplyPlan => {
  if (isAnswersResolution(resolution)) return { decision: "reject", message: DECLINED_MESSAGE, grant: false }
  switch (resolution.decision) {
    case "allow-once":
      return { decision: "once", grant: false }
    case "allow-session":
    case "allow-always":
      return { decision: "once", grant: true }
    case "deny":
      return { decision: "reject", message: resolution.message?.trim() || DECLINED_MESSAGE, grant: false }
    case "cancel":
      // A reject without a message is OpenCode's "stop": it ends the whole execution.
      return { decision: "reject", grant: false }
  }
}

// ---------------------------------------------------------------------------- forms

export interface NativeFormField {
  readonly key: string
  readonly type: string
  readonly title: string | undefined
  readonly description: string | undefined
  readonly options: ReadonlyArray<{
    readonly value: string
    readonly label: string
    readonly description: string | undefined
  }>
  readonly custom: boolean
}

export interface NativeForm {
  readonly id: string
  readonly sessionID: string
  readonly title: string | undefined
  readonly isQuestion: boolean
  readonly tool: { readonly messageID: string | undefined; readonly id: string } | undefined
  readonly fields: ReadonlyArray<NativeFormField>
}

export const decodeForm = (data: unknown): NativeForm | undefined => {
  const form = rec(rec(data).form)
  const id = str(form.id)
  const sessionID = str(form.sessionID)
  if (!id || !sessionID) return undefined
  const metadata = rec(form.metadata)
  const tool = rec(metadata.tool)
  const fields: Array<NativeFormField> = (Array.isArray(form.fields) ? form.fields : [])
    .map(rec)
    .filter((f) => str(f.key) !== undefined && f.type !== "external" && f.hidden !== true)
    .map((f) => ({
      key: str(f.key)!,
      type: str(f.type) ?? "string",
      title: str(f.title),
      description: str(f.description),
      options: (Array.isArray(f.options) ? f.options : []).map(rec).map((o) => ({
        value: str(o.value) ?? String(o.value ?? ""),
        label: str(o.label) ?? str(o.value) ?? String(o.value ?? ""),
        description: str(o.description),
      })),
      custom: f.custom === true,
    }))
  return {
    id,
    sessionID,
    title: str(form.title),
    isQuestion: metadata.kind === "question",
    tool: str(tool.id) ? { messageID: str(tool.messageID), id: str(tool.id)! } : undefined,
    fields,
  }
}

/** `form.created` → question request (every OpenCode form is rendered as questions). */
export const formToRequest = (form: NativeForm, toolKey: string | undefined): HarnessQuestionRequest => ({
  kind: "question",
  ...(form.title ? { title: form.title } : {}),
  ...(toolKey ? { toolKey } : {}),
  nativeRequestId: form.id,
  questions: form.fields.map((field): Question => ({
    id: field.key,
    ...(field.title ? { header: field.title } : {}),
    prompt: field.description ?? field.title ?? field.key,
    options:
      field.type === "boolean" && field.options.length === 0
        ? [{ label: "Yes" }, { label: "No" }]
        : field.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
    multiSelect: field.type === "multiselect",
    // Text/number fields and `custom: true` choice fields accept free text.
    allowFreeText: field.custom || (field.options.length === 0 && field.type !== "boolean"),
  })),
})

export type FormAnswerValue = string | number | boolean | ReadonlyArray<string>

/** Maps OpenBot answers (option labels or free text) to native form values. */
export const formAnswer = (
  form: NativeForm,
  answers: Readonly<Record<string, string | ReadonlyArray<string>>>,
): Record<string, FormAnswerValue> => {
  const out: Record<string, FormAnswerValue> = {}
  for (const field of form.fields) {
    const raw = answers[field.key]
    if (raw === undefined) continue
    const list = typeof raw === "string" ? [raw] : [...raw]
    const toValue = (answer: string) =>
      field.options.find((o) => o.label === answer || o.value === answer)?.value ?? answer
    switch (field.type) {
      case "multiselect":
        out[field.key] = list.map(toValue)
        break
      case "number":
      case "integer": {
        const n = Number(list[0])
        if (Number.isFinite(n)) out[field.key] = field.type === "integer" ? Math.round(n) : n
        break
      }
      case "boolean":
        out[field.key] = /^(y|yes|true|1|on)$/i.test((list[0] ?? "").trim())
        break
      default:
        out[field.key] = list.map(toValue).join(", ")
    }
  }
  return out
}
