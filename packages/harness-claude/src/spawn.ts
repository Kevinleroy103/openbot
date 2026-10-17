/**
 * `spawnClaudeCodeProcess` that starts the CLI in its own process group (detached) and SIGKILLs
 * the whole group when the CLI exits or the session closes, so tool grandchildren die too
 * (architecture §4.5 "Process"; D2.5; port of t3code `spawnClaudeProcessGroup`,
 * ClaudeAdapterV2.ts:250-266, MIT).
 *
 * The pid/pgid is reported through `onSpawn`/`onExit` so the driver can record it in the
 * `ProcessLedger` and boot recovery can kill leftovers after a brain crash. `waitExit` lets the
 * session's release wait (bounded) for the CLI to finish its graceful shutdown (stdin EOF, which
 * flushes the transcript `resume` needs) before falling back to `killGroup`.
 *
 * Known limit (recovery-matrix.md §3.1): Claude's Bash tool runs commands in new sessions
 * (`setsid`), so a process-group kill does not reach them; only a cgroup (systemd scope) kill does.
 */
import { type ChildProcess, spawn } from "node:child_process"

export interface SpawnRequest {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string | undefined
  readonly env: Readonly<Record<string, string | undefined>>
  readonly signal: AbortSignal
}

export interface SpawnHooks {
  readonly onSpawn?: (pid: number) => void
  readonly onExit?: (pid: number) => void
  /** Receives stderr chunks (kept as a short tail for diagnostics). */
  readonly onStderr?: (chunk: string) => void
}

/** SIGKILLs process group `pid`; a no-op when the group is already gone. */
export const killGroup = (pid: number): void => {
  if (pid <= 0) return
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    // The group is already empty.
  }
}

export interface ProcessGroupSpawner {
  /** SDK-compatible `Options.spawnClaudeCodeProcess`. */
  readonly spawn: (request: SpawnRequest) => ChildProcess
  /** Pid (= pgid) of the CLI this spawner started, if any. */
  readonly pid: () => number | undefined
  /** Resolves when the started CLI has exited (immediately when none was started or it already exited). */
  readonly waitExit: () => Promise<void>
  /** SIGKILLs the CLI's whole process group now. */
  readonly killGroup: () => void
}

/**
 * Returns a spawner for `Options.spawnClaudeCodeProcess`. On Windows (no process groups) do not
 * use it and let the SDK spawn (see `supportsProcessGroups`).
 */
export const makeProcessGroupSpawner = (hooks: SpawnHooks = {}): ProcessGroupSpawner => {
  let current: { readonly pid: number; readonly exited: Promise<void> } | undefined
  const spawnProcess = (request: SpawnRequest): ChildProcess => {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(request.env)) if (value !== undefined) env[key] = value
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env,
      signal: request.signal,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    })
    const pid = child.pid ?? 0
    let markExited: () => void = () => {}
    const exited = new Promise<void>((resolve) => {
      markExited = resolve
    })
    if (pid > 0) {
      current = { pid, exited }
      hooks.onSpawn?.(pid)
    } else markExited()
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => hooks.onStderr?.(chunk))
    child.once("exit", () => {
      killGroup(pid)
      if (pid > 0) hooks.onExit?.(pid)
      markExited()
    })
    child.once("error", () => {
      // Spawn failures surface through the SDK's stream; a child that never started never exits.
      if (child.pid === undefined) markExited()
    })
    return child
  }
  return {
    spawn: spawnProcess,
    pid: () => current?.pid,
    waitExit: () => current?.exited ?? Promise.resolve(),
    killGroup: () => {
      if (current) killGroup(current.pid)
    },
  }
}

export const supportsProcessGroups = process.platform !== "win32"
