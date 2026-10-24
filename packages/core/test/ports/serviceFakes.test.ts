import { describe, expect, test } from "bun:test"
import type { KnownConversationEvent } from "@openbot/contracts"
import { Effect, Exit, Fiber, Layer, Stream } from "effect"
import {
  ApprovalService,
  ConversationRepo,
  ConversationService,
  LiveHub,
  MemoryService,
  MemoryStore,
  Orchestrator,
  SettingsService,
  UsageService,
  userActor,
} from "../../src/ports/index.ts"
import {
  ApprovalServiceFake,
  botId,
  capUtf8,
  ConversationServiceFake,
  conversationId,
  CoreServiceFakes,
  LiveHubFake,
  makeBot,
  makeClaims,
  makeDirectConversation,
  OrchestratorFake,
  runTest,
  TestPorts,
  turnId,
  UsageServiceFake,
} from "../../src/testing/index.ts"

const layer = () => CoreServiceFakes().pipe(Layer.provideMerge(TestPorts()))
const bot = makeBot({ id: botId("bot_a") })
const dm = makeDirectConversation({ id: conversationId("cnv_a"), botId: bot.id })

describe("ConversationServiceFake + LiveHubFake", () => {
  test("appendEvent persists and publishes; updateEntry bumps the revision; subscribers see live changes", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        yield* (yield* ConversationRepo).upsert(dm)
        const conversations = yield* ConversationService
        const hub = yield* LiveHub
        const items = yield* Stream.runCollect(
          Stream.take(hub.subscribeConversation({ conversationId: dm.id }), 3),
        ).pipe(Effect.forkChild({ startImmediately: true }))
        const event: KnownConversationEvent = { type: "skill-saved", name: "triage" }
        const entry = yield* conversations.appendEvent({ conversationId: dm.id, event })
        const updated = yield* conversations.updateEntry(entry.id, (e) => e)
        const missing = yield* Effect.exit(
          conversations.appendEvent({ conversationId: conversationId("cnv_x"), event }),
        )
        const changes = yield* (yield* LiveHubFake).conversationChanges(dm.id)
        const written = yield* (yield* ConversationServiceFake).written
        return { entry, updated, missing, changes, written, items: yield* Fiber.join(items) }
      }),
      layer(),
    )
    expect(out.entry.revision).toBe(0)
    expect(out.updated.revision).toBe(1)
    expect(Exit.isFailure(out.missing)).toBe(true)
    expect(out.changes.map((c) => c.type)).toEqual(["entry.upserted", "entry.upserted"])
    expect(out.written.map((e) => e.revision)).toEqual([0, 1])
    expect(out.items.map((i) => (i.kind === "change" ? `change@${i.cursor.sequence}` : i.kind))).toEqual([
      "synchronized",
      "change@1",
      "change@2",
    ])
  })

  test("setActivity publishes activity.updated on the roster", async () => {
    const changes = await runTest(
      Effect.gen(function* () {
        yield* (yield* LiveHub).setActivity({ botId: bot.id, state: "thinking", since: 0 })
        return yield* (yield* LiveHubFake).rosterChanges
      }),
      layer(),
    )
    expect(changes.map((c) => c.type)).toEqual(["activity.updated"])
  })
})

describe("OrchestratorFake", () => {
  test("deliver records with defaults; awaitDelivery resolves on complete", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator
        const control = yield* OrchestratorFake
        const receipt = yield* orchestrator.deliver({
          conversationId: dm.id,
          botId: bot.id,
          kind: "routine",
          text: "Daily brief",
          urgency: "background",
        })
        const waiter = yield* orchestrator
          .awaitDelivery(receipt.deliveryId)
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* control.complete(receipt.deliveryId, { status: "completed", lastBotMessage: "Done" })
        const outcome = yield* Fiber.join(waiter)
        const unknown = yield* Effect.exit(orchestrator.awaitDelivery("dlv_x"))
        return { receipt, outcome, deliveries: yield* control.deliveries, unknown }
      }),
      layer(),
    )
    expect(out.receipt.disposition).toBe("started")
    expect(out.outcome).toEqual({ deliveryId: out.receipt.deliveryId, status: "completed", lastBotMessage: "Done" })
    expect(out.deliveries[0]?.mode).toBe("auto")
    expect(out.deliveries[0]?.causalChain).toEqual({ rootId: out.receipt.deliveryId, hops: 0 })
    expect(Exit.isFailure(out.unknown)).toBe(true)
  })
})

