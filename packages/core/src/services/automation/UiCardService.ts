/**
 * UiCardService (generative UI): the `ui` cards Bots post with `show_ui` and replace with
 * `update_ui`, and the owner's answer (`cards.act`).
 *
 * - A card with actions is `pending` until the owner presses one; without, it is `info`.
 * - The answer is one-shot: it is recorded on the card (`resolved` with `answer`) and reaches the Bot
 *   as a user message, like the answer to `ask_user`. The card is the state, so it survives restarts.
 */
import type {
  CardState,
  EntryId,
  KnownTranscriptEntry,
  TranscriptEntryOf,
  UiAnswer,
  UiCard,
  UiCardInput,
  UiValues,
} from "@openbot/contracts"
import { AlreadyAnswered, InvalidInput, NotFound } from "@openbot/contracts"
import { Clock, Effect, Layer, Option } from "effect"
import { BotRepo, EntryRepo } from "../../ports/repos.ts"
import { Notifier } from "../../ports/Notifier.ts"
import {
  ConversationService,
  type EntryDraft,
  Orchestrator,
  type ToolContext,
  UiCardService,
} from "../../ports/services.ts"
import { oneLine, truncate } from "./text.ts"

/** The longest text the owner may type into an `input` block. */
const UI_INPUT_MAX_CHARS = 4_000

type UiCardEntry = TranscriptEntryOf<"card"> & { readonly card: UiCard }

const isUiCard = (entry: KnownTranscriptEntry): entry is UiCardEntry =>
  entry.kind === "card" && entry.card.type === "ui"

const stateOf = (card: UiCardInput): CardState => ({
  status: card.actions !== undefined && card.actions.length > 0 ? "pending" : "info",
})

const titleOf = (card: UiCard): string => card.title ?? truncate(oneLine(card.fallback), 80)

/** What is wrong with the owner's values for `card`, if anything. */
const valuesProblem = (card: UiCard, values: UiValues): string | undefined => {
  for (const [id, value] of Object.entries(values)) {
    const block = card.blocks.find((b) => (b.type === "choice" || b.type === "input") && b.id === id)
    if (block === undefined || (block.type !== "choice" && block.type !== "input"))
      return `This card has no field "${id}".`
    if (block.type === "input") {
      if (typeof value !== "string") return `"${block.label}" takes text.`
      if (value.length > UI_INPUT_MAX_CHARS) return `"${block.label}" is longer than ${UI_INPUT_MAX_CHARS} characters.`
      continue
    }
    if (typeof value === "string") return `"${block.label}" takes a list of option ids.`
    if (block.mode === "one" && value.length > 1) return `Pick one option for "${block.label}".`
    const unknown = value.find((option) => !block.options.some((o) => o.id === option))
    if (unknown !== undefined) return `"${block.label}" has no option "${unknown}".`
  }
  return undefined
}

/** The Bot's message for an answer: what the owner chose, readable, then the raw values. */
const uiAnswerText = (card: UiCard, answer: UiAnswer): string => {
  const action = card.actions?.find((a) => a.id === answer.actionId)
  const lines = [`The user chose "${action?.label ?? answer.actionId}" on your card "${titleOf(card)}".`]
  for (const block of card.blocks) {
    if (block.type !== "choice" && block.type !== "input") continue
    const value = answer.values[block.id]
    if (value === undefined) continue
    if (typeof value === "string") lines.push(`${block.label}: ${value}`)
    else if (block.type === "choice")
      lines.push(`${block.label}: ${value.map((id) => block.options.find((o) => o.id === id)?.label ?? id).join(", ")}`)
  }
  lines.push(`values: ${JSON.stringify(answer.values)}`)
  return lines.join("\n")
}

