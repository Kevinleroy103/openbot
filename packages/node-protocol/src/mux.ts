// Bidirectional Effect RPC on ONE socket (direction mux). Ported from vendor/scratch/hands-e2e/mux.ts.
//
// Effect 4.0.4 sockets can be read only once (gotcha G1): acquiring `socket.reader` dials the WebSocket
// (client side) or claims the upgraded connection (server side). So an RpcServer and an RpcClient cannot
// share a socket directly. The mux acquires the physical reader ONCE and splits JSON-RPC frames by
// DIRECTION into two virtual sockets, like LSP peers do:
//   frames with a `method` (requests, @effect/rpc/{Ping,Interrupt,Ack,Eof})  -> our RpcServer
//   frames without `method` (result / error / chunk) and @effect/rpc/Pong     -> our RpcClient
// Both virtual sockets share the physical writer. Ids never clash in meaning, because a response is always
// routed to the side that issued the request.
//
// `stamp` (brain side) overwrites `x-openbot-*` request headers with the authenticated node identity, the
// same trick RpcServer uses for WebSocket upgrade headers (effect src/rpc/RpcServer.ts:1659-1660).
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Scope from "effect/Scope"
import type { Headers } from "effect/http/Headers"
import { type Rpc, RpcClient, type RpcClientError, type RpcGroup, RpcSerialization, RpcServer } from "effect/rpc"
import * as Socket from "effect/socket/Socket"
import * as SocketServer from "effect/socket/SocketServer"
import * as NetAddress from "effect/net/NetAddress"
import { ProtocolHeaders } from "./version.ts"

type Frame = string | Uint8Array
type NonEmpty<A> = readonly [A, ...Array<A>]

export interface MuxStats {
  /** messages routed to our RpcServer */
  toServer: number
  /** messages routed to our RpcClient */
  toClient: number
  /** requests stamped with brain-side headers */
  stamped: number
  /** `x-openbot-*` headers the peer tried to send (dropped) */
  strippedSpoof: number
  /** frames that were not JSON (forwarded to the server, which answers with a defect) */
  malformed: number
}

export interface MuxOptions {
  /** Brain side: headers to stamp onto every incoming request (e.g. `[["x-openbot-node-id", id]]`). */
  readonly stamp?: ReadonlyArray<readonly [string, string]> | undefined
  /**
   * Half-open detection: when no frame at all arrives for this many ms, the connection is treated as
   * dead: `closed` completes with a 1006 "liveness timeout" close and a close frame is attempted.
   * Effect's RpcClient only fails calls on a ping timeout and never closes the socket, so without
   * this a silently dropped peer stays "connected" forever. Absent or 0 disables.
   */
  readonly livenessTimeout?: number | undefined
}

export interface Mux {
  /** Milliseconds since the last frame arrived from the peer (liveness diagnostics). */
  readonly idleMs: Effect.Effect<number>
  /** Virtual socket for `RpcServer` (requests and control messages from the peer). */
  readonly server: Socket.Socket
  /** Virtual socket for `RpcClient` (responses, chunks and pongs from the peer). */
  readonly client: Socket.Socket
  /** Completes with the close reason once the physical socket is closed or failed. */
  readonly closed: Effect.Effect<Socket.SocketError>
  readonly stats: MuxStats
  /** Close the physical connection with a WebSocket close code. */
  readonly close: (code?: number, reason?: string) => Effect.Effect<void>
}

const decoder = new TextDecoder()

const closeError = (code: number, closeReason?: string) =>
  new Socket.SocketError({ reason: new Socket.SocketCloseError({ code, closeReason }) })

/** Normalize any physical failure into a SocketCloseError so RpcServer/RpcClient shut down cleanly. */
const toCloseError = (err: Socket.SocketError): Socket.SocketError =>
  err.reason._tag === "SocketCloseError" ? err : closeError(1006, err.reason.message)

