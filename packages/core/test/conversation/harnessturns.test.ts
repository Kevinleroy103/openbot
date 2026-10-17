/**
 * Harness-initiated turns (D2.1, 2026-10-17): Claude Code runs turns of its own (the notification
 * of a background command it started). Core folds them into the running turn, or runs them as a
 * "system" turn in the conversation of the bot's latest turn, one turn at a time.
 */
import { describe, expect, test } from "bun:test"
import type { ConversationId, HarnessEvent, TurnId } from "@openbot/contracts"
import { Effect } from "effect"
import { ConversationService } from "../../src/ports/index.ts"
import { NotifierFake, runTest, UsageServiceFake } from "../../src/testing/index.ts"
import {
  appLayer,
  createBot,
  eventually,
  holdBehavior,
  messagesOf,
  send,
  settled,
  TestDriver,
  transcript,
  turnsOf,
} from "./helpers.ts"

const native = (id: string) => id as TurnId

/** A harness turn's events: start, a streamed then final reply, usage and (optionally) its end. */
const harnessTurn = (id: string, text: string, options: { readonly end?: boolean } = {}): ReadonlyArray<HarnessEvent> => [
  { _tag: "TurnStarted", turnId: native(id), initiator: "harness" },
  { _tag: "Activity", label: "Typing…" },
  { _tag: "ItemUpserted", turnId: native(id), key: `${id}/msg`, item: { _tag: "Message", role: "bot", text: text.slice(0, 4), streaming: true } },
  { _tag: "ItemUpserted", turnId: native(id), key: `${id}/msg`, item: { _tag: "Message", role: "bot", text, streaming: false } },
  { _tag: "Usage", turnId: native(id), usage: { inputTokens: 7, outputTokens: 3 } },
  ...(options.end === false ? [] : [{ _tag: "TurnCompleted", turnId: native(id), stopReason: "completed" } as const]),
]

