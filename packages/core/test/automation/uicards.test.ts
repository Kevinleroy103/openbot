import { describe, expect, test } from "bun:test"
import { AlreadyAnswered, type EntryId, InvalidInput, NotFound, type UiCardInput } from "@openbot/contracts"
import { Effect, Exit, Layer } from "effect"
import { EntryRepo, UiCardService } from "../../src/ports/index.ts"
import { UiCardServiceLive } from "../../src/services/automation/index.ts"
import { makeUiCardService } from "../../src/services/automation/UiCardService.ts"
import { makeClaims, NotifierFake, OrchestratorFake, runTest } from "../../src/testing/index.ts"
import { BOT_A, BOT_B, baseLayer, DM_A, GROUP, seed } from "./helpers.ts"

const layer = UiCardServiceLive.pipe(Layer.provideMerge(baseLayer()))

const toolCtx = (callId: string, botId = BOT_A.id, conversationId = DM_A.id) => ({
  claims: makeClaims({ botId, conversationId }),
  callId,
})

const meeting: UiCardInput = {
  type: "ui",
  version: 1,
  title: "Choose a meeting time",
  blocks: [
    { type: "text", markdown: "Two slots work." },
    {
      type: "choice",
      id: "slot",
      label: "Slot",
      mode: "one",
      options: [
        { id: "s1", label: "10:00–10:30" },
        { id: "s2", label: "14:00–14:30" },
      ],
    },
    { type: "input", id: "title", label: "Title" },
  ],
  actions: [{ id: "send", label: "Send choice", style: "primary" }],
  fallback: "Choose a meeting time: 10:00 or 14:00.",
}
const board: UiCardInput = {
  type: "ui",
  version: 1,
  title: "Deploy",
  blocks: [{ type: "checklist", items: [{ label: "Build", status: "active" }] }],
  fallback: "Deploy: building.",
}

const entry = (id: EntryId) =>
  Effect.flatMap(EntryRepo, (repo) => repo.get(id)).pipe(
    Effect.map((found) => (found._tag === "Some" ? found.value : undefined)),
  )
const failure = <A, E>(exit: Exit.Exit<A, E>) => (Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined)
const errorOf = <A, E>(exit: Exit.Exit<A, E>) => {
  const reason = failure(exit)
  return reason !== undefined && reason._tag === "Fail" ? reason.error : undefined
}

