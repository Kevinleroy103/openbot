/**
 * @openbot/brain-nodes — the brain side of the hands (architecture §4.8).
 *
 * Layer 0 (no core service dependencies; interfaces.md §2.3):
 *   `NodeRegistryLive`     NodeDirectory + NodeAdmin (+ internal NodeRegistry: pairing, connections,
 *                          node events, `closeAll` for shutdown)
 *   `StreamBrokerLive`     one-time data-stream tickets (`/node/stream/:id`, local in-process dials)
 *   `RelayServiceLive`     `/relay/:nodeId/:kind` grants and handler (Codex exec-server relay)
 *   `PlacementServiceLive` PlacementService (D1.5 rules via core `planPlacement`, Codex relay grants,
 *                          remote workspace creation)
 *   `ComputerServiceLive`  ComputerPort (+ the `/ws/computer` viewer and `/ws/terminal` handlers)
 *   `NodeFilesLive`        NodeFiles: node → brain file transfer (`fs.download` + `transfer` stream)
 *   `BrainNodesLive`       all of the above, composed
 * Top level (need ApprovalService):
 *   `NodeGatewayLive`      `/node`, `/node/pair`, `/node/stream/:id` handlers
 *   `LocalNodeDaemonLive(opts)` the in-process local node (`node_local`) running node-daemon's
 *                          NodeHandlersLive with `<data>/bots/{botId}/workspace` roots
 *   `LocalNodeLive(opts)`  the same with any `NodeRpcs` handler layer
 *   `HostPathsLive`        core `HostPaths` for the local computer (HOME, git repo roots)
 * Routes for the server: `NodePublicRoutes`, `NodeInternalRoutes`, `ViewerRoutes(authorize)`.
 * Shutdown: call `NodeRegistry.closeAll()` before stopping the public listener (Bun waits for open
 * WebSockets); `NodeGatewayLive` also does it when its scope closes.
 */
import type { BotRepo, DataDir, IdGen, InternalAddress, NodeRepo } from "@openbot/core"
import { Layer } from "effect"
import { ComputerServiceLive } from "./Computer.ts"
import type { BrainIdentity, BrainNodesConfig } from "./config.ts"
import { NodeRegistryLive } from "./NodeRegistry.ts"
import { PlacementServiceLive } from "./Placement.ts"
import { RelayServiceLive } from "./Relay.ts"
import { StreamBrokerLive } from "./StreamBroker.ts"
import { NodeFilesLive } from "./Transfer.ts"

export * from "./BrainHandlers.ts"
export * from "./Computer.ts"
export * from "./config.ts"
export * from "./HostPaths.ts"
export * from "./http.ts"
export * from "./LocalNode.ts"
export * from "./NodeGateway.ts"
export * from "./NodeRegistry.ts"
export * from "./Placement.ts"
export * from "./Relay.ts"
export * from "./splice.ts"
export * from "./StreamBroker.ts"
export * from "./Transfer.ts"

/**
 * Every layer-0 service of brain-nodes: `NodeDirectory`, `NodeAdmin`, `PlacementService`,
 * `ComputerPort`, `NodeFiles` (the core ports) plus the internal `NodeRegistry`, `StreamBroker`, `RelayService`
 * and `ComputerService` that the top-level layers and routes use.
 */
export const BrainNodesLive = Layer.mergeAll(PlacementServiceLive, ComputerServiceLive, NodeFilesLive).pipe(
  Layer.provideMerge(RelayServiceLive),
  Layer.provideMerge(StreamBrokerLive),
  Layer.provideMerge(NodeRegistryLive),
)

/** What `BrainNodesLive` needs from below: repositories, ids, paths, the internal address, config, identity. */
export type BrainNodesRequirements =
  | NodeRepo
  | BotRepo
  | IdGen
  | DataDir
  | InternalAddress
  | BrainNodesConfig
  | BrainIdentity
