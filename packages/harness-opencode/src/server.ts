/**
 * `opencode serve` process manager (architecture §4.5 OpenCode, D2.3, D2.5).
 *
 * Spawns the USER's installed CLI as `opencode serve --stdio --port 0 --hostname 127.0.0.1` with a
 * generated `OPENCODE_PASSWORD` (HTTP Basic) and the isolation env (`config.ts`):
 *
 * - `--stdio` prints one JSON line `{"url": …}` and makes the server exit when its stdin closes, so
 *   the server dies with the brain (recovery-matrix.md §3.3: pending approvals and runtime MCP
 *   servers do not survive it; OpenBot re-adds MCP servers after every start).
 * - The child runs in its own process group (`detached`), recorded in `ProcessLedger` so boot
 *   recovery can kill leftovers; on release stdin is closed, then the group is killed.
 * - Readiness = an authenticated `GET /api/info` (`/health` answers HTML on every version).
 */
import { HarnessError } from "@openbot/core"
import { Effect, Scope } from "effect"
import { describeClientError, makeOpenCodeClient, type OpenCodeApi } from "./client.ts"
import { serverArgs } from "./config.ts"

/** A started, verified OpenCode server. */
export interface OpenCodeTransport {
  readonly client: OpenCodeApi
  readonly url: string
  /** Server version from `/api/info`, e.g. "2.0.6". */
  readonly version: string
  /** Completes with a reason when the server is gone. Never fails. */
  readonly exited: Effect.Effect<string>
}

export interface SpawnServerOptions {
  readonly binary: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly password: string
  /** Time allowed for the URL line and `/api/info`. */
  readonly startTimeoutMs?: number | undefined
  /** Called with the child's pid (= pgid) once spawned (ProcessLedger.record). */
  readonly onSpawned?: ((pid: number) => Effect.Effect<void>) | undefined
  /** Called after the child is gone (ProcessLedger.remove). */
  readonly onReaped?: ((pid: number) => Effect.Effect<void>) | undefined
}

const harnessError = (code: HarnessError["code"], message: string, cause?: unknown) =>
  new HarnessError({ harness: "opencode", code, message, ...(cause === undefined ? {} : { cause }) })

const STDERR_TAIL_CHARS = 4_000

/** Kills a process group, falling back to the single process. Ignores "no such process". */
const killGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // already gone
    }
  }
}

