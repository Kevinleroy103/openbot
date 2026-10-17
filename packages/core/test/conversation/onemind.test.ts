/**
 * One mind per bot (docs/decisions.md D5.0): one native session and one runner per bot, shared by
 * all of its conversations; every turn belongs to one conversation.
 */
import { describe, expect, test } from "bun:test"
import type { ConversationId, KnownRosterStreamItem } from "@openbot/contracts"
import { Deferred, Effect, Option } from "effect"
import {
  ApprovalService,
  BotRepo,
  ConversationService,
  EntryRepo,
  LiveHub,
  Messaging,
  Orchestrator,
  RequestRepo,
  TurnRepo,
} from "../../src/ports/index.ts"
import { runTest } from "../../src/testing/index.ts"
import {
  appLayer,
  collect,
  createBot,
  eventually,
  eventsOf,
  messagesOf,
  send,
  settled,
  TestDriver,
  transcript,
  turnsOf,
  type TurnHandle,
} from "./helpers.ts"

/** A behavior that waits on a per-turn gate (keyed by the turn's first input line) before replying. */
const gated = (gates: Map<string, Deferred.Deferred<void>>, reply: (turn: TurnHandle) => string) => (turn: TurnHandle) =>
  Effect.gen(function*() {
    const key = [...gates.keys()].find((k) => turn.input.text.includes(k))
    if (key !== undefined) yield* Deferred.await(gates.get(key)!)
    yield* turn.say(`${turn.turnId}/m`, reply(turn))
    yield* turn.complete("end_turn")
  })

const statuses = (conversationId: ConversationId) => Effect.map(turnsOf(conversationId), (ts) => ts.map((t) => t.status))

