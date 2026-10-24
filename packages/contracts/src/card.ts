// Card union = the immutable content of a `card` transcript entry. Mutable state
// (pending/resolved/…) lives on the entry (`CardState`), mirroring Grok, which keeps
// respondedValue/widgetDismissed/formResolution on the send-message ENTRY (domain-contract.md §F.0.2).
// Ported from vendor/scratch/contracts/src/card.ts; connector cards are cut for v1.
import { Schema } from "effect"
import { AttachmentId, Millis, NodeId, RequestId, RoutineId, withUnknownFallback } from "./base.ts"
import { SuggestedRule } from "./policy.ts"
import { FormField, Question, RuntimeRequestKind, RuntimeResponse } from "./runtime-request.ts"
import { Attachment } from "./attachment.ts"

export const ApprovalCard = Schema.Struct({
  type: Schema.Literal("approval"),
  requestId: RequestId,
  /** Which approval kind (tool / command / file / mcp); drives the card's icon and detail view. */
  requestKind: Schema.optionalKey(RuntimeRequestKind),
  title: Schema.String,
  summary: Schema.optionalKey(Schema.String),
  toolName: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  diff: Schema.optionalKey(Schema.String),
  paths: Schema.optionalKey(Schema.Array(Schema.String)),
  nodeId: Schema.optionalKey(NodeId),
  nodeLabel: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  /** "Always allow" saves this rule (D5.6). */
  suggestedRule: Schema.optionalKey(SuggestedRule),
  /**
   * "Allow in ‹folder›": the folder outside the bot's workspace this request works in (its git repo
   * root, else its directory). Answering with `scope: "project-folder"` adds it to the bot's
   * project folders and allows.
   */
  projectFolder: Schema.optionalKey(Schema.String),
  /** Raised by the bot's background work of this title (D5.7): shown as the card's subtitle. */
  taskTitle: Schema.optionalKey(Schema.String),
})
export const QuestionCard = Schema.Struct({
  type: Schema.Literal("question"),
  /** Absent only for purely informational question cards (no answer expected). */
  requestId: Schema.optionalKey(RequestId),
  title: Schema.optionalKey(Schema.String),
  /** See `ApprovalCard.taskTitle`. */
  taskTitle: Schema.optionalKey(Schema.String),
  questions: Schema.Array(Question),
})
export const FormCard = Schema.Struct({
  type: Schema.Literal("form"),
  requestId: RequestId,
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
  fields: Schema.Array(FormField),
})
export const SecretRequestCard = Schema.Struct({
  type: Schema.Literal("secret-request"),
  requestId: RequestId,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  /** Where the value goes: an env var for the bot's sessions. */
  envVar: Schema.optionalKey(Schema.String),
})
/** Computer hand-off: the owner takes over the bot's browser/desktop, then hands back. */
export const HandoffCard = Schema.Struct({
  type: Schema.Literal("handoff"),
  requestId: RequestId,
  nodeId: NodeId,
  instruction: Schema.String,
  screenshotUrl: Schema.optionalKey(Schema.String),
})
/** Informational card posted when a bot creates or changes a routine. */
export const RoutineCard = Schema.Struct({
  type: Schema.Literal("routine"),
  action: Schema.Literals(["created", "updated"]),
  routineId: RoutineId,
  name: Schema.String,
  /** Human schedule, e.g. "Every Friday at 10:00 AM". */
  triggerSummary: Schema.String,
  prompt: Schema.optionalKey(Schema.String),
})

/**
 * A Slack message a Bot drafted (`slack_draft`, D3.4): the owner edits it and presses Send (it goes
 * out as them) or Discard. Pending until then; it never expires. When sent, `text` becomes what was
 * sent and the state's `link` opens the message in Slack.
 */
