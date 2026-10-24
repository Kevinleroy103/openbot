// send_file through the real gateway and the real Messaging.sendFiles: the file comes from the fake
// node (NodeFiles), lands in the attachment store, and one bot message with it is posted in the
// conversation of the bot's CURRENT turn; a repeated tool call id replays without a second transfer.
import { afterEach, describe, expect, test } from "bun:test"
import { LOCAL_NODE_ID, type TranscriptEntryOf } from "@openbot/contracts"
import { AttachmentStore, BotRepo, ConversationRepo } from "@openbot/core"
import {
  conversationId,
  ConversationServiceFake,
  makeDirectConversation,
  makeGroupConversation,
  makeTurn,
  NodeFilesFake,
  OrchestratorFake,
  turnId,
} from "@openbot/core/testing"
import { Effect, Option } from "effect"
import { BOT_A, botA, BOT_B, botB, type Harness, REMOTE, startHarness, textOf } from "./harness.ts"

let h: Harness
afterEach(async () => {
  await h?.close()
})

const WS = `/openbot-test/bots/${BOT_A}/workspace`
const GROUP = conversationId("cnv_team")

const video = (size: number) => {
  const bytes = new Uint8Array(size).fill(3)
  bytes.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]) // ....ftypmp42
  return bytes
}

const seed = (harness: Harness) =>
  harness.run(
    Effect.gen(function* () {
      const bots = yield* BotRepo
      const conversations = yield* ConversationRepo
      for (const bot of [botA, botB]) {
        yield* Effect.orDie(bots.upsert(bot))
        yield* Effect.orDie(
          conversations.upsert(makeDirectConversation({ id: bot.directConversationId, botId: bot.id })),
        )
      }
      yield* Effect.orDie(conversations.upsert(makeGroupConversation({ id: GROUP, memberBotIds: [BOT_A, BOT_B] })))
      const files = yield* NodeFilesFake
      yield* files.put(LOCAL_NODE_ID, `${WS}/psychopomp/output/cache-demo.mp4`, video(240_000))
      yield* files.put(
        REMOTE,
        `/home/${REMOTE}/openbot/workspaces/${BOT_A}/chart.png`,
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
      )
    }),
  )

const posted = (harness: Harness) =>
  harness.run(
    Effect.map(
      Effect.flatMap(ConversationServiceFake, (fake) => fake.written),
      (all) => all.flatMap((e): Array<TranscriptEntryOf<"message">> => (e.kind === "message" ? [e] : [])),
    ),
  )

describe("send_file", () => {
  test("posts the file in the current turn's conversation as the bot's message; a repeated call id replays", async () => {
    h = await startHarness({ realMessaging: true })
    await seed(h)
    const client = await h.connect((await h.issue({ toolsets: ["bot"] })).binding)
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("send_file")
    // the bot's running turn is in the group: the file goes there, not to its DM
    await h.run(
      Effect.flatMap(OrchestratorFake, (fake) =>
        fake.setActiveTurn(
          BOT_A,
          makeTurn({ id: turnId("trn_g"), botId: BOT_A, conversationId: GROUP, status: "running" }),
        ),
      ),
    )
    const call = {
      name: "send_file",
      arguments: { path: "psychopomp/output/cache-demo.mp4", caption: "Cache demo, 1080p60" },
      _meta: { "claudecode/toolUseId": "toolu_send" },
    }
    const first = await client.callTool(call)
    expect(first.isError).toBeUndefined()
    expect(textOf(first)).toMatch(
      /^Sent cache-demo\.mp4 \(240 KB, video\/mp4\) to the owner in this conversation \(message ent_\w+\)\./,
    )
    const again = await client.callTool(call)
    expect(textOf(again)).toBe(textOf(first))

    const messages = await posted(h)
    expect(messages).toHaveLength(1)
    const message = messages[0]!
    expect(message).toMatchObject({
      conversationId: GROUP,
      author: { kind: "bot", botId: BOT_A },
      role: "bot",
      text: "Cache demo, 1080p60",
      turnId: "trn_g",
      clientNonce: `send_file:${BOT_A}:toolu_send`,
    })
    expect(message.attachments).toHaveLength(1)
    expect(message.attachments[0]).toMatchObject({ name: "cache-demo.mp4", mime: "video/mp4", byteSize: 240_000 })
    const stored = await h.run(Effect.flatMap(AttachmentStore, (store) => store.read(message.attachments[0]!.id)))
    expect(Option.getOrThrow(stored)).toEqual(video(240_000))
    const requests = await h.run(Effect.flatMap(NodeFilesFake, (fake) => fake.requests))
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      nodeId: LOCAL_NODE_ID,
      path: "psychopomp/output/cache-demo.mp4",
      cwd: WS,
      maxBytes: 200_000_000,
      inv: { botId: BOT_A, runId: `${BOT_A}:${GROUP}`, toolCallId: "toolu_send" },
    })
  })

  test("`to` another Bot: posted in its chat and delivered with the files", async () => {
    h = await startHarness({ realMessaging: true })
    await seed(h)
    const client = await h.connect((await h.issue({ toolsets: ["bot"] })).binding)
    const result = await client.callTool({
      name: "send_file",
      arguments: { path: "psychopomp/output/cache-demo.mp4", to: "Beta", caption: "for your edit" },
    })
    expect(textOf(result)).toMatch(
      /^Sent cache-demo\.mp4 \(240 KB, video\/mp4\) to @Beta in their chat \(message ent_\w+\)\. They are woken with the files/,
    )
    const messages = await posted(h)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      conversationId: botB.directConversationId,
      toBotId: BOT_B,
      text: "for your edit",
    })
    const deliveries = await h.run(Effect.flatMap(OrchestratorFake, (fake) => fake.deliveries))
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      conversationId: botB.directConversationId,
      botId: BOT_B,
      kind: "bot-message",
      fromBotId: BOT_A,
      text: "for your edit",
      attachmentIds: [messages[0]!.attachments[0]!.id],
      sourceEntryId: messages[0]!.id,
    })
  })

  test("other bound nodes, model-readable errors, and the bot's own nodes only", async () => {
    h = await startHarness({ realMessaging: true })
    await seed(h)
    const client = await h.connect((await h.issue({ toolsets: ["bot"], boundNodeIds: [REMOTE] })).binding)
    const remote = await client.callTool({ name: "send_file", arguments: { path: "chart.png", node: REMOTE } })
    expect(textOf(remote)).toMatch(/^Sent chart\.png \(11 bytes, image\/png\)/)
    const messages = await posted(h)
    expect(messages.map((m) => [m.conversationId, m.attachments.map((a) => a.mime)])).toEqual([
      [botA.directConversationId, ["image/png"]],
    ])

    const missing = await client.callTool({ name: "send_file", arguments: { path: "nope.mp4" } })
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toBe("ERROR: Could not send nope.mp4: nope.mp4 does not exist")
    const none = await client.callTool({ name: "send_file", arguments: { caption: "hi" } })
    expect(textOf(none)).toStartWith("ERROR: Pass `path` (or `paths`)")
    const stranger = await client.callTool({ name: "send_file", arguments: { path: "x.png", node: "nod_stranger" } })
    expect(textOf(stranger)).toStartWith('ERROR: You cannot use node "nod_stranger"')
    const tooMany = await client.callTool({
      name: "send_file",
      arguments: { paths: Array.from({ length: 11 }, (_, i) => `f${i}.png`) },
    })
    expect(textOf(tooMany)).toContain("at most 10 items")
    expect(await posted(h)).toHaveLength(1)
  })
})
