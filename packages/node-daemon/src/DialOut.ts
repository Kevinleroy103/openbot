// DialOut: the remote node's control connection (D1.2, D1.3; docs/node-protocol.md §3;
// docs/architecture.md §4.7). Ported from vendor/scratch/hands-e2e/node.ts (dial-out loop).
//
//  - dials `wss://<brain>/node` with a signed upgrade (`Authorization: OpenBot-Node v1 …`, fresh
//    nonce per dial), builds the direction mux: RpcServer(NodeRpcs) + RpcClient(BrainRpcs);
//  - serves the handlers through the per-connection `node.hello` gate (gate.ts);
//  - provides the node-side seams for NodeHandlersLive: `BrainLink` (over the current connection's
//    BrainRpcs client) and `StreamDialer` (`wss://<brain>/node/stream/:id` + one-time bearer);
//  - redials with exponential backoff (250 ms → 30 s, ±50 % jitter, reset only after a connection
//    stayed up 10 s) and stops for good on close code 4401 (revoked);
//  - sends `node.heartbeat` while verified, and drops half-open connections (no frames for 20 s).
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as FiberSet from "effect/FiberSet"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schedule from "effect/Schedule"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import * as Socket from "effect/socket/Socket"
import type { RpcClient, RpcClientError, RpcGroup } from "effect/rpc"
import { freemem, loadavg } from "node:os"
import {
  BrainLink,
  BrainRpcs,
  CloseCodes,
  formatStreamAuth,
  makePeer,
  makeUpgradeAuth,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  NodeRpcs,
  PROTOCOL_VERSION,
  ProtocolHeaders,
  REDIAL,
  Routes,
  StreamDialer,
  StreamRefused,
  type NodeApprovalResponse,
  type NodeHello,
} from "@openbot/node-protocol"
import { makeHelloGate } from "./gate.ts"
import { NodeHandlers, NodeInfo } from "./handlers.ts"
import type { NodeIdentity } from "./KeyStore.ts"
import { brainWsUrl } from "./pair.ts"
import { closeCodeOf, dialWebSocket } from "./sockets.ts"

export type BrainClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof BrainRpcs>, RpcClientError.RpcClientError>

/** Redial backoff (defaults: `REDIAL` from node-protocol, 250 ms → 30 s, reset after 10 s up). */
export interface BackoffConfig {
  readonly initialMs?: number | undefined
  readonly maxMs?: number | undefined
  readonly resetAfterMs?: number | undefined
}

export interface DialOutConfig {
  /** what the node stored at pairing */
  readonly identity: Pick<NodeIdentity, "nodeId" | "privateKey" | "brainPublicKey" | "brainOrigin" | "brainUrl">
  /** control socket URL; default `ws(s)://<brainUrl>/node` */
  readonly controlUrl?: string | undefined
  /** data stream URL; default `ws(s)://<brainUrl>/node/stream/:id` */
  readonly streamUrl?: ((streamId: string) => string) | undefined
  /** WebSocket open timeout (control and data), default 10 s */
  readonly openTimeoutMs?: number | undefined
  /** close and redial when the brain does not complete `node.hello` in time, default 30 s */
  readonly helloTimeoutMs?: number | undefined
  /** `node.heartbeat` interval while verified, default 30 s; 0 disables */
  readonly heartbeatMs?: number | undefined
  /**
   * Drop the connection when no frame at all arrived for this long, default 20 s. Both sides ping
   * every 5 s, so silence means a half-open connection (sleep/wake, NAT drop); Effect's RpcClient
   * only fails calls on a ping timeout and never closes the socket. 0 disables.
   */
  readonly livenessTimeoutMs?: number | undefined
  readonly backoff?: BackoffConfig | undefined
  /** jitter source in [0, 1) (tests) */
  readonly random?: (() => number) | undefined
}

// ---------------------------------------------------------------- state
export type DialState =
  | { readonly _tag: "Connecting"; readonly attempt: number }
  /** socket open, waiting for the brain's `node.hello` */
  | { readonly _tag: "Connected"; readonly since: number }
  /** `node.hello` verified against the pinned brain key */
  | { readonly _tag: "Verified"; readonly since: number; readonly protocol: number }
  | {
      readonly _tag: "Waiting"
      readonly attempt: number
      readonly delayMs: number
      readonly reason: string
      readonly closeCode?: number | undefined
    }
  /** close code 4401: the node was revoked (or its key is unknown); re-pair to continue */
  | { readonly _tag: "Revoked"; readonly reason: string }

