// Node configuration (docs/architecture.md §4.7, remote-prior-art.md §4.7–4.8).
// One `NodeConfig` per node process (remote daemon) or per embedded local node (brain-nodes).
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import { existsSync } from "node:fs"
import { arch as osArch, homedir, hostname as osHostname } from "node:os"
import * as path from "node:path"
import type { NodeRoot, PolicyCeiling } from "@openbot/node-protocol"

/** Node-side action vocabulary (Grok-style; also the `action` of `node.requestApproval`). */
export const NodeActions = [
  "read-file",
  "list-directory",
  "write-file",
  "run-command",
  "pty",
  "tunnel",
  "service",
  "forward",
  "browser",
  "computer",
] as const
export type NodeAction = (typeof NodeActions)[number]

export interface NodePolicyConfig {
  /** Default ceiling for every action (D1.4). The brain can never raise it (`remoteManaged: false`). */
  readonly ceiling: PolicyCeiling
  /** Per-action overrides of the ceiling. */
  readonly actions: Readonly<Partial<Record<NodeAction, PolicyCeiling>>>
  /** `run-command` lines matching any of these regexes need `ask` even when the ceiling is `always`. */
  readonly askCommands: ReadonlyArray<string>
  /** `run-command` lines matching any of these regexes are refused (`never`). */
  readonly denyCommands: ReadonlyArray<string>
  /** Always false in v1: the brain cannot change the node's policy. */
  readonly remoteManaged: boolean
}

export interface BrowserConfig {
  readonly enabled: boolean
  /** Chromium/Chrome binary; detected from PATH when undefined. */
  readonly executable?: string | undefined
  /**
   * `auto` (default): headless, so bots' windows never pop up on the owner's own screen (the web
   * app shows them). `false` forces headful windows on the node's display. On a node that offers
   * desktops, every bot's browser runs headful on the bot's own screen regardless.
   */
  readonly headless: "auto" | boolean
  /** Persistent profile (cookies survive restarts). Default `<dataDir>/browser-profile`. */
  readonly profileDir: string
  readonly width: number
  readonly height: number
  readonly extraArgs: ReadonlyArray<string>
  /** Timeout for page loads after `navigate`, ms. */
  readonly navigationTimeoutMs: number
}

/** Per-bot desktops (capability `desktop@1`, D1.7): one virtual X display per bot. */
export interface DesktopConfig {
  /** Offer desktops when the programs are installed (default: true unless `detectBinaries: false`). */
  readonly enabled: boolean
  /** Screen size of every bot desktop (default 1920×1200, like Grok's computer). */
  readonly width: number
  readonly height: number
  /** Width of the model-facing screenshot space (default 1280; `apiH = round(apiW · H / W)`). */
  readonly apiWidth: number
  /** First X display number tried (default 100). */
  readonly displayBase: number
  /**
   * Program directories searched first and put first on the desktop's PATH (env
   * `OPENBOT_DESKTOP_PATH`, colon-separated). For a rootless install (`<prefix>/usr/bin`), the
   * sibling `lib` and `share` dirs are added to LD_LIBRARY_PATH and XDG_DATA_DIRS.
   */
  readonly path: ReadonlyArray<string>
  /** Extra environment for every desktop program. */
  readonly env: Readonly<Record<string, string>>
  /** Delay before the screenshot that follows a computer action, ms (default 400). */
  readonly settleMs: number
  /** Screenshot encoding for the model (default JPEG quality 80). */
  readonly imageFormat: "jpeg" | "webp" | "png"
  readonly imageQuality: number
}

/** The computer's own screen (capability `screen@1`, macOS): shared by its bots and the owner. */
export interface ScreenConfig {
  /** Offer it on macOS (default: true unless `detectBinaries: false`). */
  readonly enabled: boolean
  /**
   * The helper process that posts mouse and keyboard events (default: this program's
   * `screen-helper` command when compiled, else Bun running ./screen/helper.ts).
   */
  readonly helper?: ReadonlyArray<string> | undefined
}

export interface NodeLimits {
  /** `fs.read` default/max bytes per call. */
  readonly readBytes: number
  /** max file size for `fs.write`/`fs.edit`. */
  readonly writeBytes: number
  /** `shell.exec` streamed-output cap (the rest is spilled to a file). */
  readonly execOutputBytes: number
  readonly listEntries: number
  readonly globResults: number
  readonly grepMatches: number
  /** max file size for `fs.download` (a bot sends a file to its owner); the brain applies its own cap too. */
  readonly transferBytes: number
}