const makeInbox = () => {
  let buf: Array<Frame> = []
  let err: Socket.SocketError | undefined
  let waiter: ((e: Effect.Effect<NonEmpty<Frame>, Socket.SocketError>) => void) | undefined
  const take = () => {
    const b = buf
    buf = []
    return b as unknown as NonEmpty<Frame>
  }
  return {
    get error() {
      return err
    },
    push(f: Frame) {
      if (err) return
      buf.push(f)
      if (waiter) {
        const w = waiter
        waiter = undefined
        w(Effect.succeed(take()))
      }
    },
    fail(e: Socket.SocketError) {
      if (!err) err = e
      if (waiter) {
        const w = waiter
        waiter = undefined
        w(buf.length ? Effect.succeed(take()) : Effect.fail(err))
      }
    },
    /** Wake a pull suspended under a reader acquisition whose scope is closing (Socket contract). */
    cancel(e: Socket.SocketError) {
      if (waiter) {
        const w = waiter
        waiter = undefined
        w(Effect.fail(e))
      }
    },
    pull: Effect.callback<NonEmpty<Frame>, Socket.SocketError>((resume) => {
      if (buf.length) return resume(Effect.succeed(take()))
      if (err) return resume(Effect.fail(err))
      waiter = resume
      return Effect.sync(() => {
        if (waiter === resume) waiter = undefined
      })
    }),
  }
}
type Inbox = ReturnType<typeof makeInbox>

const isObject = (m: unknown): m is Record<string, unknown> => typeof m === "object" && m !== null && !Array.isArray(m)
/** Frames with `method` go to our server, except `@effect/rpc/Pong` (answer to our client's Ping). */
export const isServerBound = (m: unknown): boolean =>
  isObject(m) && typeof m.method === "string" && m.method !== "@effect/rpc/Pong"
const isRequest = (m: unknown): m is Record<string, unknown> =>
  isObject(m) && typeof m.method === "string" && !m.method.startsWith("@effect/rpc/")

/**
 * Split one physical socket into a server-bound and a client-bound virtual socket.
 * Acquires the physical reader immediately (dials on the client side); closing the scope closes it.
 */
