// send_file (Messaging.sendFiles): files stream from a node (NodeFiles fake) into the attachment
// store and ONE bot message carrying them is posted in the conversation of the bot's current turn;
// idempotent per tool call id (in memory and durably via the entry's clientNonce); failures post
// nothing and leave no stored files. Plus the pure type sniffing / image size helpers.
import { describe, expect, test } from "bun:test"
import { type ConversationId, LOCAL_NODE_ID, type TurnId } from "@openbot/contracts"
import { Context, Deferred, Effect, Fiber, Layer, Option } from "effect"
import { AttachmentStore, BotRepo, ConversationRepo, Messaging, type ToolContext } from "../../src/ports/index.ts"
import { MessagingLive } from "../../src/services/conversation/index.ts"
import { detectMime, formatBytes, imageDimensions } from "../../src/services/conversation/files.ts"
import { messageWithAttachments } from "../../src/services/conversation/internal/util.ts"
import {
  botId,
  conversationId,
  ConversationServiceFake,
  CoreServiceFakes,
  makeBot,
  makeClaims,
  makeDirectConversation,
  makeGroupConversation,
  NodeFilesFake,
  runTest,
  TestPorts,
} from "../../src/testing/index.ts"

const ADA = makeBot({ id: botId("bot_a"), name: "Ada", directConversationId: conversationId("cnv_a") })
const BOB = makeBot({ id: botId("bot_b"), name: "Bob", directConversationId: conversationId("cnv_b") })
const GROUP = makeGroupConversation({ id: conversationId("cnv_g"), memberBotIds: [ADA.id, BOB.id] })
const WS = "/openbot-test/bots/bot_a/workspace"

const tool = (conversation: ConversationId, callId?: string, turnId?: string): ToolContext => ({
  claims: makeClaims({ botId: ADA.id, conversationId: conversation }),
  ...(callId === undefined ? {} : { callId }),
  ...(turnId === undefined ? {} : { turnId: turnId as TurnId }),
})
const inv = { invocationId: "inv_1", botId: ADA.id, runId: `${ADA.id}:cnv_a` }

/** A 1×1 PNG (real IHDR), padded to `size` bytes. */
const png = (width: number, height: number, size = 2000) => {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}
const mp4 = (size: number) => {
  const bytes = new Uint8Array(size).fill(7)
  bytes.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]) // ....ftypisom
  return bytes
}

const layer = () => MessagingLive.pipe(Layer.provideMerge(CoreServiceFakes()), Layer.provideMerge(TestPorts()))

const seed = Effect.gen(function* () {
  const bots = yield* BotRepo
  const conversations = yield* ConversationRepo
  for (const bot of [ADA, BOB]) {
    yield* Effect.orDie(bots.upsert(bot))
    yield* Effect.orDie(conversations.upsert(makeDirectConversation({ id: bot.directConversationId, botId: bot.id })))
  }
  yield* Effect.orDie(conversations.upsert(GROUP))
  const files = yield* NodeFilesFake
  yield* files.put(LOCAL_NODE_ID, `${WS}/out/cover.png`, png(1920, 1080))
  yield* files.put(LOCAL_NODE_ID, `${WS}/psychopomp/output/cache-demo.mp4`, mp4(300_000))
})

const messages = Effect.map(
  Effect.flatMap(ConversationServiceFake, (fake) => fake.written),
  (all) => all.flatMap((e) => (e.kind === "message" ? [e] : [])),
)

