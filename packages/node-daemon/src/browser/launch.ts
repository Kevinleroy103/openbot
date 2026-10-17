// Launch one Chromium/Chrome per node with a persistent profile and a loopback-only DevTools
// endpoint (computer-and-tools.md §3.2). `--remote-debugging-port=0` picks a free port; Chromium
// writes it (and the browser WebSocket path) to `<profile>/DevToolsActivePort`.
import * as Effect from "effect/Effect"
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync } from "node:fs"
import { hostname } from "node:os"
import * as path from "node:path"
import { BrowserUnavailable } from "@openbot/node-protocol"
import type { BrowserConfig } from "../config.ts"

export interface LaunchedBrowser {
  readonly proc: Bun.Subprocess
  readonly port: number
  readonly wsUrl: string
  readonly headless: boolean
}

/** Headful when a display is available (Linux: DISPLAY/WAYLAND_DISPLAY; macOS/Windows: always). */
export const resolveHeadless = (setting: BrowserConfig["headless"]): boolean => {
  if (setting !== "auto") return setting
  if (process.platform !== "linux") return false
  return !(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
}

/** A process's argv joined by spaces (`/proc` on Linux, `ps` elsewhere); undefined when unknown. */
const processArgs = (pid: number): string | undefined => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ")
  } catch {
    try {
      const out = Bun.spawnSync(["ps", "-o", "args=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" })
      const text = out.stdout.toString().trim()
      return text === "" ? undefined : text
    } catch {
      return undefined
    }
  }
}

/** Alive and not a zombie (a killed child its parent has not reaped yet counts as gone). */
const isAlive = (pid: number): boolean => {
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

/**
 * Frees the profile for a new browser. Chromium's `SingletonLock` links to `<hostname>-<pid>`:
 * - the pid is dead (crashed browser): remove the lock files;
 * - the pid is alive and is a browser on THIS profile (an orphan of a node daemon or brain that was
 *   killed with SIGKILL; it was spawned detached, so it leads its own process group): kill that
 *   group, then remove the lock files. The profile belongs to this node alone.
 * Anything else (another host, an unrelated process) is left alone; the launch then reports the
 * profile as in use.
 */
export const clearStaleLock = (profileDir: string): void => {
  const lock = path.join(profileDir, "SingletonLock")
  let target: string
  try {
    target = readlinkSync(lock)
  } catch {
    return
  }
  const dash = target.lastIndexOf("-")
  const host = dash > 0 ? target.slice(0, dash) : ""
  const pid = Number(target.slice(dash + 1))
  if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
    if (host !== "" && host !== hostname()) return
    const args = processArgs(pid)
    if (args === undefined || !args.includes(`--user-data-dir=${profileDir}`)) return
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // gone meanwhile
      }
    }
    const deadline = Date.now() + 2_000
    while (isAlive(pid) && Date.now() < deadline) Bun.sleepSync(20)
    if (isAlive(pid)) return
  }
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) rmSync(path.join(profileDir, f), { force: true })
}

export const browserArgs = (config: BrowserConfig, headless: boolean): Array<string> => [
  "--remote-debugging-port=0",
  "--remote-debugging-address=127.0.0.1",
  `--user-data-dir=${config.profileDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-features=Translate,MediaRouter",
  "--password-store=basic",
  `--window-size=${config.width},${config.height}`,
  ...(headless ? ["--headless=new", "--hide-scrollbars", "--mute-audio"] : []),
  ...config.extraArgs,
  "about:blank",
]

export const launchBrowser = (config: BrowserConfig, logFile?: string): Effect.Effect<LaunchedBrowser, BrowserUnavailable> =>
  Effect.gen(function* () {
    const exe = config.executable
    if (!config.enabled) return yield* new BrowserUnavailable({ reason: "the browser is disabled on this node" })
    if (!exe) return yield* new BrowserUnavailable({ reason: "no Chromium or Chrome was found on this node" })
    const headless = resolveHeadless(config.headless)
    const activePortFile = path.join(config.profileDir, "DevToolsActivePort")
    const proc = yield* Effect.try({
      try: () => {
        mkdirSync(config.profileDir, { recursive: true, mode: 0o700 })
        if (logFile) mkdirSync(path.dirname(logFile), { recursive: true })
        clearStaleLock(config.profileDir)
        rmSync(activePortFile, { force: true })
        return Bun.spawn([exe, ...browserArgs(config, headless)], {
          detached: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: logFile ? Bun.file(logFile) : "ignore",
        })
      },
      catch: (e) => new BrowserUnavailable({ reason: `could not start ${exe}: ${e instanceof Error ? e.message : String(e)}` }),
    })
    const deadline = Date.now() + 20_000
    while (true) {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        return yield* new BrowserUnavailable({
          reason: `${path.basename(exe)} exited during startup (code ${proc.exitCode ?? proc.signalCode}); is the profile in use by another browser?`,
        })
      }
      if (existsSync(activePortFile)) {
        const [portLine, wsPath] = readFileSync(activePortFile, "utf8").split("\n")
        const port = Number(portLine)
        if (Number.isInteger(port) && port > 0 && wsPath) {
          return { proc, port, wsUrl: `ws://127.0.0.1:${port}${wsPath.trim()}`, headless }
        }
      }
      if (Date.now() > deadline) {
        try {
          process.kill(-proc.pid, "SIGKILL")
        } catch {
          proc.kill("SIGKILL")
        }
        return yield* new BrowserUnavailable({ reason: `${path.basename(exe)} did not open a DevTools port within 20 s` })
      }
      yield* Effect.sleep(50)
    }
  })
