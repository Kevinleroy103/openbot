/**
 * Per-bot autonomy (`Bot.autonomy`, Grok "Allow automatically"): pure evaluation of a harness
 * approval that no user rule decided. ApprovalService applies it AFTER `evaluateRules` (a matching
 * deny / ask / allow rule always wins) and never to a node's own `ask` ceiling.
 *
 * - `ask` → ask.
 * - `full` → allow every harness approval (tool / command / file / mcp).
 * - `workspace` → allow only when the request's effects provably stay inside the bot's workspace
 *   or one of its project folders (Settings' shared ∪ the bot's own; "roots" below) on the node it
 *   runs on (`ApprovalWorkspace`):
 *   - the request runs on the workspace's node (`request.nodeId` absent or equal);
 *   - file surfaces (`file-edit` / `file-read`, any kind but mcp): every path resolves inside a
 *     root (relative paths against `cwd`, else the workspace; `..` resolved, never above it);
 *     Codex permission requests that also ask for the network are asked;
 *   - shell commands: `cwd` inside a root, and the command (a token scan, see
 *     `commandRisk`) references no absolute path / `~` / `..` outside the roots, uses no
 *     unverifiable expansion (`$VAR`, `$(…)`, backticks, `eval`, `sh -c`) and runs nothing from the
 *     risky list (sudo, ssh, git push, global installs, piping into a shell, …);
 *   - everything else (network, browser, computer, MCP, other tools) asks.
 *
 * `~` is expanded with the node's home when known (`ApprovalWorkspace.home`); otherwise `~` paths
 * compare symbolically with a `~` workspace (remote nodes) and `~` project folders are ignored
 * (they keep asking). Only pure path math is used (core has no `realpath`): a symlink inside a root
 * that points outside is not detected. Paths are POSIX; Windows-style roots compare with `\` read as
 * `/`, case-insensitively.
 */
import type { BotAutonomy, HarnessApprovalRequest } from "@openbot/contracts"
import { projectFolderProblem } from "@openbot/contracts"
import type { ApprovalWorkspace } from "../../ports/services.ts"
import { surfaceOf } from "./policy.ts"

export type { ApprovalWorkspace }

export interface AutonomyDecision {
  readonly action: "allow" | "ask"
  /** Why (tests, logs): "full", "inside-workspace", or the reason it asks. */
  readonly reason: string
}

const ask = (reason: string): AutonomyDecision => ({ action: "ask", reason })

// ------------------------------------------------------------------------------ path math

const isWindowsPath = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path)

interface Root {
  readonly windows: boolean
  /** Normalized segments of the workspace (the first one is `~` or a drive for those roots). */
  readonly segments: ReadonlyArray<string>
  /** "/", "~/" or "C:/" */
  readonly anchor: "/" | "~" | "drive"
}

/**
 * Normalizes an absolute (`/x`, `~/x`, `C:\x`) path into segments; `undefined` when it is not
 * absolute or a `..` climbs above its root.
 */
const absoluteSegments = (
  raw: string,
  windows: boolean,
): { readonly anchor: Root["anchor"]; readonly segments: Array<string> } | undefined => {
  let path = windows ? raw.replace(/\\/g, "/") : raw
  let anchor: Root["anchor"]
  let head: Array<string> = []
  if (path === "~" || path.startsWith("~/")) {
    anchor = "~"
    head = ["~"]
    path = path.slice(1)
  } else if (windows && /^[A-Za-z]:\//.test(path)) {
    anchor = "drive"
    head = [path.slice(0, 2).toLowerCase()]
    path = path.slice(2)
  } else if (path.startsWith("/")) {
    anchor = "/"
  } else {
    return undefined
  }
  const out = [...head]
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (out.length <= head.length) return undefined
      out.pop()
      continue
    }
    out.push(windows ? part.toLowerCase() : part)
  }
  return { anchor, segments: out }
}

const rootOf = (workspace: string): Root | undefined => {
  const windows = isWindowsPath(workspace)
  const parsed = absoluteSegments(workspace, windows)
  if (parsed === undefined) return undefined
  // The workspace must be a real directory below a root, never "/" or "~" itself.
  const minimum = parsed.anchor === "/" ? 1 : 2
  if (parsed.segments.length < minimum) return undefined
  return { windows, anchor: parsed.anchor, segments: parsed.segments }
}

