/**
 * Relay routes (architecture §4.8, D1.8; remote-codex.md §3.2): `GET /relay/:nodeId/:kind` on the
 * INTERNAL listener (loopback only). Brain-local consumers dial a loopback WebSocket; each connection
 * becomes a node tunnel:
 *
 *   codex app-server ──ws /relay/<node>/codex.exec-server──▶ brain ──tunnel.open──▶ node
 *                                                            ◀──── /node/stream/:id ───┘ (codex exec-server --listen stdio)
 *
 * Frames are spliced verbatim (one JSON-RPC message per text frame). The relay is payload-opaque.
 *
 * Auth: a relay grant per (node, bot, kind), minted by placement and refcounted across the bot's
 * sessions, so a later `environment/add` upsert never invalidates an earlier session's token. Codex
 * sends it as `Authorization: Bearer …` (allowed over loopback, remote-codex.md E12). A grant also
 * fixes the bot (for the node's audit/policy `inv`) and the cwd on the node.
 */
import type { BotId, NodeId } from "@openbot/contracts"
import { IdGen, InternalAddress, NodeDirectory } from "@openbot/core"
import { describeNodeError, randomToken, safeEqual } from "@openbot/node-protocol"
import { Context, Effect, Exit, Fiber, Layer, Result, Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import type * as Socket from "effect/socket/Socket"
import { closeWriter, open, splice } from "./splice.ts"
import { openNodeStream, StreamBroker } from "./StreamBroker.ts"

/** Tunnel kinds a relay can carry in v1 (`claude.cli` and `tcp` come with R1/H later). */
export const RelayKinds = ["codex.exec-server", "codex.app-server"] as const
export type RelayKind = (typeof RelayKinds)[number]
export const isRelayKind = (kind: string): kind is RelayKind => (RelayKinds as ReadonlyArray<string>).includes(kind)

export interface RelayGrant {
  readonly nodeId: NodeId
  readonly botId: BotId
  readonly kind: RelayKind
  /** cwd on the node for the tunnelled process. */
  readonly cwd: string
  /** Bearer the consumer presents (128-bit, base64url). */
  readonly token: string
  /** `ws://127.0.0.1:<internal>/relay/<nodeId>/<kind>` */
  readonly url: string
}

export interface RelayServiceShape {
  /** Acquire the (refcounted) grant for (node, bot, kind); released when the scope closes. */
  readonly grant: (input: {
    readonly nodeId: NodeId
    readonly botId: BotId
    readonly kind: RelayKind
    readonly cwd: string
  }) => Effect.Effect<RelayGrant, never, Scope.Scope>
  /** `GET /relay/:nodeId/:kind` (WebSocket upgrade, bearer). */
  readonly handle: (
    nodeId: string,
    kind: string,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>
  /** Active grants (tests, diagnostics). */
  readonly activeGrants: Effect.Effect<number>
}

export class RelayService extends Context.Service<RelayService, RelayServiceShape>()(
  "openbot/brain-nodes/RelayService",
) {}

const toWebSocketUrl = (httpUrl: string): string => httpUrl.replace(/^http(s?):\/\//, (_, s: string) => `ws${s}://`)

export const makeRelayService = Effect.gen(function* () {
  const directory = yield* NodeDirectory
  const broker = yield* StreamBroker
  const internal = yield* InternalAddress
  const ids = yield* IdGen

  const grants = new Map<string, { grant: RelayGrant; refs: number }>()
  const keyOf = (nodeId: string, botId: string, kind: string) => `${nodeId}\u0000${botId}\u0000${kind}`

  const grant: RelayServiceShape["grant"] = ({ botId, cwd, kind, nodeId }) =>
    Effect.gen(function* () {
      const key = keyOf(nodeId, botId, kind)
      const url = `${toWebSocketUrl(yield* internal.baseUrl)}/relay/${encodeURIComponent(nodeId)}/${kind}`
      // taking a reference and registering its release are one uninterruptible step
      return yield* Effect.acquireRelease(
        Effect.sync(() => {
          const existing = grants.get(key)
          if (existing !== undefined && existing.grant.cwd === cwd) {
            existing.refs++
            return existing.grant
          }
          const fresh: RelayGrant = { nodeId, botId, kind, cwd, token: randomToken(16), url }
          grants.set(key, { grant: fresh, refs: (existing?.refs ?? 0) + 1 })
          return fresh
        }),
        () =>
          Effect.sync(() => {
            const entry = grants.get(key)
            if (entry === undefined) return
            entry.refs--
            if (entry.refs <= 0) grants.delete(key)
          }),
      )
    })

  const findGrant = (nodeId: string, kind: string, token: string | undefined): RelayGrant | undefined => {
    if (token === undefined) return undefined
    for (const { grant: g } of grants.values()) {
      if (g.nodeId === nodeId && g.kind === kind && safeEqual(g.token, token)) return g
    }
    return undefined
  }

  /** One relayed connection: consumer socket ⇄ node tunnel. */
  const relay = (consumer: Socket.Socket, g: RelayGrant) =>
    Effect.scoped(
      Effect.gen(function* () {
        const local = yield* open(consumer)
        const client = yield* directory.client(g.nodeId)
        const inv = { invocationId: yield* ids.next("inv"), botId: g.botId, runId: `relay-${g.botId}` }
        const opened = yield* Effect.result(
          openNodeStream(broker, {
            nodeId: g.nodeId,
            kind: g.kind,
            open: (ticket) =>
              client["tunnel.open"]({
                inv,
                kind: g.kind,
                args: [],
                env: {},
                cwd: g.cwd,
                streamId: ticket.streamId,
                streamToken: ticket.streamToken,
              }),
          }),
        )
        if (Result.isFailure(opened)) {
          const e = opened.failure
          const reason = "_tag" in e && e._tag !== "RpcClientError" ? describeNodeError(e) : "node unreachable"
          yield* Effect.logWarning("relay tunnel failed", { nodeId: g.nodeId, kind: g.kind, reason })
          return yield* closeWriter(local.writer, 1011, reason)
        }
        const remote = yield* open(opened.success.socket)
        yield* splice(local, remote)
      }),
    ).pipe(Effect.catchCause((cause) => Effect.logDebug("relay ended", { nodeId: g.nodeId, kind: g.kind, cause })))

  const handle: RelayServiceShape["handle"] = (nodeId, kind) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers["authorization"] ?? "")?.[1]
      const g = isRelayKind(kind) ? findGrant(nodeId, kind, bearer) : undefined
      if (g === undefined) return HttpServerResponse.text("relay refused", { status: 401 })
      const online = yield* Effect.exit(directory.client(g.nodeId))
      if (Exit.isFailure(online)) return HttpServerResponse.text("node offline", { status: 503 })
      const upgraded = yield* Effect.result(request.upgrade)
      if (Result.isFailure(upgraded)) return HttpServerResponse.text("expected a WebSocket upgrade", { status: 400 })
      // BunHttpServer interrupts this fiber when the consumer closes (G2); the relay runs detached so
      // frames still buffered on either side are drained before it ends.
      const fiber = yield* Effect.forkDetach(relay(upgraded.success, g))
      yield* Fiber.await(fiber)
      return HttpServerResponse.empty()
    })

  return RelayService.of({ grant, handle, activeGrants: Effect.sync(() => grants.size) })
})

export const RelayServiceLive: Layer.Layer<
  RelayService,
  never,
  NodeDirectory | StreamBroker | InternalAddress | IdGen
> = Layer.effect(RelayService, makeRelayService)
