/**
 * `StreamBroker` (architecture §4.8, D1.2): one-time tickets for node-dialed data streams
 * (`/node/stream/:id`).
 *
 * A brain-side consumer (UI terminal, screencast viewers, Codex relay, node-initiated forwards) calls
 * `expect({nodeId, kind})`, passes the ticket to the node RPC that opens the stream (`pty.open`,
 * `tunnel.open`, `browser.screencast`, or the `node.openStream` answer) and awaits `socket`. The node
 * dials `/node/stream/:id` with `Authorization: Bearer <token>`; the route claims the ticket (single
 * use, 128-bit token, 30 s TTL, constant-time compare) and hands the upgraded socket to the consumer.
 *
 * The consumer owns the socket in its own fiber: BunHttpServer interrupts an upgraded route's fiber
 * when the socket closes (gotcha G2), so the route never splices; it only hands the socket over.
 *
 * The in-process local node uses `dialLocal`, which claims the same ticket and returns one end of an
 * in-memory socket pair.
 */
import type { NodeId } from "@openbot/contracts"
import { mintStreamTicket, parseStreamAuth, safeEqual, StreamRefused, type StreamTicket } from "@openbot/node-protocol"
import { makeMemorySocketPair } from "@openbot/node-protocol/testing"
import { Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Result, Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import type * as Socket from "effect/socket/Socket"
import { BrainNodesConfig } from "./config.ts"
import { closeSocket } from "./splice.ts"

export interface ExpectedStream {
  readonly ticket: StreamTicket
  readonly nodeId: NodeId
  readonly kind: string
  /**
   * The node's data socket, once it dialed. Fails with `StreamRefused` when the ticket expires
   * unused. The socket is the consumer's: open it in the consumer's scope.
   */
  readonly socket: Effect.Effect<Socket.Socket, StreamRefused>
}

export interface StreamClaim {
  readonly kind: string
  readonly nodeId: NodeId
  /** Hand the upgraded socket to the waiting consumer. Closes it when the consumer is gone. */
  readonly deliver: (socket: Socket.Socket) => Effect.Effect<void>
  /** The upgrade failed: fail the waiting consumer. */
  readonly abort: (reason: string) => Effect.Effect<void>
}

export interface StreamBrokerShape {
  /** Mint a ticket for a stream the node will dial. The ticket is revoked when the scope closes. */
  readonly expect: (input: {
    readonly nodeId: NodeId
    readonly kind: string
  }) => Effect.Effect<ExpectedStream, never, Scope.Scope>
  /** Claim a presented ticket (single use). Fails with `StreamRefused` for unknown, used, expired or bad tokens. */
  readonly claim: (streamId: string, token: string | undefined) => Effect.Effect<StreamClaim, StreamRefused>
  /** Local node: dial a ticket in-process. Returns the NODE end of an in-memory socket pair. */
  readonly dialLocal: (ticket: StreamTicket, kind: string) => Effect.Effect<Socket.Socket, StreamRefused, Scope.Scope>
  /** Number of unclaimed tickets (tests, diagnostics). */
  readonly pendingCount: Effect.Effect<number>
}

export class StreamBroker extends Context.Service<StreamBroker, StreamBrokerShape>()(
  "openbot/brain-nodes/StreamBroker",
) {}

type EntryState = "pending" | "claimed" | "delivered" | "closed"

interface Entry {
  readonly streamId: string
  readonly token: string
  readonly nodeId: NodeId
  readonly kind: string
  readonly expiresAt: number
  readonly deferred: Deferred.Deferred<Socket.Socket, StreamRefused>
  state: EntryState
  socket: Socket.Socket | undefined
}

export const makeStreamBroker = Effect.gen(function* () {
  const config = yield* BrainNodesConfig
  const ttl = config.streamTokenTtlMs
  const entries = new Map<string, Entry>()

  const refused = (kind: string, reason: string) => new StreamRefused({ kind, reason })

  const expect: StreamBrokerShape["expect"] = ({ kind, nodeId }) =>
    Effect.gen(function* () {
      const ticket = mintStreamTicket()
      const at = yield* Clock.currentTimeMillis
      const deferred = yield* Deferred.make<Socket.Socket, StreamRefused>()
      // registering the ticket and its revocation are one uninterruptible step
      const entry = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const created: Entry = {
            streamId: ticket.streamId,
            token: ticket.streamToken,
            nodeId,
            kind,
            expiresAt: at + ttl,
            deferred,
            state: "pending",
            socket: undefined,
          }
          entries.set(ticket.streamId, created)
          return created
        }),
        (revoked) =>
          Effect.suspend(() => {
            entries.delete(revoked.streamId)
            const socket = revoked.socket
            const wasOpen = revoked.state !== "closed"
            revoked.state = "closed"
            return Effect.andThen(
              Deferred.fail(deferred, refused(kind, "the stream was cancelled")),
              socket !== undefined && wasOpen ? closeSocket(socket, 1000, "stream closed") : Effect.void,
            )
          }),
      )
      // expiry: an unclaimed (or claimed but never delivered) ticket fails the consumer
      yield* Effect.forkScoped(
        Effect.sleep(ttl).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              if (entry.state === "delivered" || entry.state === "closed") return Effect.void
              entry.state = "closed"
              entries.delete(entry.streamId)
              return Deferred.fail(deferred, refused(kind, "the node did not open the stream in time"))
            }),
          ),
        ),
      )
      return { ticket, nodeId, kind, socket: Deferred.await(deferred) }
    })

  const claim: StreamBrokerShape["claim"] = (streamId, token) =>
    Effect.gen(function* () {
      const entry = entries.get(streamId)
      // a wrong token does not burn the ticket (the stream id appears in URLs; the token does not)
      if (entry === undefined || entry.state !== "pending" || token === undefined || !safeEqual(token, entry.token)) {
        return yield* refused(entry?.kind ?? "unknown", "unknown, used or expired stream")
      }
      const at = yield* Clock.currentTimeMillis
      if (at > entry.expiresAt) {
        entries.delete(streamId)
        entry.state = "closed"
        yield* Deferred.fail(entry.deferred, refused(entry.kind, "the node did not open the stream in time"))
        return yield* refused(entry.kind, "expired stream token")
      }
      entries.delete(streamId)
      entry.state = "claimed"
      return {
        kind: entry.kind,
        nodeId: entry.nodeId,
        deliver: (socket) =>
          Effect.suspend(() => {
            if (entry.state !== "claimed") return closeSocket(socket, 1001, "stream no longer wanted")
            entry.state = "delivered"
            entry.socket = socket
            return Deferred.succeed(entry.deferred, socket)
          }),
        abort: (reason) =>
          Effect.suspend(() => {
            if (entry.state !== "claimed") return Effect.void
            entry.state = "closed"
            return Deferred.fail(entry.deferred, refused(entry.kind, reason))
          }),
      } satisfies StreamClaim
    })

  const dialLocal: StreamBrokerShape["dialLocal"] = (ticket, _kind) =>
    Effect.gen(function* () {
      const claimed = yield* claim(ticket.streamId, ticket.streamToken)
      // frames are not recorded: data streams (transfers) may carry hundreds of MB
      const pair = makeMemorySocketPair({ record: false })
      yield* Effect.addFinalizer(() => Effect.sync(() => pair.drop(1000, "closed")))
      yield* claimed.deliver(pair.a)
      return pair.b
    })

  return StreamBroker.of({
    expect,
    claim,
    dialLocal,
    pendingCount: Effect.sync(() => entries.size),
  })
})

