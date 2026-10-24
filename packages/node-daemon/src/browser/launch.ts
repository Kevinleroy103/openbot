// Launch one Chromium/Chrome per node with a persistent profile and a loopback-only DevTools
// endpoint (computer-and-tools.md §3.2). The DevTools port is a free one from a fixed range
// (`DEBUG_PORT_RANGE`, never 0: see there); the browser WebSocket URL comes from its
// `/json/version`.
import * as Effect from "effect/Effect"
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync } from "node:fs"
import { hostname } from "node:os"
import * as path from "node:path"
import { BrowserUnavailable } from "@openbot/node-protocol"
import type { BrowserConfig } from "../config.ts"
import type { Exitable } from "../proc.ts"

export interface LaunchedBrowser {
  readonly proc: Exitable
  readonly port: number
  readonly wsUrl: string
  readonly headless: boolean
  /** a browser already running on this profile (opened from the bot's dock) that the node attached to */
  readonly adopted: boolean
}

/**
 * `auto` is headless: bots' windows never pop up on the owner's own screen (the web app shows a
 * bot's browser through the screencast). `--headful` (`false`) puts them on the node's display. A
 * node that offers desktops runs each bot's browser headful on the bot's own screen instead
 * (`onScreenBrowserConfig`).
 */
export const resolveHeadless = (setting: BrowserConfig["headless"]): boolean => (setting === "auto" ? true : setting)

/**
 * The browser of a bot on its own desktop (D1.7): headful on the bot's X display (`DISPLAY` comes
 * from the launch environment), X11 backend, maximized, with the bot's own persistent profile.
 */
export const onScreenBrowserConfig = (
  base: BrowserConfig,
  screen: { readonly profileDir: string; readonly width: number; readonly height: number },
): BrowserConfig => ({
  ...base,
  profileDir: screen.profileDir,
  width: screen.width,
  height: screen.height,
  headless: false,
  extraArgs: [
    "--ozone-platform=x11",
    "--start-maximized",
    "--window-position=0,0",
    "--hide-crash-restore-bubble",
    ...base.extraArgs,
  ],
})

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
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"])
    rmSync(path.join(profileDir, f), { force: true })
}

/** A process the node did not spawn, as an `Exitable` (exit observed by polling). */
const externalProcess = (pid: number): Exitable => {
  let exited: Promise<number> | undefined
  return {
    pid,
    get exitCode() {
      return isAlive(pid) ? null : 0
    },
    signalCode: null,
    get exited() {
      exited ??= (async () => {
        while (isAlive(pid)) await Bun.sleep(100)
        return 0
      })()
      return exited
    },
  }
}

/**
 * A browser already running on `profileDir` with a DevTools port (on a bot desktop, the owner or
 * the bot may have opened it from the dock with the node's own command line): its pid and port, so
 * the node attaches to it instead of killing it. The port is read from its command line (Chrome
 * writes `DevToolsActivePort` only for a random port).
 */
export const findRunningBrowser = (profileDir: string): { readonly pid: number; readonly port: number } | undefined => {
  let target: string
  try {
    target = readlinkSync(path.join(profileDir, "SingletonLock"))
  } catch {
    return undefined
  }
  const dash = target.lastIndexOf("-")
  const host = dash > 0 ? target.slice(0, dash) : ""
  const pid = Number(target.slice(dash + 1))
  if (!Number.isInteger(pid) || pid <= 0 || host !== hostname() || !isAlive(pid)) return undefined
  const args = processArgs(pid)
  if (args === undefined || !args.includes(`--user-data-dir=${profileDir}`)) return undefined
  const port = Number(/--remote-debugging-port=(\d+)/.exec(args)?.[1])
  return Number.isInteger(port) && port > 0 ? { pid, port } : undefined
}

/** The browser WebSocket URL a DevTools port serves; undefined while nothing answers there. */
const browserWsUrl = (port: number): Promise<string | undefined> =>
  fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })
    .then(async (r) => {
      if (!r.ok) return undefined
      const url = ((await r.json()) as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl
      return typeof url === "string" && url.startsWith("ws://") ? url : undefined
    })
    .catch(() => undefined)

/**
 * DevTools ports come from a fixed range, never `--remote-debugging-port=0`: Google sign-in rejects a
 * Chrome started with a random DevTools port ("This browser or app may not be secure"). Measured
 * 2026-10-17 on this stack: port 0 → rejected 8 of 8 sign-ins, a fixed port → accepted 11 of 11,
 * whatever the screen size, window manager, environment or Chrome vs Chromium.
 */
export const DEBUG_PORT_RANGE = { from: 9300, to: 9799 } as const

const portFree = (port: number): boolean => {
  try {
    const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } })
    listener.stop(true)
    return true
  } catch {
    return false
  }
}

