/**
 * UsageService (architecture §4.3): records per-step/turn usage reported by harnesses (TurnIngest)
 * and aggregates it per bot for Settings › Usage (`usage.byBot`).
 */
import type { BotUsage } from "@openbot/contracts"
import { Clock, Effect, Layer } from "effect"
import { UsageRepo } from "../../ports/repos.ts"
import { UsageService } from "../../ports/services.ts"

export const makeUsageService = Effect.gen(function* () {
  const repo = yield* UsageRepo
  return UsageService.of({
    // Usage is bookkeeping: a storage failure is logged, never propagated into a turn.
    record: (input) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        yield* repo.record({
          botId: input.botId,
          conversationId: input.conversationId,
          turnId: input.turnId,
          harness: input.harness,
          model: input.model,
          at,
          usage: input.usage,
        })
      }).pipe(Effect.catch((error) => Effect.logWarning("UsageService.record failed", error))),
    byBot: ({ sinceMs }) =>
      repo.totalsByBot(sinceMs).pipe(
        Effect.orDie,
        Effect.map((totals) =>
          totals.map((t): BotUsage => ({ botId: t.botId, usage: t.usage, turnCount: t.turnCount, lastAt: t.lastAt })),
        ),
      ),
  })
})

export const UsageServiceLive: Layer.Layer<UsageService, never, UsageRepo> = Layer.effect(
  UsageService,
  makeUsageService,
)
