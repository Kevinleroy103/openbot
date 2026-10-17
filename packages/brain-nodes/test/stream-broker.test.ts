// StreamBroker: one-time data-stream tickets (D1.2). Unit tests over the service, plus the
// `/node/stream/:id` route over a real Bun WebSocket.
import { afterAll, describe, expect, test } from "bun:test"
import type { NodeId } from "@openbot/contracts"
import { formatStreamAuth, Routes, StreamRefused } from "@openbot/node-protocol"
import { makeMemorySocketPair } from "@openbot/node-protocol/testing"
import { Effect, Exit, Fiber, Layer, Scope } from "effect"
import * as Socket from "effect/socket/Socket"
import { BrainNodesConfig, open, openNodeStream, StreamBroker, StreamBrokerLive } from "../src/index.ts"
import { brainStack, dialWebSocket, run, startServer, tempDir } from "./helpers.ts"

const NODE = "nod_test" as NodeId

const brokerLayer = (ttl = 30_000) =>
  StreamBrokerLive.pipe(Layer.provide(BrainNodesConfig.layer({ brainOrigin: "https://brain.test", streamTokenTtlMs: ttl })))

const withBroker = <A, E>(effect: Effect.Effect<A, E, StreamBroker | Scope.Scope>, ttl?: number) =>
  run(Effect.provide(effect, brokerLayer(ttl)))

