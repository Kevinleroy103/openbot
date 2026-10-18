// Background tasks end to end (D5.7): the fake bot starts parallel work through the real MCP gateway
// (`bg:`), answers the owner meanwhile, and reports the result; `tasks.*` RPCs list, inspect and stop
// work; a restart fails running work and the bot is told.
import { describe, expect, test } from "bun:test"
import { applyRosterStreamItem, emptyRosterState, type RosterState, type TaskId, type TranscriptEntry, transcriptOf } from "@openbot/contracts"
import { Effect, Ref, Stream } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eventually, login, type OpenBotClient, rpcClient, startServer, watchConversation } from "./helpers.ts"

const botMessages = (entries: ReadonlyArray<TranscriptEntry>) =>
  entries.flatMap((e) => (e.kind === "message" && e.role === "bot" && !e.streaming ? [e.text] : []))

const watchRoster = (client: OpenBotClient) =>
  Effect.gen(function*() {
    const state = yield* Ref.make<RosterState>(emptyRosterState)
    yield* client["roster.subscribe"]({}).pipe(
      Stream.runForEach((item) => Ref.update(state, (s) => applyRosterStreamItem(s, item))),
      Effect.forkScoped,
    )
    return state
  })

describe("background tasks over RPC", () => {
  test("bg: work runs in parallel; the bot answers meanwhile and reports the result; tasks.cancel stops only that work", async () => {
    const server = await startServer()
    try {
      const cookie = await login(server.base, server.ownerToken)
      await server.run(Effect.gen(function*() {
        const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })
        const roster = yield* watchRoster(client)
        const bot = yield* client["bots.create"]({ name: "Scout", harness: { kind: "fake" }, clientNonce: "t-1" })
        const dm = yield* watchConversation(client, bot.directConversationId)
        const replies = Effect.map(Ref.get(dm.state), (s) => botMessages(transcriptOf(s)))

        yield* client["messages.send"]({ conversationId: bot.directConversationId, text: "bg: 2 HN digest", clientNonce: "t-2" })
        yield* eventually(replies, (r) => r.includes("Sure — I'll get back to you about HN digest."), { label: "immediate reply" })
        const running = yield* eventually(Ref.get(roster), (s) => [...s.tasks.values()].some((t) => t.title === "HN digest" && t.status === "running"), {
          label: "roster: running",
        })
        const task = [...running.tasks.values()].find((t) => t.title === "HN digest")!
        expect(task.conversationId).toBe(bot.directConversationId)

        // the owner talks to the bot while the work runs: an immediate answer
        yield* client["messages.send"]({ conversationId: bot.directConversationId, text: "echo: still here", clientNonce: "t-3" })
        yield* eventually(replies, (r) => r.includes("still here"), { label: "answer meanwhile", timeout: 1_500 })
        expect((yield* client["tasks.get"]({ taskId: task.id })).task.status).toBe("running")

        // the result is reported by the bot in its DM; the work's steps are not chat bubbles
        const done = yield* eventually(replies, (r) => r.some((t) => t.startsWith("Update on HN digest:")), { label: "report", timeout: 15_000 })
        expect(done.find((t) => t.startsWith("Update on HN digest:"))).toBe("Update on HN digest: Here is HN digest: everything checked out after 2s of work.")
        const detail = yield* client["tasks.get"]({ taskId: task.id })
        expect(detail.task).toMatchObject({ status: "succeeded", result: "Here is HN digest: everything checked out after 2s of work.", stepCount: 1 })
        expect(detail.steps.some((s) => s.kind === "tool-call" && s.name === "fake_work")).toBe(true)
        const dmEntries = transcriptOf(yield* Ref.get(dm.state))
        expect(dmEntries.some((e) => e.kind === "tool-call" && e.name === "fake_work")).toBe(false)
        expect((yield* client["tasks.list"]({ botId: bot.id })).map((t) => [t.title, t.status])).toEqual([["HN digest", "succeeded"]])

        // the owner stops one piece of work; another keeps running
        yield* client["messages.send"]({ conversationId: bot.directConversationId, text: "bg: 30 slow one", clientNonce: "t-4" })
        yield* client["messages.send"]({ conversationId: bot.directConversationId, text: "bg: 30 other one", clientNonce: "t-5" })
        const both = yield* eventually(client["tasks.list"]({ botId: bot.id }), (ts) => ts.filter((t) => t.status === "running").length === 2, {
          label: "two running",
        })
        const slow = both.find((t) => t.title === "slow one")!
        const stopped = yield* client["tasks.cancel"]({ taskId: slow.id })
        expect(stopped).toMatchObject({ status: "cancelled", stoppedBy: "owner" })
        expect((yield* client["tasks.get"]({ taskId: both.find((t) => t.title === "other one")!.id })).task.status).toBe("running")
        yield* eventually(replies, (r) => r.some((t) => t.startsWith("Update on slow one: The owner stopped it")), { label: "stop reported" })

        const missing = yield* Effect.flip(client["tasks.get"]({ taskId: "tsk_nope" as TaskId }))
        expect(missing._tag).toBe("NotFound")
        const noBot = yield* Effect.flip(client["tasks.list"]({ botId: "bot_nope" as never }))
        expect(noBot._tag).toBe("NotFound")
      }))
    } finally {
      await server.close()
    }
  }, 60_000)

  test("restart: running work runs again under its id, in its own resumed session, and the bot gets the result", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openbot-tasks-boot-"))
    try {
      const first = await startServer({ dataDir })
      const cookie = await login(first.base, first.ownerToken)
      const { botId, conversationId } = await first.run(Effect.gen(function*() {
        const client = yield* rpcClient(`${first.wsBase}/rpc`, { cookie, origin: first.base })
        const bot = yield* client["bots.create"]({ name: "Nightly", harness: { kind: "fake" }, clientNonce: "r-1" })
        yield* client["messages.send"]({ conversationId: bot.directConversationId, text: "bg: 60 audit", clientNonce: "r-2" })
        yield* eventually(client["tasks.list"]({ botId: bot.id }), (ts) => ts.some((t) => t.status === "running"), { label: "running" })
        return { botId: bot.id, conversationId: bot.directConversationId }
      }))
      await first.close({ keepData: true })

      const second = await startServer({ dataDir })
      try {
        await second.run(Effect.gen(function*() {
          const client = yield* rpcClient(`${second.wsBase}/rpc`, { cookie, origin: second.base })
          const done = yield* eventually(client["tasks.list"]({ botId }), (ts) => ts[0]?.status === "succeeded", { label: "ran again" })
          expect(done).toHaveLength(1)
          expect(done[0]).toMatchObject({ title: "audit", status: "succeeded", restarts: 1 })
          expect(done[0]!.nativeSessionId).toBeString()
          const dm = yield* watchConversation(client, conversationId)
          yield* eventually(Effect.map(Ref.get(dm.state), (s) => botMessages(transcriptOf(s))), (r) =>
            r.some((t) => t.startsWith("Update on audit:")), { label: "told" })
        }))
      } finally {
        await second.close({ keepData: true })
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 60_000)
})
