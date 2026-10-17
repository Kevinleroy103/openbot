import { describe as group, expect, test } from "bun:test"
import { HarnessRegistry } from "@openbot/core"
import type { HarnessApprovalRequest, HarnessQuestionRequest } from "@openbot/contracts"
import { Deferred, Duration, Effect, Exit, Layer, Scope } from "effect"
import { FAKE_CAPABILITIES, FakeHarnessLayer, FakeHarnessLive, makeFakeDriver } from "../src/index.ts"
import {
  BOT,
  collect,
  finalMessages,
  openInput,
  recordingOnRequest,
  run,
  shape,
  toolCalls,
  turn,
} from "./helpers.ts"

const fast = () => makeFakeDriver({ chunkDelay: 0, slowChunkDelay: Duration.millis(40) })

group("driver", () => {
  test("capabilities, probe and models", async () => {
    const driver = fast()
    expect(driver.kind).toBe("fake")
    expect(driver.displayName).toBe("Fake")
    expect(driver.capabilities).toEqual({
      resume: true,
      steer: true,
      interrupt: true,
      approvals: "interactive",
      questions: true,
      compact: true,
      contextUsage: true,
      images: true,
      remotePlacements: ["brain-mcp-hands"],
    })
    const status = await Effect.runPromise(driver.probe)
    expect(status).toMatchObject({ kind: "fake", installed: true, auth: { state: "signed-in" }, problems: [] })
    expect(status.capabilities).toEqual(FAKE_CAPABILITIES)
    const models = await Effect.runPromise(driver.listModels)
    expect(models.find((m) => m.default)?.id).toBe("fake")
  })

  test("FakeHarnessLive registers the driver in the HarnessRegistry", async () => {
    const kinds = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* HarnessRegistry
        const driver = yield* registry.get("fake")
        const all = yield* registry.list
        return { kind: driver.kind, all: all.map((d) => d.kind) }
      }).pipe(Effect.provide(FakeHarnessLive.pipe(Layer.provideMerge(HarnessRegistry.layer)))),
    )
    expect(kinds).toEqual({ kind: "fake", all: ["fake"] })
    const custom = await Effect.runPromise(
      Effect.flatMap(HarnessRegistry, (r) => r.get("fake")).pipe(
        Effect.provide(FakeHarnessLayer({ displayName: "Demo" }).pipe(Layer.provideMerge(HarnessRegistry.layer))),
      ),
    )
    expect(custom.displayName).toBe("Demo")
  })
})

