/**
 * Brain-side handlers of `BrainRpcs` (served to nodes): approvals, node-initiated streams, events and
 * heartbeats. One implementation serves both:
 *   - remote nodes, through `BrainRpcsHandlersLayer` on every control connection (the node id comes
 *     from the brain mux stamp `x-openbot-node-id`, never from the payload);
 *   - the in-process local node, through the `BrainLink` built in `LocalNode.ts`.
 *
 * Top-level (interfaces.md §2.3, §8.5): needs `ApprovalService.evaluateNode`, so it never lives in the
 * `NodeDirectory` layer.
 */
import type { BotId, NodeId } from "@openbot/contracts"
import { ApprovalService, BotRepo, InternalAddress } from "@openbot/core"
import {
  BrainRpcs,
  type NodeApprovalRequest,
  type NodeApprovalResponse,
  type NodeHeartbeat,
  stampedNodeId,
  StreamRefused,
  type StreamTicket,
} from "@openbot/node-protocol"
import { makeNet } from "@effect/platform-bun/BunSocket"
import { Context, Deferred, Effect, Layer, Option } from "effect"
import type { Rpc, RpcGroup } from "effect/rpc"
import type { Scope } from "effect"
import { NodeRegistry } from "./NodeRegistry.ts"
import { open, splice } from "./splice.ts"
import { StreamBroker } from "./StreamBroker.ts"

export interface BrainSideHandlers {
  readonly requestApproval: (nodeId: NodeId, request: NodeApprovalRequest) => Effect.Effect<NodeApprovalResponse>
  readonly openStream: (
    nodeId: NodeId,
    input: { readonly kind: string; readonly botId: string },
  ) => Effect.Effect<StreamTicket, StreamRefused>
  readonly event: (nodeId: NodeId, type: string, data: unknown) => Effect.Effect<void>
  readonly heartbeat: (nodeId: NodeId, heartbeat: NodeHeartbeat) => Effect.Effect<void>
}

/** Fixed brain-internal TCP target of a node-initiated stream kind (no SSRF: the node never names it). */
interface NetTarget {
  readonly host: string
  readonly port: number
}

const targetFromUrl = (url: string): NetTarget | undefined => {
  try {
    const u = new URL(url)
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80
    return { host: u.hostname.replace(/^\[|\]$/g, ""), port }
  } catch {
    return undefined
  }
}

/**
 * Builds the handlers. Node-initiated forwards run in the calling layer's scope, so they stop when the
 * brain shuts down.
 */
export const makeBrainSideHandlers: Effect.Effect<
  BrainSideHandlers,
  never,
  ApprovalService | NodeRegistry | StreamBroker | BotRepo | InternalAddress | Scope.Scope
> = Effect.gen(function*() {
  const approvals = yield* ApprovalService
  const registry = yield* NodeRegistry
  const broker = yield* StreamBroker
  const bots = yield* BotRepo
  const internal = yield* InternalAddress
  const layerScope = yield* Effect.scope

  /** v1 targets: `mcp-http` → the internal listener (gateway). Credential forwarders come later. */
  const targetFor = (kind: string): Effect.Effect<NetTarget | undefined> =>
    kind === "mcp-http" ? Effect.map(internal.baseUrl, targetFromUrl) : Effect.succeed(undefined)

  const openStream: BrainSideHandlers["openStream"] = (nodeId, { botId, kind }) =>
    Effect.gen(function*() {
      const bot = Option.getOrUndefined(yield* Effect.orDie(bots.get(botId as BotId)))
      if (bot === undefined) return yield* new StreamRefused({ kind, reason: `unknown bot ${botId}` })
      if (bot.hostNodeId !== nodeId && !bot.boundNodeIds.includes(nodeId)) {
        return yield* new StreamRefused({ kind, reason: `bot ${botId} is not bound to this node` })
      }
      const target = yield* targetFor(kind)
      if (target === undefined) return yield* new StreamRefused({ kind, reason: `no brain target for ${kind}` })
      const ticket = yield* Deferred.make<StreamTicket>()
      const forward = Effect.scoped(
        Effect.gen(function*() {
          const expected = yield* broker.expect({ nodeId, kind })
          yield* Deferred.succeed(ticket, expected.ticket)
          const nodeSide = yield* open(yield* expected.socket)
          const brainSide = yield* open(yield* makeNet({ host: target.host, port: target.port }))
          yield* splice(nodeSide, brainSide)
        }),
      ).pipe(
        Effect.catchCause((cause) => Effect.logDebug("node-initiated stream ended", { nodeId, kind, cause })),
      )
      yield* Effect.forkIn(forward, layerScope, { startImmediately: true })
      return yield* Deferred.await(ticket)
    })

  return {
    requestApproval: (nodeId, request) =>
      approvals.evaluateNode({ nodeId, request }).pipe(
        Effect.catchCause((cause) =>
          Effect.as(Effect.logWarning("node approval failed; denying", { nodeId, cause }), {
            decision: "deny" as const,
            by: "error",
          })
        ),
      ),
    openStream,
    event: (nodeId, type, data) => registry.publishEvent({ nodeId, type, data }),
    heartbeat: (nodeId) => registry.touch(nodeId),
  }
})

/** `BrainRpcs` handlers for remote control connections (node id from the brain mux stamp). */
export const brainRpcsHandlersLayer = (handlers: BrainSideHandlers) =>
  BrainRpcs.toLayer({
    "node.requestApproval": (request, { headers }) => {
      const nodeId = stampedNodeId(headers)
      return nodeId === undefined
        ? Effect.succeed({ decision: "deny" as const, by: "unauthenticated" })
        : handlers.requestApproval(nodeId as NodeId, request)
    },
    "node.openStream": (input, { headers }) => {
      const nodeId = stampedNodeId(headers)
      return nodeId === undefined
        ? Effect.fail(new StreamRefused({ kind: input.kind, reason: "unauthenticated" }))
        : handlers.openStream(nodeId as NodeId, input)
    },
    "node.event": ({ data, type }, { headers }) => {
      const nodeId = stampedNodeId(headers)
      return nodeId === undefined ? Effect.void : handlers.event(nodeId as NodeId, type, data)
    },
    "node.heartbeat": (heartbeat, { headers }) => {
      const nodeId = stampedNodeId(headers)
      return nodeId === undefined ? Effect.void : handlers.heartbeat(nodeId as NodeId, heartbeat)
    },
  })

/**
 * The built brain-side handlers: the plain functions (for the local node's in-process `BrainLink`)
 * and the `BrainRpcs` handler context (for `makePeer` on remote control connections).
 */
export class BrainSide extends Context.Service<BrainSide, {
  readonly handlers: BrainSideHandlers
  readonly rpcContext: Context.Context<Rpc.ToHandler<RpcGroup.Rpcs<typeof BrainRpcs>>>
}>()("openbot/brain-nodes/BrainSide") {
  static readonly layer: Layer.Layer<
    BrainSide,
    never,
    ApprovalService | NodeRegistry | StreamBroker | BotRepo | InternalAddress
  > = Layer.effect(
    BrainSide,
    Effect.gen(function*() {
      const handlers = yield* makeBrainSideHandlers
      const rpcContext = yield* Layer.build(brainRpcsHandlersLayer(handlers))
      return { handlers, rpcContext }
    }),
  )
}