export const SlackDraftCard = Schema.Struct({
  type: Schema.Literal("slack-draft"),
  /** Workspace name. */
  team: Schema.String,
  channelId: Schema.String,
  /** Who it goes to: "#general", "Alice Smith", "Alice, Bob". */
  to: Schema.String,
  /** Reply in this thread (the parent message's `ts`). */
  threadTs: Schema.optionalKey(Schema.String),
  /** The start of the thread's first message. */
  threadLabel: Schema.optionalKey(Schema.String),
  text: Schema.String,
  /** Files the Bot attached (kept in OpenBot until sent; uploaded to Slack with the message). */
  files: Schema.optionalKey(Schema.Array(Attachment)),
})

// ---------------------------------------------------------------------------- generative UI (`show_ui`)
// Blocks are additive-only: an old client must still decode every block it knows, so only add
// optional fields or new block types.
export const UiTextBlock = Schema.Struct({ type: Schema.Literal("text"), markdown: Schema.String })
export const UiFieldsBlock = Schema.Struct({
  type: Schema.Literal("fields"),
  items: Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.String })),
})
export const UiTableBlock = Schema.Struct({
  type: Schema.Literal("table"),
  columns: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(Schema.String)),
})
/** Side-by-side option cards (stacked on a phone); `pick` is the id shown as "My pick". */
export const UiOptionsBlock = Schema.Struct({
  type: Schema.Literal("options"),
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      subtitle: Schema.optionalKey(Schema.String),
      lines: Schema.optionalKey(Schema.Array(Schema.String)),
      value: Schema.optionalKey(Schema.String),
      note: Schema.optionalKey(Schema.String),
      badge: Schema.optionalKey(Schema.String),
    }),
  ),
  pick: Schema.optionalKey(Schema.String),
})
export const UiTone = Schema.Literals(["good", "bad", "neutral"])
export type UiTone = typeof UiTone.Type
export const UiStatsBlock = Schema.Struct({
  type: Schema.Literal("stats"),
  items: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      value: Schema.String,
      delta: Schema.optionalKey(Schema.String),
      tone: Schema.optionalKey(UiTone),
    }),
  ),
})
export const UiChecklistStatus = Schema.Literals(["done", "active", "upcoming", "failed"])
export type UiChecklistStatus = typeof UiChecklistStatus.Type
export const UiChecklistBlock = Schema.Struct({
  type: Schema.Literal("checklist"),
  items: Schema.Array(
    Schema.Struct({ label: Schema.String, detail: Schema.optionalKey(Schema.String), status: UiChecklistStatus }),
  ),
})
export const UiTimelineBlock = Schema.Struct({
  type: Schema.Literal("timeline"),
  items: Schema.Array(
    Schema.Struct({
      time: Schema.String,
      title: Schema.String,
      detail: Schema.optionalKey(Schema.String),
      tag: Schema.optionalKey(Schema.String),
    }),
  ),
})
/** `x` is a category label ("Mon", "10:00"); `highlight` is one of the `x` values. */
export const UiChartBlock = Schema.Struct({
  type: Schema.Literal("chart"),
  kind: Schema.Literals(["bar", "line"]),
  unit: Schema.optionalKey(Schema.String),
  series: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      points: Schema.Array(Schema.Struct({ x: Schema.String, y: Schema.Number })),
    }),
  ),
  highlight: Schema.optionalKey(Schema.String),
})
/** Attachments only, never URLs (no remote images). */
export const UiImageBlock = Schema.Struct({
  type: Schema.Literal("image"),
  attachmentId: AttachmentId,
  alt: Schema.String,
})
/** https only; clients still open it through their URL guards. */
export const UiLinkBlock = Schema.Struct({ type: Schema.Literal("link"), label: Schema.String, url: Schema.String })
/** Its answer is the chosen option ids (at most one for `mode: "one"`). */
export const UiChoiceBlock = Schema.Struct({
  type: Schema.Literal("choice"),
  id: Schema.String,
  label: Schema.String,
  mode: Schema.Literals(["one", "many"]),
  options: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      detail: Schema.optionalKey(Schema.String),
      badge: Schema.optionalKey(Schema.String),
    }),
  ),
  default: Schema.optionalKey(Schema.Array(Schema.String)),
})
/** Its answer is the typed text. */
export const UiInputBlock = Schema.Struct({
  type: Schema.Literal("input"),
  id: Schema.String,
  label: Schema.String,
  placeholder: Schema.optionalKey(Schema.String),
  default: Schema.optionalKey(Schema.String),
  multiline: Schema.optionalKey(Schema.Boolean),
})

