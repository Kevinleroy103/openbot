import { describe, expect, test } from "bun:test"
import { type Cause, Deferred, Effect, Exit, Fiber, Queue, Sink, Stream } from "effect"
import { CodexRequestTimeout, CodexRpcError, CodexTransportClosed } from "../src/errors.ts"
import { type IncomingNotification, type IncomingRequest, makeCodexPeer, NoReply, type RequestReply } from "../src/protocol.ts"
import { run, waitUntil } from "./support.ts"

const encoder = new TextEncoder()

/** An in-memory transport: `push` feeds the peer, `written` collects what it sent. */
const memoryTransport = Effect.gen(function*() {
  const incoming = yield* Queue.unbounded<Uint8Array, Cause.Done>()
  const written: Array<Record<string, unknown>> = []
  const rawLines: Array<string> = []
  return {
    transport: {
      incoming: Stream.fromQueue(incoming),
      outgoing: Sink.forEach((line: string) =>
        Effect.sync(() => {
          rawLines.push(line)
          written.push(JSON.parse(line) as Record<string, unknown>)
        })
      ),
      terminationReason: Effect.succeed("exited with code 3"),
    },
    push: (text: string) => Queue.offerUnsafe(incoming, encoder.encode(text)),
    send: (message: unknown) => Queue.offerUnsafe(incoming, encoder.encode(`${JSON.stringify(message)}\n`)),
    end: () => Queue.endUnsafe(incoming),
    written,
    rawLines,
  }
})

const noRequests = () => Effect.succeed(Effect.succeed<RequestReply>({ error: { code: -32601, message: "none" } }))

