/**
 * Finds the `codex` binary (sdk-codex.md §1, §6.6; D2.2):
 * 1. an explicit `binaryPath` (config);
 * 2. the pinned `@openai/codex` npm package's platform package, resolved the way the npm wrapper
 *    (`@openai/codex/bin/codex.js` `findCodexExecutable`) and the SDK's `findCodexPath` do:
 *    `@openai/codex-<platform>-<arch>/vendor/<triple>/bin/codex`, with `vendor/<triple>/codex-path`
 *    (bundled `rg`) prepended to PATH;
 * 3. `codex` on PATH.
 *
 * The version is checked after `initialize` (`userAgent`), see `parseCodexVersion`.
 */
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

/** The `@openai/codex` version this adapter was written and tested against (root catalog). */
export const PINNED_CODEX_VERSION = "0.162.1"

export type CodexBinarySource = "config" | "bundled" | "path"

export interface CodexBinary {
  readonly path: string
  readonly source: CodexBinarySource
  /** Directories to prepend to PATH (the bundled `rg`). */
  readonly pathDirs: ReadonlyArray<string>
  /** Version from the npm package, when bundled. The authoritative version comes from `initialize`. */
  readonly packageVersion?: string | undefined
}

const PLATFORM_PACKAGE_BY_TARGET: Readonly<Record<string, string>> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
}

/** Rust target triple of the current host, as used by the npm platform packages. */
export const targetTriple = (platform: string = process.platform, arch: string = process.arch): string | undefined => {
  if (platform === "linux" || platform === "android") {
    if (arch === "x64") return "x86_64-unknown-linux-musl"
    if (arch === "arm64") return "aarch64-unknown-linux-musl"
  }
  if (platform === "darwin") {
    if (arch === "x64") return "x86_64-apple-darwin"
    if (arch === "arm64") return "aarch64-apple-darwin"
  }
  if (platform === "win32") {
    if (arch === "x64") return "x86_64-pc-windows-msvc"
    if (arch === "arm64") return "aarch64-pc-windows-msvc"
  }
  return undefined
}

/**
 * The bundled binary of the pinned `@openai/codex` package, or `undefined` when the platform
 * package is not installed (unsupported OS, `--no-optional`).
 */
export const findBundledCodex = (from: string = import.meta.url): CodexBinary | undefined => {
  const triple = targetTriple()
  if (!triple) return undefined
  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[triple]
  if (!platformPackage) return undefined
  try {
    const requireHere = createRequire(from)
    const codexPackageJson = requireHere.resolve("@openai/codex/package.json")
    const requireFromCodex = createRequire(codexPackageJson)
    let vendorRoot: string
    try {
      vendorRoot = join(dirname(requireFromCodex.resolve(`${platformPackage}/package.json`)), "vendor")
    } catch {
      vendorRoot = join(dirname(codexPackageJson), "vendor")
    }
    const binary = join(vendorRoot, triple, "bin", process.platform === "win32" ? "codex.exe" : "codex")
    if (!existsSync(binary)) return undefined
    const pathDir = join(vendorRoot, triple, "codex-path")
    let packageVersion: string | undefined
    try {
      const parsed: unknown = JSON.parse(readFileSync(codexPackageJson, "utf8"))
      if (typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string") {
        packageVersion = parsed.version
      }
    } catch {
      packageVersion = undefined
    }
    return { path: binary, source: "bundled", pathDirs: existsSync(pathDir) ? [pathDir] : [], packageVersion }
  } catch {
    return undefined
  }
}

export interface ResolveCodexOptions {
  /** Explicit binary (setting `codex.binaryPath`). */
  readonly binaryPath?: string | undefined
  /** Look for `codex` on PATH when nothing else is found (default true). */
  readonly usePath?: boolean | undefined
  /** Prefer the user's PATH `codex` over the bundled one (default false: bundled wins, D2.2 pin). */
  readonly preferPath?: boolean | undefined
}

const whichCodex = (): string | undefined => Bun.which("codex") ?? undefined

/** Resolution order: config → bundled → PATH (or config → PATH → bundled with `preferPath`). */
export const resolveCodexBinary = (options: ResolveCodexOptions = {}): CodexBinary | undefined => {
  if (options.binaryPath) {
    return existsSync(options.binaryPath)
      ? { path: options.binaryPath, source: "config", pathDirs: [] }
      : undefined
  }
  const fromPath = (): CodexBinary | undefined => {
    if (options.usePath === false) return undefined
    const found = whichCodex()
    return found ? { path: found, source: "path", pathDirs: [] } : undefined
  }
  return options.preferPath ? fromPath() ?? findBundledCodex() : findBundledCodex() ?? fromPath()
}

/**
 * Parses the CLI version from `initialize.userAgent`, e.g.
 * `"openbot/0.162.1 (Arch Linux Rolling Release; x86_64) ghostty/1.3.1 (openbot; 0.0.0)"` → `"0.162.1"`.
 */
export const parseCodexVersion = (userAgent: string): string | undefined => {
  const match = /^[^/\s]+\/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(userAgent.trim())
  return match?.[1]
}

const numeric = (version: string): ReadonlyArray<number> =>
  version.split(/[-+]/)[0]!.split(".").map((part) => Number.parseInt(part, 10) || 0)

/** -1 / 0 / 1 comparing dotted numeric versions (pre-release suffixes ignored). */
export const compareVersions = (a: string, b: string): number => {
  const left = numeric(a)
  const right = numeric(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

/** Human-readable problems for a running app-server version (empty when it matches the pin). */
export const versionProblems = (version: string | undefined): ReadonlyArray<string> => {
  if (version === undefined) return ["Could not read the Codex version from the app-server."]
  if (compareVersions(version, PINNED_CODEX_VERSION) === 0) return []
  return [
    compareVersions(version, PINNED_CODEX_VERSION) < 0
      ? `Codex ${version} is older than the tested ${PINNED_CODEX_VERSION}; some features may not work.`
      : `Codex ${version} is newer than the tested ${PINNED_CODEX_VERSION}.`,
  ]
}
