/**
 * `ReplicaLog` over SQLite (D4.3 resume): per-replica head `{epoch, sequence}` in `replica_heads`
 * and the newest `REPLICA_LOG_WINDOW` changes in `replica_log`.
 */
import type { StreamCursor } from "@openbot/contracts"
import {
  REPLICA_LOG_WINDOW,
  ReplicaChange,
  type ReplicaKey,
  ReplicaLog,
  type ReplicaRecord,
  RepoError,
} from "@openbot/core"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { jsonCodec, repoOp } from "../codec.ts"

const ChangeJson = jsonCodec(ReplicaChange, "replica change")

export const makeSqlReplicaLog = (window: number = REPLICA_LOG_WINDOW) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const readHead = (replicaKey: ReplicaKey) =>
      Effect.map(
        sql<{
          epoch: string
          sequence: number
        }>`SELECT epoch, sequence FROM replica_heads WHERE replica_key = ${replicaKey}`,
        (rows) => {
          const row = rows[0]
          return row === undefined
            ? Option.none<StreamCursor>()
            : Option.some<StreamCursor>({ epoch: row.epoch, sequence: row.sequence })
        },
      )

    return ReplicaLog.of({
      head: (replicaKey) => readHead(replicaKey).pipe(repoOp("ReplicaLog.head")),

      append: (record) =>
        Effect.gen(function* () {
          const head = yield* readHead(record.replicaKey)
          if (Option.isSome(head)) {
            if (head.value.epoch !== record.epoch || record.sequence !== head.value.sequence + 1) {
              return yield* new RepoError({
                op: "ReplicaLog.append",
                message: `Out-of-order append to ${record.replicaKey}: head ${head.value.epoch}/${head.value.sequence}, got ${record.epoch}/${record.sequence}`,
              })
            }
          } else {
            // A replica never written (or reset) starts with an empty window.
            yield* sql`DELETE FROM replica_log WHERE replica_key = ${record.replicaKey}`
          }
          const change = yield* ChangeJson.encode("ReplicaLog.append", record.change)
          yield* sql`INSERT INTO replica_log (replica_key, epoch, sequence, change_json)
            VALUES (${record.replicaKey}, ${record.epoch}, ${record.sequence}, ${change})
            ON CONFLICT (replica_key, sequence) DO UPDATE SET epoch = excluded.epoch, change_json = excluded.change_json`
          yield* sql`DELETE FROM replica_log WHERE replica_key = ${record.replicaKey} AND sequence <= ${record.sequence - window}`
          yield* sql`INSERT INTO replica_heads (replica_key, epoch, sequence) VALUES (${record.replicaKey}, ${record.epoch}, ${record.sequence})
            ON CONFLICT (replica_key) DO UPDATE SET epoch = excluded.epoch, sequence = excluded.sequence`
        }).pipe(sql.withTransaction, repoOp("ReplicaLog.append")),

      readAfter: (replicaKey, cursor) =>
        Effect.gen(function* () {
          const head = yield* readHead(replicaKey)
          if (Option.isNone(head) || head.value.epoch !== cursor.epoch || cursor.sequence > head.value.sequence) {
            return Option.none()
          }
          if (cursor.sequence === head.value.sequence) return Option.some<ReadonlyArray<ReplicaRecord>>([])
          const oldest = yield* sql<{ oldest: number | null }>`SELECT MIN(sequence) AS oldest FROM replica_log
            WHERE replica_key = ${replicaKey} AND epoch = ${cursor.epoch}`
          const oldestSequence = oldest[0]?.oldest ?? null
          // The record right after the cursor must still be in the window.
          if (oldestSequence === null || oldestSequence > cursor.sequence + 1) return Option.none()
          const rows = yield* sql<{
            epoch: string
            sequence: number
            change_json: string
          }>`SELECT epoch, sequence, change_json
            FROM replica_log WHERE replica_key = ${replicaKey} AND epoch = ${cursor.epoch} AND sequence > ${cursor.sequence}
            ORDER BY sequence`
          const records = yield* Effect.forEach(rows, (row) =>
            Effect.map(
              ChangeJson.decode("ReplicaLog.readAfter", row.change_json, `${replicaKey}#${row.sequence}`),
              (change): ReplicaRecord => ({ replicaKey, epoch: row.epoch, sequence: row.sequence, change }),
            ),
          )
          return Option.some<ReadonlyArray<ReplicaRecord>>(records)
        }).pipe(sql.withTransaction, repoOp("ReplicaLog.readAfter")),

      reset: (replicaKey, epoch) =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM replica_log WHERE replica_key = ${replicaKey}`
          yield* sql`INSERT INTO replica_heads (replica_key, epoch, sequence) VALUES (${replicaKey}, ${epoch}, 0)
            ON CONFLICT (replica_key) DO UPDATE SET epoch = excluded.epoch, sequence = 0`
        }).pipe(sql.withTransaction, repoOp("ReplicaLog.reset")),

      drop: (replicaKey) =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM replica_log WHERE replica_key = ${replicaKey}`
          yield* sql`DELETE FROM replica_heads WHERE replica_key = ${replicaKey}`
        }).pipe(sql.withTransaction, repoOp("ReplicaLog.drop")),
    })
  })
