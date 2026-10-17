/**
 * Live test against the user's installed `opencode` CLI. Gated by `OPENBOT_LIVE_OPENCODE=1`.
 *
 * Hermetic: XDG data/state/cache dirs point into a temp dir, so nothing touches the user's
 * `opencode.db` (and only free OpenCode models are visible). By default NO model call is made:
 * probe (`/api/info` + `integration.list`), `model.list`, session open with a real `mcp.add`
 * against a minimal in-test MCP endpoint, then close. Set `OPENBOT_LIVE_OPENCODE_TURN=1` to also run
 * one turn on a free model (`OPENBOT_LIVE_OPENCODE_MODEL`, default: the server's default model).
 */
import type { HarnessEvent, TurnId } from "@openbot/contracts"
import { LOCAL_NODE_ID } from "@openbot/contracts"
import { DataDir, HarnessRegistry, sessionKeyOf } from "@openbot/core"
import { botId, conversationId, makeBot } from "@openbot/core/testing"
import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCodeHarnessLive } from "../src/Driver.ts"

const LIVE = process.env.OPENBOT_LIVE_OPENCODE === "1"
const TURN = process.env.OPENBOT_LIVE_OPENCODE_TURN === "1"

/** Minimal MCP Streamable HTTP endpoint: initialize, tools/list, tools/call; GET → 405. */
const startMcp = () => {
  const seen: Array<string> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: async (req) => {
      if (req.method !== "POST") return new Response(null, { status: 405 })
      if (req.headers.get("authorization") !== "Bearer live-token") return new Response("unauthorized", { status: 401 })
      const body = (await req.json()) as { id?: number | string; method: string; params?: any }
      seen.push(body.method)
      if (body.id === undefined) return new Response(null, { status: 202 })
      const result = body.method === "initialize"
        ? { protocolVersion: body.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "openbot", version: "0.0.0" } }
        : body.method === "tools/list"
        ? { tools: [{ name: "whoami", description: "Who am I?", inputSchema: { type: "object", properties: {} } }] }
        : body.method === "tools/call"
        ? { content: [{ type: "text", text: "You are the live test bot." }] }
        : {}
      return Response.json({ jsonrpc: "2.0", id: body.id, result }, { headers: { "mcp-session-id": "live-session" } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/mcp/bot_live`, seen, stop: () => server.stop(true) }
}

describe.skipIf(!LIVE)("OpenCode live (OPENBOT_LIVE_OPENCODE=1)", () => {
  const root = mkdtempSync(join(tmpdir(), "openbot-oc-live-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test("probe, models, session + mcp.add against the real CLI", async () => {
    const mcp = startMcp()
    const xdg = {
      XDG_DATA_HOME: join(root, "xdg", "data"),
      XDG_STATE_HOME: join(root, "xdg", "state"),
      XDG_CACHE_HOME: join(root, "xdg", "cache"),
    }
    const layer = OpenCodeHarnessLive({ env: xdg }).pipe(
      Layer.provideMerge(HarnessRegistry.layer),
      Layer.provideMerge(DataDir.layer(join(root, "data"))),
    )
    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const driver = yield* (yield* HarnessRegistry).get("opencode")
            const status = yield* driver.probe
            const models = yield* driver.listModels
            const bot = makeBot({ id: botId("bot_live"), name: "Live", harness: { kind: "opencode" } })
            const conv = conversationId("cnv_live")
            const dir = join(root, "ws")
            const open = (nativeSessionId: string | undefined, b1 = false) =>
              driver.openSession({
              bot,
              conversationId: conv,
              sessionKey: sessionKeyOf(bot.id, conv),
              nativeSessionId,
              placement: {
                mode: b1 ? "brain-mcp-hands" : "native-local",
                hostNodeId: LOCAL_NODE_ID,
                workspacePath: dir,
                harnessCwd: dir,
                env: {},
                disableBuiltinTools: b1,
                toolsets: b1 ? ["bot", "node"] : ["bot"],
                promptAppend: "",
                release: Effect.void,
              },
              instructions: {
                text: "You are Live, an OpenBot test bot. Answer in one short sentence.",
                sections: { base: "You are Live, an OpenBot test bot.", persona: "Answer in one short sentence.", team: "", memoryIndex: "", placement: "" },
                hash: "live",
              },
              mcp: [{ name: "openbot", url: mcp.url, headers: { authorization: "Bearer live-token" } }],
              model: TURN ? process.env.OPENBOT_LIVE_OPENCODE_MODEL : undefined,
              effort: undefined,
              onRequest: () => Effect.succeed({ decision: "deny" }),
            })
            // No model calls: resume by native id (same server), B1 rules accepted, a missing id recreated.
            const first = yield* Effect.scoped(Effect.flatMap(open(undefined), (s) => s.nativeSessionId))
            const resumedId = yield* Effect.scoped(Effect.flatMap(open(first, true), (s) => s.nativeSessionId))
            const recreatedId = yield* Effect.scoped(Effect.flatMap(open("ses_openbotlivemissing0000000"), (s) => s.nativeSessionId))
            const session = yield* open(first)
            const events: Array<HarnessEvent> = []
            yield* Effect.forkScoped(Stream.runForEach(session.events, (e) => Effect.sync(() => events.push(e))))
            if (TURN) {
              yield* session.startTurn({ turnId: "trn_live" as TurnId, text: "Say hello.", attachments: [] })
              yield* Effect.promise(async () => {
                const deadline = Date.now() + 120_000
                while (!events.some((e) => e._tag === "TurnCompleted" || e._tag === "TurnFailed")) {
                  if (Date.now() > deadline) throw new Error("live turn timed out")
                  await Bun.sleep(100)
                }
              })
            }
            return { status, models, nativeSessionId: yield* session.nativeSessionId, first, resumedId, recreatedId, events }
          }),
        ).pipe(Effect.provide(layer)),
      )
      console.log("[live] status", JSON.stringify(result.status))
      console.log("[live] models", result.models.length, result.models.slice(0, 3).map((m) => m.id))
      console.log("[live] mcp methods", mcp.seen)
      expect(result.status).toMatchObject({ kind: "opencode", installed: true, problems: [] })
      expect(result.status.version).toMatch(/^2\./)
      expect(result.models.length).toBeGreaterThan(0)
      expect(result.nativeSessionId).toMatch(/^ses/)
      expect(result.resumedId).toBe(result.first!)
      expect(result.nativeSessionId).toBe(result.first!)
      expect(result.recreatedId).toMatch(/^ses/)
      expect(result.recreatedId).not.toBe(result.first!)
      expect(mcp.seen).toContain("initialize")
      expect(mcp.seen).toContain("tools/list")
      if (TURN) {
        console.log("[live] events", result.events.map((e) => e._tag).join(" "))
        expect(result.events.some((e) => e._tag === "TurnCompleted")).toBe(true)
      }
    } finally {
      mcp.stop()
    }
  }, 180_000)
})
