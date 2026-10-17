// The operating-system seam of DesktopManager: spawning and running programs, files, process
// liveness, free ports. `liveDesktopSystem` is the real one; tests inject a fake (desktop.test.ts),
// so display allocation, process cleanup and command lines are tested without X.
//
// Every desktop child gets `OPENBOT_DESKTOP=<marker>` in its environment, and so does everything it
// starts (apps opened from the dock, terminal shells, a browser). `killMarked` finds those processes
// in /proc, which is how a desktop is cleaned up completely, and how orphans of a previous run (a
// SIGKILLed brain or daemon) are found at startup.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as net from "node:net"
import { tmpdir } from "node:os"
import type { Exitable, Signal } from "../proc.ts"

export const DESKTOP_MARKER_ENV = "OPENBOT_DESKTOP"

export interface ChildHandle extends Exitable {
  /** stdout received so far (only with `captureStdout`; capped at 64 KiB) */
  readonly output: () => string
}

export interface SpawnOptions {
  readonly env: Readonly<Record<string, string>>
  readonly cwd?: string | undefined
  /** stdout + stderr are appended here (unless stdout is captured) */
  readonly logFile?: string | undefined
  readonly captureStdout?: boolean | undefined
}

export interface ExecResult {
  readonly code: number
  readonly stdout: Uint8Array
  readonly stderr: string
  readonly timedOut: boolean
}

export interface DesktopSystem {
  /** Start a long-lived child in its own process group (detached). Throws when it cannot start. */
  readonly spawn: (argv: ReadonlyArray<string>, options: SpawnOptions) => ChildHandle
  /** Run a short command to completion (killed after `timeoutMs`). */
  readonly exec: (argv: ReadonlyArray<string>, options: { readonly env: Readonly<Record<string, string>>; readonly timeoutMs: number }) => Promise<ExecResult>
  readonly exists: (path: string) => boolean
  readonly readText: (path: string) => string | undefined
  readonly writeFile: (path: string, data: string | Uint8Array, mode?: number) => void
  readonly mkdir: (path: string, mode?: number) => void
  /** `rm -rf`, never throws */
  readonly remove: (path: string) => void
  /** alive and not a zombie */
  readonly pidAlive: (pid: number) => boolean
  /** Signal a child's process group (children are spawned detached, so each leads one). Never throws. */
  readonly kill: (pid: number, signal: Signal) => boolean
  /** Signal every process whose `OPENBOT_DESKTOP` starts with `markerPrefix`; returns their pids. */
  readonly killMarked: (markerPrefix: string, signal: Signal) => ReadonlyArray<number>
  /** a free loopback TCP port (bound and released) */
  readonly freePort: () => Promise<number>
  readonly sleep: (ms: number) => Promise<void>
  readonly tmpdir: string
  readonly uid: number
}

const OUTPUT_CAP = 64 * 1024

/** Alive and not a zombie (a killed child its parent has not reaped yet counts as gone). */
export const pidAlive = (pid: number): boolean => {
  if (!(pid > 0)) return false
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z"
  } catch {
    return true
  }
}

/** Processes whose environment has `OPENBOT_DESKTOP=<value starting with prefix>` (Linux /proc). */
export const markedPids = (markerPrefix: string): ReadonlyArray<number> => {
  const needle = `${DESKTOP_MARKER_ENV}=${markerPrefix}`
  let entries: Array<string>
  try {
    entries = readdirSync("/proc")
  } catch {
    return []
  }
  const out: Array<number> = []
  for (const e of entries) {
    const pid = Number(e)
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue
    let environ: string
    try {
      environ = readFileSync(`/proc/${pid}/environ`, "latin1")
    } catch {
      continue
    }
    if (environ.startsWith(needle) || environ.includes(`\0${needle}`)) out.push(pid)
  }
  return out
}

