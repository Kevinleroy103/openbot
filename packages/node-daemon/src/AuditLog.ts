// Append-only audit log on the node (remote-prior-art.md §4.9): JSONL under
// `<dataDir>/audit/YYYY-MM-DD.jsonl`, one line per bot-originated invocation, hash-chained with
// `prevHash` so tampering is detectable. No file contents, no environment values.
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Semaphore from "effect/Semaphore"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import * as path from "node:path"
import { BrainLink, NodeEventTypes, type Invocation } from "@openbot/node-protocol"
import { NodeConfig, type NodeAction } from "./config.ts"

export type AuditDecision = "allowed" | "approved" | "denied" | "refused"
export type AuditOutcome = "ok" | "error"

export interface AuditInput {
  readonly inv: Invocation | { readonly botId: string; readonly invocationId?: string; readonly runId?: string }
  readonly action: NodeAction | string
  /** command line, path or url; truncated to 256 chars in the log */
  readonly target: string
  readonly decision: AuditDecision
  readonly by?: string | undefined
  readonly outcome?: AuditOutcome | undefined
  readonly exitCode?: number | null | undefined
  readonly durationMs?: number | undefined
  readonly error?: string | undefined
}

export interface AuditEntry {
  readonly ts: number
  readonly invocationId: string | null
  readonly botId: string
  readonly runId: string | null
  readonly toolCallId: string | null
  readonly action: string
  readonly target: string
  readonly targetSha256: string
  readonly decision: AuditDecision
  readonly by: string | null
  readonly outcome: AuditOutcome | null
  readonly exitCode: number | null
  readonly durationMs: number | null
  readonly error: string | null
  readonly prevHash: string
}

export interface AuditLogShape {
  /** Never fails (an unwritable log is reported on stderr and the call proceeds). */
  readonly record: (input: AuditInput) => Effect.Effect<void>
  /** File for a given day (UTC). */
  readonly fileFor: (ts: number) => string
  readonly dir: string
}

export class AuditLog extends Context.Service<AuditLog, AuditLogShape>()("openbot/node-daemon/AuditLog") {}

const sha256 = (s: string): string => new Bun.CryptoHasher("sha256").update(s).digest("hex")
const GENESIS = "0".repeat(64)

/** Verify a day's hash chain. Returns the index of the first broken line, or -1. */
export const verifyAuditChain = (lines: ReadonlyArray<string>, startHash = GENESIS): number => {
  let prev = startHash
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    let entry: { prevHash?: unknown }
    try {
      entry = JSON.parse(line) as { prevHash?: unknown }
    } catch {
      return i
    }
    if (entry.prevHash !== prev) return i
    prev = sha256(line)
  }
  return -1
}

export const makeAuditLog = (options: {
  readonly dir: string
  readonly forward?: ((entry: AuditEntry) => Effect.Effect<void>) | undefined
}): Effect.Effect<AuditLogShape> =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1)
    const fileFor = (ts: number) => path.join(options.dir, `${new Date(ts).toISOString().slice(0, 10)}.jsonl`)
    let lastFile = ""
    let lastHash = GENESIS
    const loadLast = (file: string) => {
      if (file === lastFile) return
      lastFile = file
      lastHash = GENESIS
      if (!existsSync(file)) return
      try {
        const lines = readFileSync(file, "utf8")
          .split("\n")
          .filter((l) => l.length > 0)
        const last = lines[lines.length - 1]
        if (last !== undefined) lastHash = sha256(last)
      } catch (err) {
        console.error(`[openbot-node] audit log read failed: ${String(err)}`)
      }
    }
    const record = (input: AuditInput) =>
      Effect.gen(function* () {
        const ts = yield* Clock.currentTimeMillis
        const entry = yield* lock.withPermits(1)(
          Effect.sync(() => {
            const file = fileFor(ts)
            loadLast(file)
            const inv = input.inv as Partial<Invocation> & { botId: string }
            const e: AuditEntry = {
              ts,
              invocationId: inv.invocationId ?? null,
              botId: inv.botId,
              runId: inv.runId ?? null,
              toolCallId: inv.toolCallId ?? null,
              action: input.action,
              target: input.target.length > 256 ? `${input.target.slice(0, 253)}...` : input.target,
              targetSha256: sha256(input.target),
              decision: input.decision,
              by: input.by ?? null,
              outcome: input.outcome ?? null,
              exitCode: input.exitCode ?? null,
              durationMs: input.durationMs ?? null,
              error: input.error === undefined ? null : input.error.slice(0, 500),
              prevHash: lastHash,
            }
            const line = JSON.stringify(e)
            try {
              mkdirSync(options.dir, { recursive: true, mode: 0o700 })
              appendFileSync(file, line + "\n", { mode: 0o600 })
              lastHash = sha256(line)
            } catch (err) {
              console.error(`[openbot-node] audit log write failed: ${String(err)}`)
            }
            return e
          }),
        )
        if (options.forward) yield* Effect.ignore(options.forward(entry))
      })
    return { record, fileFor, dir: options.dir }
  })

export const AuditLogLive: Layer.Layer<AuditLog, never, NodeConfig | BrainLink> = Layer.effect(
  AuditLog,
  Effect.gen(function* () {
    const config = yield* NodeConfig
    const brain = yield* BrainLink
    return AuditLog.of(
      yield* makeAuditLog({
        dir: path.join(config.dataDir, "audit"),
        forward: config.forwardAudit ? (entry) => brain.event(NodeEventTypes.audit, entry) : undefined,
      }),
    )
  }),
)
