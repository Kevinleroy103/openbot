/**
 * `NodeGateway` (architecture §4.8, §5.3; docs/node-protocol.md §2–3): the node-facing HTTP handlers
 * of the PUBLIC listener. brain-nodes owns no listener; the server mounts these (see `http.ts`).
 *
 * - `GET /node`: verifies the signed upgrade (Ed25519 over `openbot-node-v1|id|ts|nonce|origin`, skew,
 *   nonce replay) against the paired keys, upgrades, builds the direction mux with `RpcClient(NodeRpcs)`
 *   (ping timeout 15 s) and `RpcServer(BrainRpcs)`, calls `node.hello` with the brain signature over
 *   the upgrade nonce, and attaches the connection to the registry until the socket closes or goes
 *   silent for `livenessTimeoutMs` (half-open; the node then shows offline).
 *   Refusals: bad/unknown/replayed signatures answer 401 without upgrading. A REVOKED node whose
 *   signature verifies is upgraded and closed with 4401 so it stops redialing.
 * - `POST /node/pair`: `PairRequest` → `PairResponse` (single-use code, 10 min).
 * - `GET /node/stream/:id`: one-time data-stream tokens (`StreamBroker`).
 *
 * Top-level layer: the `BrainRpcs` handlers need `ApprovalService`.
 */
