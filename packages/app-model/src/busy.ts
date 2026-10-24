// The chat's ONE status line per bot (above the composer, the activity row's look: avatar +
// shimmering phrase). Pure; unit-tested.
// - its turn here (one mind per bot, D5.0: a bot runs one turn at a time across its conversations);
// - "Busy in …" when it works in ANOTHER conversation (and "· your message is queued" when this one
//   waits for it);
// - "Handling…" while background work (D5.7) started here runs.
import type { BotActivity, BotId, ConversationId, ConversationSummary, Task, TaskId, Turn } from "@openbot/contracts"

/** "“secret project”", "its DM with you", "routine “Daily”" — where a bot is busy. */
export const whereOf = (other: ConversationSummary | undefined): string =>
  other === undefined
    ? "another chat"
    : other.kind === "group"
      ? `“${other.title}”`
      : other.kind === "routine-run"
        ? `routine “${other.title}”`
        : "its DM with you"

export interface BusyElsewhere {
  readonly botId: BotId
  readonly conversationId: ConversationId
  /** "“secret project”", "its DM with you", "routine “Daily”". */
  readonly where: string
  /** This conversation has a turn of that bot waiting for it. */
  readonly queued: boolean
}

/**
 * Members of `conversationId` working in ANOTHER conversation right now (their activity names it),
 * unless they also run a turn here. Pure; unit-tested.
 */
export const busyElsewhere = (input: {
  readonly conversationId: ConversationId
  readonly botIds: ReadonlyArray<BotId>
  readonly activities: ReadonlyMap<BotId, BotActivity>
  readonly turns: ReadonlyArray<Turn>
  readonly conversations: ReadonlyMap<ConversationId, ConversationSummary>
}): ReadonlyArray<BusyElsewhere> =>
  input.botIds.flatMap((botId) => {
    const a = input.activities.get(botId)
    if (a === undefined || a.conversationId === undefined || a.conversationId === input.conversationId) return []
    if (a.state !== "thinking" && a.state !== "working" && a.state !== "waiting") return []
    const mine = input.turns.filter((t) => t.botId === botId)
    if (mine.some((t) => t.status === "running" || t.status === "waiting")) return []
    const where = whereOf(input.conversations.get(a.conversationId))
    return [{ botId, conversationId: a.conversationId, where, queued: mine.some((t) => t.status === "queued") }]
  })

/** Members with background work (D5.7) started in THIS conversation that is queued or running. */
export const handlingHere = (input: {
  readonly conversationId: ConversationId
  readonly botIds: ReadonlyArray<BotId>
  readonly tasks: ReadonlyMap<TaskId, Task> | undefined
}): ReadonlyArray<BotId> => {
  const busy = new Set<BotId>()
  for (const t of input.tasks?.values() ?? []) {
    if (t.conversationId === input.conversationId && (t.status === "queued" || t.status === "running"))
      busy.add(t.botId)
  }
  return input.botIds.filter((id) => busy.has(id))
}

/** The phrase of the status line while a bot's background work runs (D5.7): no titles, no counts. */
export const HANDLING = "Handling…"

/** One bot's status line in a chat. */
export type ChatStatus =
  /** Its current turn runs here: the activity phrase. */
  | { readonly kind: "turn"; readonly botId: BotId }
  /** It works in another conversation ("Busy in …", "· your message is queued"); opens that one. */
  | ({ readonly kind: "elsewhere" } & BusyElsewhere)
  /** Background work started here runs ("Handling…"); opens the Tasks tab. */
  | { readonly kind: "handling"; readonly botId: BotId }

/**
 * The ONE status line per bot of a chat, in order: bots with a turn here (oldest turn first; also a
 * bot whose activity is here, e.g. another bot writing into this DM), then the members, each with
 * the first that applies:
 * 1. its turn here → the turn's phrase;
 * 2. busy in another conversation while a message here waits for it → "Busy in … · your message is queued";
 * 3. background work started here runs → "Handling…";
 * 4. busy in another conversation → "Busy in …";
 * otherwise no line. Pure; unit-tested.
 */
export const chatStatuses = (input: {
  readonly conversationId: ConversationId
  readonly botIds: ReadonlyArray<BotId>
  readonly activities: ReadonlyMap<BotId, BotActivity>
  /** This conversation's active (queued, running, waiting) turns, oldest first. */
  readonly turns: ReadonlyArray<Turn>
  readonly conversations: ReadonlyMap<ConversationId, ConversationSummary>
  readonly tasks: ReadonlyMap<TaskId, Task> | undefined
}): ReadonlyArray<ChatStatus> => {
  const away = new Map(busyElsewhere(input).map((e) => [e.botId, e]))
  const handling = new Set(handlingHere(input))
  // a queued turn of a bot busy elsewhere waits: that bot's line says where it is
  const turnBots = new Set<BotId>(
    input.turns.filter((t) => t.status !== "queued" || !away.has(t.botId)).map((t) => t.botId),
  )
  for (const [botId, a] of input.activities) {
    if (a.conversationId === input.conversationId && (a.state === "thinking" || a.state === "working"))
      turnBots.add(botId)
  }
  const out: Array<ChatStatus> = [...turnBots].map((botId) => ({ kind: "turn" as const, botId }))
  for (const botId of input.botIds) {
    if (turnBots.has(botId)) continue
    const elsewhere = away.get(botId)
    if (elsewhere !== undefined && (elsewhere.queued || !handling.has(botId)))
      out.push({ kind: "elsewhere", ...elsewhere })
    else if (handling.has(botId)) out.push({ kind: "handling", botId })
  }
  return out
}