export const makeUiCardService = Effect.gen(function* () {
  const conversations = yield* ConversationService
  const entries = yield* EntryRepo
  const bots = yield* BotRepo
  const notifier = yield* Notifier
  const orchestrator = yield* Orchestrator

  /** Tool call id → its card (D3.3 idempotency), bounded. */
  const byCall = new Map<string, { readonly entryId: EntryId }>()

  const uiCardEntry = (entryId: EntryId) =>
    Effect.gen(function* () {
      const found = yield* entries.get(entryId).pipe(Effect.orDie)
      if (Option.isNone(found) || found.value.kind === "unknown" || !isUiCard(found.value))
        return yield* new NotFound({ entity: "card", id: entryId })
      return found.value
    })

  const show = Effect.fn("UiCardService.show")(function* (ctx: ToolContext, card: UiCardInput) {
    const key = ctx.callId === undefined ? undefined : `${ctx.claims.botId}:${ctx.callId}`
    const known = key === undefined ? undefined : byCall.get(key)
    if (known !== undefined) return known
    const state = stateOf(card)
    const entry = yield* conversations
      .appendEntry({
        kind: "card",
        conversationId: ctx.claims.conversationId,
        author: { kind: "bot", botId: ctx.claims.botId },
        card,
        state,
        ...(ctx.turnId === undefined ? {} : { turnId: ctx.turnId }),
      } as EntryDraft)
      .pipe(Effect.mapError(() => new InvalidInput({ message: "This conversation is gone." })))
    if (state.status === "pending") {
      const bot = yield* bots.get(ctx.claims.botId).pipe(Effect.orDie)
      yield* notifier.notify({
        kind: "waiting",
        botId: ctx.claims.botId,
        conversationId: ctx.claims.conversationId,
        title: Option.match(bot, { onNone: () => "OpenBot", onSome: (b) => b.name }),
        body: truncate(oneLine(card.fallback), 120),
      })
    }
    const result = { entryId: entry.id }
    if (key !== undefined) {
      byCall.set(key, result)
      if (byCall.size > 500) byCall.delete(byCall.keys().next().value!)
    }
    return result
  })

  const update = Effect.fn("UiCardService.update")(function* (ctx: ToolContext, entryId: EntryId, card: UiCardInput) {
    const entry = yield* uiCardEntry(entryId)
    if (
      entry.author.kind !== "bot" ||
      entry.author.botId !== ctx.claims.botId ||
      entry.conversationId !== ctx.claims.conversationId
    )
      return yield* new InvalidInput({ message: "You can only update a card you posted in this conversation." })
    let answered = entry.state.status === "resolved"
    if (!answered) {
      yield* conversations
        .updateEntry(entryId, (current) => {
          if (!isUiCard(current)) return current
          if (current.state.status === "resolved") {
            answered = true
            return current
          }
          return { ...current, card, state: stateOf(card) }
        })
        .pipe(Effect.orDie)
    }
    if (answered)
      return yield* new InvalidInput({
        message: "The owner already answered this card, so it can't change. Post a new one with show_ui.",
      })
  })

  const act = Effect.fn("UiCardService.act")(function* (input: {
    readonly entryId: EntryId
    readonly actionId: string
    readonly values: UiValues
  }) {
    const entry = yield* uiCardEntry(input.entryId)
    if (entry.state.status === "resolved") return yield* new AlreadyAnswered({ entryId: input.entryId })
    if (entry.state.status !== "pending")
      return yield* new InvalidInput({ message: "This card has nothing to answer." })
    if (!(entry.card.actions ?? []).some((a) => a.id === input.actionId))
      return yield* new InvalidInput({ message: `This card has no action "${input.actionId}".` })
    const problem = valuesProblem(entry.card, input.values)
    if (problem !== undefined) return yield* new InvalidInput({ message: problem })
    const answer: UiAnswer = { actionId: input.actionId, values: input.values, at: yield* Clock.currentTimeMillis }
    // the entry lock makes the answer one-shot when two presses race
    let won = false
    yield* conversations
      .updateEntry(input.entryId, (current) => {
        if (!isUiCard(current) || current.state.status !== "pending") return current
        won = true
        return { ...current, state: { status: "resolved", answer } }
      })
      .pipe(Effect.orDie)
    if (!won) return yield* new AlreadyAnswered({ entryId: input.entryId })
    if (entry.author.kind !== "bot") return
    yield* orchestrator
      .deliver({
        conversationId: entry.conversationId,
        botId: entry.author.botId,
        kind: "user-message",
        text: uiAnswerText(entry.card, answer),
        urgency: "urgent",
        sourceEntryId: input.entryId,
      })
      .pipe(
        Effect.catch((error) => Effect.logWarning(`UiCardService: answer to ${input.entryId} not delivered`, error)),
      )
  })

  return UiCardService.of({ show, update, act })
})

export const UiCardServiceLive = Layer.effect(UiCardService, makeUiCardService)
