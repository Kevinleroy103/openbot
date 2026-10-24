/**
 * Live: OpenBot MCP tools from each harness, cross-harness bot-to-bot, and a three-harness group.
 * Gated: `OPENBOT_LIVE=1 bun test apps/server/test/live/bots.test.ts [-t <name>]`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type Bot, transcriptOf } from "@openbot/contracts"
import { Effect, Ref, Stream } from "effect"
import {
  botTexts,
  type CheapHarness,
  connect,
  converse,
  createBot,
  LIVE,
  type LiveBrain,
  report,
  settle,
  startLiveBrain,
  toolCalls,
  watch,
} from "./support.ts"

let brain: LiveBrain

describe.skipIf(!LIVE)("live: bot tools", () => {
  beforeAll(async () => {
    brain = await startLiveBrain()
  }, 60_000)
  afterAll(async () => {
    await brain?.close()
  }, 60_000)

  const listBots = (harness: CheapHarness) =>
    brain.run(
      Effect.gen(function* () {
        const client = yield* connect(brain.server, brain.cookie)
        const bot: Bot = yield* createBot(client, `Lister${harness}`, harness)
        const result = yield* converse(
          client,
          bot.directConversationId,
          "Call the OpenBot tool list_bots and reply with the bot names it returns, comma separated.",
          { timeout: 240_000 },
        )
        report(`${harness} list_bots`, result.entries, result.turns)
        expect(result.turns.every((t) => t.status === "completed")).toBe(true)
        expect(toolCalls(result.entries).some((c) => c.name.includes("list_bots") && c.status === "completed")).toBe(
          true,
        )
        expect(botTexts(result.entries).join("\n")).toContain(`Lister${harness}`)
      }),
    )

  test("claude calls list_bots", () => listBots("claude"), 300_000)
  test("codex calls list_bots", () => listBots("codex"), 300_000)
  test("opencode calls list_bots", () => listBots("opencode"), 300_000)

  test(
    "claude → codex → claude over message_bot",
    () =>
      brain.run(
        Effect.gen(function* () {
          const client = yield* connect(brain.server, brain.cookie)
          const ada: Bot = yield* createBot(client, "Ada", "claude")
          const cody: Bot = yield* createBot(client, "Cody", "codex", {
            instructions:
              "Be extremely brief. When another bot messages you, answer it by calling the OpenBot tool message_bot (to = that bot's name, urgency = urgent).",
          })
          const adaState = yield* watch(client, ada.directConversationId)
          const codyState = yield* watch(client, cody.directConversationId)
          const first = yield* converse(
            client,
            ada.directConversationId,
            'Use the OpenBot tool message_bot (urgency: urgent) to ask the bot Cody: "What is 2+3? Reply to Ada with message_bot." Then end your turn.',
            { timeout: 240_000 },
          )
          report("Ada (claude) sends", first.entries, first.turns)
          expect(toolCalls(first.entries).some((c) => c.name.includes("message_bot") && c.status === "completed")).toBe(
            true,
          )
          // Cody's DM gets Ada's message and Cody answers with message_bot; Ada's DM gets the answer
          const cody2 = yield* settle(
            codyState,
            (s) => toolCalls(transcriptOf(s)).some((c) => c.name.includes("message_bot") && c.status === "completed"),
            {
              timeout: 240_000,
              label: "Cody replies with message_bot",
            },
          )
          report("Cody (codex) DM", transcriptOf(cody2))
          const ada2 = yield* settle(
            adaState,
            (s) =>
              transcriptOf(s).some(
                (e) =>
                  e.kind === "message" && e.author.kind === "bot" && e.author.botId === cody.id && e.text.includes("5"),
              ),
            { timeout: 240_000, label: "Cody's answer in Ada's DM" },
          )
          report("Ada (claude) DM after", transcriptOf(ada2))
          const events = transcriptOf(ada2).flatMap((e) => (e.kind === "event" ? [e.event.type] : []))
          expect(events).toContain("messaged-bot")
          yield* Ref.get(adaState)
        }),
      ),
    600_000,
  )

  test(
    "group: @everyone → claude, codex and opencode all answer",
    () =>
      brain.run(
        Effect.gen(function* () {
          const client = yield* connect(brain.server, brain.cookie)
          const members: ReadonlyArray<Bot> = [
            yield* createBot(client, "Gclaude", "claude"),
            yield* createBot(client, "Gcodex", "codex"),
            yield* createBot(client, "Gopencode", "opencode"),
          ]
          const group = yield* client["conversations.createGroup"]({
            title: "Live trio",
            memberBotIds: members.map((b) => b.id),
            clientNonce: `group-${Date.now()}`,
          })
          const result = yield* converse(
            client,
            group.id,
            "@everyone In one word: what color is the sky on a clear day?",
            {
              addressEveryone: true,
              timeout: 300_000,
            },
          )
          report("group trio", result.entries, result.turns)
          expect(result.turns).toHaveLength(3)
          expect(result.turns.every((t) => t.status === "completed")).toBe(true)
          for (const bot of members) expect(botTexts(result.entries, bot.id).join(" ").toLowerCase()).toContain("blue")
        }),
      ),
    600_000,
  )

  test(
    "claude creates a teammate with create_bot (same harness and model by default)",
    () =>
      brain.run(
        Effect.gen(function* () {
          const client = yield* connect(brain.server, brain.cookie)
          const boss: Bot = yield* createBot(client, "Boss", "claude")
          const result = yield* converse(
            client,
            boss.directConversationId,
            'Use the OpenBot tool create_bot to create a teammate named "Helper" with label "Ops" and instructions "Answer briefly.". Reply "created".',
            { timeout: 240_000 },
          )
          report("Boss create_bot", result.entries, result.turns)
          expect(toolCalls(result.entries).some((c) => c.name.includes("create_bot") && c.status === "completed")).toBe(
            true,
          )
          const snapshot = yield* client["roster.subscribe"]({}).pipe(
            Stream.filter((item) => item.kind === "snapshot"),
            Stream.take(1),
            Stream.runCollect,
          )
          const bots = (snapshot[0] as unknown as { bots: ReadonlyArray<Bot> }).bots
          const helper = bots.find((b) => b.name === "Helper")
          console.log("[live] created bot:", JSON.stringify(helper))
          expect(helper).toMatchObject({
            label: "Ops",
            harness: { kind: "claude", model: "haiku" },
            hostNodeId: boss.hostNodeId,
          })
        }),
      ),
    300_000,
  )
})