export interface NodeConfigShape {
  readonly nodeId: string
  /** Node software version (reported in `node.hello`). */
  readonly version: string
  /** Node state dir: audit log, browser profile, spill fallback, per-bot tool homes. */
  readonly dataDir: string
  /**
   * Workspace roots. A root path may contain `{botId}` (replaced by the calling bot's id) and `*`
   * segments (any single directory name), e.g. `<data>/bots/{botId}/workspace`.
   */
  readonly roots: ReadonlyArray<NodeRoot>
  /**
   * Extra per-bot roots computed at call time (absolute paths, `~` expanded with the home), e.g. the
   * brain's project folders for the in-process local node. Not reported in `node.hello`, never
   * created, read-write. The same path policy (realpath containment, deny-list) applies.
   */
  readonly extraRoots?: ((botId: string) => ReadonlyArray<string>) | undefined
  /** Extra deny globs (absolute-path globs, e.g. `**\/secrets/**`), on top of the built-in list. */
  readonly denyGlobs: ReadonlyArray<string>
  readonly policy: NodePolicyConfig
  readonly limits: NodeLimits
  readonly shell: {
    /** Program used for `shell.exec` (`<program> -c <command>`). */
    readonly program: string
    /** Program for `pty.open` when the payload has no `shell`. */
    readonly interactive: string
  }
  readonly binaries: {
    readonly codex?: string | undefined
    readonly opencode?: string | undefined
    readonly rg?: string | undefined
  }
  readonly browser: BrowserConfig
  readonly desktop: DesktopConfig
  /** absent: on (macOS only) */
  readonly screen?: ScreenConfig | undefined
  readonly hostname: string
  readonly platform: string
  readonly arch: string
  /** Forward audit entries to the brain as `node.event{type:"audit"}`. */
  readonly forwardAudit: boolean
}

export class NodeConfig extends Context.Service<NodeConfig, NodeConfigShape>()("openbot/node-daemon/NodeConfig") {}

export const NODE_DAEMON_VERSION = "0.1.0"

/** Risky commands that need the brain's approval even under an `always` ceiling. */
export const DEFAULT_ASK_COMMANDS: ReadonlyArray<string> = [
  String.raw`(^|[;&|]\s*)sudo\b`,
  String.raw`\bgit\s+push\b.*--force`,
  String.raw`\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b`,
]

/** Commands the node refuses outright. */
export const DEFAULT_DENY_COMMANDS: ReadonlyArray<string> = [
  String.raw`\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(/|/\*|~|~/|\$HOME/?)(\s|$)`,
  String.raw`\bmkfs(\.\w+)?\b`,
  String.raw`\bdd\b[^\n]*\bof=/dev/(sd|nvme|hd|vd|mmcblk)`,
  String.raw`:\(\)\s*\{\s*:\|:&\s*\};:`,
]

export interface NodeConfigInput {
  readonly nodeId: string
  readonly dataDir: string
  readonly roots?: ReadonlyArray<NodeRoot | string> | undefined
  /** See `NodeConfigShape.extraRoots`. */
  readonly extraRoots?: ((botId: string) => ReadonlyArray<string>) | undefined
  readonly version?: string | undefined
  readonly denyGlobs?: ReadonlyArray<string> | undefined
  readonly policy?: Partial<NodePolicyConfig> | undefined
  readonly limits?: Partial<NodeLimits> | undefined
  readonly shell?: Partial<NodeConfigShape["shell"]> | undefined
  readonly binaries?: NodeConfigShape["binaries"] | undefined
  /** Look up codex/opencode/rg/chromium (and the desktop programs) on PATH when not given (default true). */
  readonly detectBinaries?: boolean | undefined
  readonly browser?: Partial<BrowserConfig> | undefined
  readonly desktop?: Partial<DesktopConfig> | undefined
  readonly screen?: Partial<ScreenConfig> | undefined
  readonly hostname?: string | undefined
  readonly forwardAudit?: boolean | undefined
}

const which = (name: string): string | undefined => Bun.which(name) ?? undefined

/**
 * Google Chrome first (what Grok's computer runs, and what sites like Google sign-in trust most),
 * then Chromium. On Linux the browser binaries come before the distro launchers: Arch's `chromium` and
 * `google-chrome-stable` add the user's own `~/.config/chrom*-flags.conf` (extensions, Wayland flags).
 */
export const BROWSER_CANDIDATES: ReadonlyArray<string> = [
  "/opt/google/chrome/google-chrome",
  "google-chrome-stable",
  "google-chrome",
  "chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/lib/chromium/chromium",
  "chromium",
  "chromium-browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
]

/** First Chromium/Chrome found on PATH (or at a well-known macOS path). */
export const detectBrowserExecutable = (): string | undefined => {
  for (const c of BROWSER_CANDIDATES) {
    if (c.startsWith("/")) {
      if (existsSync(c)) return c
      continue
    }
    const found = which(c)
    if (found) return found
  }
  return undefined
}

/** `OPENBOT_DESKTOP_PATH` (colon-separated program dirs). */
export const desktopPathFromEnv = (env: Readonly<Record<string, string | undefined>> = process.env): ReadonlyArray<string> =>
  (env.OPENBOT_DESKTOP_PATH ?? "")
    .split(":")
    .map((p) => p.trim())
    .filter((p) => p !== "")

/**
 * Environment for desktop programs found in rootless prefixes: for each `<prefix>/usr/bin` (or
 * `<prefix>/bin`) dir, its sibling `lib` goes on LD_LIBRARY_PATH and `share` on XDG_DATA_DIRS.
 */
