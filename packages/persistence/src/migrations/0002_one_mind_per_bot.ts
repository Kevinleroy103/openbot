/**
 * "One mind per bot" (docs/decisions.md D5.0): a bot keeps ONE native harness session shared by all
 * of its conversations instead of one per (bot, conversation).
 *
 * - `bot_sessions` (one row per bot) replaces `native_sessions` (one row per (conversation, bot)).
 * - Upgrade: each bot ADOPTS the native session of its direct conversation (its DM with the owner),
 *   when it has one, keeping driver, native id and instructions hash; its group / routine-run
 *   sessions are dropped (their per-conversation `lastSeenEntryId` cursors belonged to those dropped
 *   sessions, so the adopted session starts without cursors: its next group turn gets a fresh
 *   catch-up window).
 * - The per-conversation context-ring rows (`Conversation.sessions`) of non-direct conversations
 *   are removed: the ring now lives on the bot's DM only.
 */
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE bot_sessions (
    bot_id TEXT PRIMARY KEY NOT NULL,
    driver TEXT NOT NULL,
    native_session_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  )`

  // Adopt the DM session: the direct conversation whose bot is the session's bot.
  yield* sql`INSERT INTO bot_sessions (bot_id, driver, native_session_id, updated_at, payload_json)
    SELECT ns.bot_id, ns.driver, ns.native_session_id, ns.updated_at,
      json_remove(ns.payload_json, '$.conversationId', '$.lastSeenEntryId')
    FROM native_sessions ns
    JOIN conversations c ON c.id = ns.conversation_id
    WHERE c.kind = 'direct' AND json_extract(c.payload_json, '$.botId') = ns.bot_id`

  yield* sql`DROP TABLE native_sessions`

  yield* sql`UPDATE conversations SET payload_json = json_remove(payload_json, '$.sessions')
    WHERE kind <> 'direct' AND json_extract(payload_json, '$.sessions') IS NOT NULL`
})
