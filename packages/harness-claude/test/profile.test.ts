import { describe, expect, test } from "bun:test"
import { HarnessStatus } from "@openbot/contracts"
import { makeDataDir } from "@openbot/core"
import { Effect, Exit, Schema, Scope } from "effect"
import type { ChildProcess } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { makeClaudeDriver } from "../src/Driver.ts"
import {
  claudeStateFile,
  defaultClaudeConfigDir,
  discoverClaudeConfigDirs,
  looksLikeClaudeConfigDir,
  parseClaudeState,
  profileEnv,
} from "../src/profile.ts"
import type { ClaudeQueryFunction, ClaudeQueryHandle } from "../src/sdk.ts"
import { supportsProcessGroups } from "../src/spawn.ts"
import { makeSessionInput, tempDir } from "./support.ts"

const account = (email: string, org: string) => ({
  oauthAccount: { emailAddress: email, organizationName: org, accountUuid: "x" },
})

/** A home with the `claude-account` wrapper layout: ~/.claude (+ ~/.claude.json), ~/.claude-2, ~/.claude-3. */
const makeHome = () => {
  const home = tempDir("openbot-claude-home-")
  mkdirSync(join(home, ".claude"))
  writeFileSync(join(home, ".claude", ".credentials.json"), "{}")
  writeFileSync(join(home, ".claude.json"), JSON.stringify(account("main@example.com", "Main")))
  mkdirSync(join(home, ".claude-2"))
  writeFileSync(join(home, ".claude-2", ".credentials.json"), "{}")
  writeFileSync(join(home, ".claude-2", ".claude.json"), JSON.stringify(account("two@example.com", "Two")))
  mkdirSync(join(home, ".claude-3"))
  writeFileSync(join(home, ".claude-3", ".credentials.json"), "{}")
  mkdirSync(join(home, ".claude-empty"))
  writeFileSync(join(home, ".clauderc"), "")
  mkdirSync(join(home, ".codex"))
  return home
}

describe("Claude profiles: environment", () => {
  test("default = brain env unchanged; a profile sets CLAUDE_CONFIG_DIR; ~/.claude means no override", () => {
    const home = "/home/u"
    const base = { PATH: "/bin", CLAUDE_CONFIG_DIR: "/home/u/.claude-9" }
    expect(profileEnv(base, undefined, home)).toEqual(base)
    expect(profileEnv(base, { configDir: "/home/u/.claude-2" }, home)).toEqual({
      PATH: "/bin",
      CLAUDE_CONFIG_DIR: "/home/u/.claude-2",
    })
    expect(profileEnv(base, { configDir: "/home/u/.claude/" }, home)).toEqual({ PATH: "/bin" })
    expect(profileEnv({ PATH: "/bin" }, { configDir: "/home/u/.claude-3" }, home)).toEqual({
      PATH: "/bin",
      CLAUDE_CONFIG_DIR: "/home/u/.claude-3",
    })
  })

  test("default config dir and state file", () => {
    expect(defaultClaudeConfigDir({}, "/home/u")).toBe("/home/u/.claude")
    expect(defaultClaudeConfigDir({ CLAUDE_CONFIG_DIR: "/home/u/.claude-3" }, "/home/u")).toBe("/home/u/.claude-3")
    expect(claudeStateFile("/home/u/.claude", "/home/u")).toBe("/home/u/.claude.json")
    expect(claudeStateFile("/home/u/.claude-2", "/home/u")).toBe("/home/u/.claude-2/.claude.json")
  })

  test("parseClaudeState reads only the account metadata", () => {
    expect(parseClaudeState(account("a@b.c", "Org"))).toEqual({ email: "a@b.c", organization: "Org" })
    expect(parseClaudeState({ oauthAccount: {} })).toBeUndefined()
    expect(parseClaudeState({})).toBeUndefined()
    expect(parseClaudeState("nope")).toBeUndefined()
  })
})

describe("Claude profiles: discovery", () => {
  test("finds ~/.claude and ~/.claude-* with a login, labels them from .claude.json, flags the default", async () => {
    const home = makeHome()
    const found = await discoverClaudeConfigDirs({ home, env: {} })
    expect(found).toEqual([
      {
        configDir: join(home, ".claude"),
        isDefault: true,
        account: { email: "main@example.com", organization: "Main" },
        suggestedLabel: "main@example.com (Main)",
      },
      {
        configDir: join(home, ".claude-2"),
        isDefault: false,
        account: { email: "two@example.com", organization: "Two" },
        suggestedLabel: "two@example.com (Two)",
      },
      { configDir: join(home, ".claude-3"), isDefault: false, suggestedLabel: "claude-3" },
    ])
    expect(looksLikeClaudeConfigDir(join(home, ".claude-empty"), home)).toBe(false)
  })

  test("a brain started with CLAUDE_CONFIG_DIR makes that dir the default", async () => {
    const home = makeHome()
    const found = await discoverClaudeConfigDirs({ home, env: { CLAUDE_CONFIG_DIR: join(home, ".claude-3") } })
    expect(found.filter((c) => c.isDefault).map((c) => c.configDir)).toEqual([join(home, ".claude-3")])
  })

  test("a missing home yields nothing", async () => {
    expect(await discoverClaudeConfigDirs({ home: join(tempDir(), "missing"), env: {} })).toEqual([])
  })
})