group("scripted turns", () => {
  test("echo: produces the full event sequence", () =>
    run(Effect.gen(function*() {
      const session = yield* fast().openSession(openInput())
      const c = yield* collect(session)
      yield* session.startTurn(turn("trn_1", "echo: hello big world"))
      const events = yield* c.turnEvents("trn_1")
      expect(c.events[0]).toEqual({ _tag: "SessionBound", nativeSessionId: "fake-bot_scout-cnv_scout-1" })
      expect(shape(events)).toEqual([
        "TurnStarted",
        "Activity",
        "Activity",
        "Message(streaming)",
        "Message(final)",
        "Usage",
        "ContextUsage",
        "TurnCompleted",
      ])
      expect(finalMessages(events)).toEqual(["hello big world"])
      const streamed = events.flatMap((e) =>
        e._tag === "ItemUpserted" && e.item._tag === "Message" && e.item.streaming ? [e.item.text] : []
      )
      expect(streamed).toEqual(["hello ", "hello big ", "hello big world"])
      // One stable key for the whole message.
      const keys = new Set(events.flatMap((e) => (e._tag === "ItemUpserted" ? [e.key] : [])))
      expect(keys.size).toBe(1)
      const completed = events.at(-1)
      expect(completed).toEqual({ _tag: "TurnCompleted", turnId: "trn_1", stopReason: "end_turn" } as never)
      const usage = events.find((e) => e._tag === "Usage")
      expect(usage?._tag === "Usage" && usage.usage.outputTokens > 0).toBe(true)
      expect(yield* session.nativeSessionId).toBe("fake-bot_scout-cnv_scout-1")
    })))

  test("default reply mentions the bot name and attachments", () =>
    run(Effect.gen(function*() {
      const session = yield* fast().openSession(openInput())
      const c = yield* collect(session)
      yield* session.startTurn(
        turn("trn_1", "how are you?", [{ path: "/tmp/a.png", mime: "image/png", name: "a.png" }]),
      )
      const [message] = finalMessages(yield* c.turnEvents("trn_1"))
      expect(message).toContain(BOT.name)
      expect(message).toContain("a.png")
      expect(message).toContain("how are you?")
      // files copied into the workspace are listed in the turn text
      yield* session.startTurn(
        turn("trn_2", "notes attached\n[Attachments: inbox/att_1/notes.txt (text/plain, 5 bytes), inbox/att_2/a.png (image/png, 3 KB)]", [
          { path: "/tmp/a.png", mime: "image/png", name: "a.png" },
        ]),
      )
      const [second] = finalMessages(yield* c.turnEvents("trn_2"))
      expect(second).toContain("I received 2 attachments: a.png, notes.txt.")
      expect(second).toContain('You said: "notes attached"')
    })))

  test("fail: produces TurnFailed and the session stays usable", () =>
    run(Effect.gen(function*() {
      const session = yield* fast().openSession(openInput())
      const c = yield* collect(session)
      yield* session.startTurn(turn("trn_1", "echo: before\nfail: kaboom\necho: never"))
      const events = yield* c.turnEvents("trn_1")
      expect(finalMessages(events)).toEqual(["before"])
      expect(events.at(-1)).toEqual({
        _tag: "TurnFailed",
        turnId: "trn_1",
        error: { code: "scripted-failure", message: "kaboom", retryable: false },
      } as never)
      yield* session.startTurn(turn("trn_2", "echo: after"))
      expect(finalMessages(yield* c.turnEvents("trn_2"))).toEqual(["after"])
    })))

  test("think: emits a reasoning item; fake-reasoning model adds one per turn", () =>
    run(Effect.gen(function*() {
      const session = yield* fast().openSession(openInput({ model: "fake-reasoning" }))
      const c = yield* collect(session)
      yield* session.startTurn(turn("trn_1", "think: pondering\necho: done"))
      const events = yield* c.turnEvents("trn_1")
      const reasoning = events.filter((e) => e._tag === "ItemUpserted" && e.item._tag === "Reasoning" && !e.item.streaming)
      expect(reasoning.length).toBe(2)
    })))

  test("crash: fails the turn, emits SessionClosed and ends the stream", () =>
    run(Effect.gen(function*() {
      const session = yield* fast().openSession(openInput())
      const c = yield* collect(session)
      yield* session.startTurn(turn("trn_1", "crash: segfault"))
      yield* c.join
      expect(c.ended()).toBe(true)
      expect(shape(c.events).slice(-4)).toEqual(["Usage", "ContextUsage", "TurnFailed", "SessionClosed"])
      const exit = yield* Effect.exit(session.startTurn(turn("trn_2", "echo: x")))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(JSON.stringify(exit)).toContain("closed")
    })))
})

