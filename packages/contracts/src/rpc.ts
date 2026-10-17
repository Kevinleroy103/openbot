// The client <-> brain RpcGroup `OpenBotRpcs` (architecture §4.1.1; Effect RPC over WebSocket at
// `/rpc`, `RpcSerialization.layerJson`). Names are dotted like t3code (`conversations.subscribe`).
// Ported from vendor/scratch/contracts/src/rpc.ts; v1 cut: connectors.*, messages.feedback,
// bots.setAvatarImage, conversations.thread/outline, routines.webhookCredential (and the seed's
// bots.list/search, conversations.reset, skills.import, host.status, replaced by roster / bots.newSession /
// harnesses.status).
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import {
  ApprovalRuleId,
  AttachmentId,
  BotId,
  ConversationId,
  EntryId,
  HarnessKindName,
  Millis,
  NodeId,
  NonEmptyString,
  NonNegativeInt,
  RequestId,
  RoutineId,
  SectionId,
  TaskId,
  TurnId,
  Usage,
} from "./base.ts"
import { Bot, BotAvatar, BotHarness, BotNotify, Conversation, NodeSummary, PairingCode, Routine, RoutineOutput, RoutineRun, RoutineTriggerInput, Section } from "./domain.ts"
import { HarnessProfile, HarnessProfileCandidate, HarnessStatus, ModelInfo } from "./harness.ts"
import { BotMemory, MemoryFact, MemoryFactId, MemoryFactInput } from "./memory.ts"
import { ApprovalRule, ApprovalRuleInput, BotAutonomy, ProjectFolders } from "./policy.ts"
import { RuntimeRequest, RuntimeResponseInput } from "./runtime-request.ts"
import { Settings, SettingsPatch } from "./settings.ts"
import { Skill, SkillInput, SkillName } from "./skills.ts"
import { ConversationStreamItem, RosterStreamItem, StreamCursor, TranscriptPage } from "./stream.ts"
import { Task, TaskDetail } from "./task.ts"
import { Attachment, MessageDelivery, Turn } from "./transcript.ts"

// ---------------------------------------------------------------------------- errors (architecture §6)
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { entity: Schema.String, id: Schema.String }) {}
export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", { message: Schema.String }) {}
export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", { reason: Schema.String }) {}
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", { reason: Schema.String }) {}
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", { reason: Schema.String }) {}
export class HarnessUnavailable extends Schema.TaggedError<HarnessUnavailable>()("HarnessUnavailable", { harness: HarnessKindName, message: Schema.String }) {}
export class RequestNotPending extends Schema.TaggedError<RequestNotPending>()("RequestNotPending", { requestId: RequestId, status: Schema.String }) {}
export class NodeUnavailable extends Schema.TaggedError<NodeUnavailable>()("NodeUnavailable", { nodeId: NodeId, message: Schema.String }) {}
/** A defect or repository failure, logged with its cause on the brain; the message is safe to show. */
export class Internal extends Schema.TaggedError<Internal>()("Internal", { message: Schema.String }) {}

/** Every RPC may fail with `Internal` (defects are mapped at the edge, never thrown). */
const errors = <const E extends ReadonlyArray<Schema.Top>>(...members: E) => Schema.Union([...members, Internal])
const Missing = errors(NotFound)
const Common = errors(NotFound, InvalidInput, Conflict)

// ---------------------------------------------------------------------------- payload/result types
export const SessionInfo = Schema.Struct({
  ownerName: Schema.String,
  /** Brain version (package version). */
  version: Schema.String,
  dataDir: Schema.String,
  /** True until the first bot is created (drives onboarding). */
  firstRun: Schema.Boolean,
})
export type SessionInfo = typeof SessionInfo.Type

export const BotCreateInput = Schema.Struct({
  name: NonEmptyString.check(Schema.isMaxLength(64)),
  label: Schema.optionalKey(Schema.String),
  /** Absent = deterministic default from the bot id (D6.3). */
  avatar: Schema.optionalKey(BotAvatar),
  harness: BotHarness,
  /** Absent = `LOCAL_NODE_ID`. */
  hostNodeId: Schema.optionalKey(NodeId),
  instructions: Schema.optionalKey(Schema.String),
  /** Absent = Settings' `defaultAutonomy` ("workspace" unless changed). */
  autonomy: Schema.optionalKey(BotAutonomy),
  /** Idempotency key: a retried create with the same nonce returns the same bot. */
  clientNonce: NonEmptyString,
  /** Absent/true = the new Bot greets the owner and asks what they need first (its hidden first turn). */
  introduce: Schema.optionalKey(Schema.Boolean),
})
export type BotCreateInput = typeof BotCreateInput.Type

