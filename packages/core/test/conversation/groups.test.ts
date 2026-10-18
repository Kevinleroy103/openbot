import { describe, expect, test } from "bun:test"
import type { Bot, BotId, ConversationId } from "@openbot/contracts"
import { Effect } from "effect"
import { ConversationService, Orchestrator } from "../../src/ports/index.ts"
import { botId, conversationId, makeGroupConversation, runTest } from "../../src/testing/index.ts"
import { leadOf, routeBotMessage, routeOwnerMessage } from "../../src/services/conversation/GroupRouter.ts"
import {
  appLayer,
  createBot,
  eventsOf,
  eventually,
  messagesOf,
  replyBehavior,
  send,
  settled,
  TestDriver,
  transcript,
  turnsOf,
} from "./helpers.ts"

// ============================================================================ pure routing rules

describe("GroupRouter (pure)", () => {
  const ada = { id: botId("bot_ada"), name: "Ada" }
  const bob = { id: botId("bot_bob"), name: "Bob Smith" }
  const cy = { id: botId("bot_cy"), name: "Cy" }
  const members = [ada, bob, cy]
  const group = makeGroupConversation({
    id: conversationId("cnv_g"),
    memberBotIds: [ada.id, bob.id, cy.id],
    leadBotId: bob.id,
  })
  const route = (text: string, extra?: Partial<Parameters<typeof routeOwnerMessage>[0]>) =>
    routeOwnerMessage({ group, members, text, ...extra })

  test("mentions (text and explicit) beat reply and lead; member order is kept", () => {
    expect(route("@cy and @Bob Smith, please")).toEqual({ botIds: [bob.id, cy.id], reason: "mentions" })
    expect(route("hi", { addressedBotIds: [cy.id] })).toEqual({ botIds: [cy.id], reason: "mentions" })
    // "@Bobby" is not "@Bob Smith"; an e-mail address is not a mention.
    expect(route("ask @Bobby or mail ada@example.com")).toEqual({ botIds: [bob.id], reason: "lead" })
  })

  test("@everyone reaches every member", () => {
    expect(route("@everyone standup")).toEqual({ botIds: [ada.id, bob.id, cy.id], reason: "everyone" })
    expect(route("hi", { addressEveryone: true }).reason).toBe("everyone")
  })

  test("a reply goes to the replied-to bot; otherwise the lead (or the first member)", () => {
    const replyTo = {
      id: "ent_1",
      conversationId: group.id,
      revision: 0,
      createdAt: 0,
      updatedAt: 0,
      author: { kind: "bot" as const, botId: ada.id },
      kind: "message" as const,
      role: "bot" as const,
      text: "x",
      attachments: [],
      streaming: false,
    } as unknown as Parameters<typeof routeOwnerMessage>[0]["replyTo"]
    expect(route("thanks", { replyTo })).toEqual({ botIds: [ada.id], reason: "reply" })
    expect(route("hello")).toEqual({ botIds: [bob.id], reason: "lead" })
    const { leadBotId: _lead, ...noLead } = group
    expect(leadOf(noLead)).toBe(ada.id)
  })

  test("bot messages only reach the members they mention, never the sender", () => {
    expect(routeBotMessage({ group, members, text: "@Ada done, @Cy next", senderBotId: ada.id })).toEqual([cy.id])
    expect(routeBotMessage({ group, members, text: "@everyone done", senderBotId: ada.id })).toEqual([bob.id, cy.id])
    expect(routeBotMessage({ group, members, text: "done", senderBotId: ada.id })).toEqual([])
  })
})

// ============================================================================ through the Orchestrator

const makeTeam = Effect.gen(function*() {
  const ada = yield* createBot("Ada")
  const bob = yield* createBot("Bob")
  const cy = yield* createBot("Cy")
  const group = yield* (yield* ConversationService).createGroup({
    title: "",
    memberBotIds: [ada.id, bob.id, cy.id],
    leadBotId: bob.id,
  })
  return { ada, bob, cy, group: group.id as ConversationId }
})

const botsOfTurns = (conversation: ConversationId, ids: ReadonlyArray<string>) =>
  Effect.map(turnsOf(conversation), (turns) => turns.filter((t) => ids.includes(t.id)).map((t) => t.botId))

