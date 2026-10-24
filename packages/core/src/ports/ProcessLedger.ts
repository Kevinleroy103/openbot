/**
 * `ProcessLedger` port (architecture §3.2, D2.5): pids/pgids of brain-owned children (harness CLIs,
 * app-servers, `opencode serve`) so boot recovery can kill leftovers from a previous run.
 */
import { Context, Effect, Schema } from "effect"
import type { RepoError } from "./errors.ts"

export const ProcessKind = Schema.Literals(["claude", "codex-app-server", "opencode-serve", "other"])
export type ProcessKind = typeof ProcessKind.Type

export const ProcessRecord = Schema.Struct({
  pid: Schema.Number,
  /** Process group id (children are spawned detached; kill the whole group). */
  pgid: Schema.Number,
  /** Open string; known values are `ProcessKind`. */
  kind: Schema.String,
  /** Free-form label for logs, e.g. the bot or CODEX_HOME. */
  label: Schema.optional(Schema.String),
  startedAt: Schema.Number,
})
export type ProcessRecord = typeof ProcessRecord.Type

export class ProcessLedger extends Context.Service<
  ProcessLedger,
  {
    readonly record: (entry: ProcessRecord) => Effect.Effect<void, RepoError>
    readonly remove: (pid: number) => Effect.Effect<void, RepoError>
    readonly list: Effect.Effect<ReadonlyArray<ProcessRecord>, RepoError>
    /** Removes every record (after boot recovery killed them). */
    readonly clear: Effect.Effect<void, RepoError>
  }
>()("openbot/core/ProcessLedger") {}
