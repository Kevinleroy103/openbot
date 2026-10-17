/** `ApprovalRuleRepo`, `SettingsRepo` and `UsageRepo` over SQLite. */
import type { BotId, Millis, Usage } from "@openbot/contracts"
import { ApprovalRule } from "@openbot/contracts"
import { ApprovalRuleRepo, SettingsRepo, UsageRecord, UsageRepo, type UsageTotals } from "@openbot/core"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { decodeRawJson, encodeRawJson, jsonCodec, repoOp } from "../codec.ts"

interface PayloadRow {
  readonly id: string
  readonly payload_json: string
}

const RuleJson = jsonCodec(ApprovalRule, "approval rule")
const UsageJson = jsonCodec(UsageRecord, "usage record")

export const makeSqlApprovalRuleRepo = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return ApprovalRuleRepo.of({
    get: (id) =>
      Effect.gen(function*() {
        const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM approval_rules WHERE id = ${id}`
        const row = rows[0]
        return row === undefined
          ? Option.none()
          : Option.some(yield* RuleJson.decode("ApprovalRuleRepo.get", row.payload_json, row.id))
      }).pipe(repoOp("ApprovalRuleRepo.get")),
    list: (filter) =>
      Effect.gen(function*() {
        const rows = filter?.botId === undefined
          ? yield* sql<PayloadRow>`SELECT id, payload_json FROM approval_rules ORDER BY created_at, rowid`
          : yield* sql<PayloadRow>`SELECT id, payload_json FROM approval_rules
              WHERE bot_id IS NULL OR bot_id = ${filter.botId} ORDER BY created_at, rowid`
        return yield* Effect.forEach(rows, (row) => RuleJson.decode("ApprovalRuleRepo.list", row.payload_json, row.id))
      }).pipe(repoOp("ApprovalRuleRepo.list")),
    upsert: (rule) =>
      Effect.gen(function*() {
        const payload = yield* RuleJson.encode("ApprovalRuleRepo.upsert", rule)
        yield* sql`INSERT INTO approval_rules (id, bot_id, created_at, payload_json)
          VALUES (${rule.id}, ${rule.botId ?? null}, ${rule.createdAt}, ${payload})
          ON CONFLICT (id) DO UPDATE SET bot_id = excluded.bot_id, created_at = excluded.created_at,
            payload_json = excluded.payload_json`
      }).pipe(repoOp("ApprovalRuleRepo.upsert")),
    delete: (id) =>
      sql<{ id: string }>`DELETE FROM approval_rules WHERE id = ${id} RETURNING id`.pipe(
        Effect.map((rows) => rows.length > 0),
        repoOp("ApprovalRuleRepo.delete"),
      ),
  })
})

export const makeSqlSettingsRepo = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return SettingsRepo.of({
    get: (key) =>
      Effect.gen(function*() {
        const rows = yield* sql<{ value_json: string }>`SELECT value_json FROM settings WHERE key = ${key}`
        const row = rows[0]
        return row === undefined ? Option.none() : Option.some(yield* decodeRawJson("SettingsRepo.get", row.value_json, key))
      }).pipe(repoOp("SettingsRepo.get")),
    getAll: Effect.gen(function*() {
      const rows = yield* sql<{ key: string; value_json: string }>`SELECT key, value_json FROM settings ORDER BY key`
      const values = new Map<string, unknown>()
      for (const row of rows) values.set(row.key, yield* decodeRawJson("SettingsRepo.getAll", row.value_json, row.key))
      return values as ReadonlyMap<string, unknown>
    }).pipe(repoOp("SettingsRepo.getAll")),
    set: (key, value) =>
      Effect.gen(function*() {
        const json = yield* encodeRawJson("SettingsRepo.set", value)
        yield* sql`INSERT INTO settings (key, value_json) VALUES (${key}, ${json})
          ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`
      }).pipe(repoOp("SettingsRepo.set")),
    remove: (key) => sql`DELETE FROM settings WHERE key = ${key}`.pipe(Effect.asVoid, repoOp("SettingsRepo.remove")),
  })
})

/** Sum of two usages; optional counters stay absent unless either side has them (same as the in-memory double). */
export const addUsage = (a: Usage, b: Usage): Usage => {
  const sumOptional = (x: number | undefined, y: number | undefined) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0)
  const cached = sumOptional(a.cachedInputTokens, b.cachedInputTokens)
  const reasoning = sumOptional(a.reasoningTokens, b.reasoningTokens)
  const cost = sumOptional(a.costUsd, b.costUsd)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    ...(cost === undefined ? {} : { costUsd: cost }),
  }
}

export const makeSqlUsageRepo = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  const select = (op: string, filter: { readonly botId?: BotId | undefined; readonly sinceMs?: Millis | undefined }) =>
    Effect.gen(function*() {
      const clauses = [
        ...(filter.botId === undefined ? [] : [sql`bot_id = ${filter.botId}`]),
        ...(filter.sinceMs === undefined ? [] : [sql`at >= ${filter.sinceMs}`]),
      ]
      const rows = yield* sql<{ seq: number; json: string }>`SELECT seq, json FROM usage WHERE ${sql.and(clauses)} ORDER BY seq`
      return yield* Effect.forEach(rows, (row) => UsageJson.decode(op, row.json, String(row.seq)))
    })

  return UsageRepo.of({
    record: (record) =>
      Effect.gen(function*() {
        const json = yield* UsageJson.encode("UsageRepo.record", record)
        yield* sql`INSERT INTO usage (bot_id, at, json) VALUES (${record.botId}, ${record.at}, ${json})`
      }).pipe(repoOp("UsageRepo.record")),
    totalsByBot: (sinceMs) =>
      Effect.gen(function*() {
        const records = yield* select("UsageRepo.totalsByBot", { sinceMs })
        const totals = new Map<BotId, { usage: Usage; records: number; turns: Set<string>; lastAt: Millis }>()
        for (const r of records) {
          const current = totals.get(r.botId)
          if (current === undefined) {
            totals.set(r.botId, {
              usage: r.usage,
              records: 1,
              turns: new Set(r.turnId === undefined ? [] : [r.turnId]),
              lastAt: r.at,
            })
          } else {
            current.usage = addUsage(current.usage, r.usage)
            current.records += 1
            if (r.turnId !== undefined) current.turns.add(r.turnId)
            current.lastAt = Math.max(current.lastAt, r.at) as Millis
          }
        }
        return [...totals.entries()]
          .map(([botId, t]): UsageTotals => ({ botId, usage: t.usage, records: t.records, turnCount: t.turns.size, lastAt: t.lastAt }))
          .sort((a, b) => (a.botId < b.botId ? -1 : a.botId > b.botId ? 1 : 0))
      }).pipe(repoOp("UsageRepo.totalsByBot")),
    list: (filter) => select("UsageRepo.list", filter ?? {}).pipe(repoOp("UsageRepo.list")),
  })
})