describe("send_file (Messaging.sendFiles)", () => {
  test("streams the files into the store and posts one bot message with them in the current conversation", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const messaging = yield* Messaging
        const progress: Array<string> = []
        const result = yield* messaging.sendFiles(tool(GROUP.id, "call_1", "trn_7"), {
          nodeId: LOCAL_NODE_ID,
          inv,
          cwd: WS,
          paths: ["out/cover.png", "psychopomp/output/cache-demo.mp4"],
          caption: "  Rendered: cover + demo  ",
          progress: (line) => Effect.sync(() => void progress.push(line)),
        })
        const store = yield* AttachmentStore
        const video = yield* store.read(result.files[1]!.attachment.id)
        return {
          result,
          progress,
          posted: yield* messages,
          video: Option.getOrThrow(video),
          requests: yield* (yield* NodeFilesFake).requests,
        }
      }),
      layer(),
    )
    expect(out.result.conversationId).toBe(GROUP.id)
    expect(out.result.files.map((f) => f.path)).toEqual([
      `${WS}/out/cover.png`,
      `${WS}/psychopomp/output/cache-demo.mp4`,
    ])
    expect(out.result.files.map((f) => f.attachment)).toMatchObject([
      {
        name: "cover.png",
        mime: "image/png",
        byteSize: 2000,
        width: 1920,
        height: 1080,
        url: expect.stringMatching(/^\/api\/attachments\//),
      },
      { name: "cache-demo.mp4", mime: "video/mp4", byteSize: 300_000 },
    ])
    expect(out.video.byteLength).toBe(300_000)
    expect(out.posted).toHaveLength(1)
    expect(out.posted[0]).toMatchObject({
      id: out.result.entryId,
      conversationId: GROUP.id,
      author: { kind: "bot", botId: ADA.id },
      role: "bot",
      text: "Rendered: cover + demo",
      streaming: false,
      turnId: "trn_7",
      clientNonce: "send_file:bot_a:call_1",
    })
    expect(out.posted[0]!.attachments).toEqual(out.result.files.map((f) => f.attachment))
    expect(out.progress).toEqual(["Sending cover.png (2 KB)…", "Sending cache-demo.mp4 (300 KB)…"])
    expect(out.requests.map((r) => [r.nodeId, r.path, r.cwd, r.maxBytes])).toEqual([
      [LOCAL_NODE_ID, "out/cover.png", WS, 200_000_000],
      [LOCAL_NODE_ID, "psychopomp/output/cache-demo.mp4", WS, 200_000_000],
    ])
  })

  test("idempotent per tool call id: a retry (even on a fresh service) posts nothing and downloads nothing", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const messaging = yield* Messaging
        const call = tool(ADA.directConversationId, "call_2")
        const input = { nodeId: LOCAL_NODE_ID, inv, cwd: WS, paths: ["out/cover.png"] }
        const first = yield* messaging.sendFiles(call, input)
        const retried = yield* messaging.sendFiles(call, input)
        // a new Messaging instance (brain restart / new MCP session): the posted entry's nonce answers
        const fresh = Context.get(yield* Layer.build(MessagingLive), Messaging)
        const durable = yield* fresh.sendFiles(call, input)
        const other = yield* messaging.sendFiles(tool(ADA.directConversationId, "call_3"), input)
        return {
          first,
          retried,
          durable,
          other,
          posted: yield* messages,
          requests: (yield* (yield* NodeFilesFake).requests).length,
        }
      }),
      layer(),
    )
    expect(out.retried).toMatchObject({ entryId: out.first.entryId, replayed: true })
    expect(out.durable).toMatchObject({ entryId: out.first.entryId, replayed: true })
    expect(out.durable.files.map((f) => f.attachment.id)).toEqual(out.first.files.map((f) => f.attachment.id))
    expect(out.other.entryId).not.toBe(out.first.entryId)
    expect(out.posted).toHaveLength(2)
    expect(out.requests).toBe(2)
  })

  test("failures post nothing, keep no stored files, and read as model-readable errors", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* seed
        const messaging = yield* Messaging
        const send = (paths: ReadonlyArray<string>, conversation: ConversationId = ADA.directConversationId) =>
          Effect.flip(messaging.sendFiles(tool(conversation), { nodeId: LOCAL_NODE_ID, inv, cwd: WS, paths }))
        const missing = yield* send(["nope.mp4"])
        const partial = yield* send(["out/cover.png", "nope.mp4"])
        const denied = yield* send(["/denied/x.png"])
        const none = yield* send(["  "])
        const tooMany = yield* send(Array.from({ length: 11 }, (_, i) => `f${i}.png`))
        const notMine = yield* send(["out/cover.png"], BOB.directConversationId)
        const store = yield* AttachmentStore
        // the partial call stored cover.png first, then removed it (sequential ids: scan them all)
        const leftover = yield* Effect.forEach(
          Array.from({ length: 200 }, (_, i) => `att_${String(i + 1).padStart(6, "0")}`),
          (id) => store.get(id as never),
        ).pipe(Effect.map((found) => Option.firstSomeOf(found)))
        return { missing, partial, denied, none, tooMany, notMine, leftover, posted: yield* messages }
      }),
      layer(),
    )
    expect(out.missing).toMatchObject({
      _tag: "InvalidInput",
      message: "Could not send nope.mp4: nope.mp4 does not exist",
    })
    expect(out.partial).toMatchObject({ _tag: "InvalidInput" })
    expect((out.partial as { message: string }).message).toContain("Nothing was sent")
    expect(out.denied).toMatchObject({
      _tag: "InvalidInput",
      message: "Could not send /denied/x.png: Access to /denied/x.png is denied: outside the node's roots",
    })
    expect(out.none).toMatchObject({ _tag: "InvalidInput", message: "Pass `path` (or `paths`): the file(s) to send." })
    expect((out.tooMany as { message: string }).message).toContain("at most 10 files")
    expect((out.notMine as { message: string }).message).toContain("conversation you are part of")
    expect(Option.isNone(out.leftover)).toBe(true)
    expect(out.posted).toHaveLength(0)
  })

  test("importFiles cancelled after storing a file keeps no stored files", async () => {
    const leftover = await runTest(
      Effect.gen(function* () {
        yield* seed
        const messaging = yield* Messaging
        const second = yield* Deferred.make<void>()
        const fiber = yield* Effect.forkChild(
          messaging.importFiles({
            nodeId: LOCAL_NODE_ID,
            inv,
            cwd: WS,
            paths: ["out/cover.png", "psychopomp/output/cache-demo.mp4"],
            progress: (message) =>
              message.includes("cache-demo")
                ? Effect.andThen(Deferred.succeed(second, undefined), Effect.never)
                : Effect.void,
          }),
        )
        yield* Deferred.await(second)
        yield* Fiber.interrupt(fiber)
        const store = yield* AttachmentStore
        return yield* Effect.forEach(
          Array.from({ length: 20 }, (_, i) => `att_${String(i + 1).padStart(6, "0")}`),
          (id) => store.get(id as never),
        ).pipe(Effect.map((found) => Option.firstSomeOf(found)))
      }),
      layer(),
    )
    expect(Option.isNone(leftover)).toBe(true)
  })
})