describe("one mind per bot", () => {
  test("a DM turn after a group turn runs in the SAME native session, with origin tags; the bot remembers", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const group = yield* (yield* ConversationService).createGroup({ title: "secret project", memberBotIds: [ada.id, bob.id], leadBotId: ada.id })
        yield* send(group.id, "please rename the repo to tick")
        yield* settled(group.id)
        yield* send(ada.directConversationId, "what did you just do in the group?")
        yield* settled(ada.directConversationId)
        yield* send(ada.directConversationId, "and now?")
        yield* settled(ada.directConversationId, 2)
        return {
          ada,
          group,
          opened: yield* driver.opened,
          handles: yield* driver.turns,
          session: yield* Effect.orDie((yield* BotRepo).getSession(ada.id)),
          groupEntries: yield* transcript(group.id),
          dmEntries: yield* transcript(ada.directConversationId),
        }
      }),
      appLayer(),
    )
    // One session for Ada: opened once, keyed on her DM (home), resumed by every conversation.
    expect(out.opened).toHaveLength(1)
    expect(out.opened[0]!.conversationId).toBe(out.ada.directConversationId)
    expect(new Set(out.handles.map((h) => h.sessionNumber))).toEqual(new Set([1]))
    expect(out.handles.map((h) => h.conversationId)).toEqual([out.group.id, out.ada.directConversationId, out.ada.directConversationId])
    // Origin tags: the group header; the DM tagged when it follows the group turn, untagged after.
    expect(out.handles[0]!.input.text).toStartWith('[Group chat "secret project" · members: @Ada (you), @Bob')
    expect(out.handles[1]!.input.text).toBe("[DM with the owner]\nwhat did you just do in the group?")
    expect(out.handles[2]!.input.text).toBe("and now?")
    // Replies landed in the turn's conversation.
    expect(messagesOf(out.groupEntries).filter((m) => m.role === "bot").map((m) => m.text)).toEqual(["Reply from Ada"])
    expect(messagesOf(out.dmEntries).filter((m) => m.role === "bot")).toHaveLength(2)
    // The session record is per bot and knows its last conversation.
    const session = Option.getOrThrow(out.session)
    expect(session.nativeSessionId).toBe("native-1")
    expect(session.lastConversationId).toBe(out.ada.directConversationId)
    expect(session.seen?.[out.group.id]).toBeDefined()
  })

  test("a delivery for conversation B while busy in A queues (never steers), runs after, and replies in B", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const hub = yield* LiveHub
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const group = yield* (yield* ConversationService).createGroup({ title: "secret project", memberBotIds: [ada.id, bob.id], leadBotId: ada.id })
        const gate = yield* Deferred.make<void>()
        yield* driver.setBehavior(ada.id, gated(new Map([["long group task", gate]]), (t) => `done: ${t.conversationId}`))
        const roster = yield* collect(hub.subscribeRoster({}))
        yield* send(group.id, "long group task")
        yield* eventually(Effect.map(statuses(group.id), (s) => s[0] === "running"), "group turn running")
        const queued = yield* send(ada.directConversationId, "quick question")
        const dmUser = messagesOf(yield* transcript(ada.directConversationId)).find((m) => m.role === "user")!
        const busyActivity = (yield* hub.activities).find((a) => a.botId === ada.id)
        const dmWhileBusy = yield* statuses(ada.directConversationId)
        yield* Deferred.succeed(gate, undefined)
        yield* settled(group.id)
        yield* settled(ada.directConversationId)
        return {
          ada,
          group,
          queued,
          dmUser,
          busyActivity,
          dmWhileBusy,
          handles: yield* driver.turns,
          steers: yield* driver.steers,
          dmEntries: yield* transcript(ada.directConversationId),
          groupEntries: yield* transcript(group.id),
          activities: (yield* roster.items).flatMap((i: KnownRosterStreamItem) =>
            i.kind === "change" && i.change.type === "activity.updated" && i.change.activity.botId === ada.id ? [i.change.activity] : []
          ),
        }
      }),
      appLayer({ capabilities: { steer: true } }),
    )
    expect(out.queued.disposition).toBe("queued")
    expect(out.dmUser.delivery).toBe("queued") // while waiting behind the group turn
    expect(messagesOf(out.dmEntries).find((m) => m.role === "user")?.delivery).toBe("delivered")
    expect(out.dmWhileBusy).toEqual(["queued"])
    expect(out.steers).toHaveLength(0)
    // While busy in the group, Ada's activity names the group (other chats show "busy elsewhere").
    expect(out.busyActivity?.conversationId).toBe(out.group.id)
    expect(out.busyActivity?.state).not.toBe("idle")
    expect(out.handles.map((h) => h.conversationId)).toEqual([out.group.id, out.ada.directConversationId])
    expect(messagesOf(out.dmEntries).filter((m) => m.role === "bot").map((m) => m.text)).toEqual([`done: ${out.ada.directConversationId}`])
    expect(messagesOf(out.groupEntries).filter((m) => m.role === "bot").map((m) => m.text)).toEqual([`done: ${out.group.id}`])
    expect(out.activities.some((a) => a.conversationId === out.ada.directConversationId && a.state === "thinking")).toBe(true)
  })

  test("the owner's queued message is marked queued while the bot works elsewhere", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const group = yield* (yield* ConversationService).createGroup({ title: "g", memberBotIds: [ada.id, bob.id], leadBotId: ada.id })
        const gate = yield* Deferred.make<void>()
        yield* driver.setBehavior(ada.id, gated(new Map([["long", gate]]), () => "ok"))
        yield* send(group.id, "long")
        yield* eventually(Effect.map(statuses(group.id), (s) => s[0] === "running"), "running")
        yield* send(ada.directConversationId, "hi")
        const whileQueued = messagesOf(yield* transcript(ada.directConversationId)).find((m) => m.role === "user")!.delivery
        yield* Deferred.succeed(gate, undefined)
        yield* settled(ada.directConversationId)
        return { whileQueued }
      }),
      appLayer(),
    )
    expect(out.whileQueued).toBe("queued")
  })

  test("steering only into a running turn of the same conversation; bot messages never interrupt", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const messaging = yield* Messaging
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const gate = yield* Deferred.make<void>()
        yield* driver.setBehavior(ada.id, gated(new Map([["first", gate]]), () => "ok"))
        // Bob messages Ada (urgent) while she works in her DM: folded into her turn, not interrupting.
        yield* driver.setBehavior(bob.id, (turn) =>
          Effect.gen(function*() {
            yield* messaging.messageBot({ ...turn.tool, callId: "b1" }, { to: "Ada", text: "ping", urgency: "urgent" })
            yield* turn.say(`${turn.turnId}/m`, "sent")
            yield* turn.complete()
          }).pipe(Effect.orDie))
        yield* send(ada.directConversationId, "first")
        yield* eventually(Effect.map(statuses(ada.directConversationId), (s) => s[0] === "running"), "running")
        const steered = yield* send(ada.directConversationId, "also this")
        yield* send(bob.directConversationId, "go")
        yield* settled(bob.directConversationId)
        yield* Deferred.succeed(gate, undefined)
        yield* settled(ada.directConversationId)
        return { ada, steered, steers: yield* driver.steers, adaTurns: yield* turnsOf(ada.directConversationId) }
      }),
      appLayer({ capabilities: { steer: true } }),
    )
    expect(out.steered.disposition).toBe("steered")
    expect(out.steers.map((s) => s.input.text.split("\n\n(Sent while")[0])).toEqual(["also this", "[Direct message from @Bob]: ping"])
    expect(out.steers[0]!.input.text).toContain("start_task")
    expect(out.steers[1]!.input.text).not.toContain("start_task")
    expect(out.adaTurns.map((t) => t.status)).toEqual(["completed"])
  })

  test("interrupt is scoped to the conversation: Stop in B cancels B's queued turn, A keeps running", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const orchestrator = yield* Orchestrator
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const group = yield* (yield* ConversationService).createGroup({ title: "g", memberBotIds: [ada.id, bob.id], leadBotId: ada.id })
        const gate = yield* Deferred.make<void>()
        yield* driver.setBehavior(ada.id, gated(new Map([["work", gate]]), () => "worked"))
        yield* send(group.id, "work")
        yield* eventually(Effect.map(statuses(group.id), (s) => s[0] === "running"), "running")
        yield* send(ada.directConversationId, "dm question")
        const stoppedInDm = yield* orchestrator.interrupt({ conversationId: ada.directConversationId })
        const groupAfterDmStop = yield* statuses(group.id)
        yield* Deferred.succeed(gate, undefined)
        yield* settled(group.id)
        // Stop in the group while running there interrupts that turn.
        const gate2 = yield* Deferred.make<void>()
        yield* driver.setBehavior(ada.id, gated(new Map([["again", gate2]]), () => "never"))
        yield* send(group.id, "again")
        yield* eventually(Effect.map(statuses(group.id), (s) => s[1] === "running"), "second running")
        const stoppedInGroup = yield* orchestrator.interrupt({ conversationId: group.id })
        yield* settled(group.id, 2)
        return {
          stoppedInDm,
          groupAfterDmStop,
          stoppedInGroup,
          dmTurns: yield* statuses(ada.directConversationId),
          groupTurns: yield* statuses(group.id),
          handles: yield* driver.turns,
        }
      }),
      appLayer(),
    )
    expect(out.stoppedInDm.map((t) => t.status)).toEqual(["interrupted"])
    expect(out.groupAfterDmStop).toEqual(["running"])
    expect(out.dmTurns).toEqual(["interrupted"])
    expect(out.groupTurns).toEqual(["completed", "interrupted"])
    expect(out.stoppedInGroup).toHaveLength(1)
    expect(out.handles).toHaveLength(2) // the cancelled DM turn never reached the harness
  })

  test("approval cards and tool events of a group turn land in the group; gateway-style calls see the group", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const approvals = yield* ApprovalService
        const requests = yield* RequestRepo
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const group = yield* (yield* ConversationService).createGroup({ title: "g", memberBotIds: [ada.id, bob.id], leadBotId: ada.id })
        // A DM turn first, so the group turn reuses a session opened for the DM.
        yield* send(ada.directConversationId, "hello")
        yield* settled(ada.directConversationId)
        yield* driver.setBehavior(ada.id, (turn) =>
          Effect.gen(function*() {
            yield* turn.emit({
              _tag: "ItemUpserted",
              turnId: turn.turnId,
              key: `${turn.turnId}/tool`,
              item: { _tag: "ToolCall", toolName: "Bash", title: "ls", kind: "shell", status: "completed", inputSummary: "ls" },
            })
            const resolution = yield* turn.request({ kind: "command-approval", toolName: "Bash", title: "Run rm", detail: "rm x", command: "rm x" })
            yield* turn.say(`${turn.turnId}/m`, "decision" in resolution ? resolution.decision : "?")
            yield* turn.complete()
          }))
        yield* send(group.id, "clean up")
        yield* eventually(Effect.map(Effect.orDie(requests.list({ statuses: ["pending"] })), (r) => r.length === 1), "pending")
        const pending = yield* Effect.orDie(requests.list({ statuses: ["pending"] }))
        yield* approvals.respond({ requestId: pending[0]!.id, response: { type: "decision", decision: "allow-once" } })
        yield* settled(group.id)
        return {
          group,
          pending,
          handles: yield* driver.turns,
          groupEntries: yield* transcript(group.id),
          dmEntries: yield* transcript(ada.directConversationId),
        }
      }),
      appLayer({ approvals: "live", capabilities: {} }),
    )
    expect(out.pending[0]!.conversationId).toBe(out.group.id)
    expect(out.groupEntries.some((e) => e.kind === "card")).toBe(true)
    expect(out.groupEntries.some((e) => e.kind === "tool-call")).toBe(true)
    expect(out.dmEntries.some((e) => e.kind === "card" || e.kind === "tool-call")).toBe(false)
    expect(out.handles[1]!.tool.claims.conversationId).toBe(out.group.id)
  })

  test("group catch-up: only unseen messages, each once (steered and commentary messages are not repeated)", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const ada = yield* createBot("Lead")
        const sol = yield* createBot("Sol")
        const group = yield* (yield* ConversationService).createGroup({ title: "eng", memberBotIds: [ada.id, sol.id], leadBotId: ada.id })
        const leadGate = yield* Deferred.make<void>()
        // Lead works for a while; Sol posts commentary + a final (both mentioning Lead) meanwhile.
        yield* driver.setBehavior(ada.id, (turn) =>
          Effect.gen(function*() {
            if (turn.input.text.includes("plan the release")) yield* Deferred.await(leadGate)
            yield* turn.say(`${turn.turnId}/m`, "noted")
            yield* turn.complete()
          }))
        yield* driver.setBehavior(sol.id, (turn) =>
          Effect.gen(function*() {
            yield* turn.emit({
              _tag: "ItemUpserted",
              turnId: turn.turnId,
              key: `${turn.turnId}/c`,
              item: { _tag: "Message", role: "bot", text: "@Lead I'll create an isolated checkout", streaming: false, phase: "commentary" },
            })
            yield* turn.emit({
              _tag: "ItemUpserted",
              turnId: turn.turnId,
              key: `${turn.turnId}/f`,
              item: { _tag: "Message", role: "bot", text: "@Lead merged into main", streaming: false, phase: "final" },
            })
            yield* turn.complete()
          }))
        yield* send(group.id, "@Lead plan the release")
        yield* eventually(Effect.map(statuses(group.id), (s) => s[0] === "running"), "lead running")
        yield* send(group.id, "@Sol ship it")
        yield* eventually(Effect.map(turnsOf(group.id), (ts) => ts.some((t) => t.botId === sol.id && t.status === "completed")), "sol done")
        yield* Deferred.succeed(leadGate, undefined)
        yield* settled(group.id, 2)
        // Another owner message: the Lead's catch-up must not repeat anything it already read.
        yield* send(group.id, "@Lead status?")
        yield* settled(group.id, 3)
        return { ada, handles: yield* driver.turns, steers: yield* driver.steers }
      }),
      appLayer({ capabilities: { steer: true } }),
    )
    const leadInputs = out.handles.filter((h) => h.bot.id === out.ada.id).map((h) => h.input.text)
    const all = [...leadInputs, ...out.steers.filter((s) => s.botId === out.ada.id).map((s) => s.input.text)].join("\n")
    const count = (needle: string) => all.split(needle).length - 1
    expect(count("I'll create an isolated checkout")).toBe(1)
    expect(count("merged into main")).toBe(1)
    expect(count("[@owner]: @Sol ship it")).toBe(1)
    expect(count("@Lead plan the release")).toBe(1)
    expect(leadInputs.at(-1)).toContain("[@owner]: @Lead status?")
    // Sol's reply reached the busy Lead once, folded into its running turn (the final, not the commentary)
    expect(out.steers.filter((s) => s.botId === out.ada.id).map((s) => s.input.text)).toEqual(["[@Sol]: @Lead merged into main"])
    expect(leadInputs).toHaveLength(2)
  })

  test("group catch-up without steering: a busy recipient's next turns read each message once", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const lead = yield* createBot("Lead")
        const sol = yield* createBot("Sol")
        const group = yield* (yield* ConversationService).createGroup({ title: "eng", memberBotIds: [lead.id, sol.id], leadBotId: lead.id })
        const leadGate = yield* Deferred.make<void>()
        yield* driver.setBehavior(lead.id, (turn) =>
          Effect.gen(function*() {
            if (turn.input.text.includes("plan the release")) yield* Deferred.await(leadGate)
            yield* turn.say(`${turn.turnId}/m`, "noted")
            yield* turn.complete()
          }))
        yield* driver.setBehavior(sol.id, (turn) =>
          Effect.gen(function*() {
            yield* turn.emit({
              _tag: "ItemUpserted",
              turnId: turn.turnId,
              key: `${turn.turnId}/c`,
              item: { _tag: "Message", role: "bot", text: "@Lead I'll create an isolated checkout", streaming: false, phase: "commentary" },
            })
            yield* turn.say(`${turn.turnId}/f`, "@Lead merged into main")
            yield* turn.complete()
          }))
        yield* send(group.id, "@Lead plan the release")
        yield* eventually(Effect.map(statuses(group.id), (s) => s[0] === "running"), "lead running")
        yield* send(group.id, "@Sol ship it")
        yield* eventually(Effect.map(turnsOf(group.id), (ts) => ts.some((t) => t.botId === sol.id && t.status === "completed")), "sol done")
        yield* Deferred.succeed(leadGate, undefined)
        yield* settled(group.id, 3)
        yield* send(group.id, "@Lead status?")
        yield* settled(group.id, 4)
        return { lead, handles: yield* driver.turns }
      }),
      appLayer(),
    )
    const leadInputs = out.handles.filter((h) => h.bot.id === out.lead.id).map((h) => h.input.text)
    expect(leadInputs).toHaveLength(3) // its task, Sol's (single) wake, the owner's question
    const all = leadInputs.join("\n")
    const count = (needle: string) => all.split(needle).length - 1
    expect(count("I'll create an isolated checkout")).toBe(1)
    expect(count("merged into main")).toBe(1)
    expect(count("@Sol ship it")).toBe(1)
    expect(leadInputs[2]).not.toContain("merged into main")
  })

  test("a delivery steered into a turn that then ends early (not the owner's Stop) runs again; the next turn is told", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const lead = yield* createBot("Lead")
        const opus = yield* createBot("Opus")
        const group = yield* (yield* ConversationService).createGroup({ title: "eng", memberBotIds: [lead.id, opus.id], leadBotId: lead.id })
        const gate = yield* Deferred.make<void>()
        yield* driver.setBehavior(lead.id, (turn) =>
          Effect.gen(function*() {
            if (turn.input.text.includes("final report")) {
              yield* Deferred.await(gate)
              // The harness cuts the turn off (e.g. a preempting CLI) after the steer arrived.
              return yield* turn.fail("aborted", "the harness aborted the turn", true)
            }
            yield* turn.say(`${turn.turnId}/m`, "Report: all merged.")
            yield* turn.complete()
          }))
        yield* driver.setBehavior(opus.id, (turn) =>
          Effect.gen(function*() {
            yield* turn.say(`${turn.turnId}/m`, "@Lead I checked main at 12ce616")
            yield* turn.complete()
          }))
        yield* send(group.id, "@Lead write the final report")
        yield* eventually(Effect.map(statuses(group.id), (s) => s[0] === "running"), "lead running")
        yield* send(group.id, "@Opus check main")
        yield* eventually(Effect.map(driver.steers, (s) => s.length === 1), "steered into the lead's turn")
        yield* Deferred.succeed(gate, undefined)
        yield* settled(group.id, 3)
        return { lead, handles: yield* driver.turns, entries: yield* transcript(group.id), turns: yield* turnsOf(group.id) }
      }),
      appLayer({ capabilities: { steer: true } }),
    )
    const leadInputs = out.handles.filter((h) => h.bot.id === out.lead.id).map((h) => h.input.text)
    expect(leadInputs).toHaveLength(2) // the cut-off turn, then the re-run of Opus's message
    expect(leadInputs[1]).toContain("[Note: your previous turn in the group \"eng\" ended early")
    expect(leadInputs[1]).toContain("[@Opus]: @Lead I checked main at 12ce616")
    expect(messagesOf(out.entries).at(-1)?.text).toBe("Report: all merged.")
  })

  test("NO_REPLY: the reply is not posted and wakes nobody", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const group = yield* (yield* ConversationService).createGroup({ title: "g", memberBotIds: [ada.id, bob.id], leadBotId: ada.id })
        yield* driver.setBehavior(ada.id, (turn) =>
          Effect.gen(function*() {
            yield* turn.say(`${turn.turnId}/m`, "`NO_REPLY`")
            yield* turn.complete()
          }))
        yield* send(group.id, "thanks @Ada @Bob")
        yield* settled(group.id, 2)
        return { ada, bob, entries: yield* transcript(group.id), handles: yield* driver.turns, turns: yield* turnsOf(group.id) }
      }),
      appLayer(),
    )
    expect(messagesOf(out.entries).filter((m) => m.author.kind === "bot" && m.author.botId === out.ada.id)).toHaveLength(0)
    expect(out.turns.every((t) => t.status === "completed")).toBe(true)
    expect(out.handles).toHaveLength(2) // Ada and Bob each once; nobody re-woken
  })

  test("react: the bot reacts to the triggering message instead of answering (idempotent), then NO_REPLY posts nothing", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const messaging = yield* Messaging
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const group = yield* (yield* ConversationService).createGroup({ title: "g", memberBotIds: [ada.id, bob.id], leadBotId: ada.id })
        const results: Array<unknown> = []
        yield* driver.setBehavior(ada.id, (turn) =>
          Effect.gen(function*() {
            results.push(yield* messaging.react({ ...turn.tool, callId: "r1" }, { emoji: "👍" }))
            results.push(yield* messaging.react({ ...turn.tool, callId: "r2" }, { emoji: "👍" }))
            results.push(yield* Effect.flip(messaging.react({ ...turn.tool, callId: "r3" }, { emoji: "ok" })))
            yield* turn.say(`${turn.turnId}/m`, "NO_REPLY")
            yield* turn.complete()
          }).pipe(Effect.orDie))
        yield* send(group.id, "thanks, all done")
        yield* settled(group.id)
        return { ada, results, entries: yield* transcript(group.id) }
      }),
      appLayer(),
    )
    const owner = messagesOf(out.entries).find((m) => m.role === "user")!
    expect(owner.reactions).toEqual([{ emoji: "👍", by: { kind: "bot", botId: out.ada.id } }])
    expect(out.results[0]).toMatchObject({ entryId: owner.id, emoji: "👍" })
    expect((out.results[2] as { _tag: string })._tag).toBe("InvalidInput")
    expect(messagesOf(out.entries).filter((m) => m.role === "bot")).toHaveLength(0)
  })

  test("deleting a group: cancels the members' work there, removes its records, keeps the bots", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const orchestrator = yield* Orchestrator
        const hub = yield* LiveHub
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const group = yield* (yield* ConversationService).createGroup({ title: "doomed", memberBotIds: [ada.id, bob.id], leadBotId: ada.id })
        const gate = yield* Deferred.make<void>()
        yield* driver.setBehavior(ada.id, gated(new Map([["forever", gate]]), () => "never"))
        const roster = yield* collect(hub.subscribeRoster({}))
        yield* send(group.id, "forever")
        yield* eventually(Effect.map(statuses(group.id), (s) => s[0] === "running"), "running")
        const refused = yield* Effect.flip(orchestrator.deleteConversation(ada.directConversationId))
        yield* orchestrator.deleteConversation(group.id)
        const missing = yield* Effect.flip((yield* ConversationService).get(group.id))
        // The bots still work.
        yield* driver.setBehavior(ada.id, gated(new Map(), () => "still here"))
        yield* send(ada.directConversationId, "hi")
        yield* settled(ada.directConversationId)
        return {
          refused,
          missing,
          entries: yield* Effect.orDie((yield* EntryRepo).page({ conversationId: group.id, limit: 100 })),
          turns: yield* Effect.orDie((yield* TurnRepo).listByConversation(group.id, 100)),
          bots: yield* Effect.orDie((yield* BotRepo).list),
          dm: yield* transcript(ada.directConversationId),
          removed: (yield* roster.items).some((i: KnownRosterStreamItem) =>
            i.kind === "change" && i.change.type === "conversation.removed" && i.change.conversationId === group.id
          ),
          group,
        }
      }),
      appLayer(),
    )
    expect(out.refused._tag).toBe("InvalidInput")
    expect(out.missing._tag).toBe("NotFound")
    expect(out.entries.entries).toHaveLength(0)
    expect(out.turns).toHaveLength(0)
    expect(out.bots.map((b) => b.name)).toEqual(["Ada", "Bob"])
    expect(out.removed).toBe(true)
    expect(messagesOf(out.dm).at(-1)?.text).toBe("still here")
  })

  test("New session and Compact are per bot: Conflict while the bot works in any conversation", async () => {
    const out = await runTest(
      Effect.gen(function*() {
        const driver = yield* TestDriver
        const orchestrator = yield* Orchestrator
        const ada = yield* createBot("Ada")
        const bob = yield* createBot("Bob")
        const group = yield* (yield* ConversationService).createGroup({ title: "g", memberBotIds: [ada.id, bob.id], leadBotId: ada.id })
        const gate = yield* Deferred.make<void>()
        yield* driver.setBehavior(ada.id, gated(new Map([["busy", gate]]), () => "ok"))
        yield* send(group.id, "busy")
        yield* eventually(Effect.map(statuses(group.id), (s) => s[0] === "running"), "running")
        const conflict = yield* Effect.flip(orchestrator.newSession({ botId: ada.id }))
        yield* Deferred.succeed(gate, undefined)
        yield* settled(group.id)
        yield* orchestrator.newSession({ botId: ada.id })
        const afterReset = yield* Effect.orDie((yield* BotRepo).getSession(ada.id))
        yield* send(group.id, "again")
        yield* settled(group.id, 2)
        return {
          conflict,
          afterReset,
          opened: yield* driver.opened,
          handles: yield* driver.turns,
          dm: yield* transcript(ada.directConversationId),
        }
      }),
      appLayer(),
    )
    expect(out.conflict._tag).toBe("Conflict")
    expect(Option.isNone(out.afterReset)).toBe(true)
    expect(out.opened.map((o) => o.nativeSessionId)).toEqual([undefined, undefined])
    // The new session saw nothing: its first group turn gets the group's history again.
    expect(out.handles[1]!.input.text).toContain("[@owner]: busy")
    expect(eventsOf(out.dm).some((e) => e.type === "session-changed" && e.action === "new-session")).toBe(true)
  })
})

