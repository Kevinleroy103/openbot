// Unit tests for the exchange dialog's model (chat/exchange.ts): merging pages into the window,
// the live tail, and the message(s) a clicked line stands for.
import { describe, expect, test } from "bun:test"
import type { BotId, ConversationId, EntryId, ExchangePage } from "@openbot/contracts"
import { anchorIdIn, applyPage, type ExchangeWindow, mergeMessages, targetIdsIn, withLive } from "../src/chat/exchange.ts"
import type { MessageEntry } from "../src/chat/grouping.ts"

/** A bot-to-bot message `id` from → to at `at` (seconds). */
const m = (id: string, at: number, from = "bot_a", to = "bot_b", revision = 0): MessageEntry => ({
  id: id as EntryId,
  conversationId: `cnv_${to}` as ConversationId,
  revision,
  createdAt: at * 1000,
  updatedAt: at * 1000,
  author: { kind: "bot", botId: from as BotId },
  kind: "message",
  role: "bot",
  text: id,
  attachments: [],
  streaming: false,
  toBotId: to as BotId,
})
const ids = (items: ReadonlyArray<MessageEntry>): Array<string> => items.map((e) => e.id)
const page = (entries: ReadonlyArray<MessageEntry>, beforeCursor: string | null, afterCursor: string | null): ExchangePage => ({ entries, beforeCursor, afterCursor })

describe("exchange dialog model", () => {
  test("pages: the first starts the window, older / newer ones extend their side and move only its cursor", () => {
    let win = applyPage(undefined, page([m("e4", 4), m("e5", 5, "bot_b", "bot_a"), m("e6", 6)], "c4", "c6"), "first")
    expect([ids(win.items), win.beforeCursor, win.afterCursor]).toEqual([["e4", "e5", "e6"], "c4", "c6"])
    win = applyPage(win, page([m("e2", 2), m("e3", 3)], "c2", "c3"), "older")
    expect([ids(win.items), win.beforeCursor, win.afterCursor]).toEqual([["e2", "e3", "e4", "e5", "e6"], "c2", "c6"])
    win = applyPage(win, page([m("e7", 7), m("e6", 6)], "c6", null), "newer")
    expect([ids(win.items), win.beforeCursor, win.afterCursor]).toEqual([["e2", "e3", "e4", "e5", "e6", "e7"], "c2", null])
  })

  test("merging keeps one copy per id (the higher revision) in (createdAt, id) order", () => {
    const merged = mergeMessages([m("e2", 2), m("e1", 1, "bot_a", "bot_b", 1)], [m("e1", 1, "bot_a", "bot_b", 0), m("e0", 2)])
    expect(ids(merged)).toEqual(["e1", "e0", "e2"])
    expect(merged[0]!.revision).toBe(1)
  })

  test("live tail: newer messages join only a window that reaches the newest; older ones wait for their page", () => {
    const open: ExchangeWindow = { items: [m("e4", 4), m("e5", 5)], beforeCursor: "c4", afterCursor: null }
    const live = [m("e1", 1), m("e5", 5, "bot_a", "bot_b", 2), m("e9", 9, "bot_b", "bot_a")]
    const shown = withLive(open, live)
    expect(ids(shown)).toEqual(["e4", "e5", "e9"])
    expect(shown[1]!.revision).toBe(2)
    // not at the newest yet: only newer revisions of loaded messages
    expect(ids(withLive({ ...open, afterCursor: "c5" }, live))).toEqual(["e4", "e5"])
    // nothing between them when the dialog opened: everything live is new
    expect(ids(withLive({ items: [], beforeCursor: null, afterCursor: null }, live))).toEqual(["e1", "e5", "e9"])
  })

  test("target: the line's message ids, else the newest from → to message at or before the event", () => {
    const items = [m("e1", 1), m("e2", 2, "bot_b", "bot_a"), m("e3", 3), m("e4", 4, "bot_b", "bot_a"), m("e5", 5)]
    // "2 messages with" (a run in the recipient's chat)
    expect(targetIdsIn(items, { at: 2000, entryIds: ["e2", "e4"] })).toEqual(["e2", "e4"])
    // a hand-off: no entry id, the event is written right after its message
    expect(targetIdsIn(items, { at: 4500, entryIds: [], fromBotId: "bot_a", toBotId: "bot_b" })).toEqual(["e3"])
    expect(targetIdsIn(items, { at: 4500, entryIds: [], fromBotId: "bot_b", toBotId: "bot_a" })).toEqual(["e4"])
    // "Messaged" whose entry is gone: falls back to from → to
    expect(targetIdsIn(items, { at: 1500, entryIds: ["gone"], fromBotId: "bot_a", toBotId: "bot_b" })).toEqual(["e1"])
    expect(targetIdsIn(items, { at: 1500, entryIds: ["gone"] })).toEqual([])
  })

  test("anchor: the target's first message, else the last message at or before the time, else the first", () => {
    const items = [m("e1", 1), m("e2", 2, "bot_b", "bot_a"), m("e3", 3)]
    expect(anchorIdIn(items, { at: 2000, entryIds: ["e2", "e3"] })).toBe("e2")
    expect(anchorIdIn(items, { at: 2500, entryIds: ["gone"] })).toBe("e2")
    expect(anchorIdIn(items, { at: 500, entryIds: [] })).toBe("e1")
    expect(anchorIdIn([], { at: 500, entryIds: [] })).toBeUndefined()
  })
})
