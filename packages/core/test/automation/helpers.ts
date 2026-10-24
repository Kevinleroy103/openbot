/** Shared setup for the automation service tests. */
import type { Bot, Conversation } from "@openbot/contracts"
import { Effect, Layer } from "effect"
import { BotRepo, ConversationRepo } from "../../src/ports/index.ts"
import {
  botId,
  conversationId,
  CoreServiceFakes,
  type DeliveryResult,
  makeBot,
  makeDirectConversation,
  makeGroupConversation,
  TestPorts,
} from "../../src/testing/index.ts"

export const BOT_A = makeBot({ id: botId("bot_a"), name: "Ada", directConversationId: conversationId("cnv_dm_a") })
export const BOT_B = makeBot({ id: botId("bot_b"), name: "Bob", directConversationId: conversationId("cnv_dm_b") })
export const DM_A = makeDirectConversation({ id: BOT_A.directConversationId, botId: BOT_A.id, title: "Ada" })
export const DM_B = makeDirectConversation({ id: BOT_B.directConversationId, botId: BOT_B.id, title: "Bob" })
export const GROUP = makeGroupConversation({ id: conversationId("cnv_group"), memberBotIds: [BOT_A.id, BOT_B.id] })

/** Ports + every service fake (replace the one under test by building the real layer on top). */
export const baseLayer = (options?: { readonly autoComplete?: DeliveryResult }) =>
  CoreServiceFakes(options?.autoComplete === undefined ? undefined : { autoComplete: options.autoComplete }).pipe(
    Layer.provideMerge(TestPorts()),
  )

/** Seeds two bots, their DMs and a group. */
export const seed = Effect.gen(function* () {
  const bots = yield* BotRepo
  const conversations = yield* ConversationRepo
  for (const bot of [BOT_A, BOT_B] satisfies ReadonlyArray<Bot>) yield* bots.upsert(bot)
  for (const c of [DM_A, DM_B, GROUP] satisfies ReadonlyArray<Conversation>) yield* conversations.upsert(c)
})

/** Yields until `check` holds (fibers forked by the services get to run); fails after `tries`. */
export const eventually = <E, R>(check: Effect.Effect<boolean, E, R>, tries = 200): Effect.Effect<void, E | Error, R> =>
  Effect.gen(function* () {
    for (let i = 0; i < tries; i++) {
      if (yield* check) return
      yield* Effect.yieldNow
    }
    return yield* Effect.fail(new Error("eventually: condition not met"))
  })
