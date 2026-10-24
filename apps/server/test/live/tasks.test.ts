/**
 * Live (D5.7 background tasks): a Claude haiku bot is asked for something long, hands it to
 * parallel work (`start_task`), answers the owner meanwhile, and reports the result later — and its
 * visible replies never talk about the mechanics.
 * Gated: `OPENBOT_LIVE=1 bun test apps/server/test/live/tasks.test.ts` (temp data dir, port 0).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type Bot, type Task, transcriptOf } from "@openbot/contracts"
import { Effect, Ref } from "effect"
import {
  botTexts,
  connect,
  converse,
  createBot,
  LIVE,
  type LiveBrain,
  report,
  startLiveBrain,
  watch,
} from "./support.ts"

let brain: LiveBrain

/** Mechanics the bot must never mention to the owner. */
export const PLUMBING =
  /\b(background task|task id|tsk_\w+|sub-?agents?|sessions?|spawn(?:ed|ing)?|workers?|tools?|start_task|check_task|list_tasks|cancel_task)\b/i

const log = (...args: ReadonlyArray<unknown>) => console.log("[live]", ...args)

describe.skipIf(!LIVE)("live: background tasks", () => {
  beforeAll(async () => {
    brain = await startLiveBrain()
  }, 60_000)
  afterAll(async () => {
    await brain?.close()
  }, 60_000)

  test(
    "claude: long work runs in parallel; the owner gets an immediate answer meanwhile; the result is reported naturally",
    () =>
      brain.run(
        Effect.gen(function* () {
          const client = yield* connect(brain.server, brain.cookie)
          const bot: Bot = yield* createBot(client, "Scout", "claude", {
            instructions: "You are Scout, a research assistant. Keep replies short.",
          })
          const dm = yield* watch(client, bot.directConversationId)

          const first = yield* converse(
            client,
            bot.directConversationId,
            "Please research this thoroughly, it can take a while: compare Bun, Deno and Node.js in depth using the web — history, release cadence, " +
              "performance claims, package ecosystem and licensing — and write a detailed report with sources into a file in your workspace. Tell me when it's ready.",
            { timeout: 300_000 },
          )
          report("ask", first.entries, first.turns)
          const started = yield* client["tasks.list"]({ botId: bot.id })
          log("tasks after the ask", JSON.stringify(started.map((t) => [t.title, t.status])))
          expect(started.length).toBeGreaterThan(0)
          const task: Task = started[started.length - 1]!

          // the owner talks meanwhile: an immediate answer from the main session
          const t0 = Date.now()
          const meanwhile = yield* converse(
            client,
            bot.directConversationId,
            "Quick one while you work on that: what is 12 times 12? Just the number.",
            {
              timeout: 120_000,
            },
          )
          const answeredIn = Date.now() - t0
          report("meanwhile", meanwhile.entries, meanwhile.turns)
          const during = (yield* client["tasks.get"]({ taskId: task.id })).task.status
          log(`answered in ${answeredIn} ms; the work was ${during}`)
          expect(botTexts(meanwhile.entries, bot.id).join("\n")).toContain("144")

          // the work finishes and the bot reports it in the DM
          const deadline = Date.now() + 600_000
          let done = (yield* client["tasks.get"]({ taskId: task.id })).task
          while (done.status === "queued" || done.status === "running") {
            if (Date.now() > deadline) throw new Error("the work did not finish in time")
            yield* Effect.sleep("2 seconds")
            done = (yield* client["tasks.get"]({ taskId: task.id })).task
          }
          log("work ended", done.status, done.error ?? "", (done.result ?? "").slice(0, 400))
          expect(done.status).toBe("succeeded")
          // wait for the report turn (a bot message after the result came back)
          const before = botTexts(meanwhile.entries, bot.id).length
          let entries = transcriptOf(yield* Ref.get(dm))
          for (let i = 0; i < 240 && botTexts(entries, bot.id).length <= before; i++) {
            yield* Effect.sleep("1 second")
            entries = transcriptOf(yield* Ref.get(dm))
          }
          yield* Effect.sleep("3 seconds")
          entries = transcriptOf(yield* Ref.get(dm))
          report("final DM", entries)
          const detail = yield* client["tasks.get"]({ taskId: task.id })
          log(
            "steps",
            detail.steps.length,
            detail.steps
              .filter((s) => s.kind === "tool-call")
              .map((s) => (s.kind === "tool-call" ? s.name : ""))
              .join(", "),
          )

          const replies = botTexts(entries, bot.id)
          expect(replies.length).toBeGreaterThan(before)
          // never a chat bubble from the work itself, and no mechanics in what the owner reads
          expect(entries.some((e) => e.kind === "tool-call" && detail.steps.some((s) => s.id === e.id))).toBe(false)
          const leaks = replies.filter((r) => PLUMBING.test(r))
          log("visible replies:\n" + replies.map((r) => `  - ${r.replace(/\n/g, " ")}`).join("\n"))
          expect(leaks).toEqual([])
        }),
      ),
    1_200_000,
  )
})
