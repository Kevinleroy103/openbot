// The bot-to-bot exchange dialog's model (pure, unit-tested): the pages of `conversations.exchange`
// merged into one window, the live tail from the two direct-conversation replicas, and the
// message(s) the clicked line stands for.
import type { ExchangePage, TranscriptEntry } from "@openbot/contracts"
import { isBotToBot, type MessageEntry } from "./grouping.ts"

/**
 * What a clicked line stands for: its message ids ("N messages with", "Messaged" with the delivered
 * entry), else the newest `fromBotId` → `toBotId` message at or before `at` (a hand-off, whose event
 * is written right after its message). The dialog opens around `at`.
 */
export interface ExchangeTarget {
  readonly at: number
  readonly entryIds: ReadonlyArray<string>
  readonly fromBotId?: string | undefined
  readonly toBotId?: string | undefined
}

/** The loaded part of an exchange, oldest first, with the cursors to load more. */
export interface ExchangeWindow {
  readonly items: ReadonlyArray<MessageEntry>
  /** Null when nothing is older. */
  readonly beforeCursor: string | null
  /** Null when the window reaches the newest message (the live tail then joins it). */
  readonly afterCursor: string | null
}

const order = (x: MessageEntry, y: MessageEntry): number => x.createdAt - y.createdAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)

/** Messages merged by id (the higher revision wins), in `(createdAt, id)` order. */
export const mergeMessages = (...lists: ReadonlyArray<ReadonlyArray<MessageEntry>>): ReadonlyArray<MessageEntry> => {
  const byId = new Map<string, MessageEntry>()
  for (const list of lists) {
    for (const e of list) {
      const known = byId.get(e.id)
      if (known === undefined || e.revision > known.revision) byId.set(e.id, e)
    }
  }
  return [...byId.values()].sort(order)
}

const messagesOf = (entries: ReadonlyArray<TranscriptEntry>): ReadonlyArray<MessageEntry> =>
  entries.filter((e): e is MessageEntry => e.kind === "message" && isBotToBot(e))

/**
 * The window after a page arrives: the first page starts it; an older / newer page extends it on
 * that side and moves only that side's cursor.
 */
export const applyPage = (window: ExchangeWindow | undefined, page: ExchangePage, side: "older" | "newer" | "first"): ExchangeWindow => {
  const items = messagesOf(page.entries)
  if (window === undefined || side === "first") return { items: mergeMessages(items), beforeCursor: page.beforeCursor, afterCursor: page.afterCursor }
  return {
    items: mergeMessages(window.items, items),
    beforeCursor: side === "older" ? page.beforeCursor : window.beforeCursor,
    afterCursor: side === "newer" ? page.afterCursor : window.afterCursor,
  }
}

/**
 * What the dialog shows: the window with newer revisions from the replicas and, once the window
 * reaches the newest message, the replicas' messages after its start (sent while it is open).
 * Older replica messages stay out: they belong to pages not loaded yet.
 */
export const withLive = (window: ExchangeWindow, live: ReadonlyArray<MessageEntry>): ReadonlyArray<MessageEntry> => {
  const known = new Set(window.items.map((e) => e.id))
  const first = window.items[0]
  const joins = (e: MessageEntry) =>
    known.has(e.id) || (window.afterCursor === null && (first === undefined ? window.beforeCursor === null : order(e, first) > 0))
  const extra = live.filter(joins)
  return extra.length === 0 ? window.items : mergeMessages(window.items, extra)
}

/** The loaded messages the target stands for (see `ExchangeTarget`), oldest first. */
export const targetIdsIn = (items: ReadonlyArray<MessageEntry>, target: ExchangeTarget): ReadonlyArray<string> => {
  const wanted = new Set(target.entryIds)
  const byId = items.filter((e) => wanted.has(e.id)).map((e) => e.id)
  if (byId.length > 0 || target.fromBotId === undefined) return byId
  const match = items.findLast(
    (e) => e.createdAt <= target.at && e.author.kind === "bot" && e.author.botId === target.fromBotId && e.toBotId === target.toBotId,
  )
  return match ? [match.id] : []
}

/** Where the dialog opens: the target's first message, else the last one at or before `at`. */
export const anchorIdIn = (items: ReadonlyArray<MessageEntry>, target: ExchangeTarget): string | undefined =>
  targetIdsIn(items, target)[0] ?? (items.findLast((e) => e.createdAt <= target.at) ?? items[0])?.id
