/** CODEX_HOME preparation, binary resolution and the app-server environment. */
import { describe, expect, test } from "bun:test"
import { lstatSync, readFileSync, readlinkSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { appServerEnv } from "../src/appServer.ts"
import {
  compareVersions,
  findBundledCodex,
  parseCodexVersion,
  PINNED_CODEX_VERSION,
  resolveCodexBinary,
  targetTriple,
  versionProblems,
} from "../src/binary.ts"
import { HERMETIC_CONFIG_TOML, prepareCodexHome } from "../src/codexHome.ts"
import { tempDir } from "./support.ts"

describe("OpenBot CODEX_HOME", () => {
  test("hermetic config.toml and an auth.json symlink to the user's login (never a copy)", async () => {
    const root = tempDir()
    const user = join(root, "user-codex")
    mkdirSync(user)
    writeFileSync(join(user, "auth.json"), "{}")
    const home = join(root, "data", "codex-home")
    const report = await Effect.runPromise(prepareCodexHome({ codexHome: home, userCodexHome: user }))
    expect(report.auth).toBe("linked")
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(HERMETIC_CONFIG_TOML)
    expect(lstatSync(join(home, "auth.json")).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(home, "auth.json"))).toBe(join(user, "auth.json"))
    // Idempotent; a tampered config is rewritten.
    writeFileSync(join(home, "config.toml"), 'model = "x"\n')
    const again = await Effect.runPromise(prepareCodexHome({ codexHome: home, userCodexHome: user }))
    expect(again.auth).toBe("linked")
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(HERMETIC_CONFIG_TOML)
  })

  test("the hermetic profile turns off apps, plugins, memories, bundled skills and project docs", () => {
    for (const line of [
      "apps = false",
      "plugins = false",
      "memories = false",
      "project_doc_max_bytes = 0",
      "enabled = false",
    ]) {
      expect(HERMETIC_CONFIG_TOML).toContain(line)
    }
  })

  test("no user login: missing; a real auth.json in the profile is kept; linking can be disabled", async () => {
    const root = tempDir()
    const missing = await Effect.runPromise(
      prepareCodexHome({ codexHome: join(root, "a"), userCodexHome: join(root, "nobody") }),
    )
    expect(missing.auth).toBe("missing")
    const own = join(root, "b")
    mkdirSync(own)
    writeFileSync(join(own, "auth.json"), "{}")
    const kept = await Effect.runPromise(prepareCodexHome({ codexHome: own, userCodexHome: join(root, "nobody") }))
    expect(kept.auth).toBe("own-file")
    expect(lstatSync(join(own, "auth.json")).isSymbolicLink()).toBe(false)
    const off = await Effect.runPromise(prepareCodexHome({ codexHome: join(root, "c"), linkUserAuth: false }))
    expect(off.auth).toBe("disabled")
  })

  test("a link to a moved login is re-pointed", async () => {
    const root = tempDir()
    const oldUser = join(root, "old")
    const newUser = join(root, "new")
    mkdirSync(newUser)
    writeFileSync(join(newUser, "auth.json"), "{}")
    const home = join(root, "home")
    mkdirSync(home)
    symlinkSync(join(oldUser, "auth.json"), join(home, "auth.json"))
    const report = await Effect.runPromise(prepareCodexHome({ codexHome: home, userCodexHome: newUser }))
    expect(report.auth).toBe("linked")
    expect(readlinkSync(join(home, "auth.json"))).toBe(join(newUser, "auth.json"))
  })
})

describe("codex binary", () => {
  test("version parsing and comparison", () => {
    expect(
      parseCodexVersion("openbot/0.162.1 (Arch Linux Rolling Release; x86_64) ghostty/1.3.1 (openbot; 0.0.0)"),
    ).toBe("0.162.1")
    expect(parseCodexVersion("codex_cli_rs/0.163.0-alpha.2 (x)")).toBe("0.163.0-alpha.2")
    expect(parseCodexVersion("garbage")).toBeUndefined()
    expect(compareVersions("0.162.1", "0.162.1")).toBe(0)
    expect(compareVersions("0.161.9", "0.162.0")).toBe(-1)
    expect(compareVersions("1.0", "0.999.999")).toBe(1)
    expect(versionProblems(PINNED_CODEX_VERSION)).toEqual([])
    expect(versionProblems("0.170.0")[0]).toContain("newer")
    expect(versionProblems(undefined)[0]).toContain("Could not read")
  })

  test("target triples follow the npm platform packages", () => {
    expect(targetTriple("linux", "x64")).toBe("x86_64-unknown-linux-musl")
    expect(targetTriple("darwin", "arm64")).toBe("aarch64-apple-darwin")
    expect(targetTriple("win32", "x64")).toBe("x86_64-pc-windows-msvc")
    expect(targetTriple("sunos", "x64")).toBeUndefined()
  })

  test("resolution: an explicit path wins (and must exist), else the bundled build, else PATH", () => {
    expect(resolveCodexBinary({ binaryPath: process.execPath })).toEqual({
      path: process.execPath,
      source: "config",
      pathDirs: [],
    })
    expect(resolveCodexBinary({ binaryPath: "/nonexistent/codex" })).toBeUndefined()
    const bundled = findBundledCodex()
    if (bundled) {
      expect(bundled.source).toBe("bundled")
      expect(bundled.packageVersion).toBe(PINNED_CODEX_VERSION)
      expect(bundled.path).toContain(targetTriple()!)
      expect(resolveCodexBinary()).toEqual(bundled)
    }
    const fromPath = resolveCodexBinary({ preferPath: true })
    if (Bun.which("codex")) expect(fromPath?.source).toBe("path")
  })

  test("the app-server environment: OpenBot's CODEX_HOME, bundled rg first, no inherited CODEX_* state", () => {
    const env = appServerEnv(
      {
        binary: { path: "/x/codex", source: "bundled", pathDirs: ["/x/codex-path"] },
        codexHome: "/data/codex-home",
        env: { EXTRA: "1" },
      },
      {
        PATH: "/usr/bin",
        HOME: "/home/u",
        CODEX_HOME: "/home/u/.codex",
        CODEX_SANDBOX: "seatbelt",
        CODEX_API_KEY: "k",
        UNSET: undefined,
      },
    )
    expect(env).toEqual({
      PATH: "/x/codex-path:/usr/bin",
      HOME: "/home/u",
      CODEX_API_KEY: "k",
      EXTRA: "1",
      CODEX_HOME: "/data/codex-home",
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "openbot",
    })
  })
})
