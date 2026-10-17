/**
 * Killing leftover child process groups at boot (D2.5, `ProcessLedger`). The ledger survives brain
 * restarts and machine reboots, so a recorded pid/pgid may have been reused by an unrelated
 * process. On Linux the default killer compares the process start time from `/proc` with the
 * recorded `startedAt` and refuses to signal a group whose leader started at a different time.
 */
import type { ProcessRecord } from "@openbot/core"
import { Effect } from "effect"
import { readFileSync } from "node:fs"

/** Allowed difference between `ProcessRecord.startedAt` and the kernel's start time. */
export const START_TIME_TOLERANCE_MS = 60_000

/** Linux `USER_HZ`; 100 on every mainstream architecture. */
const CLOCK_TICKS_PER_SECOND = 100

const readProc = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

/** Boot time of the machine (ms since epoch) from `/proc/stat`; undefined off Linux. */
const bootTimeMs = (): number | undefined => {
  const stat = readProc("/proc/stat")
  const line = stat?.split("\n").find((l) => l.startsWith("btime "))
  const seconds = line === undefined ? NaN : Number(line.slice(6).trim())
  return Number.isFinite(seconds) ? seconds * 1000 : undefined
}

/**
 * Start time (ms since epoch) of `pid` from `/proc/<pid>/stat`.
 * - `"missing"`: no such process;
 * - `undefined`: unknown (not Linux / unreadable).
 */
export const processStartTimeMs = (pid: number): number | "missing" | undefined => {
  const boot = bootTimeMs()
  if (boot === undefined) return undefined
  const stat = readProc(`/proc/${pid}/stat`)
  if (stat === undefined) return "missing"
  // Field 2 (comm) may contain spaces and parentheses; the remaining fields follow the last ')'.
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
  // rest[0] is field 3 (state), so field 22 (starttime) is rest[19].
  const ticks = Number(rest[19])
  return Number.isFinite(ticks) ? boot + (ticks / CLOCK_TICKS_PER_SECOND) * 1000 : undefined
}

/** The recorded process itself must have started at `startedAt` (± tolerance). */
const pidReused = (pid: number, startedAt: number): boolean => {
  const start = processStartTimeMs(pid)
  return typeof start === "number" && Math.abs(start - startedAt) > START_TIME_TOLERANCE_MS
}

/** A group leader cannot have started after a member it spawned. */
const leaderReused = (pgid: number, startedAt: number): boolean => {
  const start = processStartTimeMs(pgid)
  return typeof start === "number" && start > startedAt + START_TIME_TOLERANCE_MS
}

/**
 * Sends SIGKILL to the record's process group. Returns true when a signal was delivered.
 * Never signals pgid ≤ 1, the brain's own pid, or a group whose pid/pgid was evidently reused.
 */
export const killProcessGroup = (record: ProcessRecord): Effect.Effect<boolean> =>
  Effect.sync(() => {
    const { pid, pgid, startedAt } = record
    if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) return false
    if (pidReused(pid, startedAt)) return false
    if (pgid !== pid && leaderReused(pgid, startedAt)) return false
    try {
      process.kill(-pgid, "SIGKILL")
      return true
    } catch {
      // ESRCH: the group is gone; EPERM: not ours.
      return false
    }
  })
