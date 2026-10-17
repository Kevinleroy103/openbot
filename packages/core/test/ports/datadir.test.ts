import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { DataDir, joinPath, makeDataDir } from "../../src/ports/index.ts"

describe("DataDir", () => {
  test("derives every location from the root", () => {
    const dir = makeDataDir("/data/openbot/")
    expect(dir.root).toBe("/data/openbot")
    expect(dir.database).toBe("/data/openbot/openbot.sqlite")
    expect(dir.botDir("bot_1")).toBe("/data/openbot/bots/bot_1")
    expect(dir.memoryDir("bot_1")).toBe("/data/openbot/bots/bot_1/memory")
    expect(dir.workspaceDir("bot_1")).toBe("/data/openbot/bots/bot_1/workspace")
    expect(dir.skillsLib).toBe("/data/openbot/skills-lib")
    expect(dir.codexHome).toBe("/data/openbot/codex-home")
    expect(dir.attachments).toBe("/data/openbot/attachments")
    expect(dir.brainIdentity).toBe("/data/openbot/brain-identity.json")
    expect(dir.opencodeConfig).toBe("/data/openbot/opencode-config")
    expect(dir.localNode).toBe("/data/openbot/local-node")
  })

  test("joinPath collapses separators", () => {
    expect(joinPath("/a/", "/b//", "c")).toBe("/a/b/c")
    expect(joinPath("/")).toBe("/")
  })

  test("layer provides the service", async () => {
    const root = await Effect.runPromise(Effect.map(DataDir, (d) => d.root).pipe(Effect.provide(DataDir.layer("/x"))))
    expect(root).toBe("/x")
  })
})
