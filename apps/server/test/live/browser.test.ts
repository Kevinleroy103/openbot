/**
 * Live: a bot drives the `browser` toolkit on the local node (Chromium) and the computer view shows a
 * screen. Gated: `OPENBOT_LIVE=1 bun test apps/server/test/live/browser.test.ts`.
 * Harness: `OPENBOT_LIVE_BROWSER_HARNESS` (claude | codex | opencode; default claude).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Bot } from "@openbot/contracts"
import { Effect } from "effect"
import { botTexts, type CheapHarness, connect, converse, createBot, LIVE, type LiveBrain, report, startLiveBrain, toolCalls } from "./support.ts"

let brain: LiveBrain
const HARNESS = (process.env["OPENBOT_LIVE_BROWSER_HARNESS"] ?? "claude") as CheapHarness

/** Opens the viewer socket with the session cookie and waits for the first binary (screencast) frame. */
const firstFrame = (url: string, cookie: string, origin: string, timeoutMs: number) =>
  new Promise<{ bytes: number; notices: Array<string> }>((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { cookie, origin } } as never)
    ws.binaryType = "arraybuffer"
    const notices: Array<string> = []
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`no screencast frame within ${timeoutMs} ms; notices: ${notices.join(" | ")}`))
    }, timeoutMs)
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        notices.push(event.data.slice(0, 200))
        return
      }
      clearTimeout(timer)
      ws.close()
      resolve({ bytes: (event.data as ArrayBuffer).byteLength, notices })
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error("viewer socket error"))
    }
  })

describe.skipIf(!LIVE)("live: browser", () => {
  beforeAll(async () => {
    brain = await startLiveBrain()
  }, 60_000)
  afterAll(async () => {
    await brain?.close()
  }, 60_000)

  test(`${HARNESS}: browser toolkit opens example.com; the computer shows a screen`, () =>
    brain.run(Effect.gen(function*() {
      const client = yield* connect(brain.server, brain.cookie)
      const bot: Bot = yield* createBot(client, "Browsy", HARNESS)
      const result = yield* converse(
        client,
        bot.directConversationId,
        "Use the OpenBot browser tool to navigate to https://example.com and reply with the page title only.",
        { timeout: 300_000 },
      )
      report(`${HARNESS} browser`, result.entries, result.turns)
      expect(result.turns.every((t) => t.status === "completed")).toBe(true)
      expect(toolCalls(result.entries).some((c) => c.name.includes("browser") && c.status === "completed")).toBe(true)
      expect(botTexts(result.entries).join("\n")).toContain("Example Domain")

      const status = yield* client["computer.status"]({ botId: bot.id })
      console.log("[live] computer.status:", JSON.stringify(status))
      expect(status).toMatchObject({ state: "ready", surface: "browser", controller: "bot" })
      const frame = yield* Effect.promise(() =>
        firstFrame(`${brain.server.wsBase}${status.viewPath ?? `/ws/computer/${bot.id}`}?mode=view`, brain.cookie, brain.server.base, 20_000)
      )
      console.log("[live] first screencast frame:", frame.bytes, "bytes; notices:", frame.notices)
      expect(frame.bytes).toBeGreaterThan(1000)
    })), 400_000)
})
