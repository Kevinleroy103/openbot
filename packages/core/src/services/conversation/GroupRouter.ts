/**
 * GroupRouter (architecture §4.3.2, D5.1): which member bots respond to a group message.
 *
 * Precedence for an owner message:
 *   1. `@everyone` (explicit flag or in the text) → every member;
 *   2. explicit mentions (`addressedBotIds` from the composer ∪ `@Name` in the text) → those members;
 *   3. reply to a bot's entry → that bot;
 *   4. the lead bot (or the first member when no lead is set).
 *
 * A bot's own post or reply only reaches the members it mentions (no reply/lead fallback), so bots
 * cannot wake the whole group by accident; hop limits bound mention chains.
 *
 * Pure functions: no Effect, no repositories (the Orchestrator loads the inputs).
 */
import type { Bot, BotId, Conversation, TranscriptEntry } from "@openbot/contracts"
import { parseMentions } from "./internal/util.ts"

export type GroupConversation = Extract<Conversation, { kind: "group" }>

export type RouteReason = "everyone" | "mentions" | "reply" | "lead"

export interface GroupRoute {
  /** Target bots in member order. */
  readonly botIds: ReadonlyArray<BotId>
  readonly reason: RouteReason
}

export interface OwnerMessageRouting {
  readonly group: GroupConversation
  /** Member bots (used to resolve `@Name` mentions in the text). */
  readonly members: ReadonlyArray<Pick<Bot, "id" | "name">>
  readonly text: string
  readonly addressedBotIds?: ReadonlyArray<BotId> | undefined
  readonly addressEveryone?: boolean | undefined
  /** The entry being replied to, when the message is a reply. */
  readonly replyTo?: TranscriptEntry | undefined
}

const inMemberOrder = (group: GroupConversation, ids: ReadonlySet<BotId>): ReadonlyArray<BotId> =>
  group.memberBotIds.filter((id) => ids.has(id))

/** The default responder: the lead bot when it is a member, else the first member. */
export const leadOf = (group: GroupConversation): BotId | undefined =>
  group.leadBotId !== undefined && group.memberBotIds.includes(group.leadBotId)
    ? group.leadBotId
    : group.memberBotIds[0]

/** Routes an owner message in a group (D5.1). Empty only for a group without members. */
export const routeOwnerMessage = (input: OwnerMessageRouting): GroupRoute => {
  const { group } = input
  const parsed = parseMentions(input.text, input.members)
  if (input.addressEveryone === true || parsed.everyone) return { botIds: [...group.memberBotIds], reason: "everyone" }

  const mentioned = new Set<BotId>([...(input.addressedBotIds ?? []), ...parsed.botIds])
  const explicit = inMemberOrder(group, mentioned)
  if (explicit.length > 0) return { botIds: explicit, reason: "mentions" }

  const replyAuthor = input.replyTo?.author
  if (replyAuthor?.kind === "bot" && group.memberBotIds.includes(replyAuthor.botId)) {
    return { botIds: [replyAuthor.botId], reason: "reply" }
  }

  const lead = leadOf(group)
  return { botIds: lead === undefined ? [] : [lead], reason: "lead" }
}

/**
 * Members a bot's text addresses (mentions or `@everyone`), excluding the sender. Used for bot
 * replies and `post_to_group` posts.
 */
export const routeBotMessage = (input: {
  readonly group: GroupConversation
  readonly members: ReadonlyArray<Pick<Bot, "id" | "name">>
  readonly text: string
  readonly senderBotId: BotId
}): ReadonlyArray<BotId> => {
  const parsed = parseMentions(input.text, input.members)
  const ids = parsed.everyone ? new Set(input.group.memberBotIds) : new Set(parsed.botIds)
  ids.delete(input.senderBotId)
  return inMemberOrder(input.group, ids)
}