group("approvals and questions", () => {
  test("approve: awaits onRequest; allow completes the simulated command", () =>
    run(Effect.gen(function*() {
      const rec = recordingOnRequest(() => ({ decision: "allow-once" }))
      const session = yield* fast().openSession(openInput({ onRequest: rec.onRequest }))
      const c = yield* collect(session)
      yield* session.startTurn(turn("trn_1", "approve: ls -la"))
      const events = yield* c.turnEvents("trn_1")
      expect(rec.requests.length).toBe(1)
      const request = rec.requests[0] as HarnessApprovalRequest
      expect(request).toMatchObject({
        kind: "command-approval",
        command: "ls -la",
        surface: "shell",
        cwd: "/tmp/openbot-fake/workspace",
      })
      const calls = toolCalls(events)
      expect(calls.map((t) => t.item.status)).toEqual(["pending", "completed"])
      expect(calls[0]?.key).toBe(request.toolKey!)
      expect(calls[1]?.item.outputPreview).toContain("(simulated)")
      expect(finalMessages(events)[0]).toContain("ls -la")
      expect(events.at(-1)?._tag).toBe("TurnCompleted")
    })))

  test("approve: blocks until onRequest resolves; deny declines", () =>
    run(Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const session = yield* fast().openSession(openInput({
        onRequest: () => Effect.as(Deferred.await(gate), { decision: "deny" as const, message: "not today" }),
      }))
      const c = yield* collect(session)
      yield* session.startTurn(turn("trn_1", "approve: rm -rf /"))
      yield* c.waitUntil((list) => list.some((e) => e._tag === "Activity" && e.label.startsWith("Waiting for approval")))
      yield* Effect.sleep("30 millis")
      expect(c.events.some((e) => e._tag === "TurnCompleted")).toBe(false)
      yield* Deferred.succeed(gate, undefined)
      const events = yield* c.turnEvents("trn_1")
      expect(toolCalls(events).map((t) => t.item.status)).toEqual(["pending", "declined"])
      expect(finalMessages(events)[0]).toContain("did not run")
      expect(finalMessages(events)[0]).toContain("not today")
    })))

  test("ask: raises a question and replies with the answer", () =>
    run(Effect.gen(function*() {
      const rec = recordingOnRequest(() => ({ answers: { q1: "blue" } }))
      const session = yield* fast().openSession(openInput({ onRequest: rec.onRequest }))
      const c = yield* collect(session)
      yield* session.startTurn(turn("trn_1", "ask: Favorite color? | red | blue"))
      const events = yield* c.turnEvents("trn_1")
      const request = rec.requests[0] as HarnessQuestionRequest
      expect(request.kind).toBe("question")
      expect(request.questions[0]).toMatchObject({
        id: "q1",
        prompt: "Favorite color?",
        options: [{ label: "red" }, { label: "blue" }],
        allowFreeText: true,
      })
      expect(toolCalls(events).map((t) => t.item.status)).toEqual(["pending", "completed"])
      expect(finalMessages(events)).toEqual(["You answered: blue"])
    })))

  test("ask: cancelled question is declined", () =>
    run(Effect.gen(function*() {
      const rec = recordingOnRequest(() => ({ decision: "cancel" }))
      const session = yield* fast().openSession(openInput({ onRequest: rec.onRequest }))
      const c = yield* collect(session)
      yield* session.startTurn(turn("trn_1", "ask: Anything?"))
      const events = yield* c.turnEvents("trn_1")
      expect(toolCalls(events).map((t) => t.item.status)).toEqual(["pending", "declined"])
    })))
})

