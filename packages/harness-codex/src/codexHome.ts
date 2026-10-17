/**
 * OpenBot's own `CODEX_HOME` (D2.2; harness-context-isolation.md §0 item 4, §4.3 "Recipe as code").
 *
 * A dedicated profile is the only way to keep the user's `$CODEX_HOME/AGENTS.md`, plugins, skills,
 * hooks and MCP servers out of every bot (they cannot be suppressed per thread). The profile has a
 * hermetic `config.toml` and an `auth.json` **symlink** to the user's `~/.codex/auth.json`, so the
 * user's ChatGPT login is shared (Codex writes it with `O_TRUNC`, which follows the link).
 *
 * OpenBot never reads, copies or forwards the contents of `auth.json` (sdk-codex.md §4.6).
 */
import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { harnessError } from "./errors.ts"

/** Hermetic profile (verified recipe r3 + `codex-live.ts`). Rewritten when it differs. */
export const HERMETIC_CONFIG_TOML = `# Managed by OpenBot: rewritten on every start. Bot settings are passed per thread.
# See docs/research/harness-context-isolation.md (Codex recipe).
project_doc_max_bytes = 0

[skills.bundled]
enabled = false

[features]
apps = false
plugins = false
memories = false

[memories]
use_memories = false
`

export type CodexAuthLink =
  /** `auth.json` is a symlink to the user's login. */
  | "linked"
  /** The OpenBot profile has its own `auth.json` file (e.g. logged in through the app-server). */
  | "own-file"
  /** No user login to link (`codex login` has not been run, or the keyring store is used). */
  | "missing"
  /** Linking was disabled by config. */
  | "disabled"

export interface CodexHomeOptions {
  /** OpenBot's profile, normally `DataDir.codexHome` (`<data>/codex-home`). */
  readonly codexHome: string
  /** The user's Codex home that holds their login. Default: `$CODEX_HOME`, else `~/.codex`. */
  readonly userCodexHome?: string | undefined
  /** Symlink the user's `auth.json` (default true). */
  readonly linkUserAuth?: boolean | undefined
}

export interface CodexHomeReport {
  readonly codexHome: string
  readonly userCodexHome: string
  readonly auth: CodexAuthLink
}

/** The user's own Codex home (where `codex login` writes `auth.json`). */
export const defaultUserCodexHome = (env: NodeJS.ProcessEnv = process.env): string =>
  env.CODEX_HOME && env.CODEX_HOME.trim() !== "" ? env.CODEX_HOME : join(homedir(), ".codex")

const errnoCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false
    throw error
  }
}

const linkAuth = async (codexHome: string, userCodexHome: string): Promise<CodexAuthLink> => {
  const link = join(codexHome, "auth.json")
  const target = join(userCodexHome, "auth.json")
  const targetExists = await exists(target)
  let current: Awaited<ReturnType<typeof lstat>> | undefined
  try {
    current = await lstat(link)
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error
  }
  if (current === undefined) {
    if (!targetExists) return "missing"
    await symlink(target, link)
    return "linked"
  }
  if (!current.isSymbolicLink()) return "own-file"
  const pointsTo = await readlink(link)
  if (resolve(codexHome, pointsTo) === resolve(target)) return targetExists ? "linked" : "missing"
  // The user moved their Codex home: re-point the link when the new login exists.
  if (!targetExists) return (await exists(resolve(codexHome, pointsTo))) ? "linked" : "missing"
  await rm(link, { force: true })
  await symlink(target, link)
  return "linked"
}

/**
 * Creates the profile directory, writes the hermetic `config.toml` and links the user's login.
 * Idempotent; safe to run on every start.
 */
export const prepareCodexHome = (options: CodexHomeOptions) =>
  Effect.tryPromise({
    try: async (): Promise<CodexHomeReport> => {
      const codexHome = resolve(options.codexHome)
      const userCodexHome = resolve(options.userCodexHome ?? defaultUserCodexHome())
      await mkdir(codexHome, { recursive: true, mode: 0o700 })
      const configPath = join(codexHome, "config.toml")
      const configFile = Bun.file(configPath)
      const currentConfig = (await configFile.exists()) ? await configFile.text() : undefined
      if (currentConfig !== HERMETIC_CONFIG_TOML) await Bun.write(configPath, HERMETIC_CONFIG_TOML)
      let auth: CodexAuthLink = "disabled"
      if (options.linkUserAuth !== false && userCodexHome !== codexHome) auth = await linkAuth(codexHome, userCodexHome)
      return { codexHome, userCodexHome, auth }
    },
    catch: (cause) => harnessError("not-installed", `Could not prepare the OpenBot Codex profile at ${options.codexHome}`, cause),
  })