describe("harness-initiated turns", () => {
  test("while idle: a system turn in the bot's latest conversation; its reply is posted there once", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const bot = yield* createBot("Ada")
        const dm = bot.directConversationId
        yield* send(dm, "Render the film in the background")
        yield* settled(dm, 1)
        yield* driver.inject(bot.id, ...harnessTurn("cli-1", "The render finished: film.mp4"))
        yield* settled(dm, 2)
        return {
          bot,
          turns: yield* turnsOf(dm),
          entries: yield* transcript(dm),
          started: (yield* driver.turns).length,
          usage: yield* (yield* UsageServiceFake).recorded,
          notifications: yield* (yield* NotifierFake).sent,
        }
      }),
      appLayer(),
    )
    expect(out.started).toBe(1) // the harness turn was never sent to the harness as a turn
    expect(out.turns.map((t) => [t.trigger, t.status])).toEqual([["user", "completed"], ["system", "completed"]])
    const system = out.turns[1]!
    expect(system.id).not.toBe("cli-1") // core allocates its own id
    expect(system.stopReason).toBe("completed")
    expect(system.usage).toEqual({ inputTokens: 7, outputTokens: 3 })
    const replies = messagesOf(out.entries).filter((m) => m.role === "bot")
    expect(replies.map((m) => [m.text, m.turnId, m.streaming])).toEqual([
      ["Reply from Ada", out.turns[0]!.id, false],
      ["The render finished: film.mp4", system.id, false],
    ])
    expect(replies[1]!.harnessRef?.nativeId).toBe("cli-1/msg")
    expect(out.usage.some((u) => u.turnId === system.id)).toBe(true)
    // The bot telling the owner about its finished work is news (like a background task's result).
    expect(out.notifications.filter((n) => n.kind === "finished").map((n) => n.body)).toContain("The render finished: film.mp4")
  })

  test("it lands in the conversation of the bot's latest turn (a group), not its DM", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const group = (yield* (yield* ConversationService).createGroup({
          title: "Studio",
          memberBotIds: [ada.id, bob.id],
          leadBotId: ada.id,
        })).id as ConversationId
        yield* send(group, "Ada, render it")
        yield* settled(group, 1)
        yield* driver.inject(ada.id, ...harnessTurn("cli-g", "Render done"))
        yield* settled(group, 2)
        return {
          group: messagesOf(yield* transcript(group)).map((m) => m.text),
          dm: messagesOf(yield* transcript(ada.directConversationId)).map((m) => m.text),
          turns: (yield* turnsOf(group)).map((t) => t.trigger),
        }
      }),
      appLayer(),
    )
    expect(out.group).toEqual(["Ada, render it", "Reply from Ada", "Render done"])
    expect(out.dm).toEqual([])
    expect(out.turns).toEqual(["user", "system"])
  })

  test("one turn at a time: the owner's message waits for a running harness turn, then runs", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const bot = yield* createBot("Ada")
        const dm = bot.directConversationId
        yield* send(dm, "first")
        yield* settled(dm, 1)
        yield* driver.inject(bot.id, ...harnessTurn("cli-2", "Background shell finished", { end: false }))
        yield* eventually(
          Effect.map(turnsOf(dm), (turns) => turns.some((t) => t.trigger === "system" && t.status === "running")),
          "harness turn running",
        )
        const receipt = yield* send(dm, "Hello?")
        // Nothing reached the harness while its own turn runs.
        const startedWhileBusy = (yield* driver.turns).length
        yield* driver.inject(bot.id, { _tag: "TurnCompleted", turnId: native("cli-2") })
        yield* settled(dm, 3)
        return {
          receipt,
          startedWhileBusy,
          turns: yield* turnsOf(dm),
          texts: (yield* driver.turns).map((t) => t.input.text),
          replies: messagesOf(yield* transcript(dm)).filter((m) => m.role === "bot").map((m) => m.text),
        }
      }),
      appLayer(),
    )
    expect(out.receipt.disposition).toBe("queued")
    expect(out.startedWhileBusy).toBe(1)
    expect(out.turns.map((t) => [t.trigger, t.status])).toEqual([
      ["user", "completed"],
      ["system", "completed"],
      ["user", "completed"],
    ])
    expect(out.texts).toEqual(["first", "Hello?"])
    expect(out.replies).toEqual(["Reply from Ada", "Background shell finished", "Reply from Ada"])
  })

  test("right after a turn's end (still finishing): it waits for it and becomes a turn of its own", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const bot = yield* createBot("Ada")
        const dm = bot.directConversationId
        // The harness answers, ends the turn, and at once starts a turn of its own (same event stream).
        yield* driver.setBehavior(bot.id, (turn) =>
          Effect.gen(function*() {
            yield* turn.say(`${turn.turnId}/msg`, "Started the render")
            yield* turn.complete("end_turn")
            yield* Effect.forEach(harnessTurn("cli-4", "Render finished"), turn.emit, { discard: true })
          }))
        yield* send(dm, "Render it")
        yield* settled(dm, 2)
        return { turns: yield* turnsOf(dm), replies: messagesOf(yield* transcript(dm)).filter((m) => m.role === "bot") }
      }),
      appLayer(),
    )
    expect(out.turns.map((t) => [t.trigger, t.status])).toEqual([["user", "completed"], ["system", "completed"]])
    expect(out.replies.map((m) => [m.text, m.turnId, m.streaming])).toEqual([
      ["Started the render", out.turns[0]!.id, false],
      ["Render finished", out.turns[1]!.id, false],
    ])
  })

  test("during a running turn: its output joins that turn and its end ends nothing", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const bot = yield* createBot("Ada")
        const dm = bot.directConversationId
        yield* driver.setBehavior(bot.id, holdBehavior)
        yield* send(dm, "Do the long thing")
        yield* eventually(Effect.map(driver.turns, (turns) => turns.length === 1), "turn started")
        yield* driver.inject(bot.id, ...harnessTurn("cli-3", "A background command finished"))
        yield* eventually(
          Effect.map(transcript(dm), (entries) => messagesOf(entries).some((m) => m.text === "A background command finished")),
          "joined output",
        )
        const whileRunning = (yield* turnsOf(dm)).map((t) => t.status)
        yield* driver.release(bot.id)
        yield* settled(dm, 1)
        return {
          whileRunning,
          turns: yield* turnsOf(dm),
          replies: messagesOf(yield* transcript(dm)).filter((m) => m.role === "bot"),
        }
      }),
      appLayer(),
    )
    expect(out.whileRunning).toEqual(["running"])
    expect(out.turns).toHaveLength(1)
    expect(out.turns[0]!.status).toBe("completed")
    // (the running turn's own message entry was created first, while streaming)
    expect(out.replies.map((m) => [m.text, m.turnId, m.streaming])).toEqual([
      ["Done", out.turns[0]!.id, false],
      ["A background command finished", out.turns[0]!.id, false],
    ])
  })
})