export const desktopPrefixEnv = (dirs: ReadonlyArray<string>, exists: (p: string) => boolean = existsSync): Record<string, string> => {
  const libs: Array<string> = []
  const shares: Array<string> = []
  for (const d of dirs) {
    const prefix = path.dirname(path.resolve(d))
    if (prefix === "/" || prefix === "/usr" || prefix === "/usr/local") continue
    if (exists(path.join(prefix, "lib"))) libs.push(path.join(prefix, "lib"))
    if (exists(path.join(prefix, "share"))) shares.push(path.join(prefix, "share"))
  }
  const env: Record<string, string> = {}
  if (libs.length > 0) env.LD_LIBRARY_PATH = libs.join(":")
  if (shares.length > 0) env.XDG_DATA_DIRS = [...shares, "/usr/local/share", "/usr/share"].join(":")
  return env
}

/** Expand a leading `~` to the home directory. */
export const expandHome = (p: string): string =>
  p === "~" ? homedir() : p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p

const normalizeRoot = (r: NodeRoot | string, i: number): NodeRoot =>
  typeof r === "string"
    ? { id: i === 0 ? "work" : `root${i + 1}`, path: path.resolve(expandHome(r)), mode: "rw" }
    : { ...r, path: path.resolve(expandHome(r.path)) }

/** Fill defaults. Roots default to `~/openbot` (not `$HOME`, remote-prior-art.md §4.7). */
export const makeNodeConfig = (input: NodeConfigInput): NodeConfigShape => {
  const detect = input.detectBinaries ?? true
  const dataDir = path.resolve(expandHome(input.dataDir))
  const roots = (input.roots && input.roots.length > 0 ? input.roots : [path.join(homedir(), "openbot")]).map(normalizeRoot)
  return {
    nodeId: input.nodeId,
    version: input.version ?? NODE_DAEMON_VERSION,
    dataDir,
    roots,
    ...(input.extraRoots === undefined ? {} : { extraRoots: input.extraRoots }),
    denyGlobs: input.denyGlobs ?? [],
    policy: {
      ceiling: input.policy?.ceiling ?? "always",
      actions: input.policy?.actions ?? {},
      askCommands: input.policy?.askCommands ?? DEFAULT_ASK_COMMANDS,
      denyCommands: input.policy?.denyCommands ?? DEFAULT_DENY_COMMANDS,
      remoteManaged: false,
    },
    limits: {
      readBytes: 256 * 1024,
      writeBytes: 100 * 1024 * 1024,
      execOutputBytes: 64 * 1024,
      listEntries: 1000,
      globResults: 1000,
      grepMatches: 500,
      transferBytes: 1024 * 1024 * 1024,
      ...input.limits,
    },
    shell: {
      program: input.shell?.program ?? (which("bash") ?? "/bin/sh"),
      interactive: input.shell?.interactive ?? process.env.SHELL ?? which("bash") ?? "/bin/sh",
    },
    binaries: {
      codex: input.binaries?.codex ?? (detect ? which("codex") : undefined),
      opencode: input.binaries?.opencode ?? (detect ? which("opencode") : undefined),
      rg: input.binaries?.rg ?? (detect ? which("rg") : undefined),
    },
    browser: {
      enabled: input.browser?.enabled ?? true,
      executable: input.browser?.executable ?? (detect ? detectBrowserExecutable() : undefined),
      headless: input.browser?.headless ?? "auto",
      profileDir: input.browser?.profileDir ?? path.join(dataDir, "browser-profile"),
      width: input.browser?.width ?? 1280,
      height: input.browser?.height ?? 800,
      extraArgs: input.browser?.extraArgs ?? [],
      navigationTimeoutMs: input.browser?.navigationTimeoutMs ?? 15_000,
    },
    desktop: (() => {
      const desktopPath = (input.desktop?.path ?? desktopPathFromEnv()).map((p) => path.resolve(expandHome(p)))
      return {
        // like the other programs, desktops are only probed for when binaries are detected
        enabled: input.desktop?.enabled ?? detect,
        width: input.desktop?.width ?? 1920,
        height: input.desktop?.height ?? 1200,
        apiWidth: input.desktop?.apiWidth ?? 1280,
        displayBase: input.desktop?.displayBase ?? 100,
        path: desktopPath,
        env: input.desktop?.env ?? desktopPrefixEnv(desktopPath),
        settleMs: input.desktop?.settleMs ?? 400,
        imageFormat: input.desktop?.imageFormat ?? "jpeg",
        imageQuality: input.desktop?.imageQuality ?? 80,
      }
    })(),
    screen: { enabled: input.screen?.enabled ?? detect, helper: input.screen?.helper },
    hostname: input.hostname ?? osHostname(),
    platform: process.platform,
    arch: osArch(),
    forwardAudit: input.forwardAudit ?? true,
  }
}

export const NodeConfigLive = (input: NodeConfigInput | NodeConfigShape): Layer.Layer<NodeConfig> =>
  Layer.succeed(NodeConfig)("limits" in input && "shell" in input && "browser" in input && "desktop" in input && "platform" in input
    ? (input as NodeConfigShape)
    : makeNodeConfig(input as NodeConfigInput))
