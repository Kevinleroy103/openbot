// A ui card end to end through the real brain: a fake Bot calls show_ui over the MCP gateway, the
// owner answers with cards.act over `/rpc`, and the Bot's next turn reads the answer.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { AlreadyAnswered, type ConversationState, isTerminalTurnStatus, transcriptOf } from "@openbot/contracts"
import { Effect, Ref } from "effect"
import { eventually, login, rpcClient, startServer, type TestServer, watchConversation } from "./helpers.ts"

let server: TestServer
let cookie: string

beforeAll(async () => {
  server = await startServer()
  cookie = await login(server.base, server.ownerToken)
}, 30_000)

afterAll(async () => {
  await server?.close()
}, 30_000)

const card = {
  title: "Choose a meeting time",
  blocks: [
    {
      choice: {
        id: "slot",
        label: "Slot",
        mode: "one",
        options: [
          { id: "s1", label: "10:00–10:30" },
          { id: "s2", label: "14:00–14:30" },
        ],
      },
    },
  ],
  actions: [{ id: "send", label: "Send choice" }],
  fallback: "Choose a meeting time: 10:00 or 14:00.",
}

test("show_ui posts a pending card; cards.act answers it once and the Bot reads the answer", async () => {
  const out = await server.run(
    Effect.gen(function* () {
      const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })
      const bot = yield* client["bots.create"]({
        name: "Nova",
        harness: { kind: "fake" },
        clientNonce: "cards-1",
        introduce: false,
      })
      const convo = yield* watchConversation(client, bot.directConversationId)
      yield* eventually(Ref.get(convo.state), (s) => s.synchronized, { label: "synchronized" })
      const idle = (s: ConversationState) => [...s.turns.values()].every((t) => isTerminalTurnStatus(t.status))
      yield* client["messages.send"]({
        conversationId: bot.directConversationId,
        text: `tool: show_ui ${JSON.stringify(card)}`,
        clientNonce: "cards-send-1",
      })
      const asked = yield* eventually(
        Ref.get(convo.state),
        (s) => idle(s) && transcriptOf(s).some((e) => e.kind === "card"),
        { label: "ui card" },
      )
      const posted = transcriptOf(asked).find((e) => e.kind === "card")!
      yield* client["cards.act"]({ entryId: posted.id, actionId: "send", values: { slot: ["s2"] } })
      const twice = yield* Effect.flip(client["cards.act"]({ entryId: posted.id, actionId: "send", values: {} }))
      const answered = yield* eventually(Ref.get(convo.state), (s) => s.turns.size === 2 && idle(s), {
        label: "the Bot's turn on the answer",
      })
      return { posted, twice, entries: transcriptOf(answered) }
    }),
  )
  expect(out.posted).toMatchObject({ kind: "card", card: { type: "ui", version: 1 }, state: { status: "pending" } })
  expect(out.twice).toBeInstanceOf(AlreadyAnswered)
  expect(out.entries.find((e) => e.id === out.posted.id)).toMatchObject({
    state: { status: "resolved", answer: { actionId: "send", values: { slot: ["s2"] } } },
  })
  const replies = out.entries.flatMap((e) => (e.kind === "message" && e.role === "bot" ? [e.text] : []))
  expect(replies.at(-1)).toContain(
    'The user chose "Send choice" on your card "Choose a meeting time".\nSlot: 14:00–14:30',
  )
}, 30_000)