describe("ApprovalServiceFake", () => {
  test("default policy allows and answers first options; tool requests are pending; answers stream", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const approvals = yield* ApprovalService
        const control = yield* ApprovalServiceFake
        const ctx = { bot, conversationId: dm.id, harness: "fake" }
        const allow = yield* approvals.evaluate(ctx, {
          kind: "command-approval",
          toolName: "Bash",
          title: "Run",
          detail: "ls",
        })
        const answers = yield* approvals.evaluate(ctx, {
          kind: "question",
          questions: [
            {
              id: "q1",
              prompt: "Pick",
              options: [{ label: "A" }, { label: "B" }],
              multiSelect: false,
              allowFreeText: false,
            },
          ],
        })
        const receipt = yield* approvals.askUser({ claims: makeClaims({ botId: bot.id }) }, { questions: [] })
        const next = yield* Stream.runHead(approvals.asyncAnswers).pipe(Effect.forkChild({ startImmediately: true }))
        yield* control.answer({
          conversationId: dm.id,
          botId: bot.id,
          kind: "user-message",
          text: "B",
          urgency: "urgent",
        })
        return { allow, answers, receipt, next: yield* Fiber.join(next), tools: yield* control.toolRequests }
      }),
      layer(),
    )
    expect(out.allow).toEqual({ decision: "allow-once" })
    expect(out.answers).toEqual({ answers: { q1: "A" } })
    expect(out.receipt.status).toBe("pending")
    expect(out.tools.map((t) => t.tool)).toEqual(["ask_user"])
    expect(out.next._tag).toBe("Some")
  })
})

describe("Settings / Usage / Memory fakes", () => {
  test("settings update + rules; usage aggregation; memory prompt index cap", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const settings = yield* SettingsService
        const updated = yield* settings.update({ botMessaging: false })
        const rule = yield* settings.upsertRule({ surface: "shell", match: { commandPrefix: "git" }, action: "allow" })
        const deleted = yield* Effect.exit(settings.deleteRule(rule.id))
        const missing = yield* Effect.exit(settings.deleteRule(rule.id))

        const usage = yield* UsageService
        yield* usage.record({
          botId: bot.id,
          conversationId: dm.id,
          turnId: turnId("trn_1"),
          harness: "fake",
          usage: { inputTokens: 3, outputTokens: 1 },
        })
        yield* usage.record({
          botId: bot.id,
          conversationId: dm.id,
          turnId: turnId("trn_1"),
          harness: "fake",
          usage: { inputTokens: 2, outputTokens: 1 },
        })
        const byBot = yield* usage.byBot({})

        yield* (yield* MemoryStore).writeIndex(bot.id, "x".repeat(5000))
        const memory = yield* MemoryService
        const fact = yield* memory.putFact(userActor, bot.id, { title: "Likes tea", body: "Earl Grey" })
        const recalled = yield* memory.recall(bot.id, "earl")
        const prompt = yield* memory.promptIndex(bot.id)
        return {
          updated,
          deleted,
          missing,
          byBot,
          recorded: yield* (yield* UsageServiceFake).recorded,
          fact,
          recalled,
          promptLength: prompt.length,
        }
      }),
      layer(),
    )
    expect(out.updated.botMessaging).toBe(false)
    expect(Exit.isSuccess(out.deleted)).toBe(true)
    expect(Exit.isFailure(out.missing)).toBe(true)
    expect(out.byBot).toEqual([{ botId: bot.id, usage: { inputTokens: 5, outputTokens: 2 }, turnCount: 1, lastAt: 0 }])
    expect(out.recorded.length).toBe(2)
    expect(out.fact.id as string).toBe("likes-tea")
    expect(out.recalled.map((f): string => f.id)).toEqual(["likes-tea"])
    expect(out.promptLength).toBe(4096)
    expect(capUtf8("héllo", 2)).toBe("h")
  })
})