describe("file type and size helpers", () => {
  test("magic numbers win over the extension; ZIP containers and text keep their extension's type", () => {
    expect(detectMime("cover.png", png(10, 10))).toBe("image/png")
    expect(detectMime("photo.png", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBe("image/jpeg")
    expect(detectMime("demo.mp4", mp4(64))).toBe("video/mp4")
    expect(
      detectMime("clip.mov", new Uint8Array([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20])),
    ).toBe("video/quicktime")
    expect(detectMime("talk.webm", new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1]))).toBe("video/webm")
    expect(detectMime("song.mp3", new TextEncoder().encode("ID3\u0004\u0000"))).toBe("audio/mpeg")
    expect(detectMime("report.pdf", new TextEncoder().encode("%PDF-1.7\n"))).toBe("application/pdf")
    expect(detectMime("site.zip", new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe("application/zip")
    expect(detectMime("notes.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
    expect(detectMime("dist.tgz", new Uint8Array([0x1f, 0x8b, 8]))).toBe("application/gzip")
    expect(detectMime("README.md", new TextEncoder().encode("# Hello\n"))).toBe("text/markdown")
    expect(detectMime("Makefile", new TextEncoder().encode("all:\n\techo hi\n"))).toBe("text/plain")
    expect(detectMime("data.bin", new Uint8Array([0, 1, 2, 3]))).toBe("application/octet-stream")
    expect(detectMime("fake.txt", new Uint8Array([0, 1, 2, 3]))).toBe("application/octet-stream")
  })

  test("image dimensions from PNG / GIF / JPEG headers", () => {
    expect(imageDimensions("image/png", png(1920, 1080))).toEqual({ width: 1920, height: 1080 })
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00])
    expect(imageDimensions("image/gif", gif)).toEqual({ width: 320, height: 240 })
    // SOI, APP0 (length 16), SOF0 with height 600, width 800
    const jpeg = new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xe0,
      0x00,
      0x10,
      ...new Array(14).fill(0),
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      0x02,
      0x58,
      0x03,
      0x20,
      0x03,
    ])
    expect(imageDimensions("image/jpeg", jpeg)).toEqual({ width: 800, height: 600 })
    expect(imageDimensions("video/mp4", mp4(64))).toBeUndefined()
  })

  test("sizes and catch-up lines", () => {
    expect(formatBytes(24_123_456)).toBe("24.1 MB")
    expect(
      messageWithAttachments("Here it is", [
        {
          id: "att_1" as never,
          name: "demo.mp4",
          mime: "video/mp4",
          byteSize: 24_123_456,
          url: "/api/attachments/att_1",
        },
      ]),
    ).toBe("Here it is [attached: demo.mp4 (video/mp4, 24.1 MB)]")
    expect(messageWithAttachments("", [{ id: "att_2" as never, name: "a.png", mime: "image/png", url: "/x" }])).toBe(
      "[attached: a.png (image/png)]",
    )
  })
})