describe("Codex JSON-RPC peer", () => {
  test("requests get responses by id; no jsonrpc field on the wire", async () => {
    const result = await run(Effect.gen(function*() {
      const mem = yield* memoryTransport
      const peer = yield* makeCodexPeer({ transport: mem.transport, onNotification: () => Effect.void, onRequest: noRequests })
      const first = yield* Effect.forkChild(peer.request("initialize", { clientInfo: { name: "t" } }), { startImmediately: true })
      const second = yield* Effect.forkChild(peer.request("model/list"), { startImmediately: true })
      yield* waitUntil(() => mem.written.length === 2)
      // Answer out of order.
      mem.send({ id: 2, result: { data: [] } })
      mem.send({ id: 1, result: { userAgent: "x/1.0.0" } })
      const a = yield* Fiber.await(first)
      const b = yield* Fiber.await(second)
      return { a, b, written: mem.written, raw: mem.rawLines }
    }))
    expect(Exit.isSuccess(result.a) && result.a.value).toEqual({ userAgent: "x/1.0.0" })
    expect(Exit.isSuccess(result.b) && result.b.value).toEqual({ data: [] })
    expect(result.written).toEqual([
      { id: 1, method: "initialize", params: { clientInfo: { name: "t" } } },
      { id: 2, method: "model/list" },
    ])
    expect(result.raw.every((line) => line.endsWith("\n") && !line.includes("jsonrpc"))).toBe(true)
  })

  test("error responses fail with CodexRpcError", async () => {
    const exit = await run(Effect.gen(function*() {
      const mem = yield* memoryTransport
      const peer = yield* makeCodexPeer({ transport: mem.transport, onNotification: () => Effect.void, onRequest: noRequests })
      const fiber = yield* Effect.forkChild(peer.request("initialize"), { startImmediately: true })
      yield* waitUntil(() => mem.written.length === 1)
      mem.send({ id: 1, error: { code: -32600, message: "Already initialized", data: { x: 1 } } })
      return yield* Fiber.await(fiber)
    }))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = exit.cause.reasons.find((r) => r._tag === "Fail")
      expect(error && "error" in error ? error.error : undefined).toEqual(
        new CodexRpcError({ method: "initialize", code: -32600, message: "Already initialized", data: { x: 1 } }),
      )
    }
  })

  test("notifications arrive in wire order, split across chunks and with junk lines", async () => {
    const seen = await run(Effect.gen(function*() {
      const mem = yield* memoryTransport
      const received: Array<IncomingNotification> = []
      yield* makeCodexPeer({
        transport: mem.transport,
        onNotification: (n) => Effect.sync(() => void received.push(n)),
        onRequest: noRequests,
      })
      mem.push(`{"method":"a","params":{"n":1}}\n{"method":"b",`)
      mem.push(`"params":{"n":2}}\nnot json at all\n\n[1,2]\n{"weird":true}\n`)
      mem.push(`{"method":"c"}\n`)
      yield* waitUntil(() => received.length === 3)
      return received
    }))
    expect(seen).toEqual([
      { method: "a", params: { n: 1 } },
      { method: "b", params: { n: 2 } },
      { method: "c", params: undefined },
    ])
  })

  test("server requests are routed by method, even when their ids collide with ours", async () => {
    const result = await run(Effect.gen(function*() {
      const mem = yield* memoryTransport
      const requests: Array<IncomingRequest> = []
      const peer = yield* makeCodexPeer({
        transport: mem.transport,
        onNotification: () => Effect.void,
        onRequest: (request) =>
          Effect.sync(() => {
            requests.push(request)
            return Effect.succeed<RequestReply>({ result: { decision: "accept" } })
          }),
      })
      const pending = yield* Effect.forkChild(peer.request("turn/start", { threadId: "t" }), { startImmediately: true })
      yield* waitUntil(() => mem.written.length === 1)
      // The server's own request id 1 arrives before the response to OUR id 1.
      mem.send({ id: 1, method: "item/commandExecution/requestApproval", params: { threadId: "t" } })
      yield* waitUntil(() => mem.written.length === 2)
      mem.send({ id: 1, result: { turn: { id: "turn-1" } } })
      const response = yield* Fiber.await(pending)
      return { requests, written: mem.written, response }
    }))
    expect(result.requests).toEqual([{ id: 1, method: "item/commandExecution/requestApproval", params: { threadId: "t" } }])
    expect(result.written[1]).toEqual({ id: 1, result: { decision: "accept" } })
    expect(Exit.isSuccess(result.response) && result.response.value).toEqual({ turn: { id: "turn-1" } })
  })

  test("a slow server request does not block notifications; NoReply sends nothing", async () => {
    const result = await run(Effect.gen(function*() {
      const mem = yield* memoryTransport
      const gate = yield* Deferred.make<RequestReply>()
      const seen: Array<string> = []
      yield* makeCodexPeer({
        transport: mem.transport,
        onNotification: (n) => Effect.sync(() => void seen.push(n.method)),
        onRequest: (request) =>
          Effect.succeed(request.method === "slow" ? Deferred.await(gate) : Effect.succeed<RequestReply>(NoReply)),
      })
      mem.send({ id: 7, method: "slow", params: {} })
      mem.send({ id: 8, method: "withdrawn", params: {} })
      mem.send({ method: "after" })
      yield* waitUntil(() => seen.includes("after"))
      const before = mem.written.length
      yield* Deferred.succeed(gate, { result: { ok: true } })
      yield* waitUntil(() => mem.written.length === 1)
      return { before, written: mem.written }
    }))
    expect(result.before).toBe(0)
    expect(result.written).toEqual([{ id: 7, result: { ok: true } }])
  })

  test("too many concurrent server requests are answered with overloaded", async () => {
    const written = await run(Effect.gen(function*() {
      const mem = yield* memoryTransport
      yield* makeCodexPeer({
        transport: mem.transport,
        onNotification: () => Effect.void,
        maxConcurrentRequests: 1,
        onRequest: () => Effect.succeed(Effect.never),
      })
      mem.send({ id: 1, method: "a", params: {} })
      mem.send({ id: 2, method: "b", params: {} })
      yield* waitUntil(() => mem.written.length === 1)
      return mem.written
    }))
    expect(written).toEqual([{ id: 2, error: { code: -32001, message: "Too many Codex requests are already pending." } }])
  })

  test("the end of the output fails pending requests and later ones", async () => {
    const result = await run(Effect.gen(function*() {
      const mem = yield* memoryTransport
      const reasons: Array<string> = []
      const peer = yield* makeCodexPeer({
        transport: mem.transport,
        onNotification: () => Effect.void,
        onRequest: noRequests,
        onTermination: (reason) => Effect.sync(() => void reasons.push(reason)),
      })
      const pending = yield* Effect.forkChild(peer.request("turn/start"), { startImmediately: true })
      yield* waitUntil(() => mem.written.length === 1)
      mem.end()
      const exit = yield* Fiber.await(pending)
      const terminated = yield* peer.terminated
      const later = yield* Effect.exit(peer.request("model/list"))
      const notify = yield* Effect.exit(peer.notify("initialized"))
      return { exit, terminated, later, notify, reasons }
    }))
    const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
      Exit.isFailure(exit) ? exit.cause.reasons.find((r) => r._tag === "Fail") : undefined
    const first = failureOf(result.exit)
    expect(first && "error" in first ? first.error : undefined).toEqual(new CodexTransportClosed({ reason: "exited with code 3" }))
    expect(result.terminated).toBe("exited with code 3")
    expect(result.reasons).toEqual(["exited with code 3"])
    expect(Exit.isFailure(result.later)).toBe(true)
    expect(Exit.isFailure(result.notify)).toBe(true)
  })

  test("requests time out with CodexRequestTimeout and the late response is ignored", async () => {
    const result = await run(Effect.gen(function*() {
      const mem = yield* memoryTransport
      const peer = yield* makeCodexPeer({ transport: mem.transport, onNotification: () => Effect.void, onRequest: noRequests })
      const exit = yield* Effect.exit(peer.request("slow", {}, { timeout: "30 millis" }))
      mem.send({ id: 1, result: {} })
      const next = yield* Effect.forkChild(peer.request("next"), { startImmediately: true })
      yield* waitUntil(() => mem.written.length === 2)
      mem.send({ id: 2, result: { ok: 1 } })
      return { exit, next: yield* Fiber.await(next) }
    }))
    const failure = Exit.isFailure(result.exit) ? result.exit.cause.reasons.find((r) => r._tag === "Fail") : undefined
    expect(failure && "error" in failure ? failure.error : undefined).toEqual(new CodexRequestTimeout({ method: "slow", timeoutMs: 30 }))
    expect(Exit.isSuccess(result.next) && result.next.value).toEqual({ ok: 1 })
  })

  test("closing the scope terminates the peer", async () => {
    let terminated: string | undefined
    await run(Effect.gen(function*() {
      const mem = yield* memoryTransport
      yield* makeCodexPeer({
        transport: mem.transport,
        onNotification: () => Effect.void,
        onRequest: noRequests,
        onTermination: (reason) => Effect.sync(() => void (terminated = reason)),
      })
    }))
    expect(terminated).toBe("connection scope closed")
  })
})
