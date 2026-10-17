/**
 * Live (D5.0 one mind per bot): a Claude bot works in a group, then in its DM remembers it.
 * Gated: `OPENBOT_LIVE=1 bun test apps/server/test/live/onemind.test.ts`. Two tiny haiku turns.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Bot } from "@openbot/contracts"
import { Effect } from "effect"
import { botTexts, connect, converse, createBot, LIVE, type LiveBrain, report, startLiveBrain } from "./support.ts"

let brain: LiveBrain

describe.skipIf(!LIVE)("live: one mind per bot", () => {
  beforeAll(async () => {
    brain = await startLiveBrain()
  }, 60_000)
  afterAll(async () => {
    await brain?.close()
  }, 60_000)

  test("claude: what it did in a group is remembered in its DM (same native session)", () =>
    brain.run(Effect.gen(function*() {
      const client = yield* connect(brain.server, brain.cookie)
      const ada: Bot = yield* createBot(client, "Ada", "claude")
      const bob: Bot = yield* client["bots.create"]({ name: "Bob", harness: { kind: "fake" }, clientNonce: `bob-${Date.now()}` })
      const group = yield* client["conversations.createGroup"]({ title: "secret project", memberBotIds: [ada.id, bob.id], leadBotId: ada.id })
      const inGroup = yield* converse(
        client,
        group.id,
        "@Ada the project codeword is PERIWINKLE-42. Acknowledge with one short sentence.",
        { timeout: 240_000 },
      )
      report("group", inGroup.entries, inGroup.turns)
      expect(inGroup.turns.every((t) => t.status === "completed")).toBe(true)
      const inDm = yield* converse(
        client,
        ada.directConversationId,
        "What did you just do in the group chat, and what is the project codeword there? One sentence.",
        { timeout: 240_000 },
      )
      report("dm", inDm.entries, inDm.turns)
      expect(inDm.turns.every((t) => t.status === "completed")).toBe(true)
      const answer = botTexts(inDm.entries, ada.id).join("\n")
      expect(answer).toContain("PERIWINKLE")
    })), 600_000)
})
