// The owner's `/skill` command (D5.5) through the conversation: the chat keeps what was typed, the Bot
// reads an instruction for a skill it has, and any other `/…` message reaches it as it is.
import { describe, expect, test } from "bun:test"
import type { ConversationId, SkillName } from "@openbot/contracts"
import { Effect, Layer } from "effect"
import { ConversationService, SkillService, userActor } from "../../src/ports/index.ts"
import { SkillServiceLive } from "../../src/services/automation/index.ts"
import { runTest, SkillDirectoryFake } from "../../src/testing/index.ts"
import { appLayer, createBot, messagesOf, send, settled, TestDriver, transcript } from "./helpers.ts"

const layer = () =>
  SkillServiceLive.pipe(
    Layer.provide(SkillDirectoryFake.layer({ results: [], downloads: {} })),
    Layer.provideMerge(appLayer()),
  )

const weeklyReport = {
  name: "weekly-report" as SkillName,
  description: "Use for the Friday report",
  body: "1. Collect",
}

describe("/skill commands (D5.5)", () => {
  test("a skill the Bot has reaches it as an instruction with the skill inline; the chat shows what the owner typed", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const skills = yield* SkillService
        const ada = yield* createBot("Ada")
        yield* skills.upsert(userActor, weeklyReport)
        yield* skills.assign(weeklyReport.name, [ada.id])
        yield* send(ada.directConversationId, "/weekly-report for the platform team")
        yield* settled(ada.directConversationId)
        yield* send(ada.directConversationId, "/not-a-skill for the platform team")
        yield* settled(ada.directConversationId, 2)
        return {
          inputs: (yield* driver.turns).map((t) => t.input),
          shown: messagesOf(yield* transcript(ada.directConversationId))
            .filter((m) => m.role === "user")
            .map((m) => m.text),
        }
      }),
      layer(),
    )
    expect(out.inputs[0]!.text).toContain('The owner started your "weekly-report" skill')
    expect(out.inputs[0]!.text).toContain("Their request: for the platform team")
    expect(out.inputs[0]!.text).toContain("1. Collect")
    // a harness with its own skill commands gets the name and the request alone
    expect(out.inputs[0]!.skillCommand).toEqual({ name: "weekly-report", args: "for the platform team" })
    expect(out.inputs[1]!.text).toBe("/not-a-skill for the platform team")
    expect(out.inputs[1]!.skillCommand).toBeUndefined()
    expect(out.shown).toEqual(["/weekly-report for the platform team", "/not-a-skill for the platform team"])
  })

  test("owner-only skills reach the session as such; switching the setting reopens it", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const skills = yield* SkillService
        const ada = yield* createBot("Ada")
        yield* skills.upsert(userActor, { ...weeklyReport, disableModelInvocation: true })
        yield* skills.upsert(userActor, { name: "notes" as SkillName, description: "Notes.", body: "Write." })
        yield* skills.assign(weeklyReport.name, [ada.id])
        yield* skills.assign("notes" as SkillName, [ada.id])
        yield* send(ada.directConversationId, "hi")
        yield* settled(ada.directConversationId)
        yield* skills.upsert(userActor, { ...weeklyReport, disableModelInvocation: false })
        yield* send(ada.directConversationId, "again")
        yield* settled(ada.directConversationId, 2)
        return (yield* driver.opened).map((input) => input.ownerOnlySkills?.map(String))
      }),
      layer(),
    )
    expect(out).toEqual([["weekly-report"], []])
  })

  test("group: the current command is expanded for the Bot it addresses; a teammate catching up reads it as typed", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const driver = yield* TestDriver
        const skills = yield* SkillService
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        yield* skills.upsert(userActor, weeklyReport)
        yield* skills.assign(weeklyReport.name, [ada.id, bob.id])
        const group = (yield* (yield* ConversationService).createGroup({
          title: "",
          memberBotIds: [ada.id, bob.id],
          leadBotId: ada.id,
        })).id as ConversationId
        yield* send(group, "/weekly-report for the platform team")
        yield* settled(group, 1)
        yield* send(group, "@Bob anything to add?")
        yield* settled(group, 2)
        const turns = yield* driver.turns
        return {
          ada: turns.find((t) => t.bot.id === ada.id)!.input,
          bob: turns.find((t) => t.bot.id === bob.id)!.input,
        }
      }),
      layer(),
    )
    expect(out.ada.text).toStartWith("[Group chat")
    expect(out.ada.text).toContain('The owner started your "weekly-report" skill')
    expect(out.ada.text).toContain("1. Collect")
    expect(out.ada.text).not.toContain("/weekly-report for the platform team")
    expect(out.ada.skillCommand?.name).toBe("weekly-report")
    expect(out.ada.skillCommand?.args).toStartWith("[Group chat")
    expect(out.ada.skillCommand?.args).toEndWith("]: for the platform team")
    // Bob catches up on the earlier command as the owner typed it, and answers only the new message
    expect(out.bob.text).toContain("]: /weekly-report for the platform team")
    expect(out.bob.text).not.toContain("The owner started your")
    expect(out.bob.skillCommand).toBeUndefined()
  })
})
