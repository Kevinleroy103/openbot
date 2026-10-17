/**
 * SettingsService (architecture §4.3, D5.6): typed owner settings with decoding defaults over
 * `SettingsRepo` (one key per `Settings` field, see `readSettings`), plus approval-rule CRUD over
 * `ApprovalRuleRepo` (`rules.*`). Settings changes are persisted, then published to the roster
 * (`settings.updated`) and emitted on `changes`.
 */
import type { ApprovalRule, ApprovalRuleId, Settings, SettingsPatch } from "@openbot/contracts"
import { applySettingsPatch, cleanProjectFolders, InvalidInput, NotFound, SettingsPatch as SettingsPatchSchema } from "@openbot/contracts"
import { Clock, Effect, Layer, Option, Result, Schema, Semaphore, SubscriptionRef } from "effect"
import { IdGen } from "../../ports/IdGen.ts"
import { ApprovalRuleRepo, BotRepo, readSettings, SettingsRepo, writeSettings } from "../../ports/repos.ts"
import { LiveHub, SettingsService } from "../../ports/services.ts"
import { validateRuleMatch } from "./policy.ts"

const decodePatch = Schema.decodeUnknownResult(SettingsPatchSchema)

export const makeSettingsService = Effect.gen(function*() {
  const repo = yield* SettingsRepo
  const rulesRepo = yield* ApprovalRuleRepo
  const bots = yield* BotRepo
  const hub = yield* LiveHub
  const ids = yield* IdGen

  const initial = yield* Effect.provideService(readSettings, SettingsRepo, repo).pipe(Effect.orDie)
  const state = yield* SubscriptionRef.make<Settings>(initial)
  const lock = yield* Semaphore.make(1)

  const update = (patch: SettingsPatch) =>
    lock.withPermits(1)(Effect.gen(function*() {
      const decoded = decodePatch(patch)
      if (Result.isFailure(decoded)) {
        return yield* new InvalidInput({ message: `Invalid settings: ${String(decoded.failure)}` })
      }
      let accepted = decoded.success
      if (accepted.sharedProjectFolders !== undefined) {
        const cleaned = cleanProjectFolders(accepted.sharedProjectFolders)
        if ("problem" in cleaned) return yield* new InvalidInput({ message: cleaned.problem })
        accepted = { ...accepted, sharedProjectFolders: cleaned.folders }
      }
      const next = applySettingsPatch(yield* SubscriptionRef.get(state), accepted)
      yield* Effect.provideService(writeSettings(next), SettingsRepo, repo).pipe(Effect.orDie)
      yield* SubscriptionRef.set(state, next)
      yield* hub.publishRoster({ type: "settings.updated", settings: next })
      return next
    }))

  const upsertRule = Effect.fn("SettingsService.upsertRule")(function*(input: Parameters<SettingsService["Service"]["upsertRule"]>[0]) {
    const problem = validateRuleMatch(input.match)
    if (problem !== undefined) return yield* new InvalidInput({ message: problem })
    if (input.botId !== undefined) {
      const bot = yield* bots.get(input.botId).pipe(Effect.orDie)
      if (Option.isNone(bot)) return yield* new NotFound({ entity: "bot", id: input.botId })
    }
    const existing = input.id === undefined ? Option.none<ApprovalRule>() : yield* rulesRepo.get(input.id).pipe(Effect.orDie)
    if (input.id !== undefined && Option.isNone(existing)) {
      return yield* new NotFound({ entity: "rule", id: input.id })
    }
    const rule: ApprovalRule = {
      id: input.id ?? (yield* ids.ruleId),
      surface: input.surface,
      match: input.match,
      action: input.action,
      origin: Option.isSome(existing) ? (existing.value.origin ?? "user") : "user",
      createdAt: Option.isSome(existing) ? existing.value.createdAt : yield* Clock.currentTimeMillis,
      ...(input.botId === undefined ? {} : { botId: input.botId }),
      ...(input.note === undefined ? {} : { note: input.note }),
    }
    yield* rulesRepo.upsert(rule).pipe(Effect.orDie)
    return rule
  })

  return SettingsService.of({
    get: SubscriptionRef.get(state),
    update,
    changes: SubscriptionRef.changes(state),
    listRules: ({ botId }) => rulesRepo.list(botId === undefined ? undefined : { botId }).pipe(Effect.orDie),
    upsertRule,
    deleteRule: (ruleId: ApprovalRuleId) =>
      rulesRepo.delete(ruleId).pipe(
        Effect.orDie,
        Effect.flatMap((deleted) => (deleted ? Effect.void : Effect.fail(new NotFound({ entity: "rule", id: ruleId })))),
      ),
  })
})

/** `SettingsService` over `SettingsRepo` + `ApprovalRuleRepo`; publishes `settings.updated`. */
export const SettingsServiceLive: Layer.Layer<
  SettingsService,
  never,
  SettingsRepo | ApprovalRuleRepo | BotRepo | LiveHub | IdGen
> = Layer.effect(SettingsService, makeSettingsService)
