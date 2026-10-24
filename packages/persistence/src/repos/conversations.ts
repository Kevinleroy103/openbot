/** `ConversationRepo` over SQLite: conversations and the member index. */
import type { BotId, Conversation } from "@openbot/contracts"
import { Conversation as ConversationSchema } from "@openbot/contracts"
import { ConversationRepo } from "@openbot/core"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { bool, jsonCodec, repoOp } from "../codec.ts"

interface PayloadRow {
  readonly id: string
  readonly payload_json: string
}

const ConversationJson = jsonCodec(ConversationSchema, "conversation")

/** Member bot ids (direct: `[botId]`, group: `memberBotIds`, routine-run: `[botId]`). */
export const conversationMembers = (conversation: Conversation): ReadonlyArray<BotId> => {
  switch (conversation.kind) {
    case "direct":
    case "routine-run":
      return [conversation.botId]
    case "group":
      return conversation.memberBotIds
  }
}

export const makeSqlConversationRepo = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const getConversation = (op: string, id: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM conversations WHERE id = ${id}`
      const row = rows[0]
      return row === undefined
        ? Option.none<Conversation>()
        : Option.some(yield* ConversationJson.decode(op, row.payload_json, row.id))
    })

  return ConversationRepo.of({
    get: (id) => getConversation("ConversationRepo.get", id).pipe(repoOp("ConversationRepo.get")),

    list: (filter) =>
      Effect.gen(function* () {
        const clauses = [
          ...(filter?.kind === undefined ? [] : [sql`kind = ${filter.kind}`]),
          ...(filter?.botId === undefined
            ? []
            : [sql`id IN (SELECT conversation_id FROM conversation_members WHERE bot_id = ${filter.botId})`]),
          ...(filter?.includeHidden === false ? [sql`hidden = 0`] : []),
        ]
        const rows = yield* sql<PayloadRow>`SELECT id, payload_json FROM conversations
          WHERE ${sql.and(clauses)} ORDER BY last_activity_at DESC, id`
        return yield* Effect.forEach(rows, (row) =>
          ConversationJson.decode("ConversationRepo.list", row.payload_json, row.id),
        )
      }).pipe(repoOp("ConversationRepo.list")),

    upsert: (conversation) =>
      Effect.gen(function* () {
        const payload = yield* ConversationJson.encode("ConversationRepo.upsert", conversation)
        yield* sql`INSERT INTO conversations (id, kind, last_activity_at, hidden, payload_json)
          VALUES (${conversation.id}, ${conversation.kind}, ${conversation.lastActivityAt}, ${bool(
            conversation.hiddenFromSidebar,
          )}, ${payload})
          ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, last_activity_at = excluded.last_activity_at,
            hidden = excluded.hidden, payload_json = excluded.payload_json`
        yield* sql`DELETE FROM conversation_members WHERE conversation_id = ${conversation.id}`
        const members = conversationMembers(conversation)
        if (members.length > 0) {
          yield* sql`INSERT OR IGNORE INTO conversation_members ${sql.insert(
            members.map((botId, position) => ({ conversation_id: conversation.id, bot_id: botId, position })),
          )}`
        }
      }).pipe(sql.withTransaction, repoOp("ConversationRepo.upsert")),

    delete: (id) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM conversation_members WHERE conversation_id = ${id}`
        const rows = yield* sql<{ id: string }>`DELETE FROM conversations WHERE id = ${id} RETURNING id`
        return rows.length > 0
      }).pipe(sql.withTransaction, repoOp("ConversationRepo.delete")),

    members: (id) =>
      getConversation("ConversationRepo.members", id).pipe(
        Effect.map(Option.match({ onNone: (): ReadonlyArray<BotId> => [], onSome: conversationMembers })),
        repoOp("ConversationRepo.members"),
      ),
  })
})
