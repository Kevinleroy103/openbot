// The dev mock's `ui-*` scenarios (dev/mock/uiCards.ts): each posts a card the RPC can encode, cards.act
// answers a card once, and ui-progress updates one entry in place.
import { expect, test } from "bun:test"
import { Schema } from "effect"
import { AlreadyAnswered, type KnownTranscriptEntry, TranscriptEntry, type TurnId } from "@openbot/contracts"
import { MockBrain } from "../dev/mock/brain.ts"
import { UI_SCENARIOS } from "../dev/mock/uiCards.ts"

const brain = new MockBrain()
brain.speed = 0.01
const conversationId = brain.createBot({ name: "Scout", harness: { kind: "fake" } }).directConversationId
let nonce = 0

const turnEntries = async (turnId: TurnId) => {
  while (brain.conv(conversationId).state.turns.get(turnId)?.status !== "completed") await Bun.sleep(5)
  return brain.conv(conversationId).entries.filter((e) => e.turnId === turnId)
}

const send = (text: string) => {
  const { turnIds } = brain.send({ conversationId, text, clientNonce: `n${++nonce}` })
  return turnEntries(turnIds[0]!)
}

const uiCard = (entries: KnownTranscriptEntry[]) => {
  const cards = entries.filter((e) => e.kind === "card" && e.card.type === "ui")
  expect(cards).toHaveLength(1)
  return cards[0] as Extract<KnownTranscriptEntry, { kind: "card" }>
}

test.each(Object.keys(UI_SCENARIOS))("%s posts a card the RPC can encode", async (name) => {
  const scenario = UI_SCENARIOS[name]!
  const entry = uiCard(await send(`show me ${name} please`))
  expect(entry.card).toEqual(scenario.updates?.at(-1) ?? scenario.card)
  expect(entry.state.status).toBe(scenario.card.actions ? "pending" : "info")
  expect(() => Schema.encodeUnknownSync(TranscriptEntry)(entry)).not.toThrow()
})

test("cards.act answers ui-choice once and the Bot replies with the values", async () => {
  const entry = uiCard(await send("ui-choice"))
  brain.actCard(entry.id, "send", { slot: ["1330"], title: "Design sync" })
  expect(brain.conv(conversationId).state.entries.get(entry.id)).toMatchObject({
    state: { status: "resolved", answer: { actionId: "send", values: { slot: ["1330"], title: "Design sync" } } },
  })
  const reply = await turnEntries(brain.conv(conversationId).turns.at(-1)!.id)
  expect(reply.at(-1)).toMatchObject({ text: 'Got "Send choice": slot = 13:30 – 14:00; title = Design sync.' })
  expect(() => brain.actCard(entry.id, "send", {})).toThrow(AlreadyAnswered)
})

test("ui-progress replaces the same entry until every step is done", async () => {
  const entries = await send("ui-progress")
  expect(uiCard(entries).revision).toBe(4)
  expect(entries.at(-1)).toMatchObject({ kind: "message", text: "Rolled out to everyone. No errors so far." })
})
