/**
 * Node access ports (architecture §3.4, §3.5, §4.8). Implemented by `@openbot/brain-nodes`
 * (`NodeRegistry`, `Pairing`, `ComputerService`); fakes live in `@openbot/core/testing`.
 *
 * `node_local` (`LOCAL_NODE_ID`) is always present in `NodeDirectory` unless disabled by config.
 *
 * Layering (services.ts header): `NodeDirectory`, `NodeAdmin`, `PlacementService` and `ComputerPort`
 * sit at layer 0 and must NOT depend on any core service. LiveHub forwards `NodeDirectory.changes`
 * into the roster; brain-nodes never publishes to LiveHub. Node-initiated approvals
 * (`node.requestApproval`) are served by a separate top-level layer that needs `ApprovalService`.
 *
 * `NodeUnavailable` here is the CONTRACT error (`{nodeId, message}`), so it can flow straight to the
 * RPC edge (`computer.ensure`) and be rendered by the gateway as `ERROR: Node ‹label› is offline`.
 * Errors of individual node RPCs (`PathDenied`, `PolicyRefused`, …) come from `@openbot/node-protocol`.
 */
import type {
  Forbidden,
  InvalidInput,
  NodeId,
  NodeSummary,
  NodeUnavailable,
  NotFound,
  PairingCode,
} from "@openbot/contracts"
import type { NodeRpcs } from "@openbot/node-protocol"
import { Context, Effect, Stream } from "effect"
import type { RpcClient, RpcClientError } from "effect/rpc"

/** Typed client for a node's `NodeRpcs` (an Effect `RpcClient` over the node's control socket). */
export type NodeClient = RpcClient.FromGroup<typeof NodeRpcs, RpcClientError.RpcClientError>

/**
 * A change of the node list, shaped exactly like the roster changes `node.upserted` / `node.removed`
 * so LiveHub can publish it unchanged.
 */
export type NodeDirectoryChange =
  | { readonly type: "node.upserted"; readonly node: NodeSummary }
  | { readonly type: "node.removed"; readonly nodeId: NodeId }

export interface NodeDirectoryShape {
  /** Every known, non-revoked node with live status. */
  readonly list: Effect.Effect<ReadonlyArray<NodeSummary>>
  readonly get: (nodeId: NodeId) => Effect.Effect<NodeSummary, NodeUnavailable>
  /**
   * Every change: upserts (status, capabilities, label, lastSeenAt) and removals (revoked/deleted).
   * Hot; no initial snapshot (read `list` first).
   */
  readonly changes: Stream.Stream<NodeDirectoryChange>
  /** RPC client for an online node; fails with `NodeUnavailable` when offline, unknown or revoked. */
  readonly client: (nodeId: NodeId) => Effect.Effect<NodeClient, NodeUnavailable>
  /** Effective capabilities (declared ∩ approved), e.g. `["fs@1", "shell@1", "browser@1"]`. */
  readonly capabilities: (nodeId: NodeId) => Effect.Effect<ReadonlyArray<string>, NodeUnavailable>
}

export class NodeDirectory extends Context.Service<NodeDirectory, NodeDirectoryShape>()("openbot/core/NodeDirectory") {}

/** Owner-facing node management for the `nodes.*` RPCs (§4.1.1). */
export class NodeAdmin extends Context.Service<
  NodeAdmin,
  {
    /** `nodes.createPairingCode`: 8 chars, single use, 10 min TTL; includes a ready-to-paste command. */
    readonly createPairingCode: Effect.Effect<PairingCode>
    readonly rename: (nodeId: NodeId, label: string) => Effect.Effect<NodeSummary, NotFound | InvalidInput>
    /** Revokes the node's key and closes its socket with 4401. The local node → `Forbidden`. */
    readonly revoke: (nodeId: NodeId) => Effect.Effect<void, NotFound | Forbidden>
    /** Sets the owner-approved capabilities; effective = declared ∩ approved. */
    readonly setCapabilities: (
      nodeId: NodeId,
      approved: ReadonlyArray<string>,
    ) => Effect.Effect<NodeSummary, NotFound | InvalidInput>
  }
>()("openbot/core/NodeAdmin") {}
