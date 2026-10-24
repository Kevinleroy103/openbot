/**
 * Deploys without losing work: `Orchestrator.drain` holds new turns while running ones finish,
 * `handOff` saves what is left for the next boot, `resume` replays it there.
 */
import { describe, expect, test } from "bun:test"
import type { TurnId } from "@openbot/contracts"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { type BootRecoveryReport, CarryoverStore, Orchestrator, TurnRepo } from "../../src/ports/index.ts"
import { runTest } from "../../src/testing/index.ts"
import {
  appLayer,
  createBot,
  eventually,
  holdBehavior,
  messagesOf,
  send,
  settled,
  TestDriver,
  transcript,
  turnsOf,
} from "./helpers.ts"

const noReport: BootRecoveryReport = {
  killedProcesses: [],
  interruptedTurns: [],
  cutOffTurns: [],
  expiredRequests: [],
  updatedEntries: [],
  interruptedRuns: [],
  interruptedTasks: [],
}

describe("drain and hand-off", () => {
  test("a message sent while draining waits; the running turn finishes; the waiting one is handed off", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator
        const driver = yield* TestDriver
        const ada = yield* createBot("Ada")
        const dm = ada.directConversationId
        yield* driver.setBehavior(ada.id, holdBehavior)
        yield* send(dm, "first")
        yield* eventually(
          Effect.map(driver.turns, (t) => t.length === 1),
          "first turn running",
        )
        const draining = yield* Effect.forkChild(orchestrator.drain({ graceMs: 60_000 }))
        yield* eventually(orchestrator.draining, "draining")
        const second = yield* send(dm, "second")
        const queued = (yield* turnsOf(dm)).find((t) => t.id === second.turnIds[0])
        const startedWhileDraining = (yield* driver.turns).length
        yield* driver.release(ada.id)
        yield* TestClock.adjust("2 seconds")
        yield* Fiber.join(draining)
        return {
          second,
          queued,
          startedWhileDraining,
          turns: yield* turnsOf(dm),
          carried: yield* Effect.orDie((yield* CarryoverStore).take),
          user: messagesOf(yield* transcript(dm)).filter((m) => m.role === "user"),
        }
      }),
      appLayer(),
    )
    expect(out.startedWhileDraining).toBe(1)
    expect(out.queued?.status).toBe("queued")
    expect(out.user.find((m) => m.text === "second")?.delivery).toBe("queued")
    expect(out.turns.find((t) => t.id === out.second.turnIds[0])?.status).toBe("queued")
    expect(out.carried.cutOff).toEqual([])
    expect(out.carried.deliveries.map((d) => [d.text, d.turnId])).toEqual([["second", out.second.turnIds[0]]])
  })

  test("when the grace runs out the running turn is cut off and handed off with what waits", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator
        const driver = yield* TestDriver
        const ada = yield* createBot("Ada")
        const dm = ada.directConversationId
        yield* driver.setBehavior(ada.id, holdBehavior)
        const first = yield* send(dm, "long job")
        yield* eventually(
          Effect.map(driver.turns, (t) => t.length === 1),
          "running",
        )
        const draining = yield* Effect.forkChild(orchestrator.drain({ graceMs: 5_000 }))
        yield* eventually(orchestrator.draining, "draining")
        yield* TestClock.adjust("6 seconds")
        yield* Fiber.join(draining)
        return { first, ada, carried: yield* Effect.orDie((yield* CarryoverStore).take), turns: yield* turnsOf(dm) }
      }),
      appLayer(),
    )
    expect(out.carried.cutOff).toEqual([
      { botId: out.ada.id, conversationId: out.ada.directConversationId, turnId: out.first.turnIds[0]! },
    ])
    expect(out.turns[0]!.status).toBe("interrupted")
  })
})

describe("resume", () => {
  test("carried messages are delivered first under their turn ids, then cut-off bots continue", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator
        const driver = yield* TestDriver
        const ada = yield* createBot("Ada")
        const dm = ada.directConversationId
        yield* Effect.orDie(
          (yield* CarryoverStore).save({
            deliveries: [
              {
                id: "dlv_carried",
                conversationId: dm,
                botId: ada.id,
                kind: "user-message",
                text: "and the docs too",
                attachmentIds: [],
                causalChain: { rootId: "dlv_carried", hops: 0 },
                urgency: "urgent",
                mode: "auto",
                turnId: "trn_carried" as TurnId,
              },
            ],
            cutOff: [{ botId: ada.id, conversationId: dm, turnId: "trn_cut" as TurnId }],
          }),
        )
        yield* orchestrator.resume(noReport)
        yield* settled(dm, 2)
        return {
          handles: yield* driver.turns,
          turns: yield* turnsOf(dm),
          left: yield* Effect.orDie((yield* CarryoverStore).take),
        }
      }),
      appLayer(),
    )
    expect(out.handles.map((h) => h.turnId)[0]).toBe("trn_carried" as TurnId)
    expect(out.handles[0]!.input.text).toContain("and the docs too")
    expect(out.handles[1]!.input.text).toContain("[Your last turn here was cut off before you finished")
    expect(out.turns.find((t) => t.id === ("trn_carried" as TurnId))).toMatchObject({
      trigger: "user",
      status: "completed",
    })
    expect(out.turns.filter((t) => t.trigger === "system").map((t) => t.status)).toEqual(["completed"])
    expect(out.left).toEqual({ deliveries: [], cutOff: [] })
  })

  test("after a crash: a queued owner message is delivered again, a running turn continues", async () => {
    const out = await runTest(
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator
        const driver = yield* TestDriver
        const ada = yield* createBot("Ada")
        const dm = ada.directConversationId
        yield* send(dm, "hello")
        yield* settled(dm)
        const [done] = yield* turnsOf(dm)
        const turns = yield* TurnRepo
        // what boot recovery reports for a turn that was running and one queued behind it
        const cut = { ...done!, id: "trn_cut" as TurnId, status: "interrupted" as const, stopReason: "brain-restart" }
        const queued = {
          ...done!,
          id: "trn_queued" as TurnId,
          status: "interrupted" as const,
          stopReason: "brain-restart",
        }
        yield* Effect.orDie(turns.upsert(cut))
        yield* Effect.orDie(turns.upsert(queued))
        yield* orchestrator.resume({ ...noReport, interruptedTurns: [cut, queued], cutOffTurns: [cut] })
        yield* settled(dm, 4)
        return { handles: yield* driver.turns, turns: yield* turnsOf(dm) }
      }),
      appLayer(),
    )
    const [, again, resumed] = out.handles
    expect(again!.turnId).toBe("trn_queued" as TurnId)
    expect(again!.input.text).toContain("hello")
    expect(resumed!.input.text).toContain("[Your last turn here was cut off")
    expect(out.turns.find((t) => t.id === ("trn_queued" as TurnId))?.status).toBe("completed")
  })
})