/** Probe-only fake query recording the options. */
const probeQuery = (init: unknown) => {
  const calls: Array<Readonly<Record<string, unknown>>> = []
  const query: ClaudeQueryFunction = (params) => {
    calls.push(params.options)
    const handle: ClaudeQueryHandle = {
      next: () => new Promise(() => {}),
      interrupt: async () => ({}),
      close: () => {},
      setMcpServers: async () => ({}),
      initializationResult: async () => init,
      getContextUsage: async () => ({}),
    }
    return handle
  }
  return { query, calls }
}

const INIT = {
  models: [{ value: "default", displayName: "Default" }],
  account: { email: "two@example.com", subscriptionType: "team", organization: "Two", apiProvider: "firstParty" },
  claude_code_version: "2.1.300",
}

describe("Claude profiles: driver", () => {
  test("a profile driver probes with its CLAUDE_CONFIG_DIR and stamps the status", async () => {
    const { query, calls } = probeQuery(INIT)
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* makeClaudeDriver(
          {
            query,
            executable: "bundled",
            env: { PATH: "/bin" },
            home: "/home/u",
            profile: { id: "hpf_2", label: "Work", configDir: "/home/u/.claude-2" },
          },
          { dataDir: makeDataDir(tempDir()) },
        )
        expect(driver.profileId).toBe("hpf_2")
        return yield* driver.probe
      }),
    )
    expect((calls[0]!.env as Record<string, string>).CLAUDE_CONFIG_DIR).toBe("/home/u/.claude-2")
    expect(status).toMatchObject({
      kind: "claude",
      profileId: "hpf_2",
      profileLabel: "Work",
      configDir: "/home/u/.claude-2",
      account: { email: "two@example.com", plan: "team", organization: "Two" },
      auth: { state: "signed-in", label: "two@example.com (team)" },
    })
    expect(() => Schema.decodeUnknownSync(HarnessStatus)(status)).not.toThrow()
  })

  test("the default driver leaves CLAUDE_CONFIG_DIR alone", async () => {
    const { query, calls } = probeQuery(INIT)
    await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* makeClaudeDriver(
          { query, executable: "bundled", env: { PATH: "/bin" } },
          { dataDir: makeDataDir(tempDir()) },
        )
        expect(driver.profileId).toBeUndefined()
        return yield* driver.probe
      }),
    )
    expect("CLAUDE_CONFIG_DIR" in (calls[0]!.env as Record<string, string>)).toBe(false)
  })

  test.skipIf(!supportsProcessGroups)(
    "a session's spawned CLI runs with the profile's CLAUDE_CONFIG_DIR (process env)",
    async () => {
      const root = tempDir()
      const out = join(root, "seen-config-dir")
      let child: ChildProcess | undefined
      // Spawns a stand-in CLI through the driver's process-group spawner with the env the SDK would pass.
      const query: ClaudeQueryFunction = (params) => {
        const options = params.options as Record<string, unknown>
        const spawnCli = options.spawnClaudeCodeProcess as (o: Record<string, unknown>) => ChildProcess
        child = spawnCli({
          command: "sh",
          args: ["-c", `printf %s "$CLAUDE_CONFIG_DIR" > '${out}'; read line`],
          env: options.env,
          cwd: options.cwd,
          signal: new AbortController().signal,
        })
        return {
          next: () => new Promise(() => {}),
          return: async () => ({ value: undefined, done: true as const }),
          interrupt: async () => ({}),
          close: () => child?.stdin?.end(),
          setMcpServers: async () => ({}),
          initializationResult: async () => ({}),
          getContextUsage: async () => ({}),
        } as ClaudeQueryHandle
      }
      const configDir = join(root, ".claude-2")
      const seen = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const driver = yield* makeClaudeDriver(
              {
                query,
                executable: "bundled",
                closeTimeoutMs: 2000,
                env: { PATH: process.env.PATH ?? "/usr/bin" },
                profile: { id: "hpf_2", configDir },
              },
              { dataDir: makeDataDir(root) },
            )
            const scope = yield* Scope.make()
            yield* driver
              .openSession(makeSessionInput(join(root, "ws"), () => Effect.never, { mcp: [] }))
              .pipe(Scope.provide(scope))
            let text = ""
            for (let i = 0; i < 400 && text === ""; i++) {
              yield* Effect.sleep(5)
              try {
                text = readFileSync(out, "utf8")
              } catch {
                // not written yet
              }
            }
            const pid = child!.pid!
            const environ = process.platform === "linux" ? readFileSync(`/proc/${pid}/environ`, "utf8").split("\0") : []
            yield* Scope.close(scope, Exit.void)
            return { text, environ }
          }),
        ),
      )
      expect(seen.text).toBe(configDir)
      if (process.platform === "linux") expect(seen.environ).toContain(`CLAUDE_CONFIG_DIR=${configDir}`)
    },
  )
})