export const UiBlockMembers = [
  UiTextBlock,
  UiFieldsBlock,
  UiTableBlock,
  UiOptionsBlock,
  UiStatsBlock,
  UiChecklistBlock,
  UiTimelineBlock,
  UiChartBlock,
  UiImageBlock,
  UiLinkBlock,
  UiChoiceBlock,
  UiInputBlock,
] as const
const uiBlockFallback = withUnknownFallback({ members: UiBlockMembers, tag: "type", keep: {} })
/** Decodes unknown block types into `{ type: "unknown", originalTag }`, shown as "can't show this part". */
export const UiBlock = uiBlockFallback.schema
export type UiBlock = typeof UiBlock.Type
export type KnownUiBlock = (typeof UiBlockMembers)[number]["Type"]
export const KnownUiBlockTypes = uiBlockFallback.known

export const UiAction = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  style: Schema.optionalKey(Schema.Literals(["primary", "secondary", "danger"])),
})
export type UiAction = typeof UiAction.Type

const uiCardFields = {
  type: Schema.Literal("ui"),
  /** 1 today. A client shows `fallback` for a version it doesn't know. */
  version: Schema.Number,
  title: Schema.optionalKey(Schema.String),
  subtitle: Schema.optionalKey(Schema.String),
  /** Starts as a one-line summary (the fallback) that expands on tap. */
  collapsed: Schema.optionalKey(Schema.Boolean),
  actions: Schema.optionalKey(Schema.Array(UiAction)),
  /** Plain text read by search, notifications, previews, teammates, voice and old clients. */
  fallback: Schema.String,
}
/**
 * A card a Bot posted with `show_ui`. With actions it is pending until the owner presses one
 * (`cards.act`, one-shot, never expires); without, it is informational.
 */
export const UiCard = Schema.Struct({ ...uiCardFields, blocks: Schema.Array(UiBlock) })
export type UiCard = typeof UiCard.Type
/** What `show_ui` / `update_ui` may store: known block types only. */
export const UiCardInput = Schema.Struct({ ...uiCardFields, blocks: Schema.Array(Schema.Union(UiBlockMembers)) })
export type UiCardInput = typeof UiCardInput.Type

/** Answers to a card's `choice` (option ids) and `input` (text) blocks, by block id. */
export const UiValues = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)]))
export type UiValues = typeof UiValues.Type

export const UiAnswer = Schema.Struct({ actionId: Schema.String, values: UiValues, at: Millis })
export type UiAnswer = typeof UiAnswer.Type

export const CardMembers = [
  ApprovalCard,
  QuestionCard,
  FormCard,
  SecretRequestCard,
  HandoffCard,
  RoutineCard,
  SlackDraftCard,
  UiCard,
] as const
const fallback = withUnknownFallback({ members: CardMembers, tag: "type", keep: {} })
/** Decodes unknown card types into `{ type: "unknown", originalTag }` (decode-only). */
export const Card = fallback.schema
export type Card = typeof Card.Type
export type KnownCard = (typeof CardMembers)[number]["Type"]
export const KnownCardTypes = fallback.known

export const CardStatus = Schema.Literals(["pending", "resolved", "dismissed", "expired", "cancelled", "info"])
export type CardStatus = typeof CardStatus.Type

export const CardState = Schema.Struct({
  /** `info` = an informational card with nothing to answer (e.g. `routine`). */
  status: CardStatus,
  response: Schema.optionalKey(RuntimeResponse),
  /** e.g. "Saved securely and kept private", "Blocked by your rules". */
  detail: Schema.optionalKey(Schema.String),
  /** Where the result lives, e.g. a sent Slack message. */
  link: Schema.optionalKey(Schema.String),
  /** The action the owner pressed on a `ui` card (its status is then `resolved`). */
  answer: Schema.optionalKey(UiAnswer),
})
export type CardState = typeof CardState.Type