describe("group routing (D5.1)", () => {
  test("lead, mentions, @everyone, reply and explicit addressing pick the responders", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const team = yield* makeTeam
        const { group } = team
        const plain = yield* send(group, "hello team")
        yield* settled(group, 1)
        const mention = yield* send(group, "@Cy what do you think?")
        yield* settled(group, 2)
        const everyone = yield* send(group, "@everyone status?")
        yield* settled(group, 5)
        const adaReply = messagesOf(yield* transcript(group)).filter((m) => m.author.kind === "bot" && m.author.botId === team.ada.id).at(-1)!
        const reply = yield* send(group, "thanks!", { replyToId: adaReply.id })
        yield* settled(group, 6)
        const explicit = yield* send(group, "you two", { addressedBotIds: [team.ada.id, team.cy.id] })
        yield* settled(group, 8)
        const entries = yield* transcript(group)
        return {
          team,
          entries,
          routed: {
            plain: yield* botsOfTurns(group, plain.turnIds),
            mention: yield* botsOfTurns(group, mention.turnIds),
            everyone: yield* botsOfTurns(group, everyone.turnIds),
            reply: yield* botsOfTurns(group, reply.turnIds),
            explicit: yield* botsOfTurns(group, explicit.turnIds),
          },
          handles: yield* (yield* TestDriver).turns,
        }
      }),
      appLayer(),
    )
    const { ada, bob, cy } = out.team
    expect(out.routed.plain).toEqual([bob.id])
    expect(out.routed.mention).toEqual([cy.id])
    expect([...out.routed.everyone].sort()).toEqual([ada.id, bob.id, cy.id].sort())
    expect(out.routed.reply).toEqual([ada.id])
    expect([...out.routed.explicit].sort()).toEqual([ada.id, cy.id].sort())

    // The owner entries record whom they addressed.
    const owner = messagesOf(out.entries).filter((m) => m.role === "user")
    expect(owner.map((m) => m.addressedBotIds)).toEqual([
      undefined,
      [cy.id],
      [ada.id, bob.id, cy.id],
      undefined,
      [ada.id, cy.id],
    ])

    // Group catch-up (§4.3.2): Cy's first turn sees the earlier owner message and Bob's reply.
    const cyFirst = out.handles.find((h) => h.bot.id === cy.id)!
    expect(cyFirst.input.text).toContain("[@owner]: hello team")
    expect(cyFirst.input.text).toContain("[@Bob]: Reply from Bob")
    expect(cyFirst.input.text).toContain("[@owner]: @Cy what do you think?")
    // Bob's second turn only sees what happened since its first one, never its own replies.
    const bobTurns = out.handles.filter((h) => h.bot.id === bob.id)
    expect(bobTurns[1]!.input.text).not.toContain("hello team")
    expect(bobTurns[1]!.input.text).not.toContain("Reply from Bob")
    expect(bobTurns[1]!.input.text).toContain("[@Cy]: Reply from Cy")
    expect(bobTurns[1]!.input.text).toContain("[@owner]: @everyone status?")
  })

  test("a bot reply that mentions another member wakes it; chains stop at the hop limit", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const team = yield* makeTeam
        yield* driver.setBehavior(team.ada.id, replyBehavior(() => "@Bob ping"))
        yield* driver.setBehavior(team.bob.id, replyBehavior(() => "@Ada pong"))
        yield* send(team.group, "@Ada start a rally")
        yield* eventually(
          Effect.map(transcript(team.group), (entries) => eventsOf(entries).some((e) => e.type === "hop-limit")),
          "hop-limit event",
        )
        yield* settled(team.group, 9)
        return { team, turns: yield* turnsOf(team.group), entries: yield* transcript(team.group) }
      }),
      appLayer(),
    )
    // The owner's message starts the chain (hop 0); 8 bot hops follow; the 9th is refused.
    expect(out.turns).toHaveLength(9)
    expect(out.turns.map((t) => t.trigger)).toEqual(["user", ...Array(8).fill("bot")])
    const bots: ReadonlyArray<BotId> = out.turns.map((t) => t.botId)
    expect(bots).toEqual(Array.from({ length: 9 }, (_, i) => (i % 2 === 0 ? out.team.ada.id : out.team.bob.id)))
    expect(eventsOf(out.entries).filter((e) => e.type === "hop-limit")).toEqual([{ type: "hop-limit", hops: 8 }])
  })

  test("retry: a bot that failed on a teammate's message answers it again; nobody else wakes", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const orchestrator = yield* Orchestrator
        const driver = yield* TestDriver
        const team = yield* makeTeam
        yield* driver.setBehavior(team.ada.id, replyBehavior(() => "@Bob take the CPU side"))
        yield* driver.setBehavior(team.bob.id, (turn) => turn.crash("Codex went away"))
        yield* send(team.group, "@Ada plan it")
        yield* settled(team.group, 2)
        const failed = (yield* turnsOf(team.group)).find((t) => t.status === "failed")!
        yield* driver.setBehavior(team.bob.id, replyBehavior(() => "on it"))
        yield* orchestrator.retry({ conversationId: team.group, turnId: failed.id })
        yield* settled(team.group, 3)
        return { team, failed, turns: yield* turnsOf(team.group), handles: yield* driver.turns }
      }),
      appLayer(),
    )
    expect(out.failed.botId).toBe(out.team.bob.id)
    expect(out.turns.map((t) => [t.botId, t.status])).toEqual([
      [out.team.ada.id, "completed"],
      [out.team.bob.id, "failed"],
      [out.team.bob.id, "completed"],
    ])
    expect(out.handles.at(-1)!.input.text).toContain("[@Ada]: @Bob take the CPU side")
  })

  test("createGroup validates 2–6 members and setMembers emits member events", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const conversations = yield* ConversationService
        const team = yield* makeTeam
        const tooSmall = yield* Effect.flip(conversations.createGroup({ title: "x", memberBotIds: [team.ada.id] }))
        const dupes = yield* Effect.flip(conversations.createGroup({ title: "x", memberBotIds: [team.ada.id, team.ada.id] }))
        const created = yield* conversations.get(team.group)
        const updated = yield* conversations.setMembers({ conversationId: team.group, memberBotIds: [team.ada.id, team.cy.id] })
        return { tooSmall, dupes, created, updated, entries: yield* transcript(team.group), team }
      }),
      appLayer(),
    )
    expect(out.tooSmall._tag).toBe("InvalidInput")
    expect(out.dupes._tag).toBe("InvalidInput")
    expect(out.created.title).toBe("Ada, Bob & Cy")
    // Bob was the lead: removing him clears the lead.
    expect(out.updated.kind === "group" && out.updated.leadBotId).toBeUndefined()
    expect(eventsOf(out.entries).map((e) => e.type)).toEqual(["joined", "joined", "joined", "member-removed"])
    const removed = eventsOf(out.entries).find((e) => e.type === "member-removed") as { readonly botId: Bot["id"] }
    expect(removed.botId).toBe(out.team.bob.id)
  })
})