import type { NodeId } from "@openbot/contracts"
import { ApprovalService, BotRepo, InternalAddress } from "@openbot/core"
import {
  BRAIN_CLIENT_PING_TIMEOUT_MS,
  BrainRpcs,
  CloseCodes,
  makePeer,
  makeReplayCache,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  negotiateProtocol,
  nodeStamp,
  NodeRpcs,
  PairRequest,
  PROTOCOL_VERSION,
  signHello,
  type UpgradeAuthError,
  type VerifiedUpgrade,
  verifyUpgradeAuth,
} from "@openbot/node-protocol"
import { Context, Effect, Layer, Option, Result, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import type * as Socket from "effect/socket/Socket"
import { BrainSide } from "./BrainHandlers.ts"
import { acceptedOrigins, BrainIdentity, BrainNodesConfig } from "./config.ts"
import { NodeRegistry } from "./NodeRegistry.ts"
import { closeSocket } from "./splice.ts"
import { handleStreamUpgrade, StreamBroker } from "./StreamBroker.ts"

type Handler = Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>

export interface NodeGatewayShape {
  /** `GET /node` (WebSocket upgrade, signed). */
  readonly control: Handler
  /** `POST /node/pair` (JSON). */
  readonly pair: Handler
  /** `GET /node/stream/:id` (WebSocket upgrade, one-time bearer). */
  readonly stream: (streamId: string) => Handler
}

export class NodeGateway extends Context.Service<NodeGateway, NodeGatewayShape>()("openbot/brain-nodes/NodeGateway") {}

const decodePairRequest = Schema.decodeUnknownOption(PairRequest)

export const makeNodeGateway = Effect.gen(function* () {
  const config = yield* BrainNodesConfig
  const identity = yield* BrainIdentity
  const registry = yield* NodeRegistry
  const broker = yield* StreamBroker
  const brainContext = (yield* BrainSide).rpcContext
  const replay = makeReplayCache()
  // the gateway going away (brain shutdown) disconnects every node; they redial with backoff
  yield* Effect.addFinalizer(() => registry.closeAll(1001, "brain shutting down"))

  /** Public key of a paired, non-revoked remote node. */
  const activeKey = (nodeId: string) =>
    Effect.map(registry.record(nodeId), (r) =>
      Option.isSome(r) && r.value.revokedAt === undefined && r.value.kind === "remote" ? r.value.publicKey : undefined,
    )
  /** Public key of a revoked node (to recognise it and close with 4401). */
  const revokedKey = (nodeId: string) =>
    Effect.map(registry.record(nodeId), (r) =>
      Option.isSome(r) && r.value.revokedAt !== undefined && r.value.kind === "remote" ? r.value.publicKey : undefined,
    )

  /** Verify against every accepted origin; returns the origin the node signed for. */
  const verify = (
    header: string | undefined,
    lookupKey: (nodeId: string) => Effect.Effect<string | undefined>,
  ): Effect.Effect<Result.Result<{ readonly auth: VerifiedUpgrade; readonly origin: string }, UpgradeAuthError>> =>
    Effect.gen(function* () {
      const origins = yield* acceptedOrigins(config)
      let last: UpgradeAuthError | undefined
      for (const origin of origins) {
        const r = yield* Effect.result(verifyUpgradeAuth({ header, brainOrigin: origin, lookupKey, replay }))
        if (Result.isSuccess(r)) return Result.succeed({ auth: r.success, origin })
        last = r.failure
        if (r.failure.reason !== "bad-signature") break // other failures do not depend on the origin
      }
      return Result.fail(last!)
    })

  /** One control connection, from upgrade to close. Runs in the route fiber (finalizers detach). */
  const runConnection = (socket: Socket.Socket, auth: VerifiedUpgrade, origin: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const nodeId = auth.nodeId as NodeId
        const peer = yield* makePeer({
          socket,
          serve: BrainRpcs,
          call: NodeRpcs,
          stamp: nodeStamp(nodeId),
          pingTimeout: BRAIN_CLIENT_PING_TIMEOUT_MS,
          // half-open detection: a node that vanished without a close goes offline
          livenessTimeout: config.livenessTimeoutMs,
          disableFatalDefects: true,
        }).pipe(Effect.provide(brainContext))
        const close = (code: number, reason: string) => peer.mux.close(code, reason)
        const brainSig = yield* Effect.orDie(
          signHello({ brainPrivateKey: identity.privateKey, nodeId, nonce: auth.nonce, brainOrigin: origin }),
        )
        const hello = yield* peer.client["node.hello"]({
          protocol: { min: MIN_SUPPORTED_PROTOCOL_VERSION, max: PROTOCOL_VERSION },
          brainVersion: config.brainVersion,
          brainSig,
        }).pipe(Effect.timeout(config.helloTimeoutMs), Effect.result)
        if (Result.isFailure(hello)) {
          yield* Effect.logWarning("node.hello failed", { nodeId, error: String(hello.failure) })
          return yield* close(CloseCodes.helloFailed, "node.hello failed")
        }
        const h = hello.success
        if (h.nodeId !== nodeId || !h.brainVerified) {
          return yield* close(CloseCodes.helloFailed, "node identity mismatch")
        }
        const version = negotiateProtocol(
          { min: MIN_SUPPORTED_PROTOCOL_VERSION, max: PROTOCOL_VERSION },
          { min: h.protocol, max: h.protocol },
        )
        if (version === undefined) return yield* close(CloseCodes.protocolMismatch, "no common protocol version")
        const attached = yield* Effect.result(registry.attach({ nodeId, hello: h, client: peer.client, close }))
        if (Result.isFailure(attached)) {
          return yield* close(attached.failure.closeCode, attached.failure.reason)
        }
        yield* Effect.logInfo("node connected", { nodeId, hostname: h.hostname, capabilities: h.capabilities })
        const reason = yield* peer.closed
        yield* Effect.logInfo("node disconnected", { nodeId, reason: reason.message })
      }),
    ).pipe(Effect.catchCause((cause) => Effect.logWarning("node connection failed", { nodeId: auth.nodeId, cause })))

  const control: Handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const header = request.headers["authorization"]
    const verified = yield* verify(header, activeKey)
    if (Result.isFailure(verified)) {
      if (verified.failure.reason === "unknown-node") {
        // a revoked node with a valid signature is told (4401) to stop redialing
        const revoked = yield* verify(header, revokedKey)
        if (Result.isSuccess(revoked)) {
          const socket = yield* Effect.result(request.upgrade)
          if (Result.isSuccess(socket)) {
            yield* closeSocket(socket.success, CloseCodes.revoked, "node revoked")
            return HttpServerResponse.empty()
          }
        }
      }
      return HttpServerResponse.text(verified.failure.message, { status: 401 })
    }
    const socket = yield* Effect.result(request.upgrade)
    if (Result.isFailure(socket)) return HttpServerResponse.text("expected a WebSocket upgrade", { status: 400 })
    yield* runConnection(socket.success, verified.success.auth, verified.success.origin)
    return HttpServerResponse.empty()
  })

  const pair: Handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const body = yield* Effect.result(request.json)
    const decoded = Result.isSuccess(body) ? decodePairRequest(body.success) : Option.none()
    if (Option.isNone(decoded)) {
      return HttpServerResponse.jsonUnsafe({ error: "expected a PairRequest JSON body" }, { status: 400 })
    }
    const paired = yield* Effect.result(registry.pair(decoded.value))
    if (Result.isFailure(paired)) {
      return HttpServerResponse.jsonUnsafe({ error: paired.failure.reason }, { status: paired.failure.status })
    }
    return HttpServerResponse.jsonUnsafe(paired.success)
  })

  return NodeGateway.of({
    control,
    pair,
    stream: (streamId) => handleStreamUpgrade(broker, streamId),
  })
})

/**
 * `NodeGateway` (the `/node`, `/node/pair`, `/node/stream/:id` handlers). Top-level: needs
 * `ApprovalService` for the `BrainRpcs` handlers.
 */
export const NodeGatewayLive: Layer.Layer<
  NodeGateway,
  never,
  BrainNodesConfig | BrainIdentity | NodeRegistry | StreamBroker | ApprovalService | BotRepo | InternalAddress
> = Layer.effect(NodeGateway, makeNodeGateway).pipe(Layer.provide(BrainSide.layer))