export const mux = (
  physical: Socket.Socket,
  options?: MuxOptions,
): Effect.Effect<Mux, Socket.SocketError, Scope.Scope> =>
  Effect.gen(function* () {
    const { pull } = yield* physical.reader
    const writer = yield* physical.writer
    const toServer = makeInbox()
    const toClient = makeInbox()
    const stats: MuxStats = { toServer: 0, toClient: 0, stamped: 0, strippedSpoof: 0, malformed: 0 }
    const closed = yield* Deferred.make<Socket.SocketError>()
    const stamp = options?.stamp
    const reserved = ProtocolHeaders.reservedPrefix

    const stampRequest = (m: Record<string, unknown>) => {
      const own = Array.isArray(m.headers) ? (m.headers as Array<unknown>) : []
      const kept: Array<[string, string]> = []
      for (const h of own) {
        if (!Array.isArray(h) || typeof h[0] !== "string" || typeof h[1] !== "string") continue
        if (h[0].toLowerCase().startsWith(reserved)) stats.strippedSpoof++
        else kept.push([h[0], h[1]])
      }
      m.headers = [...stamp!.map(([k, v]) => [k, v] as [string, string]), ...kept]
      stats.stamped++
      return m
    }

    const route = (frame: Frame) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(typeof frame === "string" ? frame : decoder.decode(frame))
      } catch {
        stats.malformed++
        toServer.push(frame) // the RpcServer answers with a defect
        return
      }
      if (Array.isArray(parsed)) {
        // JSON-RPC batch (foreign peers): split by direction
        const s = parsed.filter(isServerBound)
        const c = parsed.filter((m) => !isServerBound(m))
        if (s.length) {
          stats.toServer += s.length
          toServer.push(JSON.stringify(stamp ? s.map((m) => (isRequest(m) ? stampRequest(m) : m)) : s))
        }
        if (c.length) {
          stats.toClient += c.length
          toClient.push(JSON.stringify(c))
        }
        return
      }
      if (isServerBound(parsed)) {
        stats.toServer++
        toServer.push(stamp && isRequest(parsed) ? JSON.stringify(stampRequest(parsed)) : frame)
      } else {
        stats.toClient++
        toClient.push(frame)
      }
    }

    // every frame from the peer (requests, pings, pongs, results) is a sign of life
    let lastFrameAt = yield* Clock.currentTimeMillis
    yield* Effect.gen(function* () {
      while (true) {
        const frames = yield* pull
        lastFrameAt = yield* Clock.currentTimeMillis
        for (const f of frames) route(f)
      }
    }).pipe(
      Effect.catchCause((cause) => {
        const found = Cause.findError(cause)
        const err = Result.isSuccess(found) ? toCloseError(found.success) : closeError(1006)
        toServer.fail(err)
        toClient.fail(err)
        return Deferred.succeed(closed, err)
      }),
      Effect.onInterrupt(() =>
        Effect.suspend(() => {
          const err = closeError(1000, "mux closed")
          toServer.fail(err)
          toClient.fail(err)
          return Deferred.succeed(closed, err)
        }),
      ),
      Effect.forkScoped,
    )

    // liveness watchdog (half-open connections)
    const livenessMs = options?.livenessTimeout ?? 0
    if (livenessMs > 0) {
      yield* Effect.gen(function* () {
        const interval = Math.max(10, Math.min(Math.floor(livenessMs / 4), 5_000))
        while (true) {
          const before = yield* Clock.currentTimeMillis
          yield* Effect.sleep(interval)
          const now = yield* Clock.currentTimeMillis
          // our own event loop stalled (the reader could not run either): judge on the next tick
          if (now - before > interval * 2) continue
          const silent = now - lastFrameAt
          if (silent >= livenessMs) {
            const err = closeError(1006, `liveness timeout: no frames for ${silent} ms`)
            toServer.fail(err)
            toClient.fail(err)
            yield* Deferred.succeed(closed, err)
            // best effort: on a half-open socket the close frame may never leave
            yield* Effect.forkDetach(Effect.timeout(Effect.ignore(writer.write(new Socket.CloseEvent(1001, "liveness timeout"))), "1 second"))
            return
          }
        }
      }).pipe(Effect.forkScoped)
    }

    const virtual = (inbox: Inbox): Socket.Socket =>
      Socket.make({
        reader: Effect.gen(function* () {
          const scope = yield* Effect.scope
          if (inbox.error) return yield* Effect.fail(inbox.error)
          yield* Scope.addFinalizer(scope, Effect.sync(() => inbox.cancel(closeError(1000, "reader released"))))
          return { pull: inbox.pull, upgrade: Socket.SocketUpgradeError.unsupported }
        }),
        writer: Effect.succeed(writer),
      })

    return {
      server: virtual(toServer),
      client: virtual(toClient),
      closed: Deferred.await(closed),
      idleMs: Effect.map(Clock.currentTimeMillis, (now) => now - lastFrameAt),
      stats,
      close: (code = 1000, reason?: string) => Effect.ignore(writer.write(new Socket.CloseEvent(code, reason))),
    } satisfies Mux
  })

