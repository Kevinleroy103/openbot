/**
 * Initial schema (architecture §4.4). Projection tables keep the indexed scalar columns needed by
 * the repository queries plus the whole entity as Schema-encoded `payload_json` (decoded on read).
 *
 * Foreign keys are used only for indexes the repositories maintain themselves
 * (`conversation_members`): the repository contract (shared with the in-memory doubles) allows
 * entries, requests, turns and runs to reference rows that are written later or never.
 */
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // ---------------------------------------------------------------- bots & sections
  yield* sql`CREATE TABLE bots (
    id TEXT PRIMARY KEY NOT NULL,
    created_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  )`
  yield* sql`CREATE INDEX bots_created_at ON bots (created_at, id)`

  yield* sql`CREATE TABLE sections (
    id TEXT PRIMARY KEY NOT NULL,
    sort_order REAL NOT NULL,
    payload_json TEXT NOT NULL
  )`

  // ---------------------------------------------------------------- conversations
  yield* sql`CREATE TABLE conversations (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    last_activity_at INTEGER NOT NULL,
    hidden INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  )`
  yield* sql`CREATE INDEX conversations_activity ON conversations (last_activity_at DESC, id)`

  yield* sql`CREATE TABLE conversation_members (
    conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, bot_id)
  )`
  yield* sql`CREATE INDEX conversation_members_bot ON conversation_members (bot_id)`

  yield* sql`CREATE TABLE native_sessions (
    conversation_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    driver TEXT NOT NULL,
    native_session_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (conversation_id, bot_id)
  )`
  yield* sql`CREATE INDEX native_sessions_bot ON native_sessions (bot_id)`

  // ---------------------------------------------------------------- transcript
  yield* sql`CREATE TABLE entries (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    turn_id TEXT,
    client_nonce TEXT,
    native_id TEXT,
    payload_json TEXT NOT NULL
  )`
  yield* sql`CREATE INDEX entries_conversation_order ON entries (conversation_id, created_at, id)`
  yield* sql`CREATE INDEX entries_turn ON entries (turn_id, created_at, id) WHERE turn_id IS NOT NULL`
  yield* sql`CREATE INDEX entries_client_nonce ON entries (conversation_id, client_nonce) WHERE client_nonce IS NOT NULL`
  yield* sql`CREATE INDEX entries_native_id ON entries (conversation_id, native_id) WHERE native_id IS NOT NULL`

  yield* sql`CREATE TABLE turns (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  )`
  yield* sql`CREATE INDEX turns_conversation ON turns (conversation_id, started_at, id)`
  yield* sql`CREATE INDEX turns_status ON turns (status, started_at, id)`

  yield* sql`CREATE TABLE requests (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    turn_id TEXT,
    status TEXT NOT NULL,
    native_request_id TEXT,
    created_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  )`
  yield* sql`CREATE INDEX requests_created ON requests (created_at, id)`
  yield* sql`CREATE INDEX requests_status ON requests (status, created_at)`
  yield* sql`CREATE INDEX requests_native ON requests (bot_id, native_request_id) WHERE native_request_id IS NOT NULL`

  // ---------------------------------------------------------------- routines
  yield* sql`CREATE TABLE routines (
    id TEXT PRIMARY KEY NOT NULL,
    bot_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  )`
  yield* sql`CREATE INDEX routines_bot ON routines (bot_id, created_at)`

  yield* sql`CREATE TABLE routine_runs (
    id TEXT PRIMARY KEY NOT NULL,
    routine_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`
  yield* sql`CREATE INDEX routine_runs_routine ON routine_runs (routine_id, started_at DESC, id DESC)`

  // ---------------------------------------------------------------- nodes
  yield* sql`CREATE TABLE nodes (
    id TEXT PRIMARY KEY NOT NULL,
    public_key TEXT,
    created_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  )`
  yield* sql`CREATE INDEX nodes_public_key ON nodes (public_key) WHERE public_key IS NOT NULL`

  yield* sql`CREATE TABLE pairing_codes (
    code TEXT PRIMARY KEY NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`

  // ---------------------------------------------------------------- policy, settings, usage
  yield* sql`CREATE TABLE approval_rules (
    id TEXT PRIMARY KEY NOT NULL,
    bot_id TEXT,
    created_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  )`

  yield* sql`CREATE TABLE settings (
    key TEXT PRIMARY KEY NOT NULL,
    value_json TEXT NOT NULL
  )`

  yield* sql`CREATE TABLE usage (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    json TEXT NOT NULL
  )`
  yield* sql`CREATE INDEX usage_bot_at ON usage (bot_id, at)`
  yield* sql`CREATE INDEX usage_at ON usage (at)`

  // ---------------------------------------------------------------- replica log (resume, D4.3)
  yield* sql`CREATE TABLE replica_heads (
    replica_key TEXT PRIMARY KEY NOT NULL,
    epoch TEXT NOT NULL,
    sequence INTEGER NOT NULL
  )`
  yield* sql`CREATE TABLE replica_log (
    replica_key TEXT NOT NULL,
    epoch TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    change_json TEXT NOT NULL,
    PRIMARY KEY (replica_key, sequence)
  )`

  // ---------------------------------------------------------------- gateway tokens, processes, attachments
  yield* sql`CREATE TABLE mcp_tokens (
    hash TEXT PRIMARY KEY NOT NULL,
    bot_id TEXT NOT NULL,
    claims_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked INTEGER NOT NULL
  )`
  yield* sql`CREATE INDEX mcp_tokens_bot ON mcp_tokens (bot_id)`

  yield* sql`CREATE TABLE process_ledger (
    pid INTEGER PRIMARY KEY NOT NULL,
    pgid INTEGER NOT NULL,
    kind TEXT NOT NULL,
    label TEXT,
    started_at INTEGER NOT NULL
  )`

  yield* sql`CREATE TABLE attachments (
    id TEXT PRIMARY KEY NOT NULL,
    created_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  )`
})
