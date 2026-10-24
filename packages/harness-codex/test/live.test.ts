/**
 * Live smoke test against the real Codex with the user's own login. Gated by
 * `OPENBOT_LIVE_CODEX=1`. One trivial turn on the cheapest catalog model at the lowest effort, in a
 * temporary OpenBot profile whose `auth.json` links to the user's login (never copied).
 */
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { HarnessEvent } from "@openbot/contracts"
import { DataDir, makeDataDir } from "@openbot/core"
import { Effect } from "effect"
import { codexDriver } from "../src/Driver.ts"
import { collect, has, makeSessionInput, ofTag, tempDir, turnId } from "./support.ts"

const live = process.env.OPENBOT_LIVE_CODEX === "1"

describe.skipIf(!live)("live Codex (OPENBOT_LIVE_CODEX=1)", () => {
  test("probe, models, and one trivial turn on the cheapest model", async () => {
    const root = tempDir("openbot-codex-live-")
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* codexDriver({})
          const status = yield* driver.probe
          const models = yield* driver.listModels
          const cheapest =
            models.find((m) => /luna|mini|spark|nano/i.test(m.id)) ?? models.find((m) => m.default) ?? models[0]
          const effort = cheapest?.efforts?.includes("low") ? "low" : cheapest?.efforts?.[0]
          const session = yield* driver.openSession(
            makeSessionInput(join(root, "workspace"), () => Effect.succeed({ decision: "deny" }), {
              mcp: [],
              model: cheapest?.id,
              effort,
            }),
          )
          const events = yield* collect(session.events)
          yield* session.startTurn({
            turnId: turnId(1),
            text: "Reply with exactly the word PONG and nothing else.",
            attachments: [],
          })
          for (let i = 0; i < 1200; i++) {
            if (events.events.some((e) => e._tag === "TurnCompleted" || e._tag === "TurnFailed")) break
            yield* Effect.sleep(100)
          }
          return {
            status,
            model: cheapest?.id,
            events: events.events as ReadonlyArray<HarnessEvent>,
            context: yield* session.contextUsage,
          }
        }).pipe(Effect.provideService(DataDir, makeDataDir(root))),
      ),
    )
    expect(result.status).toMatchObject({ installed: true, auth: { state: "signed-in" } })
    expect(has("TurnCompleted")(result.events)).toBe(true)
    const message = ofTag(result.events, "ItemUpserted")
      .map((e) => e.item)
      .filter((i) => i._tag === "Message")
      .at(-1)
    expect(message?._tag === "Message" && message.text.toUpperCase()).toContain("PONG")
    expect(ofTag(result.events, "Usage").length).toBe(1)
    expect(result.context?.windowTokens).toBeGreaterThan(0)
  }, 180_000)
})