group("interrupt, steer, compact, lifecycle", () => {
  test("interrupt during slow: emits aborted message and TurnInterrupted; next turn works", () =>
    run(Effect.gen(function*() {
      const session = yield* fast().openSession(openInput())
      const c = yield* collect(session)
      yield* session.startTurn(turn("trn_1", "slow: one two three four five six seven eight"))
      yield* c.waitUntil((list) =>
        list.some((e) => e._tag === "ItemUpserted" && e.item._tag === "Message" && e.item.text.startsWith("one two"))
      )
      yield* session.interrupt
      const events = yield* c.turnEvents("trn_1")
      expect(events.at(-1)).toEqual({ _tag: "TurnInterrupted", turnId: "trn_1" } as never)
      const aborted = events.at(-2)
      expect(aborted?._tag === "ItemUpserted" && aborted.item._tag === "Message" && aborted.item.aborted).toBe(true)
      expect(events.some((e) => e._tag === "TurnCompleted")).toBe(false)
      // interrupt with no turn running is a no-op
      yield* session.interrupt
      yield* session.startTurn(turn("trn_2", "echo: again"))
      expect(finalMessages(yield* c.turnEvents("trn_2"))).toEqual(["again"])
    })))

  test("interrupt while waiting on onRequest", () =>
    run(Effect.gen(function*() {
      const session = yield* fast().openSession(openInput({ onRequest: () => Effect.never }))
      const c = yield* collect(session)
      yield* session.startTurn(turn("trn_1", "approve: sleep 100"))
      yield* c.waitUntil((list) => list.some((e) => e._tag === "Activity" && e.label.startsWith("Waiting")))
      yield* session.interrupt
      const events = yield* c.turnEvents("trn_1")
      expect(events.at(-1)?._tag).toBe("TurnInterrupted")
    })))

  test("startTurn while busy is rejected; steer joins the running turn", () =>
    run(Effect.gen(function*() {
      const session = yield* fast().openSession(openInput())
      const c = yield* collect(session)
      const idleSteer = yield* Effect.exit(session.steer(turn("trn_x", "echo: nope")))
      expect(Exit.isFailure(idleSteer) && JSON.stringify(idleSteer).includes("turn-rejected")).toBe(true)
      yield* session.startTurn(turn("trn_1", "slow: a b c"))
      const busy = yield* Effect.exit(session.startTurn(turn("trn_2", "echo: x")))
      expect(Exit.isFailure(busy) && JSON.stringify(busy).includes("turn-rejected")).toBe(true)
      yield* session.steer(turn("trn_3", "echo: steered"))
      const events = yield* c.turnEvents("trn_1")
      expect(finalMessages(events)).toEqual(["a b c", "steered"])
      expect(c.events.filter((e) => e._tag === "TurnStarted").length).toBe(1)
    })))

  test("contextUsage grows with turns and compact shrinks it", () =>
    run(Effect.gen(function*() {
      const session = yield* fast().openSession(openInput())
      const c = yield* collect(session)
      const before = yield* session.contextUsage
      yield* session.startTurn(turn("trn_1", `echo: ${"lorem ipsum ".repeat(50)}`))
      yield* c.turnEvents("trn_1")
      const after = yield* session.contextUsage
      expect(after!.usedTokens).toBeGreaterThan(before!.usedTokens)
      expect(after!.windowTokens).toBe(200_000)
      yield* session.compact
      const compacted = yield* session.contextUsage
      expect(compacted!.usedTokens).toBeLessThan(after!.usedTokens)
      yield* c.waitUntil((list) => list.filter((e) => e._tag === "ContextUsage").length === 2)
    })))

  test("resume keeps the native session id; fresh sessions get distinct ids", () =>
    run(Effect.gen(function*() {
      const driver = fast()
      const resumed = yield* driver.openSession(openInput({ nativeSessionId: "fake-previous" }))
      expect(yield* resumed.nativeSessionId).toBe("fake-previous")
      const a = yield* driver.openSession(openInput())
      const b = yield* driver.openSession(openInput())
      const [idA, idB] = [yield* a.nativeSessionId, yield* b.nativeSessionId]
      expect(idA).not.toBe(idB)
      expect(idA?.includes(":")).toBe(false)
    })))

  test("closing the session scope interrupts the turn and ends the event stream", () =>
    run(Effect.gen(function*() {
      const scope = yield* Scope.make()
      const session = yield* fast().openSession(openInput()).pipe(Scope.provide(scope))
      const c = yield* collect(session)
      yield* session.startTurn(turn("trn_1", "slow: a b c d e f g h i j"))
      yield* c.waitUntil((list) => list.some((e) => e._tag === "ItemUpserted"))
      yield* Scope.close(scope, Exit.void)
      yield* c.join
      expect(c.ended()).toBe(true)
      expect(c.events.at(-1)?._tag).toBe("TurnInterrupted")
      const exit = yield* Effect.exit(session.startTurn(turn("trn_2", "echo: x")))
      expect(Exit.isFailure(exit)).toBe(true)
    })))
})
