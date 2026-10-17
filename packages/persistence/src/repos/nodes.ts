/** `NodeRepo` over SQLite: node records (incl. public keys) and single-use pairing codes. */
import { NodeRecord, NodeRepo, type PairingCodeRecord } from "@openbot/core"
import type { Millis } from "@openbot/contracts"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { jsonCodec, repoOp } from "../codec.ts"

interface PayloadRow {
  readonly id: string
  readonly payload_json: string
}

const NodeJson = jsonCodec(NodeRecord, "node")

export const makeSqlNodeRepo = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const first = (op: string, rows: ReadonlyArray<PayloadRow>) => {
    const row = rows[0]
    return row === undefined
      ? Effect.succeed(Option.none<NodeRecord>())
      : Effect.map(NodeJson.decode(op, row.payload_json, row.id), Option.some)
  }

  return NodeRepo.of({
    get: (id) =>
      sql<PayloadRow>`SELECT id, payload_json FROM nodes WHERE id = ${id}`.pipe(
        Effect.flatMap((rows) => first("NodeRepo.get", rows)),
        repoOp("NodeRepo.get"),
      ),
    list: Effect.gen(function*() {
      const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM nodes ORDER BY created_at, rowid`
      return yield* Effect.forEach(rows, (row) => NodeJson.decode("NodeRepo.list", row.payload_json, row.id))
    }).pipe(repoOp("NodeRepo.list")),
    findByPublicKey: (publicKey) =>
      sql<PayloadRow>`SELECT id, payload_json FROM nodes WHERE public_key = ${publicKey} ORDER BY created_at, rowid LIMIT 1`.pipe(
        Effect.flatMap((rows) => first("NodeRepo.findByPublicKey", rows)),
        repoOp("NodeRepo.findByPublicKey"),
      ),
    upsert: (node) =>
      Effect.gen(function*() {
        const payload = yield* NodeJson.encode("NodeRepo.upsert", node)
        yield* sql`INSERT INTO nodes (id, public_key, created_at, payload_json)
          VALUES (${node.id}, ${node.publicKey ?? null}, ${node.createdAt}, ${payload})
          ON CONFLICT (id) DO UPDATE SET public_key = excluded.public_key, created_at = excluded.created_at,
            payload_json = excluded.payload_json`
      }).pipe(repoOp("NodeRepo.upsert")),
    delete: (id) =>
      sql<{ id: string }>`DELETE FROM nodes WHERE id = ${id} RETURNING id`.pipe(
        Effect.map((rows) => rows.length > 0),
        repoOp("NodeRepo.delete"),
      ),
    putPairingCode: (record) =>
      sql`INSERT INTO pairing_codes (code, created_at, expires_at) VALUES (${record.code}, ${record.createdAt}, ${record.expiresAt})
        ON CONFLICT (code) DO UPDATE SET created_at = excluded.created_at, expires_at = excluded.expires_at`.pipe(
        Effect.asVoid,
        repoOp("NodeRepo.putPairingCode"),
      ),
    consumePairingCode: (code, now) =>
      // A single statement: deleting and returning the row makes the code single-use atomically.
      sql<{ code: string; created_at: number; expires_at: number }>`DELETE FROM pairing_codes WHERE code = ${code}
        RETURNING code, created_at, expires_at`.pipe(
        Effect.map((rows) => {
          const row = rows[0]
          if (row === undefined || !(now < row.expires_at)) return Option.none<PairingCodeRecord>()
          return Option.some<PairingCodeRecord>({
            code: row.code,
            createdAt: row.created_at as Millis,
            expiresAt: row.expires_at as Millis,
          })
        }),
        repoOp("NodeRepo.consumePairingCode"),
      ),
  })
})