const within = (root: Root, anchor: Root["anchor"], segments: ReadonlyArray<string>): boolean =>
  anchor === root.anchor && segments.length >= root.segments.length && root.segments.every((s, i) => segments[i] === s)

/** `~` and `~/x` with the home spelled out (when known); anything else unchanged. */
const expandHome = (path: string, home: string | undefined): string => {
  if (home === undefined || !(path === "~" || path.startsWith("~/"))) return path
  return `${home.replace(/[\\/]+$/, "")}${path.slice(1)}`
}

/**
 * The roots autonomy "workspace" works in: the workspace, then each project folder (`~` expanded
 * with `home`; `~` folders are skipped when the home is unknown, and a folder `projectFolderProblem`
 * refuses — `/`, `~`, a whole home, relative, with `..` — never counts).
 */
interface Roots {
  readonly list: ReadonlyArray<Root>
  readonly home: string | undefined
}

const rootsOf = (
  workspace: string,
  options?: { readonly projectFolders?: ReadonlyArray<string> | undefined; readonly home?: string | undefined },
): Roots | undefined => {
  const home = options?.home !== undefined && rootOf(options.home) !== undefined ? options.home : undefined
  const main = rootOf(expandHome(workspace, home))
  if (main === undefined) return undefined
  const list: Array<Root> = [main]
  for (const raw of options?.projectFolders ?? []) {
    const folder = raw.trim()
    if (projectFolderProblem(folder) !== undefined) continue // `/`, `~`, a whole home, relative, `..`
    if (folder.startsWith("~") && home === undefined) continue
    const root = rootOf(expandHome(folder, home))
    if (root !== undefined) list.push(root)
  }
  return { list, home }
}

/** Resolves `path` (absolute, `~`, or relative to `base`) and checks it is inside `root`. */
const pathInsideRoot = (root: Root, path: string, base: string, home: string | undefined): boolean => {
  const p = expandHome(root.windows ? path.replace(/\\/g, "/") : path, home)
  if (p.startsWith("~") && p !== "~" && !p.startsWith("~/")) return false // ~user
  const absolute = p.startsWith("/") || p === "~" || p.startsWith("~/") || (root.windows && /^[A-Za-z]:\//.test(p))
  const joined = absolute ? p : `${expandHome(base, home).replace(/[\\/]+$/, "")}/${p}`
  const parsed = absoluteSegments(joined, root.windows)
  return parsed !== undefined && within(root, parsed.anchor, parsed.segments)
}

/** True when `path` (relative ones against `base`) is inside one of the roots. */
const pathInside = (roots: Roots, path: string, base: string): boolean =>
  roots.list.some((root) => pathInsideRoot(root, path, base, roots.home))

/** True when `path` is inside `workspace` (pure path math; relative paths resolve against `base`). */
export const isInsideWorkspace = (workspace: string, path: string, base: string = workspace): boolean => {
  const roots = rootsOf(workspace)
  return roots !== undefined && pathInside(roots, base, workspace) && pathInside(roots, path, base)
}

/**
 * True when `path` is inside the workspace or a project folder (pure path math; relative paths
 * resolve against `base`, which defaults to the workspace).
 */
export const isInsideRoots = (workspace: ApprovalWorkspace, path: string, base: string = workspace.path): boolean => {
  const roots = rootsOf(workspace.path, workspace)
  return roots !== undefined && pathInside(roots, base, workspace.path) && pathInside(roots, path, base)
}

// ------------------------------------------------------------------------------ commands

/** Programs that always ask under "workspace" (they reach beyond the workspace or the machine). */
const RISKY_PROGRAMS: ReadonlySet<string> = new Set([
  "sudo",
  "su",
  "doas",
  "pkexec",
  "runas",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  "ftp",
  "eval",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "init",
  "mkfs",
  "fdisk",
  "parted",
  "dd",
  "mount",
  "umount",
  "diskutil",
  "kill",
  "killall",
  "pkill",
  "systemctl",
  "launchctl",
  "service",
  "crontab",
  "iptables",
  "ufw",
  "nft",
  "apt",
  "apt-get",
  "dpkg",
  "yum",
  "dnf",
  "pacman",
  "brew",
  "snap",
  "flatpak",
  "port",
  "zypper",
  "apk",
  "docker",
  "podman",
  "kubectl",
  "gh",
  "open",
  "xdg-open",
  "chown",
  "chgrp",
])

/** Shells: `sh -c "…"` (unverifiable) and anything piped into a shell (`curl … | sh`) ask. */
const SHELLS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "pwsh",
  "powershell",
  "cmd",
])