export interface DialOutShape {
  readonly state: Effect.Effect<DialState>
  /** current state first, then every change */
  readonly changes: Stream.Stream<DialState>
  /** completes when the dial loop stops for good (revoked) */
  readonly done: Effect.Effect<DialState>
  /** connections that completed `node.hello` so far */
  readonly verifiedConnections: () => number
}

export class DialOut extends Context.Service<DialOut, DialOutShape>()("openbot/node-daemon/DialOut") {}

/** The current control connection's BrainRpcs client (shared by BrainLink and the dial loop). */
export interface BrainConnectionShape {
  readonly current: () => BrainClient | undefined
  readonly attach: (client: BrainClient) => Effect.Effect<void, never, Scope.Scope>
}

export class BrainConnection extends Context.Service<BrainConnection, BrainConnectionShape>()(
  "openbot/node-daemon/BrainConnection",
) {}

// ---------------------------------------------------------------- helpers
const controlUrlOf = (config: DialOutConfig) =>
  config.controlUrl ?? brainWsUrl(config.identity.brainUrl, Routes.control)
const streamUrlOf = (config: DialOutConfig) =>
  config.streamUrl ?? ((id: string) => brainWsUrl(config.identity.brainUrl, Routes.stream(id)))

/** Bun's WebSocket accepts handshake headers in an options object (the DOM typing hides it). */
export const BunWebSocketConstructor: Layer.Layer<Socket.WebSocketConstructor> = Layer.succeed(
  Socket.WebSocketConstructor,
)((url, options) => {
  const Ctor = globalThis.WebSocket as unknown as new (u: string, o?: unknown) => globalThis.WebSocket
  if (options === undefined || typeof options === "string" || Array.isArray(options)) return new Ctor(url, options)
  return new Ctor(url, {
    protocols: typeof options.protocols === "string" ? [options.protocols] : options.protocols,
    headers: options.headers,
  })
})

/** Exponential backoff with ±50 % jitter (`random` in [0, 1)). */
export const backoffDelayMs = (attempt: number, random: number, backoff?: BackoffConfig): number => {
  const initial = backoff?.initialMs ?? REDIAL.initialMs
  const max = backoff?.maxMs ?? REDIAL.maxMs
  const base = Math.min(initial * 2 ** Math.max(0, attempt), max)
  return Math.round(base * (0.5 + random / 2))
}

const deny = (by: string): NodeApprovalResponse => ({ decision: "deny", by })

const describeFailure = (cause: Cause.Cause<unknown>): string => {
  const e = Cause.squash(cause)
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message
  }
  return String(e)
}

// ---------------------------------------------------------------- links (BrainLink, StreamDialer)
/**
 * The node-side seams over the dial-out connection. `BrainLink` uses whichever control connection is
 * current: approvals resolve `deny`/`unreachable` while disconnected, events are dropped, and
 * `openStream` fails with `StreamRefused`.
 */
export const DialOutLinksLive = (config: DialOutConfig): Layer.Layer<BrainLink | StreamDialer | BrainConnection> =>
  Layer.effectContext(
    Effect.gen(function* () {
      let current: BrainClient | undefined
      const runFork = yield* FiberSet.makeRuntime<never>()
      const connection: BrainConnectionShape = {
        current: () => current,
        attach: (client) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              current = client
            }),
            () =>
              Effect.sync(() => {
                if (current === client) current = undefined
              }),
          ),
      }
      const keepInterrupts = (cause: Cause.Cause<unknown>) => Cause.hasInterruptsOnly(cause)

      const brainLink = BrainLink.of({
        requestApproval: (request) =>
          Effect.suspend(() => {
            const client = current
            if (!client) return Effect.succeed(deny("unreachable"))
            return client["node.requestApproval"](request).pipe(
              Effect.catchCause((cause) =>
                keepInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(deny("unreachable")),
              ),
            ) as Effect.Effect<NodeApprovalResponse>
          }),
        openStream: ({ kind, botId }) =>
          Effect.suspend(() => {
            const client = current
            if (!client)
              return Effect.fail(new StreamRefused({ kind, reason: "the node is not connected to the brain" }))
            return client["node.openStream"]({ kind, botId }).pipe(
              Effect.catchTag("RpcClientError", (e) => Effect.fail(new StreamRefused({ kind, reason: e.message }))),
            )
          }),
        event: (type, data) =>
          Effect.sync(() => {
            const client = current
            if (!client) return
            runFork(client["node.event"]({ type, data }).pipe(Effect.timeout("10 seconds"), Effect.ignore))
          }),
      })

      const urlFor = streamUrlOf(config)
      const dialer = StreamDialer.of({
        dial: ({ ticket, kind }) =>
          dialWebSocket(urlFor(ticket.streamId), {
            headers: { authorization: formatStreamAuth(ticket.streamToken) },
            openTimeout: config.openTimeoutMs ?? 10_000,
          }).pipe(
            Effect.mapError((e) => new StreamRefused({ kind, reason: `cannot open the data stream: ${e.message}` })),
          ),
      })

      return Context.make(BrainLink, brainLink).pipe(
        Context.add(StreamDialer, dialer),
        Context.add(BrainConnection, connection),
      )
    }),
  )

