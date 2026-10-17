import { describe, expect, test } from "bun:test"
import { ConfigError, DEFAULT_HARNESSES, defaultDataDir, normalizeOrigin, parseCommand, resolvePath } from "../src/config.ts"
import { originsFor } from "../src/listeners.ts"

const system = { home: "/home/u", cwd: "/work/repo" }
const run = (argv: ReadonlyArray<string>, env: Record<string, string> = {}) => {
  const parsed = parseCommand(argv, env, system)
  if (parsed._tag !== "Run") throw new Error(`expected Run, got ${parsed._tag}`)
  return parsed.config
}

describe("parseCommand", () => {
  test("defaults", () => {
    expect(run([])).toEqual({
      dataDir: "/home/u/.local/share/openbot",
      port: 7420,
      host: "127.0.0.1",
      publicOrigins: [],
      localNode: true,
      dev: false,
      harnesses: DEFAULT_HARNESSES,
      claudePath: undefined,
    })
    expect(run([], { XDG_DATA_HOME: "/xdg/data/" }).dataDir).toBe("/xdg/data/openbot")
  })

  test("flags (both --flag value and --flag=value)", () => {
    const config = run([
      "--data-dir",
      "./data",
      "--port=0",
      "--host",
      "0.0.0.0",
      "--public-origin",
      "https://Box.tailnet.ts.net/",
      "--public-origin=box.lan:8443",
      "--no-local-node",
      "--dev",
      "--harness",
      "claude,codex",
      "--claude-path",
      "~/bin/claude",
    ])
    expect(config).toEqual({
      dataDir: "/work/repo/data",
      port: 0,
      host: "0.0.0.0",
      publicOrigins: ["https://box.tailnet.ts.net", "https://box.lan:8443"],
      localNode: false,
      dev: true,
      harnesses: ["fake", "claude", "codex"],
      claudePath: "/home/u/bin/claude",
    })
  })

  test("OPENBOT_* environment, and the CLI wins over it", () => {
    const env = {
      OPENBOT_DATA_DIR: "/srv/openbot",
      OPENBOT_PORT: "9000",
      OPENBOT_HOST: "::",
      OPENBOT_PUBLIC_ORIGIN: "https://a.example, https://b.example",
      OPENBOT_LOCAL_NODE: "0",
      OPENBOT_DEV: "true",
      OPENBOT_HARNESSES: "opencode",
      OPENBOT_CLAUDE_PATH: "/opt/claude",
    }
    expect(run([], env)).toEqual({
      dataDir: "/srv/openbot",
      port: 9000,
      host: "::",
      publicOrigins: ["https://a.example", "https://b.example"],
      localNode: false,
      dev: true,
      harnesses: ["fake", "opencode"],
      claudePath: "/opt/claude",
    })
    expect(run(["--port", "7000", "--local-node", "--harness", "all"], env)).toMatchObject({
      port: 7000,
      localNode: true,
      harnesses: ["fake", "claude", "codex", "opencode"],
    })
    expect(run(["--claude-path", "bundled"], env).claudePath).toBeUndefined()
    // send_file cap: CLI beats env; absent = core's default
    expect(run([], env).maxFileBytes).toBeUndefined()
    expect(run([], { ...env, OPENBOT_MAX_FILE_MB: "50" }).maxFileBytes).toBe(50_000_000)
    expect(run(["--max-file-mb", "1024"], { ...env, OPENBOT_MAX_FILE_MB: "50" }).maxFileBytes).toBe(1_024_000_000)
  })

  test("help, version and errors", () => {
    expect(parseCommand(["--help"], {}, system)._tag).toBe("Help")
    expect(parseCommand(["-v"], {}, system)._tag).toBe("Version")
    expect(() => parseCommand(["--nope"], {}, system)).toThrow(ConfigError)
    expect(() => parseCommand(["--port"], {}, system)).toThrow("--port needs a value")
    expect(() => parseCommand(["--port", "70000"], {}, system)).toThrow("out of range")
    expect(() => parseCommand(["--port", "abc"], {}, system)).toThrow("not a port")
    expect(() => parseCommand(["--harness", "gemini"], {}, system)).toThrow("unknown harness")
    expect(() => parseCommand(["--public-origin", "ftp://x"], {}, system)).toThrow("http(s)")
    expect(() => parseCommand(["--max-file-mb", "0"], {}, system)).toThrow("not a size in MB")
    expect(() => parseCommand(["--max-file-mb", "lots"], {}, system)).toThrow("not a size in MB")
  })
})

describe("helpers", () => {
  test("resolvePath / defaultDataDir / normalizeOrigin", () => {
    expect(resolvePath("~", "/h", "/c")).toBe("/h")
    expect(resolvePath("a/../b/./c/", "/h", "/c")).toBe("/c/b/c")
    expect(resolvePath("/x//y/", "/h", "/c")).toBe("/x/y")
    expect(defaultDataDir({ XDG_DATA_HOME: "relative" }, "/h")).toBe("/h/.local/share/openbot")
    expect(normalizeOrigin("http://127.0.0.1:7420/path?q")).toBe("http://127.0.0.1:7420")
  })

  test("origins: loopback binds get 127.0.0.1 + localhost; the first public origin is canonical for nodes", () => {
    expect(originsFor({ host: "127.0.0.1", port: 7420, publicOrigins: [] })).toEqual({
      selfBase: "http://127.0.0.1:7420",
      loginBase: "http://127.0.0.1:7420",
      brainOrigin: "http://127.0.0.1:7420",
      allowedOrigins: ["http://127.0.0.1:7420", "http://localhost:7420"],
    })
    const lan = originsFor({ host: "192.168.1.5", port: 80, publicOrigins: ["https://box.ts.net"] })
    expect(lan.brainOrigin).toBe("https://box.ts.net")
    expect(lan.selfBase).toBe("http://192.168.1.5:80")
    expect(lan.allowedOrigins).toEqual(["https://box.ts.net", "http://127.0.0.1:80", "http://localhost:80", "http://192.168.1.5:80"])
    expect(originsFor({ host: "0.0.0.0", port: 1, publicOrigins: [] }).selfBase).toBe("http://127.0.0.1:1")
  })
})
