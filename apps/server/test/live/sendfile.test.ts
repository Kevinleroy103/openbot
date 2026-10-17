/**
 * Live: a real Claude bot (haiku) shows the owner a file it has in its workspace with `send_file`
 * (instructions: "use send_file — don't just print its path"). Temp data dir, ephemeral port.
 * Gated: `OPENBOT_LIVE=1 bun test apps/server/test/live/sendfile.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Bot } from "@openbot/contracts"
import { Effect } from "effect"
import { mkdirSync } from "node:fs"
import { deflateSync } from "node:zlib"
import { join } from "node:path"
import { CHEAP, connect, converse, createBot, LIVE, type LiveBrain, report, startLiveBrain, toolCalls } from "./support.ts"

let brain: LiveBrain

/** A 64×64 solid PNG. */
const png = (): Uint8Array => {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff
    for (const x of b) c = table[(c ^ x) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, data.length)
    out.set(new TextEncoder().encode(type), 4)
    out.set(data, 8)
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)))
    return out
  }
  const ihdr = new Uint8Array(13)
  new DataView(ihdr.buffer).setUint32(0, 64)
  new DataView(ihdr.buffer).setUint32(4, 64)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const raw = new Uint8Array(64 * (64 * 3 + 1)).map((_, i) => (i % 193 === 0 ? 0 : 200))
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]
  return new Uint8Array(parts.flatMap((p) => [...p]))
}

describe.skipIf(!LIVE)("live: send_file", () => {
  beforeAll(async () => {
    brain = await startLiveBrain()
  }, 60_000)
  afterAll(async () => {
    await brain?.close()
  }, 60_000)

  test("claude: shows the owner a PNG from its workspace with send_file", () =>
    brain.run(Effect.gen(function*() {
      const client = yield* connect(brain.server, brain.cookie)
      const bot: Bot = yield* createBot(client, "Painter", "claude")
      const out = join(brain.server.dataDir, "bots", bot.id, "workspace", "output")
      mkdirSync(out, { recursive: true })
      yield* Effect.promise(() => Bun.write(join(out, "swatch.png"), png()))
      const result = yield* converse(
        client,
        bot.directConversationId,
        "I rendered output/swatch.png in your workspace. Please show it to me here.",
        { timeout: 240_000 },
      )
      report(`claude send_file (${CHEAP.claude.model})`, result.entries, result.turns)
      expect(result.turns.every((t) => t.status === "completed")).toBe(true)
      expect(toolCalls(result.entries).some((t) => t.kind === "tool-call" && t.name.includes("send_file"))).toBe(true)
      const withFile = result.entries.find((e) => e.kind === "message" && e.role === "bot" && e.attachments.length > 0)
      expect(withFile?.kind === "message" ? withFile.attachments[0] : undefined).toMatchObject({ name: "swatch.png", mime: "image/png", width: 64, height: 64 })
    })), 300_000)
})
