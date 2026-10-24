/**
 * Claude harness accounts ("profiles"): a profile is a `CLAUDE_CONFIG_DIR` on the brain machine.
 *
 * - The DEFAULT profile is "no override": the CLI runs with the brain's environment, so it uses
 *   `$CLAUDE_CONFIG_DIR` when the brain was started with one, else `~/.claude` (+ `~/.claude.json`).
 * - Any other profile sets `CLAUDE_CONFIG_DIR=<configDir>` for the CLI it spawns (sessions and
 *   probes). `~/.claude` itself is spelled as "no override" because Claude Code keeps that login's
 *   `.claude.json` in `$HOME`, not in the dir.
 *
 * Policy (AGENTS.md, D0.2): OpenBot only points the owner's own CLI at the owner's own config dir
 * on this machine. It never reads, copies or forwards credentials and never changes `HOME`. The
 * only file it reads is the non-secret `.claude.json` (`oauthAccount.emailAddress` /
 * `organizationName`) to suggest a label during discovery.
 */
import type { HarnessAccount } from "@openbot/contracts"
import { readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"

export interface ClaudeProfile {
  readonly id: string
  readonly label?: string | undefined
  /** Absolute `CLAUDE_CONFIG_DIR`. */
  readonly configDir: string
}

type Env = Readonly<Record<string, string | undefined>>

/** `~/.claude`: the CLI's built-in config dir (its `.claude.json` lives in `$HOME`). */
export const canonicalClaudeDir = (home: string = homedir()): string => join(home, ".claude")

/** The dir the DEFAULT profile uses: the brain's `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export const defaultClaudeConfigDir = (env: Env = process.env, home: string = homedir()): string => {
  const fromEnv = env.CLAUDE_CONFIG_DIR?.trim()
  return fromEnv !== undefined && fromEnv !== "" ? resolve(fromEnv) : canonicalClaudeDir(home)
}

/**
 * The CLI environment of a profile: unchanged for the default profile (`undefined`); otherwise
 * `CLAUDE_CONFIG_DIR=<configDir>`, or no `CLAUDE_CONFIG_DIR` at all when the profile is `~/.claude`.
 */
export const profileEnv = (
  env: Env,
  profile: Pick<ClaudeProfile, "configDir"> | undefined,
  home: string = homedir(),
): Record<string, string | undefined> => {
  const out: Record<string, string | undefined> = { ...env }
  if (profile === undefined) return out
  const dir = resolve(profile.configDir)
  if (dir === canonicalClaudeDir(home)) delete out.CLAUDE_CONFIG_DIR
  else out.CLAUDE_CONFIG_DIR = dir
  return out
}

/** Where Claude Code keeps the account metadata (`.claude.json`) of a config dir. */
export const claudeStateFile = (configDir: string, home: string = homedir()): string =>
  resolve(configDir) === canonicalClaudeDir(home) ? join(home, ".claude.json") : join(configDir, ".claude.json")

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined

/** The account in a `.claude.json` (`oauthAccount`), or `undefined`. Never touches credentials. */
export const parseClaudeState = (state: unknown): HarnessAccount | undefined => {
  const account = isRecord(state) && isRecord(state.oauthAccount) ? state.oauthAccount : undefined
  if (account === undefined) return undefined
  const email = str(account.emailAddress)
  const organization = str(account.organizationName)
  if (email === undefined && organization === undefined) return undefined
  return { ...(email !== undefined ? { email } : {}), ...(organization !== undefined ? { organization } : {}) }
}

/** Reads the account of a config dir from its `.claude.json` (cheap, no CLI). */
export const readClaudeAccount = async (
  configDir: string,
  home: string = homedir(),
): Promise<HarnessAccount | undefined> => {
  try {
    const file = Bun.file(claudeStateFile(configDir, home))
    if (!(await file.exists())) return undefined
    return parseClaudeState(await file.json())
  } catch {
    return undefined
  }
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** A config dir that looks like a Claude login: it has `.credentials.json` or a `.claude.json`. */
export const looksLikeClaudeConfigDir = (configDir: string, home: string = homedir()): boolean =>
  isDir(configDir) && (isFile(join(configDir, ".credentials.json")) || isFile(claudeStateFile(configDir, home)))

export interface ClaudeConfigDirCandidate {
  readonly configDir: string
  /** The dir the default profile already uses. */
  readonly isDefault: boolean
  readonly account?: HarnessAccount | undefined
  /** `leka@example.com (Org)` when the account is known, else the dir name (`claude-2`). */
  readonly suggestedLabel: string
}

/**
 * Claude config dirs in `home`: `~/.claude` and `~/.claude-*` (e.g. the `claude-account` wrapper's
 * `~/.claude-2`) that contain `.credentials.json` or `.claude.json`. Sorted by path.
 */
export const discoverClaudeConfigDirs = async (options?: {
  readonly home?: string | undefined
  readonly env?: Env | undefined
}): Promise<ReadonlyArray<ClaudeConfigDirCandidate>> => {
  const home = options?.home ?? homedir()
  const defaultDir = defaultClaudeConfigDir(options?.env ?? process.env, home)
  let names: ReadonlyArray<string>
  try {
    names = readdirSync(home)
  } catch {
    return []
  }
  const dirs = names
    .filter((name) => name === ".claude" || /^\.claude-[^/]+$/.test(name))
    .map((name) => join(home, name))
    .filter((dir) => looksLikeClaudeConfigDir(dir, home))
    .sort()
  const out: Array<ClaudeConfigDirCandidate> = []
  for (const configDir of dirs) {
    const account = await readClaudeAccount(configDir, home)
    const who = account?.email ?? account?.organization
    const suggestedLabel =
      who !== undefined
        ? account?.email !== undefined && account.organization !== undefined
          ? `${account.email} (${account.organization})`
          : who
        : basename(configDir).replace(/^\./, "")
    out.push({ configDir, isDefault: configDir === defaultDir, ...(account ? { account } : {}), suggestedLabel })
  }
  return out
}
