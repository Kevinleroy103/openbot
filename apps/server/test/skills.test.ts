// Skills over RPC (D5.5): the library on disk, per-bot skills in the roster, skills.sh import (a fake
// directory), and Unavailable when skills.sh does not answer.
import { describe, expect, test } from "bun:test"
import type { SkillName } from "@openbot/contracts"
import { SkillDirectoryFake } from "@openbot/core/testing"
import { Effect } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { login, rpcClient, startServer } from "./helpers.ts"

const skillMd = "---\nname: release-notes\ndescription: Use when writing release notes.\n---\n# Notes\n"

describe("skills over RPC", () => {
  test("upsert, assign to a bot, import from skills.sh with its files, delete takes it from the bot", async () => {
    const server = await startServer({
      server: {
        skillDirectory: SkillDirectoryFake.layer({
          results: [{ id: "acme/skills/release-notes", name: "release-notes", repo: "acme/skills", installs: 3 }],
          downloads: {
            "acme/skills/release-notes": {
              hash: "h",
              files: [
                { path: "SKILL.md", contents: skillMd },
                { path: "scripts/a.sh", contents: "echo\n" },
              ],
            },
          },
        }),
      },
    })
    try {
      const cookie = await login(server.base, server.ownerToken)
      await server.run(
        Effect.gen(function* () {
          const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })
          const bot = yield* client["bots.create"]({
            name: "Scout",
            harness: { kind: "fake" },
            clientNonce: "s-1",
            introduce: false,
          })
          const triage = yield* client["skills.upsert"]({
            name: "triage" as SkillName,
            description: "Use when triaging.",
            body: "1. Read",
          })
          yield* client["skills.assign"]({ name: triage.name, botIds: [bot.id] })
          const skillsOf = Effect.map(client["bots.get"]({ botId: bot.id }), (b) => [...b.skills].map(String).sort())
          expect(yield* skillsOf).toEqual(["triage"])

          expect(yield* client["skills.search"]({ query: "release" })).toEqual([
            { id: "acme/skills/release-notes", name: "release-notes", repo: "acme/skills", installs: 3 },
          ])
          const preview = yield* client["skills.preview"]({ id: "acme/skills/release-notes" })
          expect(preview).toMatchObject({
            name: "release-notes",
            replaces: false,
            files: [{ path: "SKILL.md" }, { path: "scripts/a.sh", bytes: 5 }],
          })
          const installed = yield* client["skills.install"]({ id: "acme/skills/release-notes", botIds: [bot.id] })
          expect(installed).toMatchObject({
            source: { kind: "skills.sh", id: "acme/skills/release-notes" },
            files: ["scripts/a.sh"],
          })
          expect(yield* skillsOf).toEqual(["release-notes", "triage"])
          const dir = join(server.dataDir, "skills-lib", "skills", "release-notes")
          expect(readFileSync(join(dir, "scripts", "a.sh"), "utf8")).toBe("echo\n")

          yield* client["skills.delete"]({ name: triage.name })
          expect(yield* skillsOf).toEqual(["release-notes"])
          expect(existsSync(join(server.dataDir, "skills-lib", "skills", "triage"))).toBe(false)
          const missing = yield* Effect.flip(client["skills.preview"]({ id: "acme/skills/nope" }))
          expect(missing._tag).toBe("NotFound")
        }),
      )
    } finally {
      await server.close()
    }
  })

  test("skills.sh not answering is Unavailable", async () => {
    const server = await startServer({ server: { skillDirectory: SkillDirectoryFake.layer({ offline: true }) } })
    try {
      const cookie = await login(server.base, server.ownerToken)
      await server.run(
        Effect.gen(function* () {
          const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })
          expect((yield* Effect.flip(client["skills.search"]({ query: "x" })))._tag).toBe("Unavailable")
        }),
      )
    } finally {
      await server.close()
    }
  })
})
