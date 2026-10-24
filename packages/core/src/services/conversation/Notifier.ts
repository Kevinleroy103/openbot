/**
 * Notifier (architecture §3.5): web notifications in v1. Honors the bot's `notify` preference and
 * publishes a roster `notification` change.
 *
 * Preference rules: `all` → every kind; `mentions` → only what needs the owner (`waiting`, `error`);
 * `none` → nothing (returns `undefined`).
 */
import type { Notification, NotificationKind } from "@openbot/contracts"
import { Clock, Effect, Layer, Option } from "effect"
import { IdGen } from "../../ports/IdGen.ts"
import { Notifier } from "../../ports/Notifier.ts"
import { BotRepo } from "../../ports/repos.ts"
import { LiveHub } from "../../ports/services.ts"
import { compact, orDie } from "./internal/util.ts"

const MENTION_KINDS: ReadonlyArray<NotificationKind> = ["waiting", "error"]

export const NotifierLive: Layer.Layer<Notifier, never, LiveHub | BotRepo | IdGen> = Layer.effect(
  Notifier,
  Effect.gen(function* () {
    const hub = yield* LiveHub
    const bots = yield* BotRepo
    const ids = yield* IdGen
    return Notifier.of({
      notify: Effect.fn("Notifier.notify")(function* (input) {
        if (input.botId !== undefined) {
          const bot = yield* orDie(bots.get(input.botId))
          if (Option.isSome(bot)) {
            if (bot.value.notify === "none") return undefined
            if (bot.value.notify === "mentions" && !MENTION_KINDS.includes(input.kind)) return undefined
          }
        }
        const notification: Notification = compact({
          id: yield* ids.notificationId,
          kind: input.kind,
          botId: input.botId,
          conversationId: input.conversationId,
          title: input.title,
          body: input.body,
          at: yield* Clock.currentTimeMillis,
        })
        yield* hub.publishRoster({ type: "notification", notification })
        return notification
      }),
    })
  }),
)