// ---------------------------------------------------------------- the dial loop
interface ConnectionOutcome {
  readonly closeCode: number | undefined
  readonly reason: string
  readonly verified: boolean
}

export const makeDialOut = (config: DialOutConfig) =>
  Effect.gen(function* () {
    const { handlers } = yield* NodeHandlers
    const info = yield* NodeInfo
    const connection = yield* BrainConnection
    const { identity } = config
    const controlUrl = controlUrlOf(config)
    const random = config.random ?? Math.random
    const resetAfterMs = config.backoff?.resetAfterMs ?? REDIAL.resetAfterMs
    const heartbeatMs = config.heartbeatMs ?? 30_000
    const state = yield* SubscriptionRef.make<DialState>({ _tag: "Connecting", attempt: 0 })
    const done = yield* Deferred.make<DialState>()
    let verifiedCount = 0
    const setState = (s: DialState) => SubscriptionRef.set(state, s)

    const heartbeat = (client: BrainClient) =>
      client["node.heartbeat"]({
        at: Date.now(),
        activeInvocations: info.activeInvocations(),
        load: loadavg(),
        freeMemBytes: freemem(),
      }).pipe(Effect.timeout("10 seconds"), Effect.ignore)

    /** One control connection, from the signed dial to the close. */
    const connectOnce: Effect.Effect<ConnectionOutcome, unknown, Scope.Scope> = Effect.gen(function* () {
      const scope = yield* Effect.scope
      const auth = yield* makeUpgradeAuth({
        nodeId: identity.nodeId,
        privateKey: identity.privateKey,
        brainOrigin: identity.brainOrigin,
      })
      const socket = yield* Socket.makeWebSocket(controlUrl, {
        headers: {
          [ProtocolHeaders.authorization]: auth.header,
          [ProtocolHeaders.protocol]: `${MIN_SUPPORTED_PROTOCOL_VERSION}-${PROTOCOL_VERSION}`,
        },
        openTimeout: config.openTimeoutMs ?? 10_000,
      }).pipe(Effect.provide(BunWebSocketConstructor))

      let close: (code: number, reason: string) => Effect.Effect<void> = () => Effect.void
      const hello = yield* Deferred.make<NodeHello>()
      const gate = makeHelloGate(handlers, {
        nodeId: identity.nodeId,
        brainPublicKey: identity.brainPublicKey,
        brainOrigin: identity.brainOrigin,
        nonce: auth.nonce,
        // let the NotAuthenticated response go out, then close
        onRejected: (code, reason) =>
          Effect.asVoid(
            Effect.forkIn(
              Effect.andThen(
                Effect.logWarning(`node.hello rejected: ${reason}`),
                Effect.delay(
                  Effect.suspend(() => close(code, reason)),
                  "100 millis",
                ),
              ),
              scope,
            ),
          ),
        onVerified: (h) => Effect.asVoid(Deferred.succeed(hello, h)),
      })
      const handlerContext = yield* NodeRpcs.toHandlers(gate.handlers)
      const peer = yield* makePeer({
        socket,
        serve: NodeRpcs,
        call: BrainRpcs,
        disableFatalDefects: true,
      }).pipe(Effect.provide(handlerContext))
      close = (code, reason) => peer.mux.close(code, reason)
      yield* connection.attach(peer.client)
      yield* setState({ _tag: "Connected", since: yield* Clock.currentTimeMillis })
      yield* Effect.logInfo(`connected to ${controlUrl}; waiting for node.hello`)

      // hello watchdog, then heartbeats
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const h = yield* Deferred.await(hello).pipe(Effect.timeoutOption(config.helloTimeoutMs ?? 30_000))
          if (h._tag === "None") {
            yield* Effect.logWarning("the brain did not complete node.hello in time; closing")
            return yield* close(CloseCodes.helloFailed, "node.hello timeout")
          }
          verifiedCount++
          yield* setState({ _tag: "Verified", since: yield* Clock.currentTimeMillis, protocol: h.value.protocol })
          yield* Effect.logInfo(`brain verified (protocol ${h.value.protocol}); serving`)
          if (heartbeatMs > 0) {
            yield* Effect.repeat(heartbeat(peer.client), Schedule.spaced(heartbeatMs))
          }
        }),
      )

      // liveness: any routed frame (requests, pings, pongs, results) counts
      const dead = yield* Deferred.make<string>()
      const livenessMs = config.livenessTimeoutMs ?? 20_000
      if (livenessMs > 0) {
        const frames = () => peer.mux.stats.toServer + peer.mux.stats.toClient
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            let seen = frames()
            let lastChange = yield* Clock.currentTimeMillis
            while (true) {
              yield* Effect.sleep(Math.max(10, Math.min(Math.floor(livenessMs / 4), 5_000)))
              const now = yield* Clock.currentTimeMillis
              const current = frames()
              if (current !== seen) {
                seen = current
                lastChange = now
              } else if (now - lastChange >= livenessMs) {
                yield* Effect.forkDetach(Effect.timeout(close(1001, "liveness timeout"), "1 second"))
                return yield* Deferred.succeed(dead, `no frames from the brain for ${now - lastChange} ms`)
              }
            }
          }),
        )
      }

      const ended = yield* Effect.raceFirst(
        Effect.map(peer.closed, (closed) => ({ closeCode: closeCodeOf(closed), reason: closed.message })),
        Effect.map(Deferred.await(dead), (reason) => ({ closeCode: undefined, reason })),
      )
      return { ...ended, verified: gate.isVerified() }
    })

    const loop = Effect.gen(function* () {
      let attempt = 0
      while (true) {
        yield* setState({ _tag: "Connecting", attempt })
        const t0 = yield* Clock.currentTimeMillis
        const result = yield* Effect.result(Effect.scoped(Effect.sandbox(connectOnce)))
        const t1 = yield* Clock.currentTimeMillis
        const outcome: ConnectionOutcome = Result.isSuccess(result)
          ? result.success
          : { closeCode: undefined, reason: describeFailure(result.failure), verified: false }
        if (outcome.closeCode === CloseCodes.revoked) {
          const revoked: DialState = { _tag: "Revoked", reason: outcome.reason || "the brain revoked this node" }
          yield* setState(revoked)
          yield* Effect.logError("the brain revoked this node (4401); pair it again to reconnect")
          yield* Deferred.succeed(done, revoked)
          return
        }
        const n = outcome.verified && t1 - t0 >= resetAfterMs ? 0 : attempt
        const delayMs = backoffDelayMs(n, random(), config.backoff)
        attempt = n + 1
        yield* setState({ _tag: "Waiting", attempt, delayMs, reason: outcome.reason, closeCode: outcome.closeCode })
        yield* Effect.logInfo(
          `connection ended${outcome.closeCode ? ` (${outcome.closeCode})` : ""}: ${outcome.reason || "closed"}; redial in ${delayMs} ms`,
        )
        yield* Effect.sleep(delayMs)
      }
    })

    yield* Effect.forkScoped(loop)

    return DialOut.of({
      state: SubscriptionRef.get(state),
      changes: SubscriptionRef.changes(state),
      done: Deferred.await(done),
      verifiedConnections: () => verifiedCount,
    })
  })

/** The dial loop (forked for the layer's lifetime). Needs the handlers and the links. */
export const DialOutLive = (
  config: DialOutConfig,
): Layer.Layer<DialOut, never, NodeHandlers | NodeInfo | BrainConnection> => Layer.effect(DialOut, makeDialOut(config))
