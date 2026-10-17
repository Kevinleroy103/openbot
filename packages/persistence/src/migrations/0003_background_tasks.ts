/**
 * Background tasks (docs/decisions.md D5.7): a bot's parallel work, run in short-lived sessions of
 * its own. `tasks` holds the task records; `task_steps` the transcript entries of each task's
 * session (tool calls, reasoning, messages) — kept apart from `entries` so they never show up as
 * chat bubbles.
 */
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE tasks (
    id TEXT PRIMARY KEY NOT NULL,
    bot_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  )`
  yield* sql`CREATE INDEX tasks_bot ON tasks (bot_id, created_at, id)`
  yield* sql`CREATE INDEX tasks_status ON tasks (status)`
  yield* sql`CREATE INDEX tasks_conversation ON tasks (conversation_id)`

  yield* sql`CREATE TABLE task_steps (
    task_id TEXT NOT NULL,
    id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (task_id, id)
  )`
  yield* sql`CREATE INDEX task_steps_order ON task_steps (task_id, created_at, id)`
})