/** `null` clears an optional field. */
export const BotPatch = Schema.Struct({
  name: Schema.optionalKey(NonEmptyString.check(Schema.isMaxLength(64))),
  label: Schema.optionalKey(Schema.NullOr(Schema.String)),
  avatar: Schema.optionalKey(BotAvatar),
  harness: Schema.optionalKey(BotHarness),
  hostNodeId: Schema.optionalKey(NodeId),
  boundNodeIds: Schema.optionalKey(Schema.Array(NodeId)),
  instructions: Schema.optionalKey(Schema.String),
  sectionId: Schema.optionalKey(Schema.NullOr(SectionId)),
  pinned: Schema.optionalKey(Schema.Boolean),
  hidden: Schema.optionalKey(Schema.Boolean),
  notify: Schema.optionalKey(BotNotify),
  autonomy: Schema.optionalKey(BotAutonomy),
  /** Replaces the bot's project folders (owner-only; normalized and validated by BotService). */
  projectFolders: Schema.optionalKey(ProjectFolders),
})
export type BotPatch = typeof BotPatch.Type

export const BotContext = Schema.Struct({
  /** The fully rendered instructions the harness receives (persona + team + memory index + placement). */
  instructions: Schema.String,
  memory: BotMemory,
})
export type BotContext = typeof BotContext.Type

export const SendMode = Schema.Literals(["auto", "queue", "steer"])
export type SendMode = typeof SendMode.Type
export const SendInput = Schema.Struct({
  conversationId: ConversationId,
  text: Schema.String,
  attachmentIds: Schema.optionalKey(Schema.Array(AttachmentId)),
  replyToId: Schema.optionalKey(EntryId),
  /** Group chats: explicitly addressed bots (@mentions). */
  addressedBotIds: Schema.optionalKey(Schema.Array(BotId)),
  /** Group chats: `@everyone`. */
  addressEveryone: Schema.optionalKey(Schema.Boolean),
  clientNonce: NonEmptyString,
  /** auto (default): steer when the harness supports it and a turn is running, else queue. */
  mode: Schema.optionalKey(SendMode),
})
export type SendInput = typeof SendInput.Type

export const SendResult = Schema.Struct({
  entryId: EntryId,
  /** Turns started or queued by this send (one per targeted bot in a group). */
  turnIds: Schema.Array(TurnId),
  /** Started a turn, queued behind the active one, steered into it, or replayed (same clientNonce). */
  disposition: Schema.Literals(["started", "queued", "steered", "duplicate"]),
})
export type SendResult = typeof SendResult.Type

export const SendLookup = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("found"), entryId: EntryId, delivery: MessageDelivery }),
  Schema.Struct({ outcome: Schema.Literal("not-found") }),
])
export type SendLookup = typeof SendLookup.Type

export const RoutineSpec = Schema.Struct({
  name: NonEmptyString,
  prompt: Schema.String,
  trigger: RoutineTriggerInput,
  enabled: Schema.Boolean,
  output: RoutineOutput,
})
export type RoutineSpec = typeof RoutineSpec.Type

export const ComputerState = Schema.Literals(["absent", "starting", "ready", "error", "unsupported"])
export type ComputerState = typeof ComputerState.Type
export const ComputerStatus = Schema.Struct({
  botId: BotId,
  /** The bot's host node, where its browser/desktop runs. */
  nodeId: NodeId,
  state: ComputerState,
  /** Which live view the node offers (D1.7). */
  surface: Schema.Literals(["browser", "desktop", "none"]),
  /** Who holds the control lease (D1.7 takeover). */
  controller: Schema.Literals(["bot", "user"]),
  /** Path of the viewer socket, e.g. `/ws/computer/<botId>`. */
  viewPath: Schema.optionalKey(Schema.String),
  /** Human message for `error`/`unsupported` ("Can't reach Scout's screen"). */
  message: Schema.optionalKey(Schema.String),
})
export type ComputerStatus = typeof ComputerStatus.Type

