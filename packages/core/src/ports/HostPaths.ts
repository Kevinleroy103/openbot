/**
 * `HostPaths` port: the few facts about a computer's file system that project folders need and that
 * core cannot learn itself (no `node:*` in core).
 *
 * - `home(nodeId)`: the home directory on that computer, used to expand `~` in project folders and
 *   requested paths. The local computer (`node_local`) answers with the brain process's `HOME`;
 *   remote computers answer `undefined` until they report it, so `~` folders there are not matched
 *   (autonomy keeps asking for them).
 * - `projectRoot(nodeId, dir)`: the folder "Allow in ‹folder›" offers for work in `dir`: the root of
 *   the git work tree containing `dir`, else `dir` itself. `undefined` when it cannot be determined
 *   (a remote computer): the caller then offers `dir`.
 *
 * Optional: services read it with `Effect.serviceOption`; without it, `~` is never expanded and the
 * offered folder is the request's directory.
 */
import type { NodeId } from "@openbot/contracts"
import { Context, type Effect } from "effect"

export class HostPaths extends Context.Service<HostPaths, {
  readonly home: (nodeId: NodeId) => string | undefined
  readonly projectRoot: (nodeId: NodeId, dir: string) => Effect.Effect<string | undefined>
}>()("openbot/core/HostPaths") {}
