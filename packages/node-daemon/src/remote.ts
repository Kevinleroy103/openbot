// A complete remote node: NodeHandlersLive behind DialOut (the `apps/node` daemon's main layer).
import * as Layer from "effect/Layer"
import type { BrainLink, StreamDialer } from "@openbot/node-protocol"
import type { NodeConfigInput, NodeConfigShape } from "./config.ts"
import { DialOutLinksLive, DialOutLive, type BrainConnection, type DialOut, type DialOutConfig } from "./DialOut.ts"
import { NodeHandlersLive, type NodeHandlers, type NodeHandlersContext, type NodeInfo } from "./handlers.ts"

export interface RemoteNodeOptions {
  /** node configuration; `nodeId` must be the paired identity's node id */
  readonly node: NodeConfigInput | NodeConfigShape
  readonly dial: DialOutConfig
}

/**
 * Handlers + DialOut + links, wired so the handlers' `BrainLink`/`StreamDialer` are the dial-out
 * connection's (one shared instance). Building the layer starts dialing; releasing it closes the
 * connection, interrupts every session (killing process groups) and closes the browser gracefully.
 */
export const RemoteNodeLive = (
  options: RemoteNodeOptions,
): Layer.Layer<
  DialOut | NodeInfo | NodeHandlers | NodeHandlersContext | BrainLink | StreamDialer | BrainConnection
> => {
  const links = DialOutLinksLive(options.dial)
  const handlers = NodeHandlersLive(options.node).pipe(Layer.provideMerge(links))
  return DialOutLive(options.dial).pipe(Layer.provideMerge(handlers))
}
