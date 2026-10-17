// shell.exec (capability shell@1): a streaming RPC of Started | Output | Exit.
//  - `<shell> -c <command>` spawned with `detached: true` (setsid), so pgid === pid;
//  - interrupt (client `@effect/rpc/Interrupt`, socket drop) or timeout: TERM the group, 500 ms, KILL;
//  - after the leader exits, the group is KILLed so background children release the pipes (G7);
//  - streamed output is capped at `outputLimitBytes`; the full output is spilled to
//    `<root>/.openbot/spill/<invocationId>.log` (readable with fs.read) and reported in Exit.
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"
import { appendFileSync, mkdirSync, statSync } from "node:fs"
import * as path from "node:path"
import { PathDenied, type ExecEvent, type Invocation, type PolicyRefused } from "@openbot/node-protocol"
import type { NodeConfigShape } from "./config.ts"
import type { Guard } from "./guard.ts"
import type { PathPolicyShape } from "./PathPolicy.ts"
import { baseEnv, filterEnv, killGroup, terminateGroup } from "./proc.ts"

export interface ExecPayload {
  readonly inv: Invocation
  readonly command: string
  readonly cwd: string
  readonly timeoutMs: number
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly outputLimitBytes?: number | undefined
}

export interface ShellDeps {
  readonly config: NodeConfigShape
  readonly paths: PathPolicyShape
  readonly guard: Guard
  /** running-invocation counter (heartbeats) */
  readonly active: { count: number }
}

const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000
const safeName = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 96) || "exec"

export const makeShellExec =
  ({ config, paths, guard, active }: ShellDeps) =>
  (p: ExecPayload): Stream.Stream<ExecEvent, PathDenied | PolicyRefused> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const cwd = yield* paths.resolve({ path: p.cwd, botId: p.inv.botId, access: "read" })
        let isDir = false
        try {
          isDir = statSync(cwd.real).isDirectory()
        } catch {
          isDir = false
        }
        if (!isDir) {
          return yield* new PathDenied({ path: p.cwd, reason: "cwd is not an existing directory" })
        }
        // policy + audit "allowed"; the exec outcome is audited when the stream ends
        yield* guard.check({ inv: p.inv, action: "run-command", target: p.command })
        const limit = Math.max(1024, Math.floor(p.outputLimitBytes ?? config.limits.execOutputBytes))
        const timeoutMs = Math.max(1, Math.min(Math.floor(p.timeoutMs), MAX_TIMEOUT_MS))
        const spillDir = cwd.root.mode === "rw" ? path.join(cwd.rootDir, ".openbot", "spill") : path.join(config.dataDir, "spill")
        const spillPath = path.join(spillDir, `${safeName(p.inv.invocationId)}.log`)
        return run(config, p, cwd.real, limit, timeoutMs, spillPath, guard, active)
      }),
    )

const run = (
  config: NodeConfigShape,
  p: ExecPayload,
  cwd: string,
  limit: number,
  timeoutMs: number,
  spillPath: string,
  guard: Guard,
  active: { count: number },
): Stream.Stream<ExecEvent> =>
  Stream.callback<ExecEvent>((queue) =>
    Effect.gen(function* () {
      const t0 = yield* Clock.currentTimeMillis
      let seq = 0
      let streamed = 0
      let spilled = false
      let pending: Array<string> = [] // everything streamed so far, written to the spill file on overflow
      const write = (data: string) => {
        try {
          if (!spilled) {
            mkdirSync(path.dirname(spillPath), { recursive: true })
            appendFileSync(spillPath, pending.join(""))
            pending = []
            spilled = true
          }
          appendFileSync(spillPath, data)
        } catch {
          // spill is best effort
        }
      }
      const emit = (stream: "stdout" | "stderr", data: string) => {
        if (data.length === 0) return
        const bytes = Buffer.byteLength(data)
        if (!spilled && streamed + bytes <= limit) {
          streamed += bytes
          pending.push(data)
          Queue.offerUnsafe(queue, { _tag: "Output", stream, data, seq: seq++ })
          return
        }
        if (!spilled) {
          // send the part that still fits, then spill everything
          const room = Math.max(0, limit - streamed)
          const head = Buffer.from(data).subarray(0, room).toString("utf8")
          if (head.length > 0) {
            streamed += Buffer.byteLength(head)
            pending.push(head)
            Queue.offerUnsafe(queue, { _tag: "Output", stream, data: head, seq: seq++ })
          }
          pending.push(data.slice(head.length))
          write("")
          return
        }
        write(data)
      }

      const proc = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.spawn([config.shell.program, "-c", p.command], {
            cwd,
            detached: true,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: baseEnv({
              ...filterEnv(p.env),
              TERM: "dumb",
              OPENBOT_NODE_ID: config.nodeId,
              OPENBOT_BOT_ID: p.inv.botId,
            }),
          }),
        ),
        (child) => terminateGroup(child, 500),
      )
      active.count++
      yield* Effect.addFinalizer(() => Effect.sync(() => void active.count--))
      Queue.offerUnsafe(queue, { _tag: "Started", pid: proc.pid, pgid: proc.pid })

      const pump = async (rs: ReadableStream<Uint8Array>, stream: "stdout" | "stderr") => {
        const d = new TextDecoder()
        try {
          for await (const c of rs) emit(stream, d.decode(c, { stream: true }))
          emit(stream, d.decode())
        } catch {
          // pipe closed
        }
      }
      const pumps = Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr")])

      let timedOut = false
      const exited = yield* Effect.promise(() => proc.exited).pipe(Effect.timeoutOption(timeoutMs))
      if (exited._tag === "None") {
        timedOut = true
        yield* terminateGroup(proc, 500)
        yield* Effect.promise(() => proc.exited)
      }
      // G7: background children of a finished foreground command die with it and release the pipes
      killGroup(proc.pid, "SIGKILL")
      yield* Effect.promise(() => Promise.race([pumps, Bun.sleep(1000)]))
      const t1 = yield* Clock.currentTimeMillis
      const code = proc.signalCode ? null : proc.exitCode
      const exit: ExecEvent = {
        _tag: "Exit",
        code,
        signal: proc.signalCode === null ? null : String(proc.signalCode),
        timedOut,
        durationMs: t1 - t0,
        ...(spilled ? { outputTruncated: true, spillPath } : {}),
      }
      Queue.offerUnsafe(queue, exit)
      yield* guard.audit.record({
        inv: p.inv,
        action: "run-command",
        target: p.command,
        decision: "allowed",
        outcome: timedOut || code !== 0 ? "error" : "ok",
        exitCode: code,
        durationMs: t1 - t0,
        error: timedOut ? `timed out after ${timeoutMs} ms` : undefined,
      })
      yield* Queue.end(queue)
    }).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause)
          ? guard.audit.record({ inv: p.inv, action: "run-command", target: p.command, decision: "allowed", outcome: "error", error: "interrupted" })
          : Effect.void,
      ),
    ),
  )
