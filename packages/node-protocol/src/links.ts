// Node-side seams shared by @openbot/node-daemon (whose NodeHandlersLive depends on them) and
// @openbot/brain-nodes (which embeds those handlers in-process as the local node, D1.1).
//
//   remote node : DialOut provides BrainLink from its BrainRpcs client on the control socket and
//                 StreamDialer by dialing `wss://<brain>/node/stream/:id` with the one-time token.
//   local node  : brain-nodes provides BrainLink in-process (its BrainRpcs handlers, e.g. via
//                 `RpcTest.makeClient(BrainRpcs)`) and StreamDialer from its StreamBroker (an
//                 in-memory socket pair, see `@openbot/node-protocol/testing` makeMemorySocketPair).
//
// The `node.hello` gate (NotAuthenticated before hello) belongs to the CONNECTION (DialOut), not to
// NodeHandlersLive, so the in-process local node needs no hello.
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type * as Socket from "effect/socket/Socket"
import type { StreamRefused } from "./errors.ts"
import type { BrainStreamKind, NodeApprovalRequest, NodeApprovalResponse, StreamTicket } from "./schemas.ts"

/** The node's view of the brain (`BrainRpcs`), used by node handlers. */
export class BrainLink extends Context.Service<
  BrainLink,
  {
    /**
     * `node.requestApproval` when the node's own ceiling says `ask` (D1.4). Never fails: when the
     * brain is unreachable it resolves `{decision: "deny", by: "unreachable"}`. Pass `runId` and
     * `toolCallId` from the call's `Invocation` so the brain can route the card.
     */
    readonly requestApproval: (request: NodeApprovalRequest) => Effect.Effect<NodeApprovalResponse>
    /** `node.openStream`: a node-initiated data stream to a fixed brain target (e.g. `forward.listen`). */
    readonly openStream: (input: {
      readonly kind: BrainStreamKind
      readonly botId: string
    }) => Effect.Effect<StreamTicket, StreamRefused>
    /** `node.event` (fire-and-forget; dropped while disconnected). Types: `NodeEventTypes`. */
    readonly event: (type: string, data: unknown) => Effect.Effect<void>
  }
>()("openbot/node-protocol/BrainLink") {}

/** Opens the NODE side of a data stream for a ticket the brain issued (pty, tunnels, screencast, …). */
export class StreamDialer extends Context.Service<
  StreamDialer,
  {
    /**
     * `kind` is the stream kind (`StreamKind`) for framing/logging. The socket is closed when the
     * scope closes. Fails with `StreamRefused` (bad/expired token, brain unreachable).
     */
    readonly dial: (input: {
      readonly ticket: StreamTicket
      readonly kind: string
    }) => Effect.Effect<Socket.Socket, StreamRefused, Scope.Scope>
  }
>()("openbot/node-protocol/StreamDialer") {}
