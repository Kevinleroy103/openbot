/**
 * Migration 0002 "one mind per bot": a bot adopts its DM's native session; group sessions are
 * dropped; non-direct conversations lose their per-conversation context-ring rows.
 */
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { BotRepo, ConversationRepo, TaskRepo } from "@openbot/core"
import { botId, conversationId, entryId, makeTask, makeToolCallEntry, taskId } from "@openbot/core/testing"
import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { join } from "node:path"
import Initial from "../src/migrations/0001_initial.ts"
import OneMind from "../src/migrations/0002_one_mind_per_bot.ts"
import { cleanupTempDirs, run, tempDataDir, testPersistence } from "./helpers.ts"

afterAll(cleanupTempDirs)

const conversationRow = (id: string, kind: string, payload: object) => ({
  id,
  kind,
  last_activity_at: 1,
  hidden: 0,
  payload_json: JSON.stringify({ id, kind, title: id, createdAt: 1, lastActivityAt: 1, unreadCount: 0, hiddenFromSidebar: false, epoch: "epc_1", ...payload }),
})

const sessionRow = (conversation: string, bot: string, native: string, extra: object = {}) => ({
  conversation_id: conversation,
  bot_id: bot,
  driver: "claude",
  native_session_id: native,
  updated_at: 5,
  payload_json: JSON.stringify({ conversationId: conversation, botId: bot, driver: "claude", nativeSessionId: native, updatedAt: 5, ...extra }),
})

describe("0002_one_mind_per_bot", () => {
  test("adopts each bot's DM session, drops its group sessions and the groups' context rows", async () => {
    const dir = await tempDataDir()
    // A database at schema 0001 with per-(conversation, bot) sessions.
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord({ "0001_initial": Initial }) })
        const sql = yield* SqlClient.SqlClient
        const ring = { sessions: [{ botId: "bot_ada", active: true, contextUsage: { usedTokens: 10, windowTokens: 100 }, updatedAt: 1 }] }
        yield* sql`INSERT INTO conversations ${
          sql.insert([
            conversationRow("cnv_ada", "direct", { botId: "bot_ada", ...ring }),
            conversationRow("cnv_bob", "direct", { botId: "bot_bob" }),
            conversationRow("cnv_group", "group", { memberBotIds: ["bot_ada", "bot_bob"], namedBy: "user", ...ring }),
          ])
        }`
        yield* sql`INSERT INTO native_sessions ${
          sql.insert([
            sessionRow("cnv_ada", "bot_ada", "dm-session", { instructionsHash: "h1" }),
            sessionRow("cnv_group", "bot_ada", "group-session-ada", { lastSeenEntryId: "ent_9" }),
            // Bob only ever worked in the group: nothing to adopt.
            sessionRow("cnv_group", "bot_bob", "group-session-bob"),
          ])
        }`
      }).pipe(Effect.provide(SqliteClient.layer({ filename: join(dir, "openbot.sqlite") }))),
    )
    const out = await run(
      Effect.gen(function*() {
        const bots = yield* BotRepo
        const conversations = yield* ConversationRepo
        const sql = yield* SqlClient.SqlClient
        const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'native_sessions'`
        return {
          ada: yield* bots.getSession(botId("bot_ada")),
          bob: yield* bots.getSession(botId("bot_bob")),
          dm: yield* conversations.get(conversationId("cnv_ada")),
          group: yield* conversations.get(conversationId("cnv_group")),
          legacyTable: tables.length,
        }
      }),
      testPersistence(dir),
    )
    expect(Option.getOrThrow(out.ada) as unknown).toEqual({ botId: "bot_ada", driver: "claude", nativeSessionId: "dm-session", instructionsHash: "h1", updatedAt: 5 })
    expect(Option.isNone(out.bob)).toBe(true)
    expect(out.legacyTable).toBe(0)
    expect(Option.getOrThrow(out.dm).sessions).toHaveLength(1)
    expect(Option.getOrThrow(out.group).sessions).toBeUndefined()
  })
})

describe("0003_background_tasks", () => {
  test("a 0002 database gains the tasks tables; tasks and their steps round-trip", async () => {
    const dir = await tempDataDir()
    await Effect.runPromise(
      SqliteMigrator.run({ loader: SqliteMigrator.fromRecord({ "0001_initial": Initial, "0002_one_mind_per_bot": OneMind }) }).pipe(
        Effect.provide(SqliteClient.layer({ filename: join(dir, "openbot.sqlite") })),
      ),
    )
    const out = await run(
      Effect.gen(function*() {
        const tasks = yield* TaskRepo
        yield* tasks.upsert(makeTask({ id: taskId("tsk_1"), botId: botId("bot_ada"), status: "running", startedAt: 1 }))
        yield* tasks.putStep(taskId("tsk_1"), makeToolCallEntry({ id: entryId("ent_step"), status: "running" }))
        return { task: yield* tasks.get(taskId("tsk_1")), steps: yield* tasks.steps(taskId("tsk_1")) }
      }),
      testPersistence(dir),
    )
    expect(Option.getOrThrow(out.task).status).toBe("running")
    expect(out.steps.map((s) => s.id)).toEqual([entryId("ent_step")])
  })
})