export const StreamBrokerLive: Layer.Layer<StreamBroker, never, BrainNodesConfig> = Layer.effect(
  StreamBroker,
  makeStreamBroker,
)

/**
 * `GET /node/stream/:id` (public listener). Verifies the one-time bearer, upgrades, and hands the
 * socket to the consumer that minted the ticket. Refusals answer 401 without upgrading.
 */
export const handleStreamUpgrade = (
  broker: StreamBrokerShape,
  streamId: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const token = parseStreamAuth(request.headers["authorization"])
    const claimed = yield* Effect.result(broker.claim(streamId, token))
    if (Result.isFailure(claimed)) {
      return HttpServerResponse.text("stream refused", { status: 401 })
    }
    const upgraded = yield* Effect.result(request.upgrade)
    if (Result.isFailure(upgraded)) {
      yield* claimed.success.abort("the stream upgrade failed")
      return HttpServerResponse.text("expected a WebSocket upgrade", { status: 400 })
    }
    yield* claimed.success.deliver(upgraded.success)
    return HttpServerResponse.empty()
  })

/**
 * Open a node data stream: mint a ticket, ask the node to dial it (`open(ticket)`, e.g. `pty.open`),
 * and wait for the socket. Fails when `open` fails or the node never dials; the ticket is revoked at
 * once in that case. The node RPC runs concurrently with the wait, so it does not matter whether the
 * node answers before or after dialing. On success the ticket, the socket and the RPC fiber live in
 * the caller's scope.
 */
export const openNodeStream = <A, E, R>(
  broker: StreamBrokerShape,
  input: {
    readonly nodeId: NodeId
    readonly kind: string
    readonly open: (ticket: StreamTicket) => Effect.Effect<A, E, R>
  },
): Effect.Effect<
  { readonly socket: Socket.Socket; readonly opened: Effect.Effect<A, E> },
  E | StreamRefused,
  R | Scope.Scope
> =>
  Effect.gen(function* () {
    const stream = yield* Scope.fork(yield* Effect.scope, "sequential")
    const expected = yield* broker.expect({ nodeId: input.nodeId, kind: input.kind }).pipe(Scope.provide(stream))
    const opening = yield* Effect.forkIn(input.open(expected.ticket), stream, { startImmediately: true })
    // a failed `open` wins the race; a successful one waits for the socket
    const failedOpen = Effect.flatMap(Fiber.await(opening), (exit) =>
      Exit.isFailure(exit) ? Effect.failCause(exit.cause) : Effect.never,
    )
    const socket = yield* Effect.raceFirst(expected.socket, failedOpen).pipe(
      Effect.onError(() => Scope.close(stream, Exit.void)),
    )
    return { socket, opened: Fiber.join(opening) }
  })