/** Wrappers whose first non-option argument is the real program. */
const WRAPPERS: ReadonlySet<string> = new Set([
  "env",
  "time",
  "nohup",
  "nice",
  "command",
  "builtin",
  "exec",
  "xargs",
  "timeout",
  "stdbuf",
])

/** Device paths a command may name freely. */
const HARMLESS_ABSOLUTE: ReadonlySet<string> = new Set([
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/stdin",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/tty",
])

interface Token {
  readonly text: string
}

interface Segment {
  readonly tokens: ReadonlyArray<Token>
  /** Separator before the segment ("|" for a pipe). */
  readonly after: string
}

/**
 * Splits a command into segments (on `;`, `&&`, `||`, `|`, `&`, newlines) of quote-aware tokens.
 * Any expansion outside single quotes (`$VAR`, `${…}`, `$(…)`, backticks) makes the command
 * unverifiable: "expansion".
 */
const parseCommand = (command: string): ReadonlyArray<Segment> | "unbalanced" | "expansion" => {
  const segments: Array<Segment> = []
  let tokens: Array<Token> = []
  let current = ""
  let started = false
  let quote: "'" | '"' | undefined
  let separator = ""
  const endToken = () => {
    if (started) tokens.push({ text: current })
    current = ""
    started = false
  }
  const endSegment = (next: string) => {
    endToken()
    if (tokens.length > 0) segments.push({ tokens, after: separator })
    tokens = []
    separator = next
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote !== "'" && (c === "`" || (c === "$" && /[{(A-Za-z_]/.test(command[i + 1] ?? "")))) return "expansion"
    if (quote !== undefined) {
      if (c === quote) quote = undefined
      else if (c === "\\" && quote === '"' && i + 1 < command.length) current += command[++i]!
      else current += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      started = true
      continue
    }
    if (c === "\\" && i + 1 < command.length) {
      current += command[++i]!
      started = true
      continue
    }
    if (c === " " || c === "\t") {
      endToken()
      continue
    }
    if (c === "\n" || c === "\r" || c === ";") {
      endSegment(";")
      continue
    }
    if (c === "|" || c === "&") {
      const pair = command[i + 1] === c
      // `2>&1`, `>&2`, `&>file`: a redirection, not a separator.
      if (c === "&" && (current.endsWith(">") || command[i - 1] === ">")) {
        current += c
        started = true
        continue
      }
      endSegment(c === "|" && !pair ? "|" : c === "&" && !pair ? "&" : c + c)
      if (pair) i++
      continue
    }
    current += c
    started = true
  }
  if (quote !== undefined) return "unbalanced"
  endSegment("")
  return segments
}

/** Redirection operators glued to a token (`>out.txt`, `2>>log`, `&>x`, `<in`) → the target. */
const redirectTarget = (text: string): string | undefined => {
  const match = /^(?:\d*>>?|&>>?|<<?<?|\d*<)&?(.*)$/.exec(text)
  return match === null ? undefined : match[1]
}

const looksLikePath = (text: string): boolean =>
  text.startsWith("/") ||
  text.startsWith("~") ||
  text === ".." ||
  text.startsWith("../") ||
  text.includes("/../") ||
  text.endsWith("/..") ||
  /^[A-Za-z]:[\\/]/.test(text)

/** Candidate paths inside one token (`--out=/x`, `VAR=/x`, `a:/b` lists; URLs are not paths). */
const pathCandidates = (text: string): ReadonlyArray<string> => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return []
  const parts = [text]
  const eq = text.indexOf("=")
  if (eq >= 0 && !text.slice(eq + 1).includes("://")) parts.push(text.slice(eq + 1))
  for (const part of [...parts]) {
    if (part.includes(":") && !part.includes("://") && !/^[A-Za-z]:[\\/]/.test(part)) parts.push(...part.split(":"))
  }
  const found = parts.filter((p) => p.length > 0 && looksLikePath(p))
  // Paths embedded in inline code or quoted text: `open("/etc/x")`, `-e 'fs.rmSync("~/x")'`.
  for (const match of text.matchAll(/(?:^|[\s"'(=,;[{])((?:~|\.\.)?\/[^\s"'),;\]}]*)/g)) {
    const embedded = match[1]!
    if (embedded !== text && embedded !== "/" && !found.includes(embedded)) found.push(embedded)
  }
  return found
}

/** A program named by its path in a system bin directory (`/usr/bin/env`): same as its bare name. */
const SYSTEM_PROGRAM = /^\/(?:usr\/(?:local\/)?)?s?bin\/[^/]+$|^\/opt\/homebrew\/bin\/[^/]+$/

/** Strips env assignments and wrappers: `FOO=1 env time bun test` → `bun`. */
const programOf = (tokens: ReadonlyArray<Token>): { readonly program: string | undefined; readonly index: number } => {
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]!.text
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++
      continue
    }
    const base = t.split("/").pop() ?? t
    if (WRAPPERS.has(base)) {
      i++
      // options and numeric args of the wrapper (`timeout 30`, `nice -n 5`, `env -u X`)
      while (i < tokens.length && (/^-/.test(tokens[i]!.text) || /^\d+[smhd]?$/.test(tokens[i]!.text))) i++
      continue
    }
    return { program: t, index: i }
  }
  return { program: undefined, index: i }
}

