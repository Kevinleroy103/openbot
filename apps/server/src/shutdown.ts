/**
 * Shutdown watchdog (D2.5). SIGINT/SIGTERM interrupt the brain and release its layers gracefully
 * (harness sessions, node sockets, the local node's browser and terminals, SQLite). If that does not
 * finish within the deadline (a stuck finalizer must never keep the brain alive), or a second
 * signal arrives, the watchdog SIGKILLs every child process group (harness CLIs, app-servers, the
 * local node's Chromium, ptys and commands; each is spawned detached, leading its own group) and
 * exits. The next boot's recovery still kills anything recorded in the process ledger.
 *
 * The current shutdown step is tracked so a forced exit can say what was stuck.
 */

/** Default grace period between the first signal and a forced exit. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000

let phase = "running"

/** Records the current shutdown step (shown when the watchdog forces the exit). */
export const setShutdownPhase = (step: string): void => {
  phase = step
}

export const shutdownPhase = (): string => phase

/** Direct children of `pid` (`pgrep -P`, available on Linux and macOS). Empty when unknown. */
export const childPids = (pid: number = process.pid): ReadonlyArray<number> => {
  try {
    const out = Bun.spawnSync(["pgrep", "-P", String(pid)], { stdout: "pipe", stderr: "ignore" })
    return out.stdout
      .toString()
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}

/** SIGKILLs each child's process group (and the child itself, when it shares ours). Returns the pids. */
export const killChildren = (pid: number = process.pid): ReadonlyArray<number> => {
  const children = childPids(pid)
  for (const child of children) {
    try {
      process.kill(-child, "SIGKILL")
    } catch {
      // not a group leader (or already gone)
    }
    try {
      process.kill(child, "SIGKILL")
    } catch {
      // already gone
    }
  }
  return children
}

export interface ShutdownWatchdog {
  /** Called on every SIGINT/SIGTERM: the first arms the deadline, the second forces the exit now. */
  readonly signal: (name: string) => void
  /** Graceful shutdown finished: disarm. */
  readonly done: () => void
}

export interface WatchdogOptions {
  readonly timeoutMs?: number | undefined
  readonly log?: ((line: string) => void) | undefined
  readonly exit?: ((code: number) => void) | undefined
  readonly kill?: (() => ReadonlyArray<number>) | undefined
}

/** Shutdown timeout from `OPENBOT_SHUTDOWN_TIMEOUT_MS` (ms; invalid → default). */
export const shutdownTimeoutFromEnv = (env: Readonly<Record<string, string | undefined>>): number => {
  const raw = env["OPENBOT_SHUTDOWN_TIMEOUT_MS"]
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SHUTDOWN_TIMEOUT_MS
}

export const makeShutdownWatchdog = (options?: WatchdogOptions): ShutdownWatchdog => {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  const log = options?.log ?? ((line: string) => console.error(line))
  const exit = options?.exit ?? ((code: number) => process.exit(code))
  const kill = options?.kill ?? (() => killChildren())
  let timer: ReturnType<typeof setTimeout> | undefined
  let finished = false
  let forced = false

  const force = (why: string) => {
    if (finished || forced) return
    forced = true
    if (timer !== undefined) clearTimeout(timer)
    const killed = kill()
    log(`openbot: ${why}; forcing exit (stuck at: ${phase}${killed.length > 0 ? `; killed ${killed.length} child process group(s)` : ""})`)
    exit(1)
  }

  return {
    signal: (name) => {
      if (finished) return
      if (timer !== undefined) return force(`second ${name}`)
      timer = setTimeout(() => force(`shutdown did not finish within ${timeoutMs} ms`), timeoutMs)
      timer.unref?.()
    },
    done: () => {
      finished = true
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}
