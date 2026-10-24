import { describe, expect, test } from "bun:test"
import { HarnessStatus } from "@openbot/contracts"
import { HarnessRegistry, makeDataDir } from "@openbot/core"
import { TestPorts } from "@openbot/core/testing"
import { Effect, Layer, Schema } from "effect"
import { chmodSync } from "node:fs"
import { join } from "node:path"
import { CLAUDE_CAPABILITIES, ClaudeHarnessLive, makeClaudeDriver, resolveExecutable } from "../src/Driver.ts"
import {
  describeProbeError,
  parseAuth,
  parseCliVersion,
  parseInitialization,
  readCliVersion,
  runProbe,
} from "../src/probe.ts"
import type { ClaudeQueryFunction, ClaudeQueryHandle, ClaudeQueryParams } from "../src/sdk.ts"
import { tempDir } from "./support.ts"

const INIT = {
  commands: [{ name: "compact", description: "Compact", argumentHint: "" }],
  agents: [],
  output_style: "default",
  available_output_styles: ["default"],
  models: [
    {
      value: "default",
      displayName: "Default (recommended)",
      description: "Opus",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high"],
    },
    { value: "haiku", displayName: "Haiku", description: "Fast" },
    { value: "haiku", displayName: "dup", description: "dup" },
    { value: "", displayName: "empty", description: "" },
  ],
  account: { email: "owner@example.com", subscriptionType: "Claude Team", apiProvider: "firstParty" },
  claude_code_version: "2.1.300",
}

/** A probe-only fake: records options, resolves `initializationResult`, records close. */
const probeQuery = (init: () => Promise<unknown>) => {
  const calls: Array<{ options: Readonly<Record<string, unknown>>; closed: boolean }> = []
  const query: ClaudeQueryFunction = (params: ClaudeQueryParams) => {
    const call = { options: params.options, closed: false }
    calls.push(call)
    const handle: ClaudeQueryHandle = {
      next: () => new Promise(() => {}),
      interrupt: async () => ({}),
      close: () => {
        call.closed = true
      },
      setMcpServers: async () => ({}),
      initializationResult: init,
      getContextUsage: async () => ({}),
    }
    return handle
  }
  return { query, calls }
}

const decodeStatus = Schema.decodeUnknownSync(HarnessStatus)

describe("probe parsing", () => {
  test("parseInitialization: version, account label, models (deduped, efforts)", () => {
    const parsed = parseInitialization(INIT)
    expect(parsed.version).toBe("2.1.300")
    expect(parsed.auth).toEqual({ state: "signed-in", label: "owner@example.com (Claude Team)" })
    expect(parsed.models).toEqual([
      { id: "default", label: "Default (recommended)", default: true, efforts: ["low", "medium", "high"] },
      { id: "haiku", label: "Haiku" },
    ])
    expect(parsed.problems).toEqual([])
  })

  test("parseAuth: tokenSource none = signed out; 3P providers and API keys are signed in", () => {
    expect(parseAuth({ tokenSource: "none", apiKeySource: "none" })).toEqual({ state: "signed-out" })
    expect(parseAuth({ apiProvider: "bedrock" })).toEqual({ state: "signed-in", label: "Amazon Bedrock" })
    expect(parseAuth({ apiKeySource: "ANTHROPIC_API_KEY" })).toEqual({ state: "signed-in", label: "API key" })
    expect(parseAuth({ subscriptionType: "Claude Max" })).toEqual({ state: "signed-in", label: "Claude Max" })
    expect(parseAuth({})).toEqual({ state: "unknown" })
    expect(parseInitialization({ account: { tokenSource: "none" } }).problems[0]).toContain("claude auth login")
  })

  test("describeProbeError distinguishes a missing CLI", () => {
    expect(describeProbeError(new Error("Native CLI binary for linux-x64 not found.")).installed).toBe(false)
    expect(describeProbeError(new Error("spawn /x/claude ENOENT")).installed).toBe(false)
    expect(describeProbeError(new Error("boom")).installed).toBe(true)
  })
})

