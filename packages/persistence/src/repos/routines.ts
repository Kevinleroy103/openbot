/** `RoutineRepo` over SQLite (routines + runs; only the newest `ROUTINE_RUNS_KEPT` runs per routine). */
import { ROUTINE_RUNS_KEPT, Routine, RoutineRun } from "@openbot/contracts"
import { RoutineRepo } from "@openbot/core"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { jsonCodec, repoOp } from "../codec.ts"

interface PayloadRow {
  readonly id: string
  readonly payload_json: string
}

const RoutineJson = jsonCodec(Routine, "routine")
const RunJson = jsonCodec(RoutineRun, "routine run")

export const makeSqlRoutineRepo = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  return RoutineRepo.of({
    get: (id) =>
      Effect.gen(function*() {
        const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM routines WHERE id = ${id}`
        const row = rows[0]
        return row === undefined
          ? Option.none()
          : Option.some(yield* RoutineJson.decode("RoutineRepo.get", row.payload_json, row.id))
      }).pipe(repoOp("RoutineRepo.get")),
    list: (filter) =>
      Effect.gen(function*() {
        const rows = filter?.botId === undefined
          ? yield* sql<PayloadRow>`SELECT id, payload_json FROM routines ORDER BY created_at, rowid`
          : yield* sql<PayloadRow>`SELECT id, payload_json FROM routines WHERE bot_id = ${filter.botId}
              ORDER BY created_at, rowid`
        return yield* Effect.forEach(rows, (row) => RoutineJson.decode("RoutineRepo.list", row.payload_json, row.id))
      }).pipe(repoOp("RoutineRepo.list")),
    upsert: (routine) =>
      Effect.gen(function*() {
        const payload = yield* RoutineJson.encode("RoutineRepo.upsert", routine)
        yield* sql`INSERT INTO routines (id, bot_id, created_at, payload_json)
          VALUES (${routine.id}, ${routine.botId}, ${routine.createdAt}, ${payload})
          ON CONFLICT (id) DO UPDATE SET bot_id = excluded.bot_id, created_at = excluded.created_at,
            payload_json = excluded.payload_json`
      }).pipe(repoOp("RoutineRepo.upsert")),
    delete: (id) =>
      Effect.gen(function*() {
        yield* sql`DELETE FROM routine_runs WHERE routine_id = ${id}`
        const rows = yield* sql<{ id: string }>`DELETE FROM routines WHERE id = ${id} RETURNING id`
        return rows.length > 0
      }).pipe(sql.withTransaction, repoOp("RoutineRepo.delete")),
    upsertRun: (run) =>
      Effect.gen(function*() {
        const payload = yield* RunJson.encode("RoutineRepo.upsertRun", run)
        yield* sql`INSERT INTO routine_runs (id, routine_id, started_at, status, payload_json)
          VALUES (${run.id}, ${run.routineId}, ${run.startedAt}, ${run.status}, ${payload})
          ON CONFLICT (id) DO UPDATE SET routine_id = excluded.routine_id, started_at = excluded.started_at,
            status = excluded.status, payload_json = excluded.payload_json`
        yield* sql`DELETE FROM routine_runs WHERE routine_id = ${run.routineId} AND id NOT IN (
          SELECT id FROM routine_runs WHERE routine_id = ${run.routineId}
          ORDER BY started_at DESC, id DESC LIMIT ${ROUTINE_RUNS_KEPT})`
      }).pipe(sql.withTransaction, repoOp("RoutineRepo.upsertRun")),
    getRun: (id) =>
      Effect.gen(function*() {
        const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM routine_runs WHERE id = ${id}`
        const row = rows[0]
        return row === undefined ? Option.none() : Option.some(yield* RunJson.decode("RoutineRepo.getRun", row.payload_json, row.id))
      }).pipe(repoOp("RoutineRepo.getRun")),
    listRuns: (routineId) =>
      Effect.gen(function*() {
        const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM routine_runs WHERE routine_id = ${routineId}
          ORDER BY started_at DESC, id DESC`
        return yield* Effect.forEach(rows, (row) => RunJson.decode("RoutineRepo.listRuns", row.payload_json, row.id))
      }).pipe(repoOp("RoutineRepo.listRuns")),
  })
})