/** Spawns and verifies `opencode serve`; the server is stopped when the scope closes. */
export const spawnServer = (options: SpawnServerOptions): Effect.Effect<OpenCodeTransport, HarnessError, Scope.Scope> =>
  Effect.gen(function* () {
    const startTimeoutMs = options.startTimeoutMs ?? 30_000
    const proc = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.spawn([...serverArgs(options.binary)], {
            cwd: options.cwd,
            env: options.env,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            detached: true,
          }),
        catch: (cause) =>
          harnessError(
            "not-installed",
            `Could not start "${options.binary} serve": ${describeClientError(cause)}`,
            cause,
          ),
      }),
      (child) =>
        Effect.promise(async () => {
          try {
            child.stdin.end()
          } catch {
            // already closed
          }
          const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(3_000).then(() => false)])
          // Graceful exit on stdin EOF kills running tools; anything left in the group goes too.
          killGroup(child.pid, exited ? "SIGTERM" : "SIGKILL")
          if (!exited) await Promise.race([child.exited, Bun.sleep(2_000)])
        }).pipe(Effect.andThen(options.onReaped ? options.onReaped(child.pid) : Effect.void)),
    )
    if (options.onSpawned) yield* options.onSpawned(proc.pid)

    // stderr tail for error messages; stdout is drained after the URL line (no pipe backpressure).
    let stderrTail = ""
    void (async () => {
      const decoder = new TextDecoder()
      try {
        for await (const chunk of proc.stderr) {
          stderrTail = (stderrTail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_CHARS)
        }
      } catch {
        // stream closed
      }
    })()
    const withStderr = (message: string) => {
      const tail = stderrTail.trim()
      return tail.length > 0 ? `${message}\n${tail.slice(-800)}` : message
    }

    const url = yield* Effect.tryPromise({
      try: async () => {
        const reader = proc.stdout.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        const readLine = (async () => {
          while (!buffer.includes("\n")) {
            const next = await reader.read()
            if (next.done) throw new Error("stdout closed before the server printed its URL")
            buffer += decoder.decode(next.value, { stream: true })
          }
          return buffer.slice(0, buffer.indexOf("\n"))
        })()
        const exitedEarly = proc.exited.then((code) => {
          throw new Error(`exited with code ${code} before printing its URL`)
        })
        // The loser of the race settles later (normal exit at shutdown): never leave it unhandled.
        readLine.catch(() => {})
        exitedEarly.catch(() => {})
        const line = await Promise.race([readLine, exitedEarly])
        // Keep draining stdout so the child never blocks on a full pipe.
        void (async () => {
          try {
            while (!(await reader.read()).done) {
              // discard
            }
          } catch {
            // closed
          }
        })()
        const parsed = JSON.parse(line) as { url?: unknown }
        if (typeof parsed.url !== "string") throw new Error(`unexpected first line: ${line.slice(0, 200)}`)
        return parsed.url
      },
      catch: (cause) =>
        harnessError("open-failed", withStderr(`OpenCode server did not start: ${describeClientError(cause)}`), cause),
    }).pipe(
      Effect.timeoutOrElse({
        duration: startTimeoutMs,
        orElse: () =>
          Effect.fail(harnessError("open-failed", withStderr("Timed out waiting for the OpenCode server to start."))),
      }),
    )

    const client = makeOpenCodeClient({ baseUrl: url, password: options.password })
    const version = yield* verifyServer(client, Math.min(startTimeoutMs, 15_000))
    return {
      client,
      url,
      version,
      exited: Effect.promise(() => proc.exited).pipe(
        Effect.map((code) => withStderr(`The OpenCode server exited (code ${code}).`)),
      ),
    } satisfies OpenCodeTransport
  })

/**
 * Confirms an authenticated OpenCode 2 server through `/api/info` and returns its version.
 * 1.x servers answer HTML (the client fails to parse it) and are reported as unsupported.
 */
export const verifyServer = (client: OpenCodeApi, timeoutMs = 10_000): Effect.Effect<string, HarnessError> =>
  Effect.tryPromise({
    try: (signal) => client.server.info({ signal }),
    catch: (cause) => {
      const message = describeClientError(cause)
      return /401|Unauthori[sz]ed/i.test(message)
        ? harnessError("auth", "The OpenCode server rejected the server password.", cause)
        : harnessError("open-failed", `Not an OpenCode 2 server (/api/info failed: ${message}).`, cause)
    },
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(harnessError("open-failed", "Timed out waiting for the OpenCode server (/api/info).")),
    }),
    Effect.flatMap((info) =>
      typeof info?.version === "string" && /^2\./.test(info.version)
        ? Effect.succeed(info.version)
        : Effect.fail(
            harnessError(
              "not-installed",
              `OpenCode ${String(info?.version)} is not supported; OpenBot needs OpenCode 2.x.`,
            ),
          ),
    ),
  )

/** Resolves the user's `opencode` binary: explicit path, PATH, then the usual install locations. */
export const resolveOpenCodeBinary = (explicit: string | undefined): string | undefined => {
  if (explicit !== undefined && explicit.length > 0) return Bun.which(explicit) ?? undefined
  const found = Bun.which("opencode")
  if (found) return found
  const home = process.env.HOME
  if (!home) return undefined
  for (const candidate of [
    `${home}/.bun/bin/opencode`,
    `${home}/.opencode/bin/opencode`,
    `${home}/.local/bin/opencode`,
  ]) {
    const resolved = Bun.which(candidate)
    if (resolved) return resolved
  }
  return undefined
}
