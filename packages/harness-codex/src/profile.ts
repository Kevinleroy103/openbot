/**
 * Codex harness accounts ("profiles"). A profile is a Codex home on the brain machine whose
 * `auth.json` backs one OpenBot `CODEX_HOME`: the server runs one app-server per profile with
 * `codexHome = <data>/codex-home/<profileId>` and `userCodexHome = <profile configDir>` (the default
 * profile keeps `<data>/codex-home` linked to `~/.codex`, see codexHome.ts).
 *
 * Discovery only checks that `auth.json` EXISTS; it never reads it (sdk-codex.md §4.6). The account
 * (email, plan) comes from the profile's probe (`account/read`).
 */
import { readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { defaultUserCodexHome } from "./codexHome.ts"

/** The OpenBot `CODEX_HOME` of a non-default profile: `<default codex home>/<profileId>`. */
export const profileCodexHome = (codexHome: string, profileId: string): string => join(codexHome, profileId)

export interface CodexHomeCandidate {
  readonly configDir: string
  /** The Codex home the default profile already uses (`$CODEX_HOME`, else `~/.codex`). */
  readonly isDefault: boolean
  /** The dir name (`codex-work`). */
  readonly suggestedLabel: string
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** A Codex home with a login (`auth.json` exists; its contents are never read). */
export const looksLikeCodexHome = (dir: string): boolean => {
  try {
    return statSync(dir).isDirectory() && isFile(join(dir, "auth.json"))
  } catch {
    return false
  }
}

/** `~/.codex` and `~/.codex-*` that contain `auth.json`, sorted by path. */
export const discoverCodexHomes = (options?: {
  readonly home?: string | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}): ReadonlyArray<CodexHomeCandidate> => {
  const home = options?.home ?? homedir()
  const env = options?.env ?? process.env
  const defaultDir = resolve(env.CODEX_HOME && env.CODEX_HOME.trim() !== "" ? env.CODEX_HOME : join(home, ".codex"))
  let names: ReadonlyArray<string>
  try {
    names = readdirSync(home)
  } catch {
    return []
  }
  return names
    .filter((name) => name === ".codex" || /^\.codex-[^/]+$/.test(name))
    .map((name) => join(home, name))
    .filter(looksLikeCodexHome)
    .sort()
    .map((configDir) => ({
      configDir,
      isDefault: configDir === defaultDir,
      suggestedLabel: basename(configDir).replace(/^\./, ""),
    }))
}

/** The Codex home the default profile links (`$CODEX_HOME`, else `~/.codex`). */
export const defaultCodexConfigDir = (env: NodeJS.ProcessEnv = process.env): string =>
  resolve(defaultUserCodexHome(env))
