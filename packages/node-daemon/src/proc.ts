// Process-group helpers. Children are spawned with `detached: true` (setsid), so each command leads
// its own process group and the whole tree can be signalled with `kill(-pgid)` (S.4.2, gotcha G7).
import * as Effect from "effect/Effect"

export type Signal = "SIGTERM" | "SIGKILL" | "SIGHUP" | "SIGINT"

/** Signal a whole process group. Never throws. */
export const killGroup = (pgid: number, signal: Signal): boolean => {
  if (!(pgid > 1)) return false
  try {
    process.kill(-pgid, signal)
    return true
  } catch {
    return false
  }
}

/** True while any process of the group is alive. */
export const groupAlive = (pgid: number): boolean => {
  if (!(pgid > 1)) return false
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

export interface Exitable {
  readonly pid: number
  readonly exited: Promise<number>
  readonly exitCode: number | null
  readonly signalCode: string | number | null
}

const isRunning = (p: Exitable) => p.exitCode === null && p.signalCode === null

/**
 * TERM the process group, wait up to `graceMs` for the leader to exit, then KILL the group.
 * Leftover group members (background jobs of a finished command) are always KILLed.
 */
export const terminateGroup = (proc: Exitable, graceMs = 500): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (isRunning(proc)) {
      killGroup(proc.pid, "SIGTERM")
      yield* Effect.promise(() => proc.exited).pipe(Effect.timeoutOption(graceMs))
    }
    killGroup(proc.pid, "SIGKILL")
  })

/** Variables the node passes through from its own environment to commands (no secrets). */
const PASS_THROUGH = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR"]

/** Brain-supplied env is advisory: the node owns PATH/HOME/loader hooks/tool homes. */
const BLOCKED_ENV = /^(PATH|HOME|SHELL|USER|LOGNAME|LD_|DYLD_|NODE_OPTIONS|BUN_|BASH_ENV|ENV|PROMPT_COMMAND|CLAUDE_CONFIG_DIR|CODEX_HOME|XDG_|OPENBOT_)/

export const filterEnv = (env: Readonly<Record<string, string>> | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  if (!env) return out
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || BLOCKED_ENV.test(k)) continue
    out[k] = v
  }
  return out
}

export const baseEnv = (extra: Readonly<Record<string, string>>): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const k of PASS_THROUGH) {
    const v = process.env[k]
    if (v !== undefined) out[k] = v
  }
  if (!out.PATH) out.PATH = "/usr/local/bin:/usr/bin:/bin"
  if (!out.LANG) out.LANG = "C.UTF-8"
  return { ...out, ...extra }
}