/** A free loopback port from `DEBUG_PORT_RANGE` (skipping `taken`); 0 (random) only when all are busy. */
export const freeDebugPort = (taken: ReadonlySet<number> = new Set()): number => {
  const span = DEBUG_PORT_RANGE.to - DEBUG_PORT_RANGE.from + 1
  const start = Math.floor(Math.random() * span)
  for (let i = 0; i < span; i++) {
    const port = DEBUG_PORT_RANGE.from + ((start + i) % span)
    if (!taken.has(port) && portFree(port)) return port
  }
  return 0
}

/** `config.debugPort`: the DevTools port to use (`freeDebugPort` when the caller has none). */
export const browserArgs = (
  config: BrowserConfig & { readonly debugPort?: number | undefined },
  headless: boolean,
): Array<string> => [
  `--remote-debugging-port=${config.debugPort ?? freeDebugPort()}`,
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

export interface LaunchOptions {
  readonly logFile?: string | undefined
  /** the browser's environment (default: the node's own) */
  readonly env?: Readonly<Record<string, string>> | undefined
  /** attach to a browser already running on the profile (`findRunningBrowser`) instead of replacing it */
  readonly adopt?: boolean | undefined
  readonly cwd?: string | undefined
}

export const launchBrowser = (
  config: BrowserConfig & { readonly debugPort?: number | undefined },
  options?: LaunchOptions,
): Effect.Effect<LaunchedBrowser, BrowserUnavailable> =>
  Effect.gen(function* () {
    const exe = config.executable
    const logFile = options?.logFile
    if (!config.enabled) return yield* new BrowserUnavailable({ reason: "the browser is disabled on this node" })
    if (!exe) return yield* new BrowserUnavailable({ reason: "no Chromium or Chrome was found on this node" })
    const headless = resolveHeadless(config.headless)
    if (options?.adopt) {
      const running = findRunningBrowser(config.profileDir)
      if (running) {
        const wsUrl = yield* Effect.promise(() => browserWsUrl(running.port))
        if (wsUrl) return { proc: externalProcess(running.pid), port: running.port, wsUrl, headless, adopted: true }
      }
    }
    // a reserved port something else took meanwhile: any other free one
    const port = config.debugPort !== undefined && portFree(config.debugPort) ? config.debugPort : freeDebugPort()
    const activePortFile = path.join(config.profileDir, "DevToolsActivePort")
    const proc = yield* Effect.try({
      try: () => {
        mkdirSync(config.profileDir, { recursive: true, mode: 0o700 })
        if (logFile) mkdirSync(path.dirname(logFile), { recursive: true })
        clearStaleLock(config.profileDir)
        rmSync(activePortFile, { force: true })
        return Bun.spawn([exe, ...browserArgs({ ...config, debugPort: port }, headless)], {
          ...(options?.env ? { env: { ...options.env } } : {}),
          ...(options?.cwd ? { cwd: options.cwd } : {}),
          detached: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: logFile ? Bun.file(logFile) : "ignore",
        })
      },
      catch: (e) =>
        new BrowserUnavailable({ reason: `could not start ${exe}: ${e instanceof Error ? e.message : String(e)}` }),
    })
    const deadline = Date.now() + 20_000
    while (true) {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        return yield* new BrowserUnavailable({
          reason: `${path.basename(exe)} exited during startup (code ${proc.exitCode ?? proc.signalCode}); is the profile in use by another browser?`,
        })
      }
      if (port > 0) {
        const wsUrl = yield* Effect.promise(() => browserWsUrl(port))
        if (wsUrl) return { proc, port, wsUrl, headless, adopted: false }
      } else if (existsSync(activePortFile)) {
        // every range port was busy: Chrome picked one and wrote it here
        const [portLine, wsPath] = readFileSync(activePortFile, "utf8").split("\n")
        const picked = Number(portLine)
        if (Number.isInteger(picked) && picked > 0 && wsPath) {
          return { proc, port: picked, wsUrl: `ws://127.0.0.1:${picked}${wsPath.trim()}`, headless, adopted: false }
        }
      }
      if (Date.now() > deadline) {
        try {
          process.kill(-proc.pid, "SIGKILL")
        } catch {
          proc.kill("SIGKILL")
        }
        return yield* new BrowserUnavailable({
          reason: `${path.basename(exe)} did not open a DevTools port within 20 s`,
        })
      }
      yield* Effect.sleep(50)
    }
  })
