// RuntimeRequest = anything that blocks on (or waits for) the owner: native harness approvals and
// questions (Claude canUseTool/AskUserQuestion, Codex server requests, OpenCode permission.asked /
// form.created) and OpenBot's own async `ask_user` / `request_approval` tools (D3.3), forms,
// secrets and computer hand-off. Answered by one RPC, `requests.respond` (D4.1).
// Ported from vendor/scratch/contracts/src/runtime-request.ts.
import { Schema } from "effect"
import {
  Author,
  BotId,
  ConversationId,
  EntryId,
  HarnessKindName,
  Millis,
  NodeId,
  NonEmptyString,
  RequestId,
  TaskId,
  TurnId,
} from "./base.ts"
import { SuggestedRule } from "./policy.ts"

/** Harness-neutral decisions. Adapters map them to native values (domain-contract.md §F.8). */
export const DecisionId = Schema.Literals(["allow-once", "allow-session", "allow-always", "deny", "cancel"])
export type DecisionId = typeof DecisionId.Type

export const DecisionOption = Schema.Struct({
  id: DecisionId,
  label: Schema.optionalKey(Schema.String),
  /** Adapter-private native payload to send back verbatim (e.g. Codex acceptWithExecpolicyAmendment). */
  native: Schema.optionalKey(Schema.Unknown),
})
export type DecisionOption = typeof DecisionOption.Type

export const QuestionOption = Schema.Struct({ label: Schema.String, description: Schema.optionalKey(Schema.String) })
export type QuestionOption = typeof QuestionOption.Type
export const Question = Schema.Struct({
  id: NonEmptyString,
  header: Schema.optionalKey(Schema.String),
  prompt: Schema.String,
  options: Schema.Array(QuestionOption),
  multiSelect: Schema.Boolean,
  allowFreeText: Schema.Boolean,
  isSecret: Schema.optionalKey(Schema.Boolean),
})
export type Question = typeof Question.Type

export const FormField = Schema.Struct({
  key: NonEmptyString,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  type: Schema.Literals(["string", "text", "number", "boolean", "date", "select", "multiselect", "secret"]),
  required: Schema.Boolean,
  options: Schema.optionalKey(Schema.Array(QuestionOption)),
})
export type FormField = typeof FormField.Type

export const HandoffAction = Schema.Literals(["done", "take-over", "skip"])
export type HandoffAction = typeof HandoffAction.Type

/** What the UI may send back. Drives which buttons/inputs a card renders. */
export const ResponseCapability = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("decision"),
    options: Schema.Array(DecisionOption),
    allowMessage: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("answers"), questions: Schema.Array(Question) }),
  Schema.Struct({ type: Schema.Literal("form"), fields: Schema.Array(FormField) }),
  Schema.Struct({ type: Schema.Literal("secret"), label: Schema.String, envVar: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("acknowledge"), actions: Schema.Array(HandoffAction) }),
])
export type ResponseCapability = typeof ResponseCapability.Type

export const RuntimeRequestKind = Schema.Literals([
  "tool-approval", // generic tool (Claude canUseTool, OpenCode non-shell/edit permission, Codex permissions)
  "command-approval", // shell command (Codex commandExecution, OpenCode shell, Claude Bash)
  "file-approval", // edits with a diff (Codex fileChange, OpenCode edit, Claude Write/Edit)
  "mcp-approval", // MCP tool call (Codex mcpServer/elicitation approval, OpenBot request_approval)
  "question", // multiple-choice questions (Claude AskUserQuestion, Codex requestUserInput, OpenCode question form, ask_user)
  "form", // structured form (MCP elicitation form, OpenCode generic form)
  "secret", // secret value (Codex isSecret question, OpenBot secret request)
  "handoff", // the owner takes over the bot's computer, then hands back
])
export type RuntimeRequestKind = typeof RuntimeRequestKind.Type

/** `statusReason` of a question the owner answered by writing in the chat instead of on the card. */
export const ANSWERED_IN_CHAT = "answered-in-chat"

export const RuntimeRequestStatus = Schema.Literals(["pending", "resolved", "expired", "cancelled"])
export type RuntimeRequestStatus = typeof RuntimeRequestStatus.Type

