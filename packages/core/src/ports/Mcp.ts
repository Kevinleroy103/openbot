/**
 * Gateway binding port (architecture §3.4, D3.1): per-run MCP bearer tokens that bind a harness
 * session to `{botId, conversationId, sessionKey, toolsets, hostNodeId, workspacePath, boundNodeIds}`.
 *
 * The bot runner mints one binding per opened session (`McpBindingIssuer.issue`, scoped to the
 * session) with claims taken from the `ResolvedPlacement`. A bot has ONE session for all of its
 * conversations (D5.0), so the minted `conversationId` / `sessionKey` name the bot's HOME
 * conversation (its DM). The gateway verifies the bearer (sha256 → `McpTokenRepo.lookup`), gates
 * tools by `toolsets`, and — per tool call — substitutes the conversation of the bot's CURRENT turn
 * (`Orchestrator.activeTurn(botId)`, else the home conversation) into `conversationId` and
 * `sessionKey` before any tool runs. Node-protocol `Invocation`s are built as
 * `{invocationId: <fresh>, botId, runId: claims.sessionKey, toolCallId?}`.
 */
import { BotId, ConversationId, NodeId, TaskId } from "@openbot/contracts"
import { Context, Effect, Option, Schema, Scope } from "effect"
import type { RepoError } from "./errors.ts"

export const ToolsetSchema = Schema.Literals(["bot", "node", "browser", "computer"])

/** Claims carried by an MCP bearer token (stored hashed in `McpTokenRepo`). */
export const McpClaims = Schema.Struct({
  botId: BotId,
  /**
   * Minted: the bot's home conversation (DM). In a `ToolContext` (per call): the conversation of the
   * bot's current turn — replies, cards, events and `post_to_group` defaults use it.
   */
  conversationId: ConversationId,
  /** `sessionKeyOf(botId, conversationId)` for the `conversationId` above. */
  sessionKey: Schema.String,
  toolsets: Schema.Array(ToolsetSchema),
  hostNodeId: NodeId,
  /** The bot's workspace on the host node (`ResolvedPlacement.workspacePath`); default cwd of node tools. */
  workspacePath: Schema.String,
  /** Nodes the bot may target with the `node` parameter (host node is always allowed). */
  boundNodeIds: Schema.Array(NodeId),
  /**
   * Set on the token of a background task's own session (D5.7): calls run for that task —
   * `conversationId` stays the conversation the task was started from (no current-turn lookup),
   * and task-management / ask-the-owner tools are not offered.
   */
  taskId: Schema.optional(TaskId),
})
export type McpClaims = typeof McpClaims.Type

/** What a harness gets to register the OpenBot MCP server. Tokens live in `headers`, never on argv. */
export interface McpBinding {
  readonly name: "openbot"
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

export class McpBindingIssuer extends Context.Service<McpBindingIssuer, {
  /** Mints a per-run bearer bound to `claims`; revoked when the caller's scope closes. */
  readonly issue: (claims: McpClaims) => Effect.Effect<McpBinding, never, Scope.Scope>
}>()("openbot/core/McpBindingIssuer") {}

/** Stored token row (`mcp_tokens`). */
export const McpTokenRecord = Schema.Struct({
  /** Hex SHA-256 of the bearer token. */
  hash: Schema.String,
  claims: McpClaims,
  createdAt: Schema.Number,
  expiresAt: Schema.optional(Schema.Number),
  revoked: Schema.Boolean,
})
export type McpTokenRecord = typeof McpTokenRecord.Type

export class McpTokenRepo extends Context.Service<McpTokenRepo, {
  readonly put: (record: McpTokenRecord) => Effect.Effect<void, RepoError>
  /** Returns the record even if revoked/expired; callers check `revoked` and `expiresAt`. */
  readonly lookup: (hash: string) => Effect.Effect<Option.Option<McpTokenRecord>, RepoError>
  readonly revoke: (hash: string) => Effect.Effect<void, RepoError>
  /** Revokes every token of a bot (bot deleted) or every token (`botId` omitted; brain boot). */
  readonly revokeAll: (botId?: BotId) => Effect.Effect<void, RepoError>
}>()("openbot/core/McpTokenRepo") {}