describe("UiCardService", () => {
  test("a card with actions is pending; the owner's answer is recorded, delivered once, then AlreadyAnswered", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const cards = yield* UiCardService
        const first = yield* cards.show(toolCtx("call-1"), meeting)
        const again = yield* cards.show(toolCtx("call-1"), meeting)
        const posted = yield* entry(first.entryId)
        const act = (actionId: string, values: Record<string, string | ReadonlyArray<string>>) =>
          Effect.exit(cards.act({ entryId: first.entryId, actionId, values }))
        const rejected = [
          yield* act("cancel", {}),
          yield* act("send", { room: "3" }),
          yield* act("send", { slot: ["s1", "s2"] }),
          yield* act("send", { slot: ["s9"] }),
          yield* act("send", { slot: "s1" }),
          yield* act("send", { title: ["a"] }),
          yield* act("send", { title: "x".repeat(4_001) }),
        ].map(errorOf)
        yield* cards.act({ entryId: first.entryId, actionId: "send", values: { slot: ["s1"], title: "Design review" } })
        const answered = yield* entry(first.entryId)
        const twice = yield* act("send", { slot: ["s2"] })
        const missing = yield* Effect.exit(cards.act({ entryId: "ent_nope" as EntryId, actionId: "send", values: {} }))
        return {
          first,
          again,
          posted,
          rejected,
          answered,
          twice,
          missing,
          deliveries: yield* Effect.flatMap(OrchestratorFake, (fake) => fake.deliveries),
          notified: yield* Effect.flatMap(NotifierFake, (fake) => fake.sent),
        }
      }),
      layer,
    )
    expect(out.again).toEqual(out.first)
    expect(out.posted).toMatchObject({
      kind: "card",
      conversationId: DM_A.id,
      author: { kind: "bot", botId: BOT_A.id },
      card: meeting,
      state: { status: "pending" },
    })
    expect(out.notified).toEqual([
      expect.objectContaining({ kind: "waiting", botId: BOT_A.id, body: "Choose a meeting time: 10:00 or 14:00." }),
    ])
    expect(out.rejected.map((e) => (e instanceof InvalidInput ? e.message : e))).toEqual([
      'This card has no action "cancel".',
      'This card has no field "room".',
      'Pick one option for "Slot".',
      '"Slot" has no option "s9".',
      '"Slot" takes a list of option ids.',
      '"Title" takes text.',
      '"Title" is longer than 4000 characters.',
    ])
    expect(out.answered).toMatchObject({
      state: { status: "resolved", answer: { actionId: "send", values: { slot: ["s1"], title: "Design review" } } },
    })
    expect(errorOf(out.twice)).toBeInstanceOf(AlreadyAnswered)
    expect(errorOf(out.missing)).toBeInstanceOf(NotFound)
    expect(out.deliveries).toHaveLength(1)
    expect(out.deliveries[0]).toMatchObject({
      conversationId: DM_A.id,
      botId: BOT_A.id,
      kind: "user-message",
      urgency: "urgent",
      sourceEntryId: out.first.entryId,
    })
    expect(out.deliveries[0]!.text).toBe(
      [
        'The user chose "Send choice" on your card "Choose a meeting time".',
        "Slot: 10:00–10:30",
        "Title: Design review",
        'values: {"slot":["s1"],"title":"Design review"}',
      ].join("\n"),
    )
  })

  test("the answer works after a restart: the card is the state", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const before = yield* makeUiCardService
        const { entryId } = yield* before.show(toolCtx("call-1"), meeting)
        const after = yield* makeUiCardService
        yield* after.act({ entryId, actionId: "send", values: { slot: ["s2"] } })
        return {
          answered: yield* entry(entryId),
          deliveries: yield* Effect.flatMap(OrchestratorFake, (fake) => fake.deliveries),
        }
      }),
      layer,
    )
    expect(out.answered).toMatchObject({ state: { status: "resolved", answer: { values: { slot: ["s2"] } } } })
    expect(out.deliveries.map((d) => d.text.split("\n")[1])).toEqual(["Slot: 14:00–14:30"])
  })

  test("update_ui replaces the poster's own card until it is answered; a display-only card has nothing to answer", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const cards = yield* UiCardService
        const { entryId } = yield* cards.show(toolCtx("call-1"), board)
        const info = yield* entry(entryId)
        const nothing = yield* Effect.exit(cards.act({ entryId, actionId: "send", values: {} }))
        const done: UiCardInput = {
          ...board,
          blocks: [{ type: "checklist", items: [{ label: "Build", status: "done" }] }],
          fallback: "Deploy: built.",
        }
        yield* cards.update(toolCtx("call-2"), entryId, done)
        const updated = yield* entry(entryId)
        const otherBot = yield* Effect.exit(cards.update(toolCtx("call-3", BOT_B.id), entryId, board))
        const otherChat = yield* Effect.exit(cards.update(toolCtx("call-4", BOT_A.id, GROUP.id), entryId, board))
        const missing = yield* Effect.exit(cards.update(toolCtx("call-5"), "ent_nope" as EntryId, board))
        yield* cards.update(toolCtx("call-6"), entryId, meeting)
        const asking = yield* entry(entryId)
        yield* cards.act({ entryId, actionId: "send", values: {} })
        const late = yield* Effect.exit(cards.update(toolCtx("call-7"), entryId, board))
        return {
          info,
          nothing,
          updated,
          otherBot,
          otherChat,
          missing,
          asking,
          late,
          notified: yield* Effect.flatMap(NotifierFake, (fake) => fake.sent),
        }
      }),
      layer,
    )
    expect(out.info).toMatchObject({ card: board, state: { status: "info" } })
    expect(out.notified).toEqual([])
    expect(errorOf(out.nothing)).toEqual(new InvalidInput({ message: "This card has nothing to answer." }))
    expect(out.updated).toMatchObject({ revision: 1, card: { fallback: "Deploy: built." }, state: { status: "info" } })
    const notYours = new InvalidInput({ message: "You can only update a card you posted in this conversation." })
    expect(errorOf(out.otherBot)).toEqual(notYours)
    expect(errorOf(out.otherChat)).toEqual(notYours)
    expect(errorOf(out.missing)).toBeInstanceOf(NotFound)
    expect(out.asking).toMatchObject({ card: { title: "Choose a meeting time" }, state: { status: "pending" } })
    expect(errorOf(out.late)).toEqual(
      new InvalidInput({
        message: "The owner already answered this card, so it can't change. Post a new one with show_ui.",
      }),
    )
  })
})