/** HTTP status of a `/node/stream/:id` upgrade attempt (the brain answers before upgrading on refusal). */
const streamUpgradeStatus = (httpBase: string, streamId: string, authorization: string | undefined) =>
  Effect.promise(async () => {
    const headers: Record<string, string> = {
      connection: "upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    }
    if (authorization !== undefined) headers["authorization"] = authorization
    return (await fetch(`${httpBase}${Routes.stream(streamId)}`, { headers })).status
  })

describe("StreamBroker tickets", () => {
  test("tickets are 96-bit ids with 128-bit tokens; a ticket is claimed once; wrong tokens do not burn it", () =>
    withBroker(
      Effect.gen(function*() {
        const broker = yield* StreamBroker
        const expected = yield* broker.expect({ nodeId: NODE, kind: "pty" })
        expect(expected.ticket.streamId).toMatch(/^[A-Za-z0-9_-]{16}$/)
        expect(expected.ticket.streamToken).toMatch(/^[A-Za-z0-9_-]{22}$/)
        expect(yield* broker.pendingCount).toBe(1)

        const wrong = yield* Effect.flip(broker.claim(expected.ticket.streamId, "A".repeat(22)))
        expect(wrong).toBeInstanceOf(StreamRefused)
        const missing = yield* Effect.flip(broker.claim(expected.ticket.streamId, undefined))
        expect(missing._tag).toBe("StreamRefused")
        expect(yield* broker.pendingCount).toBe(1)

        const claim = yield* broker.claim(expected.ticket.streamId, expected.ticket.streamToken)
        expect(claim).toMatchObject({ kind: "pty", nodeId: NODE })
        expect(yield* broker.pendingCount).toBe(0)
        const again = yield* Effect.flip(broker.claim(expected.ticket.streamId, expected.ticket.streamToken))
        expect(again._tag).toBe("StreamRefused")

        // delivering hands the socket to the consumer
        const pair = makeMemorySocketPair()
        yield* claim.deliver(pair.a)
        expect(yield* expected.socket).toBe(pair.a)

        const unknown = yield* Effect.flip(broker.claim("nope", expected.ticket.streamToken))
        expect(unknown.reason).toContain("unknown")
      }),
    ))

  test("an unclaimed ticket expires and fails the waiting consumer", () =>
    withBroker(
      Effect.gen(function*() {
        const broker = yield* StreamBroker
        const expected = yield* broker.expect({ nodeId: NODE, kind: "cdp-screencast" })
        const waited = yield* Effect.flip(expected.socket)
        expect(waited.reason).toContain("in time")
        expect(yield* broker.pendingCount).toBe(0)
        const late = yield* Effect.flip(broker.claim(expected.ticket.streamId, expected.ticket.streamToken))
        expect(late._tag).toBe("StreamRefused")
      }),
      50,
    ))

  test("closing the consumer's scope revokes its ticket", () =>
    withBroker(
      Effect.gen(function*() {
        const broker = yield* StreamBroker
        const scope = yield* Scope.make()
        const expected = yield* broker.expect({ nodeId: NODE, kind: "pty" }).pipe(Scope.provide(scope))
        const waiting = yield* Effect.forkChild(Effect.exit(expected.socket), { startImmediately: true })
        yield* Scope.close(scope, Exit.void)
        const exit = yield* Fiber.join(waiting)
        expect(Exit.isFailure(exit)).toBe(true)
        const claimed = yield* Effect.flip(broker.claim(expected.ticket.streamId, expected.ticket.streamToken))
        expect(claimed._tag).toBe("StreamRefused")
      }),
    ))

  test("dialLocal claims the ticket in-process and returns the node end of a socket pair", () =>
    withBroker(
      Effect.gen(function*() {
        const broker = yield* StreamBroker
        const expected = yield* broker.expect({ nodeId: NODE, kind: "pty" })
        const nodeEnd = yield* broker.dialLocal(expected.ticket, "pty")
        const brainEnd = yield* expected.socket
        const node = yield* open(nodeEnd)
        const brain = yield* open(brainEnd)
        yield* node.writer.write("hello")
        yield* node.writer.write(new Uint8Array([1, 2, 3]))
        const got: Array<string | Uint8Array> = []
        while (got.length < 2) got.push(...(yield* brain.pull))
        expect(got[0]).toBe("hello")
        expect([...(got[1] as Uint8Array)]).toEqual([1, 2, 3])
        // a second local dial of the same ticket is refused
        const again = yield* Effect.flip(broker.dialLocal(expected.ticket, "pty"))
        expect(again._tag).toBe("StreamRefused")
      }),
    ))

  test("openNodeStream fails fast when the node refuses to open the stream", () =>
    withBroker(
      Effect.gen(function*() {
        const broker = yield* StreamBroker
        const failed = yield* Effect.flip(
          openNodeStream(broker, {
            nodeId: NODE,
            kind: "pty",
            open: () => Effect.fail(new StreamRefused({ kind: "pty", reason: "no pty here" })),
          }),
        )
        expect(failed).toMatchObject({ _tag: "StreamRefused", reason: "no pty here" })
        expect(yield* broker.pendingCount).toBe(0)

        // success: the node "dials" (in-process) while the open RPC is still running
        const opened = yield* openNodeStream(broker, {
          nodeId: NODE,
          kind: "pty",
          open: (ticket) => Effect.as(broker.dialLocal(ticket, "pty"), { pid: 1 }),
        })
        expect(yield* opened.opened).toEqual({ pid: 1 })
      }),
    ))
})

const dir = tempDir()
afterAll(() => dir.cleanup())

describe("/node/stream/:id over a real WebSocket", () => {
  test("the node dials with the one-time bearer; frames pass verbatim; reuse and bad tokens get 401", () =>
    run(
      Effect.gen(function*() {
        const server = yield* startServer
        const broker = yield* StreamBroker

        const expected = yield* broker.expect({ nodeId: NODE, kind: "tcp" })
        // bad token: refused without burning the ticket
        expect(yield* streamUpgradeStatus(server.http, expected.ticket.streamId, formatStreamAuth("x".repeat(22)))).toBe(401)
        expect(yield* streamUpgradeStatus(server.http, expected.ticket.streamId, undefined)).toBe(401)

        const nodeSocket = yield* dialWebSocket(`${server.ws}${Routes.stream(expected.ticket.streamId)}`, {
          authorization: formatStreamAuth(expected.ticket.streamToken),
        })
        const node = yield* open(nodeSocket)
        const brain = yield* open(yield* expected.socket.pipe(Effect.timeout("5 seconds")))

        yield* node.writer.write("text-frame")
        yield* node.writer.write(new Uint8Array([9, 8, 7]))
        const got: Array<string | Uint8Array> = []
        while (got.length < 2) got.push(...(yield* brain.pull))
        expect(got[0]).toBe("text-frame")
        expect(got[1]).toBeInstanceOf(Uint8Array)
        expect([...(got[1] as Uint8Array)]).toEqual([9, 8, 7])

        yield* brain.writer.write("back")
        const back = yield* node.pull
        expect(back[0]).toBe("back")

        // the ticket was used: a second dial is refused
        expect(
          yield* streamUpgradeStatus(server.http, expected.ticket.streamId, formatStreamAuth(expected.ticket.streamToken)),
        ).toBe(401)

        // closing the node end closes the brain end
        yield* node.writer.write(new Socket.CloseEvent(1000, "done"))
        const ended = yield* Effect.exit(Effect.forever(brain.pull)).pipe(Effect.timeout("5 seconds"))
        expect(Exit.isFailure(ended)).toBe(true)
      }).pipe(Effect.provide(Layer.fresh(brainStack({ dataRoot: dir.path })))),
    ))
})