const GLOBAL_FLAGS: ReadonlySet<string> = new Set(["-g", "--global", "--location=global", "--system", "--user"])

/** Why a single segment asks (undefined = it stays inside). */
const riskOf = (segment: Segment, roots: Roots, cwd: string): string | undefined => {
  const { program, index } = programOf(segment.tokens)
  if (program === undefined) return undefined
  const name = (program.split("/").pop() ?? program).toLowerCase()
  const args = segment.tokens.slice(index + 1).map((t) => t.text)
  if (RISKY_PROGRAMS.has(name) || /^mkfs(\.|$)/.test(name)) return `risky command: ${name}`
  // `cd` alone goes home, `cd -` / `popd` to an unknown earlier directory.
  if (name === "popd") return "changes to an unknown directory"
  if ((name === "cd" || name === "pushd") && (args.length === 0 || args.some((a) => a.startsWith("-"))))
    return "changes to an unknown directory"
  if (SHELLS.has(name)) {
    if (segment.after === "|") return "pipes into a shell"
    if (args.some((a) => /^-[a-z]*c[a-z]*$/i.test(a) || a === "/c" || a === "-Command")) return "inline shell script"
  }
  if (
    segment.after === "|" &&
    ["python", "python3", "node", "bun", "deno", "perl", "ruby", "php"].includes(name) &&
    args.every((a) => a.startsWith("-"))
  ) {
    return "pipes into an interpreter"
  }
  if (name === "git") {
    const sub = args.find((a) => !a.startsWith("-"))
    if (
      sub === "push" ||
      sub === "send-email" ||
      sub === "daemon" ||
      args.includes("--global") ||
      args.includes("--system")
    ) {
      return `risky command: git ${sub ?? ""}`.trim()
    }
  }
  if (["npm", "pnpm", "yarn", "bun", "pip", "pip3", "pipx", "cargo", "go", "gem", "uv", "npx", "bunx"].includes(name)) {
    if (args.some((a) => GLOBAL_FLAGS.has(a))) return "global install"
    const sub = args.find((a) => !a.startsWith("-"))
    if (sub === "publish" || (name === "cargo" && sub === "install") || (name === "go" && sub === "install"))
      return `risky command: ${name} ${sub}`
    if ((name === "yarn" || name === "pnpm") && sub === "global") return "global install"
    if (name === "uv" && sub === "tool") return "global install"
  }
  // Paths named anywhere in the segment (program included) must stay inside.
  for (const [i, token] of segment.tokens.entries()) {
    if (i <= index && SYSTEM_PROGRAM.test(token.text)) continue
    const target = redirectTarget(token.text)
    const texts = target === undefined ? [token.text] : [target]
    for (const text of texts) {
      for (const candidate of pathCandidates(text)) {
        const bare = candidate.replace(/[*?[].*$/, "").replace(/\/+$/, "") || candidate
        if (HARMLESS_ABSOLUTE.has(bare)) continue
        if (!pathInside(roots, bare, cwd)) return `path outside the workspace: ${candidate}`
      }
    }
  }
  return undefined
}

/**
 * Heuristic scan of a shell command run in `cwd`: undefined when it stays inside `workspace` (or a
 * project folder), else the reason it must ask (see the module header).
 */
export const commandRisk = (
  command: string,
  cwd: string,
  workspace: string,
  options?: { readonly projectFolders?: ReadonlyArray<string> | undefined; readonly home?: string | undefined },
): string | undefined => {
  const roots = rootsOf(workspace, options)
  if (roots === undefined) return "no workspace"
  if (!pathInside(roots, cwd, workspace)) return "runs outside the workspace"
  const segments = parseCommand(command)
  if (segments === "unbalanced") return "unbalanced quotes"
  if (segments === "expansion") return "shell expansion"
  if (segments.length === 0) return "empty command"
  for (const segment of segments) {
    const risk = riskOf(segment, roots, cwd)
    if (risk !== undefined) return risk
  }
  return undefined
}

// ------------------------------------------------------------------------------ evaluation

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Codex `request_permissions` (and the like) asking for network access as well. */
const wantsNetwork = (request: HarnessApprovalRequest): boolean =>
  isRecord(request.input) && isRecord(request.input.network) && request.input.network.enabled === true

/** Autonomy verdict for an approval no rule decided. */
export const evaluateAutonomy = (
  autonomy: BotAutonomy,
  request: HarnessApprovalRequest,
  workspace: ApprovalWorkspace | undefined,
): AutonomyDecision => {
  if (autonomy === "ask") return ask("autonomy is ask")
  // which skills a Bot has is the owner's call (or a rule's), whatever the autonomy
  if (surfaceOf(request) === "skills") return ask("changes a Bot's skills")
  if (autonomy === "full") return { action: "allow", reason: "full" }
  if (workspace === undefined) return ask("workspace unknown")
  const roots = rootsOf(workspace.path, workspace)
  if (roots === undefined) return ask("workspace unknown")
  if (request.nodeId !== undefined && request.nodeId !== workspace.nodeId) return ask("another computer")
  if (request.kind === "mcp-approval") return ask("MCP tool")
  const surface = surfaceOf(request)
  const base = request.cwd ?? workspace.path
  switch (surface) {
    case "file-edit":
    case "file-read": {
      const paths = request.paths ?? []
      if (paths.length === 0) return ask("no paths")
      if (wantsNetwork(request)) return ask("network access")
      if (request.cwd !== undefined && !pathInside(roots, request.cwd, workspace.path))
        return ask("runs outside the workspace")
      return paths.every((p) => p.trim().length > 0 && pathInside(roots, p.trim(), base))
        ? { action: "allow", reason: "inside-workspace" }
        : ask("path outside the workspace")
    }
    case "shell": {
      if (request.kind !== "command-approval") return ask("not a command")
      if (request.cwd === undefined) return ask("no working directory")
      if (request.command === undefined || request.command.trim().length === 0) return ask("no command")
      const risk = commandRisk(request.command, request.cwd, workspace.path, workspace)
      return risk === undefined ? { action: "allow", reason: "inside-workspace" } : ask(risk)
    }
    default:
      return ask(`${surface} access`)
  }
}

// ------------------------------------------------------------------------------ "Allow in ‹folder›"

/** `/a/b/../c` → `/a/c` (pure; `~` expanded with `home`); undefined when not absolute. */
const cleanAbsolute = (path: string, home: string | undefined): string | undefined => {
  const expanded = expandHome(path.trim(), home)
  const windows = isWindowsPath(expanded)
  const parsed = absoluteSegments(expanded, windows)
  if (parsed === undefined || parsed.anchor === "~") return undefined
  if (parsed.anchor === "drive") return `${parsed.segments[0]!.toUpperCase()}\\${parsed.segments.slice(1).join("\\")}`
  return `/${parsed.segments.join("/")}`
}

const parentOf = (path: string): string => {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return cut <= 0 ? path.slice(0, 1) : path.slice(0, cut)
}

/**
 * The directory a shell / file request works in when that directory is outside the workspace and
 * every project folder (the start of an "Allow in ‹folder›" offer; ApprovalService then prefers the
 * git repo root around it): the request's `cwd`, else the directory of its first file path outside
 * the roots. Undefined when the request runs on another node, is not a shell / file request, already
 * works inside a root (it asks for another reason), or names no absolute directory.
 */
export const outsideWorkDir = (
  request: HarnessApprovalRequest,
  workspace: ApprovalWorkspace | undefined,
): string | undefined => {
  if (workspace === undefined) return undefined
  if (request.nodeId !== undefined && request.nodeId !== workspace.nodeId) return undefined
  if (request.kind === "mcp-approval") return undefined
  const surface = surfaceOf(request)
  if (surface !== "shell" && surface !== "file-edit" && surface !== "file-read") return undefined
  const roots = rootsOf(workspace.path, workspace)
  if (roots === undefined) return undefined
  const home = roots.home
  if (request.cwd !== undefined && request.cwd.trim().length > 0) {
    if (!pathInside(roots, request.cwd, workspace.path)) return cleanAbsolute(request.cwd, home)
    if (surface === "shell") return undefined
  }
  const base = request.cwd ?? workspace.path
  for (const raw of request.paths ?? []) {
    const p = raw.trim()
    if (p.length === 0 || pathInside(roots, p, base)) continue
    const absolute =
      cleanAbsolute(p, home) ?? cleanAbsolute(`${expandHome(base, home).replace(/[\\/]+$/, "")}/${p}`, home)
    return absolute === undefined ? undefined : parentOf(absolute)
  }
  return undefined
}

/** Top-level system directories never offered as a project folder. */
const SYSTEM_TOP = new Set([
  "etc",
  "usr",
  "bin",
  "sbin",
  "lib",
  "lib32",
  "lib64",
  "libx32",
  "boot",
  "dev",
  "proc",
  "sys",
  "run",
  "var",
  "snap",
  "System",
  "Library",
  "private",
  "Applications",
  "Windows",
  "Program Files",
  "Program Files (x86)",
  "ProgramData",
])
/** Secret directories (the node deny-list) never offered either. */
const SECRET_SEGMENTS = new Set([".ssh", ".gnupg", ".aws", ".kube", ".password-store", ".config", ".local"])

/**
 * Whether "Allow in ‹folder›" may offer `folder` (absolute, already cleaned): a valid project folder
 * (`projectFolderProblem`), not the home directory or one of its ancestors, not a system directory
 * and not inside a secrets / config directory.
 */
export const offerableFolder = (folder: string, home: string | undefined): boolean => {
  if (projectFolderProblem(folder) !== undefined) return false
  const windows = isWindowsPath(folder)
  const parsed = absoluteSegments(folder, windows)
  if (parsed === undefined || parsed.anchor === "~") return false
  const segments = parsed.anchor === "drive" ? parsed.segments.slice(1) : parsed.segments
  if (segments.length === 0 || SYSTEM_TOP.has(segments[0]!)) return false
  if (segments.some((s) => SECRET_SEGMENTS.has(s))) return false
  if (home !== undefined) {
    const h = absoluteSegments(home, isWindowsPath(home))
    // the home itself, or a directory above it
    if (
      h !== undefined &&
      h.anchor === parsed.anchor &&
      parsed.segments.length <= h.segments.length &&
      parsed.segments.every((s, i) => h.segments[i] === s)
    ) {
      return false
    }
  }
  return true
}

/** Labels for the UI and event lines. */
export const AUTONOMY_LABELS: Readonly<Record<BotAutonomy, string>> = {
  ask: "Ask first",
  workspace: "Auto in workspace",
  full: "Full auto",
}
