import { describe, expect, test } from "bun:test"
import { HarnessStatus } from "@openbot/contracts"
import { makeDataDir } from "@openbot/core"
import { Effect, Schema } from "effect"
import { lstatSync, mkdirSync, readlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { makeCodexDriver } from "../src/Driver.ts"
import { discoverCodexHomes, looksLikeCodexHome, profileCodexHome } from "../src/profile.ts"
import { parseAccount } from "../src/probe.ts"
import { FakeAppServer, fakeLauncher, run, tempDir } from "./support.ts"

const makeHome = () => {
  const home = tempDir("openbot-codex-home-")
  for (const name of [".codex", ".codex-work"]) {
    mkdirSync(join(home, name))
    writeFileSync(join(home, name, "auth.json"), "{}")
  }
  mkdirSync(join(home, ".codex-empty"))
  mkdirSync(join(home, ".claude-2"))
  return home
}

describe("Codex profiles: discovery", () => {
  test("finds ~/.codex and ~/.codex-* with an auth.json and flags the default", () => {
    const home = makeHome()
    expect(discoverCodexHomes({ home, env: {} })).toEqual([
      { configDir: join(home, ".codex"), isDefault: true, suggestedLabel: "codex" },
      { configDir: join(home, ".codex-work"), isDefault: false, suggestedLabel: "codex-work" },
    ])
    expect(
      discoverCodexHomes({ home, env: { CODEX_HOME: join(home, ".codex-work") } })
        .filter((c) => c.isDefault)
        .map((c) => c.configDir),
    ).toEqual([join(home, ".codex-work")])
    expect(looksLikeCodexHome(join(home, ".codex-empty"))).toBe(false)
    expect(discoverCodexHomes({ home: join(home, "missing"), env: {} })).toEqual([])
  })

  test("profile CODEX_HOMEs live under the default one", () => {
    expect(profileCodexHome("/data/codex-home", "hpf_1")).toBe("/data/codex-home/hpf_1")
  })

  test("parseAccount splits the ChatGPT account out", () => {
    expect(parseAccount({ account: { type: "chatgpt", email: "a@b.c", planType: "pro" } })).toEqual({
      auth: { state: "signed-in", label: "a@b.c (ChatGPT pro)" },
      problems: [],
      account: { email: "a@b.c", plan: "ChatGPT pro" },
    })
  })
})

describe("Codex profiles: driver", () => {
  test("a profile driver runs its own app-server on its own CODEX_HOME, linked to the profile's auth.json", async () => {
    const home = makeHome()
    const root = tempDir()
    const dataDir = makeDataDir(root)
    const codexHome = profileCodexHome(dataDir.codexHome, "hpf_work")
    const fake = fakeLauncher(() => FakeAppServer.make())
    const { status, profileId } = await run(
      Effect.gen(function* () {
        const driver = yield* makeCodexDriver(
          {
            binaryPath: process.execPath,
            launcher: fake.launcher,
            codexHome,
            userCodexHome: join(home, ".codex-work"),
            profile: { id: "hpf_work", label: "Work" },
          },
          { dataDir },
        )
        return { status: yield* driver.probe, profileId: driver.profileId }
      }),
    )
    expect(profileId).toBe("hpf_work")
    expect(fake.launches.map((l) => l.spec.codexHome)).toEqual([codexHome])
    const link = join(codexHome, "auth.json")
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(join(home, ".codex-work", "auth.json"))
    expect(status).toMatchObject({
      kind: "codex",
      profileId: "hpf_work",
      profileLabel: "Work",
      configDir: join(home, ".codex-work"),
      account: { email: "ada@example.com", plan: "ChatGPT plus" },
    })
    expect(() => Schema.decodeUnknownSync(HarnessStatus)(status)).not.toThrow()
  })

  test("the default driver has no profile id and no profile stamp", async () => {
    const fake = fakeLauncher(() => FakeAppServer.make())
    const { status, profileId } = await run(
      Effect.gen(function* () {
        const driver = yield* makeCodexDriver(
          { binaryPath: process.execPath, launcher: fake.launcher, linkUserAuth: false },
          { dataDir: makeDataDir(tempDir()) },
        )
        return { status: yield* driver.probe, profileId: driver.profileId }
      }),
    )
    expect(profileId).toBeUndefined()
    expect(status.profileId).toBeUndefined()
  })
})
