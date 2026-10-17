/** `McpTokenRepo` and `ProcessLedger` over SQLite. */
import { McpClaims, McpTokenRepo, ProcessLedger, type ProcessRecord } from "@openbot/core"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { bool, jsonCodec, repoOp } from "../codec.ts"

const ClaimsJson = jsonCodec(McpClaims, "MCP token claims")

interface TokenRow {
  readonly hash: string
  readonly claims_json: string
  readonly created_at: number
  readonly expires_at: number | null
  readonly revoked: number
}

export const makeSqlMcpTokenRepo = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return McpTokenRepo.of({
    put: (record) =>
      Effect.gen(function*() {
        const claims = yield* ClaimsJson.encode("McpTokenRepo.put", record.claims)
        yield* sql`INSERT INTO mcp_tokens (hash, bot_id, claims_json, created_at, expires_at, revoked)
          VALUES (${record.hash}, ${record.claims.botId}, ${claims}, ${record.createdAt}, ${record.expiresAt ?? null}, ${
          bool(record.revoked)
        })
          ON CONFLICT (hash) DO UPDATE SET bot_id = excluded.bot_id, claims_json = excluded.claims_json,
            created_at = excluded.created_at, expires_at = excluded.expires_at, revoked = excluded.revoked`
      }).pipe(repoOp("McpTokenRepo.put")),
    lookup: (hash) =>
      Effect.gen(function*() {
        const rows = yield* sql<TokenRow>`SELECT hash, claims_json, created_at, expires_at, revoked FROM mcp_tokens
          WHERE hash = ${hash}`
        const row = rows[0]
        if (row === undefined) return Option.none()
        const claims = yield* ClaimsJson.decode("McpTokenRepo.lookup", row.claims_json, "token")
        return Option.some({
          hash: row.hash,
          claims,
          createdAt: row.created_at,
          ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
          revoked: row.revoked !== 0,
        })
      }).pipe(repoOp("McpTokenRepo.lookup")),
    revoke: (hash) =>
      sql`UPDATE mcp_tokens SET revoked = 1 WHERE hash = ${hash}`.pipe(Effect.asVoid, repoOp("McpTokenRepo.revoke")),
    revokeAll: (botId) =>
      (botId === undefined
        ? sql`UPDATE mcp_tokens SET revoked = 1 WHERE revoked = 0`
        : sql`UPDATE mcp_tokens SET revoked = 1 WHERE bot_id = ${botId} AND revoked = 0`).pipe(
          Effect.asVoid,
          repoOp("McpTokenRepo.revokeAll"),
        ),
  })
})

interface LedgerRow {
  readonly pid: number
  readonly pgid: number
  readonly kind: string
  readonly label: string | null
  readonly started_at: number
}

export const makeSqlProcessLedger = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return ProcessLedger.of({
    record: (entry) =>
      sql`INSERT INTO process_ledger (pid, pgid, kind, label, started_at)
        VALUES (${entry.pid}, ${entry.pgid}, ${entry.kind}, ${entry.label ?? null}, ${entry.startedAt})
        ON CONFLICT (pid) DO UPDATE SET pgid = excluded.pgid, kind = excluded.kind, label = excluded.label,
          started_at = excluded.started_at`.pipe(Effect.asVoid, repoOp("ProcessLedger.record")),
    remove: (pid) => sql`DELETE FROM process_ledger WHERE pid = ${pid}`.pipe(Effect.asVoid, repoOp("ProcessLedger.remove")),
    list: sql<LedgerRow>`SELECT pid, pgid, kind, label, started_at FROM process_ledger ORDER BY started_at, pid`.pipe(
      Effect.map((rows) =>
        rows.map((row): ProcessRecord => ({
          pid: row.pid,
          pgid: row.pgid,
          kind: row.kind,
          ...(row.label === null ? {} : { label: row.label }),
          startedAt: row.started_at,
        }))
      ),
      repoOp("ProcessLedger.list"),
    ),
    clear: sql`DELETE FROM process_ledger`.pipe(Effect.asVoid, repoOp("ProcessLedger.clear")),
  })
})