export const BotUsage = Schema.Struct({
  botId: BotId,
  usage: Usage,
  turnCount: NonNegativeInt,
  lastAt: Schema.optionalKey(Millis),
})
export type BotUsage = typeof BotUsage.Type

// ---------------------------------------------------------------------------- RPCs
/** Standalone definitions so tests and sub-groups can reuse them. */
export const ConversationsSubscribe = Rpc.make("conversations.subscribe", {
  payload: { conversationId: ConversationId, after: Schema.optionalKey(StreamCursor), tailLimit: Schema.optionalKey(NonNegativeInt) },
  success: ConversationStreamItem,
  error: Missing,
  stream: true,
})
export const RosterSubscribe = Rpc.make("roster.subscribe", {
  payload: { after: Schema.optionalKey(StreamCursor) },
  success: RosterStreamItem,
  error: errors(),
  stream: true,
})
/** One endpoint for every RuntimeRequest kind (approvals, questions, forms, secrets, hand-off). */
export const RequestsRespond = Rpc.make("requests.respond", {
  payload: { requestId: RequestId, response: RuntimeResponseInput },
  success: RuntimeRequest,
  error: errors(NotFound, RequestNotPending, InvalidInput),
})

export class OpenBotRpcs extends RpcGroup.make(
  // session
  Rpc.make("session.info", { success: SessionInfo, error: errors() }),

  // roster
  RosterSubscribe,

  // bots
  Rpc.make("bots.create", { payload: BotCreateInput, success: Bot, error: errors(NotFound, InvalidInput, Conflict, HarnessUnavailable) }),
  Rpc.make("bots.update", { payload: { botId: BotId, patch: BotPatch }, success: Bot, error: Common }),
  Rpc.make("bots.delete", { payload: { botId: BotId }, error: Missing }),
  Rpc.make("bots.get", { payload: { botId: BotId }, success: Bot, error: Missing }),
  Rpc.make("bots.readContext", { payload: { botId: BotId }, success: BotContext, error: Missing }),
  /** Drop the native session; the conversation stays (D0.4 "New session"). */
  Rpc.make("bots.newSession", { payload: { botId: BotId }, error: errors(NotFound, Conflict) }),
  Rpc.make("bots.compact", { payload: { botId: BotId }, error: errors(NotFound, Conflict, HarnessUnavailable) }),

  // sections (a bot's section is set with bots.update {patch: {sectionId}})
  Rpc.make("sections.list", { success: Schema.Array(Section), error: errors() }),
  Rpc.make("sections.create", { payload: { name: NonEmptyString }, success: Section, error: errors(InvalidInput) }),
  Rpc.make("sections.rename", { payload: { sectionId: SectionId, name: NonEmptyString }, success: Section, error: errors(NotFound, InvalidInput) }),
  /** Bots in the section move to Unassigned. */
  Rpc.make("sections.delete", { payload: { sectionId: SectionId }, error: Missing }),
  /** Full desired order; returns the sections with their new `order`. */
  Rpc.make("sections.reorder", { payload: { sectionIds: Schema.Array(SectionId) }, success: Schema.Array(Section), error: Common }),

  // conversations
  ConversationsSubscribe,
  Rpc.make("conversations.history", {
    payload: { conversationId: ConversationId, beforeCursor: Schema.String, limit: NonNegativeInt },
    success: TranscriptPage,
    error: errors(NotFound, InvalidInput),
  }),
  Rpc.make("conversations.createGroup", {
    payload: { title: Schema.String, memberBotIds: Schema.Array(BotId), leadBotId: Schema.optionalKey(BotId), clientNonce: Schema.optionalKey(NonEmptyString) },
    success: Conversation,
    error: Common,
  }),
  Rpc.make("conversations.setMembers", {
    payload: { conversationId: ConversationId, memberBotIds: Schema.Array(BotId), leadBotId: Schema.optionalKey(Schema.NullOr(BotId)) },
    success: Conversation,
    error: Common,
  }),
  Rpc.make("conversations.rename", { payload: { conversationId: ConversationId, title: Schema.String }, success: Conversation, error: errors(NotFound, InvalidInput) }),
  /** `unread: true` = "Mark as Unread"; `at` moves the unread boundary. */
  Rpc.make("conversations.markRead", { payload: { conversationId: ConversationId, unread: Schema.optionalKey(Schema.Boolean), at: Schema.optionalKey(Millis) }, error: Missing }),
  Rpc.make("conversations.setHidden", { payload: { conversationId: ConversationId, hidden: Schema.Boolean }, error: Missing }),
  /** Deletes a GROUP chat (its transcript, turns and requests; member bots stay). Direct chats go with their bot → InvalidInput. */
  Rpc.make("conversations.delete", { payload: { conversationId: ConversationId }, error: errors(NotFound, InvalidInput) }),

  // messages + turns
  Rpc.make("messages.send", { payload: SendInput, success: SendResult, error: errors(NotFound, InvalidInput, HarnessUnavailable) }),
  Rpc.make("messages.lookupSend", { payload: { conversationId: ConversationId, clientNonce: NonEmptyString }, success: SendLookup, error: Missing }),
  /** Toggles the owner's reaction. */
  Rpc.make("messages.react", { payload: { conversationId: ConversationId, entryId: EntryId, emoji: NonEmptyString }, error: Missing }),
  /** Interrupt the running turn (all bots' turns in a group when `turnId` is absent). */
  Rpc.make("turns.interrupt", { payload: { conversationId: ConversationId, turnId: Schema.optionalKey(TurnId) }, success: Schema.Array(Turn), error: Missing }),
  Rpc.make("attachments.upload", { payload: { name: Schema.String, mime: Schema.String, bytesBase64: Schema.String }, success: Attachment, error: errors(InvalidInput) }),

  // runtime requests
  RequestsRespond,
  Rpc.make("requests.listPending", { payload: { conversationId: Schema.optionalKey(ConversationId) }, success: Schema.Array(RuntimeRequest), error: errors() }),

  // routines
  Rpc.make("routines.list", { payload: { botId: Schema.optionalKey(BotId) }, success: Schema.Array(Routine), error: errors() }),
  Rpc.make("routines.create", { payload: { botId: BotId, spec: RoutineSpec }, success: Routine, error: Common }),
  Rpc.make("routines.update", { payload: { routineId: RoutineId, spec: RoutineSpec }, success: Routine, error: Common }),
  Rpc.make("routines.setEnabled", { payload: { routineId: RoutineId, enabled: Schema.Boolean }, success: Routine, error: Missing }),
  Rpc.make("routines.delete", { payload: { routineId: RoutineId }, error: Missing }),
  /** "Test run": fires now regardless of the trigger; returns the run (turn id filled in later). */
  Rpc.make("routines.runNow", { payload: { routineId: RoutineId }, success: RoutineRun, error: errors(NotFound, Conflict, HarnessUnavailable) }),
  /** Most recent first (at most 20 kept). */
  Rpc.make("routines.runs", { payload: { routineId: RoutineId }, success: Schema.Array(RoutineRun), error: Missing }),

  // memory
  Rpc.make("memory.get", { payload: { botId: BotId }, success: BotMemory, error: Missing }),
  Rpc.make("memory.putFact", { payload: { botId: BotId, fact: MemoryFactInput }, success: MemoryFact, error: errors(NotFound, InvalidInput) }),
  Rpc.make("memory.deleteFact", { payload: { botId: BotId, factId: MemoryFactId }, error: Missing }),
  Rpc.make("memory.setIndex", { payload: { botId: BotId, index: Schema.String }, success: BotMemory, error: errors(NotFound, InvalidInput) }),

  // skills (library-level in v1)
  Rpc.make("skills.list", { success: Schema.Array(Skill), error: errors() }),
  Rpc.make("skills.upsert", { payload: SkillInput, success: Skill, error: errors(InvalidInput) }),
  Rpc.make("skills.delete", { payload: { name: SkillName }, error: Missing }),

  // harnesses
  /** One status per (kind, profile) of every registered harness (D2.6; no model call). */
  Rpc.make("harnesses.status", { success: Schema.Array(HarnessStatus), error: errors() }),
  /** Models of a harness; `profileId` absent = the default profile. */
  Rpc.make("harnesses.models", {
    payload: { kind: HarnessKindName, profileId: Schema.optionalKey(Schema.String) },
    success: Schema.Array(ModelInfo),
    error: errors(HarnessUnavailable),
  }),
  /** Harness accounts (profiles), the built-in default of each enabled harness first. */
  Rpc.make("harnesses.profiles", { payload: { kind: Schema.optionalKey(HarnessKindName) }, success: Schema.Array(HarnessProfile), error: errors() }),
  /** Adds an account: `configDir` is an existing dir on the brain machine (`~/` is expanded). */
  Rpc.make("harnesses.addProfile", {
    payload: { kind: HarnessKindName, label: Schema.String, configDir: Schema.String },
    success: HarnessProfile,
    error: errors(InvalidInput, Conflict),
  }),
  /** Removes an account. Refused (Conflict) while bots use it; the default cannot be removed (Forbidden). */
  Rpc.make("harnesses.removeProfile", { payload: { profileId: NonEmptyString }, error: errors(NotFound, Conflict, Forbidden) }),
  /** Config dirs on the brain machine that look like logins of `kind` and are not accounts yet. */
  Rpc.make("harnesses.discover", { payload: { kind: HarnessKindName }, success: Schema.Array(HarnessProfileCandidate), error: errors() }),

  // nodes
  Rpc.make("nodes.list", { success: Schema.Array(NodeSummary), error: errors() }),
  Rpc.make("nodes.createPairingCode", { success: PairingCode, error: errors() }),
  Rpc.make("nodes.rename", { payload: { nodeId: NodeId, label: NonEmptyString }, success: NodeSummary, error: errors(NotFound, InvalidInput) }),
  /** Revoking closes the node's socket with 4401 (D1.3). The local node cannot be revoked. */
  Rpc.make("nodes.revoke", { payload: { nodeId: NodeId }, error: errors(NotFound, Forbidden) }),
  Rpc.make("nodes.setCapabilities", { payload: { nodeId: NodeId, approved: Schema.Array(Schema.String) }, success: NodeSummary, error: errors(NotFound, InvalidInput) }),

  // computer (live view, D1.7)
  Rpc.make("computer.status", { payload: { botId: BotId }, success: ComputerStatus, error: Missing }),
  /** Start (or reuse) the bot's browser window on its host node. */
  Rpc.make("computer.ensure", { payload: { botId: BotId }, success: ComputerStatus, error: errors(NotFound, NodeUnavailable) }),
  /** take=true: the owner takes control (bot browser actions then fail); false: hand back. */
  Rpc.make("computer.lease", { payload: { botId: BotId, take: Schema.Boolean }, success: ComputerStatus, error: errors(NotFound, NodeUnavailable, Conflict) }),

  // settings + approval rules
  Rpc.make("settings.get", { success: Settings, error: errors() }),
  Rpc.make("settings.update", { payload: { patch: SettingsPatch }, success: Settings, error: errors(InvalidInput) }),
  Rpc.make("rules.list", { payload: { botId: Schema.optionalKey(BotId) }, success: Schema.Array(ApprovalRule), error: errors() }),
  Rpc.make("rules.upsert", { payload: { rule: ApprovalRuleInput }, success: ApprovalRule, error: errors(NotFound, InvalidInput) }),
  Rpc.make("rules.delete", { payload: { ruleId: ApprovalRuleId }, error: Missing }),

  // background tasks (D5.7)
  /** A bot's tasks, newest first (`limit` default 50). */
  Rpc.make("tasks.list", { payload: { botId: BotId, limit: Schema.optionalKey(NonNegativeInt) }, success: Schema.Array(Task), error: Missing }),
  /** One task with its steps (tool calls, reasoning, messages), oldest first. */
  Rpc.make("tasks.get", { payload: { taskId: TaskId }, success: TaskDetail, error: Missing }),
  /** The owner stops a queued or running task (only that one); a finished task is returned unchanged. */
  Rpc.make("tasks.cancel", { payload: { taskId: TaskId }, success: Task, error: Missing }),

  // usage
  Rpc.make("usage.byBot", { payload: { sinceMs: Schema.optionalKey(Millis) }, success: Schema.Array(BotUsage), error: errors() }),
) {}

/** Every RPC tag in `OpenBotRpcs` (handy for exhaustiveness checks in the server). */
export type OpenBotRpcTag = RpcGroup.Rpcs<typeof OpenBotRpcs>["_tag"]