const signalGroup = (pid: number, signal: Signal): boolean => {
  if (!(pid > 1)) return false
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

export const liveDesktopSystem = (): DesktopSystem => ({
  spawn: (argv, options) => {
    const logFd = options.logFile ? openSync(options.logFile, "a", 0o600) : undefined
    let proc: Bun.Subprocess<"ignore", "pipe" | number | "ignore", number | "ignore">
    try {
      proc = Bun.spawn([...argv], {
        env: { ...options.env },
        ...(options.cwd ? { cwd: options.cwd } : {}),
        detached: true,
        stdin: "ignore",
        stdout: options.captureStdout ? "pipe" : (logFd ?? "ignore"),
        stderr: logFd ?? "ignore",
      }) as Bun.Subprocess<"ignore", "pipe" | number | "ignore", number | "ignore">
    } finally {
      if (logFd !== undefined) closeSync(logFd)
    }
    let text = ""
    const stdout = proc.stdout
    if (stdout && typeof stdout !== "number") {
      void (async () => {
        const d = new TextDecoder()
        try {
          for await (const chunk of stdout as ReadableStream<Uint8Array>) {
            if (text.length < OUTPUT_CAP) text += d.decode(chunk, { stream: true })
          }
        } catch {
          // closed
        }
      })()
    }
    return {
      pid: proc.pid,
      exited: proc.exited,
      get exitCode() {
        return proc.exitCode
      },
      get signalCode() {
        return proc.signalCode
      },
      output: () => text,
    }
  },
  exec: (argv, options) =>
    (async () => {
      const proc = Bun.spawn([...argv], { env: { ...options.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          proc.kill("SIGKILL")
        } catch {
          // gone
        }
      }, options.timeoutMs)
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).arrayBuffer(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        return { code, stdout: new Uint8Array(stdout), stderr: stderr.trim(), timedOut }
      } finally {
        clearTimeout(timer)
      }
    })(),
  exists: (p) => existsSync(p),
  readText: (p) => {
    try {
      return readFileSync(p, "utf8")
    } catch {
      return undefined
    }
  },
  writeFile: (p, data, mode) => writeFileSync(p, data, mode === undefined ? undefined : { mode }),
  mkdir: (p, mode) => void mkdirSync(p, { recursive: true, ...(mode === undefined ? {} : { mode }) }),
  remove: (p) => {
    try {
      rmSync(p, { recursive: true, force: true })
    } catch {
      // best effort
    }
  },
  pidAlive,
  kill: signalGroup,
  killMarked: (prefix, signal) => {
    const pids = markedPids(prefix)
    for (const pid of pids) {
      try {
        process.kill(pid, signal)
      } catch {
        // gone
      }
    }
    return pids
  },
  freePort: () =>
    new Promise<number>((resolve, reject) => {
      const server = net.createServer()
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        const port = typeof address === "object" && address ? address.port : 0
        server.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))))
      })
    }),
  sleep: (ms) => Bun.sleep(ms),
  tmpdir: tmpdir(),
  uid: typeof process.getuid === "function" ? process.getuid() : 0,
})

/**
 * An `.Xauthority` file with one MIT-MAGIC-COOKIE-1 entry for any display (FamilyWild), so only
 * clients that read this file can connect to the bot's X server.
 */
export const xauthFile = (cookie: Uint8Array): Uint8Array => {
  const parts: Array<Uint8Array> = [new Uint8Array([0xff, 0xff])]
  const field = (bytes: Uint8Array) => {
    parts.push(new Uint8Array([(bytes.length >> 8) & 0xff, bytes.length & 0xff]), bytes)
  }
  const enc = new TextEncoder()
  field(new Uint8Array(0)) // address
  field(new Uint8Array(0)) // display number (empty: any)
  field(enc.encode("MIT-MAGIC-COOKIE-1"))
  field(cookie)
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export const displayLockPath = (n: number) => `/tmp/.X${n}-lock`
export const displaySocketPath = (n: number) => `/tmp/.X11-unix/X${n}`

/**
 * The first free X display number from `base`: no live lock file and no socket. A lock file of a
 * dead server (a SIGKILLed Xvfb) is stale: it and the socket are removed and the number is used.
 */
export const pickDisplay = (
  sys: Pick<DesktopSystem, "exists" | "readText" | "remove" | "pidAlive">,
  base: number,
  reserved: ReadonlySet<number>,
  count = 400,
): number | undefined => {
  for (let n = base; n < base + count; n++) {
    if (reserved.has(n)) continue
    const lock = displayLockPath(n)
    if (sys.exists(lock)) {
      const pid = Number((sys.readText(lock) ?? "").trim())
      if (Number.isInteger(pid) && pid > 0 && sys.pidAlive(pid)) continue
      if (!Number.isInteger(pid) || pid <= 0) continue // unreadable: not ours to judge
      sys.remove(lock)
      sys.remove(displaySocketPath(n))
      return n
    }
    if (sys.exists(displaySocketPath(n))) continue
    return n
  }
  return undefined
}