describe("runProbe (no model call)", () => {
  test("never-yielding prompt, isolated options, closes the query, schema-valid status", async () => {
    const { query, calls } = probeQuery(async () => INIT)
    const result = await Effect.runPromise(
      runProbe({ query, env: { PATH: "/bin" }, executable: "/opt/claude", capabilities: CLAUDE_CAPABILITIES }),
    )
    expect(() => decodeStatus(result.status)).not.toThrow()
    expect(result.status).toMatchObject({
      kind: "claude",
      installed: true,
      version: "2.1.300",
      auth: { state: "signed-in" },
      problems: [],
    })
    expect(result.models?.map((m) => m.id)).toEqual(["default", "haiku"])
    expect(calls[0]!.options).toMatchObject({
      persistSession: false,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      settings: { disableAllHooks: true },
      pathToClaudeCodeExecutable: "/opt/claude",
    })
    expect(calls[0]!.closed).toBe(true)
  })

  test("older CLIs without claude_code_version: the version comes from `--version`", async () => {
    const { claude_code_version: _omitted, ...olderInit } = INIT
    const { query } = probeQuery(async () => olderInit)
    const result = await Effect.runPromise(
      runProbe({
        query,
        env: {},
        executable: "/x/claude",
        capabilities: CLAUDE_CAPABILITIES,
        cliVersion: async () => "2.1.280",
      }),
    )
    expect(result.status.version).toBe("2.1.280")
    const none = await Effect.runPromise(runProbe({ query, env: {}, capabilities: CLAUDE_CAPABILITIES }))
    expect(none.status.version).toBeUndefined() // bundled CLI: no binary path to ask
    expect(parseCliVersion("2.1.280 (Claude Code)\n")).toBe("2.1.280")
    expect(parseCliVersion("claude 3.0.0-beta.1")).toBe("3.0.0-beta.1")
    expect(parseCliVersion("nope")).toBeUndefined()
  })

  test("readCliVersion runs `<executable> --version`; failures are undefined", async () => {
    const dir = tempDir()
    const fake = join(dir, "claude")
    await Bun.write(fake, '#!/bin/sh\n[ "$1" = "--version" ] && echo "9.8.7 (Claude Code)"\n')
    chmodSync(fake, 0o755)
    expect(await readCliVersion(fake, { PATH: process.env.PATH })).toBe("9.8.7")
    expect(await readCliVersion(join(dir, "missing"), {})).toBeUndefined()
  })

  test("missing CLI → installed:false; timeout → problem, never throws", async () => {
    const missing = probeQuery(() => Promise.reject(new Error("Native CLI binary for linux-x64 not found")))
    const a = await Effect.runPromise(runProbe({ query: missing.query, env: {}, capabilities: CLAUDE_CAPABILITIES }))
    expect(a.status).toMatchObject({ installed: false, auth: { state: "unknown" } })
    expect(a.models).toBeUndefined()
    const throwing: ClaudeQueryFunction = () => {
      throw new Error("spawn claude ENOENT")
    }
    const b = await Effect.runPromise(runProbe({ query: throwing, env: {}, capabilities: CLAUDE_CAPABILITIES }))
    expect(b.status.installed).toBe(false)
    const slow = probeQuery(() => new Promise(() => {}))
    const c = await Effect.runPromise(
      runProbe({ query: slow.query, env: {}, timeoutMs: 30, capabilities: CLAUDE_CAPABILITIES }),
    )
    expect(c.status.problems[0]).toContain("did not answer")
    expect(slow.calls[0]!.closed).toBe(true)
  })
})

describe("driver", () => {
  test("listModels comes from the probe (cached)", async () => {
    const { query, calls } = probeQuery(async () => INIT)
    const models = await Effect.runPromise(
      Effect.gen(function* () {
        const driver = yield* makeClaudeDriver({ query, executable: "bundled" }, { dataDir: makeDataDir(tempDir()) })
        expect(driver.capabilities).toEqual(CLAUDE_CAPABILITIES)
        const first = yield* driver.listModels
        yield* driver.listModels
        return first
      }),
    )
    expect(models.map((m) => m.id)).toEqual(["default", "haiku"])
    expect(calls).toHaveLength(1)
  })

  test("listModels fails with HarnessError when Claude is missing", async () => {
    const { query } = probeQuery(() => Promise.reject(new Error("Native CLI binary not found")))
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const driver = yield* makeClaudeDriver({ query }, { dataDir: makeDataDir(tempDir()) })
        return yield* driver.listModels
      }),
    )
    expect(JSON.stringify(exit)).toContain("not-installed")
  })

  test("ClaudeHarnessLive registers the claude driver in HarnessRegistry", async () => {
    const { query } = probeQuery(async () => INIT)
    const layer = ClaudeHarnessLive({ query, executable: "bundled" }).pipe(Layer.provideMerge(TestPorts()))
    const status = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* HarnessRegistry
          const driver = yield* registry.get("claude")
          expect(driver.displayName).toBe("Claude")
          expect(driver.capabilities.remotePlacements).toEqual(["brain-mcp-hands"])
          return yield* driver.probe
        }).pipe(Effect.provide(layer)),
      ),
    )
    expect(status.installed).toBe(true)
  })

  test("resolveExecutable: bundled, explicit, or PATH", () => {
    expect(resolveExecutable("bundled")).toBeUndefined()
    expect(resolveExecutable("/x/claude")).toBe("/x/claude")
    expect(resolveExecutable(undefined)).toBe(Bun.which("claude") ?? undefined)
  })
})
