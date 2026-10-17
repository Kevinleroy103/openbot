/**
 * MemoryService (D5.4, architecture §4.3): per-bot memory in Claude auto-memory format over
 * `MemoryStore` — `MEMORY.md` (index) plus one file per fact. Fact writes keep the index line in
 * sync (`memoryIndex.ts`). Bot-originated changes (`remember` / `forget` tools) append a
 * `memory-updated` event ("Updated memory for ‹Bot›") into the conversation the bot works in.
 */
import type { BotId, ConversationId, MemoryFact, MemoryFactId, MemoryFactInput } from "@openbot/contracts"
import {
  InvalidInput,
  MEMORY_INDEX_PROMPT_CAP_BYTES,
  MemoryFactId as MemoryFactIdSchema,
  memoryFactIdFromTitle,
  NotFound,
} from "@openbot/contracts"
import { Clock, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { BotRepo } from "../../ports/repos.ts"
import { type Actor, ConversationService, MemoryService } from "../../ports/services.ts"
import { MemoryStore } from "../../ports/stores.ts"
import { removeIndexLine, upsertIndexLine } from "./memoryIndex.ts"
import { capUtf8, utf8Length } from "./text.ts"

/** Limits that keep memory files reasonable (and model-readable refusals). */
export const MEMORY_LIMITS = {
  titleChars: 200,
  descriptionChars: 300,
  factBodyBytes: 32 * 1024,
  indexBytes: 64 * 1024,
} as const

const isFactId = Schema.is(MemoryFactIdSchema)

export const makeMemoryService = Effect.gen(function*() {
  const store = yield* MemoryStore
  const bots = yield* BotRepo
  const conversations = yield* ConversationService
  // Index updates are read-modify-write; serialize them (one brain, few writes).
  const lock = yield* Semaphore.make(1)

  const requireBot = (botId: BotId) =>
    bots.get(botId).pipe(
      Effect.orDie,
      Effect.flatMap(Option.match({
        onNone: () => Effect.fail(new NotFound({ entity: "bot", id: botId })),
        onSome: Effect.succeed,
      })),
    )

  /** A bot may only change its own memory (model-readable refusal). */
  const checkActor = (actor: Actor, botId: BotId) =>
    actor.kind === "bot" && actor.tool.claims.botId !== botId
      ? Effect.fail(new InvalidInput({ message: "A bot can only change its own memory." }))
      : Effect.void

  const read = (botId: BotId) => Effect.all({ index: store.readIndex(botId), facts: store.listFacts(botId) }).pipe(Effect.orDie)

  const emit = (actor: Actor, botId: BotId, action: "remembered" | "forgot" | "edited", title: string | undefined) => {
    if (actor.kind !== "bot") return Effect.void
    const conversationId: ConversationId = actor.tool.claims.conversationId
    return conversations.appendEvent({
      conversationId,
      author: { kind: "bot", botId },
      event: { type: "memory-updated", botId, action, ...(title === undefined ? {} : { title }) },
    }).pipe(
      Effect.asVoid,
      Effect.catch((error) => Effect.logWarning("MemoryService: memory-updated event not written", error)),
    )
  }

  const validate = (input: MemoryFactInput) => {
    const title = input.title.trim()
    if (title.length === 0) return Effect.fail(new InvalidInput({ message: "A memory needs a title." }))
    if ([...title].length > MEMORY_LIMITS.titleChars) {
      return Effect.fail(new InvalidInput({ message: `The title is too long (max ${MEMORY_LIMITS.titleChars} characters).` }))
    }
    if (input.description !== undefined && [...input.description].length > MEMORY_LIMITS.descriptionChars) {
      return Effect.fail(
        new InvalidInput({ message: `The description is too long (max ${MEMORY_LIMITS.descriptionChars} characters).` }),
      )
    }
    if (utf8Length(input.body) > MEMORY_LIMITS.factBodyBytes) {
      return Effect.fail(new InvalidInput({ message: `The memory is too long (max ${MEMORY_LIMITS.factBodyBytes / 1024} KB).` }))
    }
    if (input.id !== undefined && !isFactId(input.id)) {
      return Effect.fail(new InvalidInput({ message: `Invalid memory id "${input.id}" (use a lower-case slug).` }))
    }
    return Effect.succeed(title)
  }

  const putFact = (actor: Actor, botId: BotId, input: MemoryFactInput) =>
    Effect.gen(function*() {
      yield* requireBot(botId)
      yield* checkActor(actor, botId)
      const title = yield* validate(input)
      const id: MemoryFactId = input.id ?? memoryFactIdFromTitle(title)
      const { existed, fact } = yield* lock.withPermits(1)(Effect.gen(function*() {
        const previous = yield* store.getFact(botId, id).pipe(Effect.orDie)
        const next: MemoryFact = {
          id,
          title,
          body: input.body,
          updatedAt: yield* Clock.currentTimeMillis,
          ...(input.description === undefined ? {} : { description: input.description }),
        }
        yield* store.putFact(botId, next).pipe(Effect.orDie)
        const index = yield* store.readIndex(botId).pipe(Effect.orDie)
        yield* store.writeIndex(botId, upsertIndexLine(index, next)).pipe(Effect.orDie)
        return { existed: Option.isSome(previous), fact: next }
      }))
      yield* emit(actor, botId, existed ? "edited" : "remembered", fact.title)
      return fact
    })

  const deleteFact = (actor: Actor, botId: BotId, factId: MemoryFactId) =>
    Effect.gen(function*() {
      yield* requireBot(botId)
      if (actor.kind === "bot" && actor.tool.claims.botId !== botId) {
        // deleteFact's error channel is NotFound only: another bot's memory is invisible.
        return yield* new NotFound({ entity: "memory-fact", id: factId })
      }
      const removed = yield* lock.withPermits(1)(Effect.gen(function*() {
        const previous = yield* store.getFact(botId, factId).pipe(Effect.orDie)
        const deleted = yield* store.deleteFact(botId, factId).pipe(Effect.orDie)
        if (!deleted) return Option.none<MemoryFact>()
        const index = yield* store.readIndex(botId).pipe(Effect.orDie)
        yield* store.writeIndex(botId, removeIndexLine(index, factId)).pipe(Effect.orDie)
        return previous
      }))
      if (Option.isNone(removed)) return yield* new NotFound({ entity: "memory-fact", id: factId })
      yield* emit(actor, botId, "forgot", removed.value.title)
    })

  return MemoryService.of({
    get: (botId) => requireBot(botId).pipe(Effect.andThen(read(botId))),
    putFact,
    deleteFact,
    setIndex: (botId, index) =>
      Effect.gen(function*() {
        yield* requireBot(botId)
        if (utf8Length(index) > MEMORY_LIMITS.indexBytes) {
          return yield* new InvalidInput({ message: `MEMORY.md is too long (max ${MEMORY_LIMITS.indexBytes / 1024} KB).` })
        }
        yield* lock.withPermits(1)(store.writeIndex(botId, index).pipe(Effect.orDie))
        return yield* read(botId)
      }),
    recall: (botId, query) =>
      Effect.gen(function*() {
        yield* requireBot(botId)
        const facts = yield* store.listFacts(botId).pipe(Effect.orDie)
        const q = query?.trim().toLowerCase() ?? ""
        if (q.length === 0) return facts
        return facts.filter((f) => `${f.title}\n${f.description ?? ""}\n${f.body}`.toLowerCase().includes(q))
      }),
    // Rendering instructions must not fail because of memory: a storage error yields "".
    promptIndex: (botId) =>
      store.readIndex(botId).pipe(
        Effect.map((index) => capUtf8(index, MEMORY_INDEX_PROMPT_CAP_BYTES)),
        Effect.catch((error) => Effect.logWarning("MemoryService.promptIndex failed", error).pipe(Effect.as(""))),
      ),
  })
})

export const MemoryServiceLive: Layer.Layer<MemoryService, never, MemoryStore | BotRepo | ConversationService> = Layer
  .effect(MemoryService, makeMemoryService)