// ---------------------------------------------------------------- peer: RpcServer + RpcClient on one socket
export interface PeerOptions<Serve extends Rpc.Any, Call extends Rpc.Any> {
  /** The physical socket (node: the dialed WebSocket; brain: the upgraded `/node` socket). */
  readonly socket: Socket.Socket
  /** Group this side serves (node: NodeRpcs, brain: BrainRpcs). Handlers come from the environment. */
  readonly serve: RpcGroup.RpcGroup<Serve>
  /** Group this side calls (node: BrainRpcs, brain: NodeRpcs). */
  readonly call: RpcGroup.RpcGroup<Call>
  /** Brain side: stamp authenticated identity onto every incoming request. */
  readonly stamp?: ReadonlyArray<readonly [string, string]> | undefined
  /** Client ping interval (default 5 s). */
  readonly pingInterval?: number | undefined
  /** Client ping timeout in ms (default = interval; brain uses 15 s). */
  readonly pingTimeout?: number | undefined
  /** Drop the connection after this much silence (see `MuxOptions.livenessTimeout`; brain uses 20 s). */
  readonly livenessTimeout?: number | undefined
  readonly concurrency?: number | "unbounded" | undefined
  readonly disableFatalDefects?: boolean | undefined
  readonly disableTracing?: boolean | undefined
}

export interface Peer<Call extends Rpc.Any> {
  readonly client: RpcClient.RpcClient<Call, RpcClientError.RpcClientError>
  readonly mux: Mux
  /** Completes when the connection ends. */
  readonly closed: Effect.Effect<Socket.SocketError>
}

/**
 * One side of a node control connection: serves `serve` and calls `call` over a single physical socket,
 * JSON-RPC serialization (`RpcSerialization.jsonRpc()`). Everything lives in the current scope; when the
 * socket closes, in-flight handlers are interrupted and in-flight calls fail with `RpcClientError`.
 */
export const makePeer = <Serve extends Rpc.Any, Call extends Rpc.Any>(
  options: PeerOptions<Serve, Call>,
): Effect.Effect<
  Peer<Call>,
  Socket.SocketError,
  Scope.Scope | Rpc.ToHandler<Serve> | Rpc.Middleware<Serve> | Rpc.ServicesServer<Serve> | Rpc.MiddlewareClient<Call>
> =>
  Effect.gen(function* () {
    const m = yield* mux(options.socket, { stamp: options.stamp, livenessTimeout: options.livenessTimeout })
    const serialization = RpcSerialization.jsonRpc()

    // server: a one-connection SocketServer over the server-bound virtual socket
    const socketServer = SocketServer.SocketServer.of({
      address: NetAddress.unixPathAddress("openbot-node-mux"),
      run: (handler) => Effect.andThen(Effect.orDie(handler(m.server)), Effect.never),
    })
    const serverProtocol = yield* RpcServer.makeProtocolSocketServer.pipe(
      Effect.provideService(SocketServer.SocketServer, socketServer),
      Effect.provideService(RpcSerialization.RpcSerialization, serialization),
    )
    yield* RpcServer.make(options.serve, {
      concurrency: options.concurrency,
      disableFatalDefects: options.disableFatalDefects,
      disableTracing: options.disableTracing,
    }).pipe(Effect.provideService(RpcServer.Protocol, serverProtocol), Effect.forkScoped)

    // client over the client-bound virtual socket
    const clientProtocol = yield* RpcClient.makeProtocolSocket({
      retryTransientErrors: false,
      pingInterval: options.pingInterval,
      pingTimeout: options.pingTimeout,
    }).pipe(
      Effect.provideService(Socket.Socket, m.client),
      Effect.provideService(RpcSerialization.RpcSerialization, serialization),
    )
    const client = yield* RpcClient.make(options.call, { disableTracing: options.disableTracing }).pipe(
      Effect.provideService(RpcClient.Protocol, clientProtocol),
    )
    return { client, mux: m, closed: m.closed }
  })

/** Brain side: the node id stamped by the mux (`x-openbot-node-id`). Never read node ids from payloads. */
export const stampedNodeId = (headers: Headers): string | undefined => headers[ProtocolHeaders.nodeId]

/** Stamp pairs for the brain mux. */
export const nodeStamp = (nodeId: string): ReadonlyArray<readonly [string, string]> => [[ProtocolHeaders.nodeId, nodeId]]