/** Stored/streamed response. Secrets are never echoed: only `provided: true`. */
export const RuntimeResponse = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("decision"),
    decision: DecisionId,
    message: Schema.optionalKey(Schema.String),
    /** Edit-before-approve (Claude canUseTool `updatedInput`). */
    updatedInput: Schema.optionalKey(Schema.Unknown),
    /**
     * "Allow in ‹folder›" (with `decision: "allow-once"`): also add the request's `projectFolder` to
     * the bot's project folders, so work there no longer asks under autonomy "workspace".
     */
    scope: Schema.optionalKey(Schema.Literal("project-folder")),
  }),
  Schema.Struct({
    type: Schema.Literal("answers"),
    answers: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  }),
  Schema.Struct({ type: Schema.Literal("form"), values: Schema.Record(Schema.String, Schema.Unknown) }),
  Schema.Struct({ type: Schema.Literal("secret"), provided: Schema.Literal(true) }),
  Schema.Struct({ type: Schema.Literal("acknowledge"), action: HandoffAction }),
  Schema.Struct({ type: Schema.Literal("dismiss"), reason: Schema.optionalKey(Schema.String) }),
])
export type RuntimeResponse = typeof RuntimeResponse.Type

/** Client -> server. Same as RuntimeResponse but a secret carries its value (never persisted or streamed). */
export const RuntimeResponseInput = Schema.Union([
  ...RuntimeResponse.members.filter((m) => m.fields.type.literal !== "secret"),
  Schema.Struct({ type: Schema.Literal("secret"), value: Schema.String }),
])
export type RuntimeResponseInput = typeof RuntimeResponseInput.Type

export const RuntimeRequestSubject = Schema.Struct({
  toolName: Schema.optionalKey(Schema.String),
  toolCallEntryId: Schema.optionalKey(EntryId),
  command: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  paths: Schema.optionalKey(Schema.Array(Schema.String)),
  diff: Schema.optionalKey(Schema.String),
  server: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.Unknown),
  nodeId: Schema.optionalKey(NodeId),
  reason: Schema.optionalKey(Schema.String),
})
export type RuntimeRequestSubject = typeof RuntimeRequestSubject.Type

/** `openbot` for OpenBot's own tools; otherwise the harness kind (claude | codex | opencode | fake). */
export const RuntimeRequestOrigin = HarnessKindName
export type RuntimeRequestOrigin = HarnessKindName

export const RuntimeRequest = Schema.Struct({
  id: RequestId,
  conversationId: ConversationId,
  botId: BotId,
  turnId: Schema.optionalKey(TurnId),
  /** Raised by one of the bot's background tasks (D5.7): routed back to that task's session. */
  taskId: Schema.optionalKey(TaskId),
  /** The `card` transcript entry that renders this request. */
  cardEntryId: EntryId,
  kind: RuntimeRequestKind,
  status: RuntimeRequestStatus,
  /** Why it left `pending` without an answer: "timeout", "not_resumable" (brain restart), "turn-ended", … */
  statusReason: Schema.optionalKey(Schema.String),
  title: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  subject: RuntimeRequestSubject,
  responseCapability: ResponseCapability,
  /** Rule the UI may save on "Always allow" / an expired card's "Always allow next time". */
  suggestedRule: Schema.optionalKey(SuggestedRule),
  /** Folder offered by "Allow in ‹folder›" (see `ApprovalCard.projectFolder`). */
  projectFolder: Schema.optionalKey(Schema.String),
  source: Schema.Struct({ origin: RuntimeRequestOrigin, method: Schema.String, nativeRequestId: Schema.String }),
  /** true = the harness turn is paused on it; false = async OpenBot tool (D3.3), answered as a new message. */
  blocking: Schema.Boolean,
  createdAt: Millis,
  expiresAt: Schema.optionalKey(Millis),
  resolvedAt: Schema.optionalKey(Millis),
  response: Schema.optionalKey(RuntimeResponse),
  resolvedBy: Schema.optionalKey(Author),
})
export type RuntimeRequest = typeof RuntimeRequest.Type

/** Unattended requests expire after this long by default (D5.6; overridable in Settings). */
export const DEFAULT_APPROVAL_EXPIRY_MINUTES = 10
