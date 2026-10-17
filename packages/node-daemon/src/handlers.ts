// NodeHandlersLive: the `NodeRpcs` handlers of a node (docs/architecture.md §4.7). The same layer
// serves the remote daemon (behind DialOut, which wraps the raw handlers in the per-connection
// `node.hello` gate, gate.ts) and the brain's in-process local node (brain-nodes provides
// BrainLink + StreamDialer in-process and needs no hello, links.ts).
import * as Context from "effect/Context"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as FiberSet from "effect/FiberSet"
import * as Layer from "effect/Layer"
import type { Rpc, RpcGroup } from "effect/rpc"
import {
  BrainLink,
  BrowserUnavailable,
  Capabilities,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  NotAuthenticated,
  NodeRpcs,
  PolicyRefused,
  PROTOCOL_VERSION,
  StreamDialer,
  TunnelFailed,
  negotiateProtocol,
  type BrowserAction,
  type NodeHello,
} from "@openbot/node-protocol"
import { AuditLog, AuditLogLive } from "./AuditLog.ts"
import { BrowserManager, BrowserManagerLive } from "./browser/BrowserManager.ts"
import { NodeConfig, NodeConfigLive, type NodeConfigInput, type NodeConfigShape } from "./config.ts"
import { makeFsOps } from "./fs.ts"
import { makeGuard } from "./guard.ts"
import { NodePolicy, NodePolicyLive } from "./NodePolicy.ts"
import { PathPolicy, PathPolicyLive } from "./PathPolicy.ts"
import {
  availableTunnels,
  makeForwardListen,
  makePtyOpen,
  makeServiceStart,
  makeServiceStop,
  makeTunnelOpen,
  type ServiceRegistry,
} from "./sessions.ts"
import { makeShellExec } from "./shell.ts"
import { makeFsDownload, makeFsUpload } from "./transfer.ts"
import { openDuplex } from "./sockets.ts"

/** Static facts about this node, for `node.hello`, heartbeats and the composition root. */
export interface NodeInfoShape {
  readonly nodeId: string
  /** `NodeHello` with `brainVerified` and the negotiated `protocol` filled in by the caller. */
  readonly hello: (options: { readonly brainVerified: boolean; readonly protocol: number }) => NodeHello
  readonly capabilities: ReadonlyArray<string>
  /** running `shell.exec` invocations */
  readonly activeInvocations: () => number
}

export class NodeInfo extends Context.Service<NodeInfo, NodeInfoShape>()("openbot/node-daemon/NodeInfo") {}

export type NodeHandlersContext = Rpc.ToHandler<RpcGroup.Rpcs<typeof NodeRpcs>>

/** The plain handler record (what `NodeRpcs.toHandlers` takes). */
export type NodeHandlerRecord = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof NodeRpcs>>

/**
 * The raw handler record, so a connection can wrap it (DialOut's `node.hello` gate) and build its
 * own handler context with `NodeRpcs.toHandlers`.
 */
export class NodeHandlers extends Context.Service<NodeHandlers, { readonly handlers: NodeHandlerRecord }>()(
  "openbot/node-daemon/NodeHandlers",
) {}

const describeAction = (a: BrowserAction): string => {
  switch (a._tag) {
    case "navigate":
      return `navigate ${a.url}`
    case "type":
      return `type ${a.text.length} chars${a.ref ? ` into ${a.ref}` : ""}`
    case "tabs":
      return `tabs ${a.op}${a.url ? ` ${a.url}` : ""}`
    case "click":
      return `click ${a.ref ?? `${a.x},${a.y}`}`
    case "key":
      return `key ${a.key}`
    default:
      return a._tag
  }
}

/** Capabilities this node declares, from its config and what is installed. */
export const nodeCapabilities = (config: NodeConfigShape, browserAvailable: boolean): ReadonlyArray<string> => [
  Capabilities.fs,
  Capabilities.shell,
  Capabilities.pty,
  Capabilities.tunnel,
  ...(browserAvailable ? [Capabilities.browser] : []),
  ...(config.binaries.codex ? [Capabilities.codexExecServer] : []),
  ...(config.binaries.opencode ? [Capabilities.opencodeServe] : []),
]

/** Build the handler record (all services from the environment). */
export const makeNodeHandlers = Effect.gen(function* () {
  const config = yield* NodeConfig
  const paths = yield* PathPolicy
  const policy = yield* NodePolicy
  const audit = yield* AuditLog
  const browser = yield* BrowserManager
  const brain = yield* BrainLink
  const dialer = yield* StreamDialer
  const scope = yield* Effect.scope
  const sessions = yield* FiberSet.make<unknown, unknown>()
  const runFork = yield* FiberSet.makeRuntime<never>()
  const guard = makeGuard(policy, audit)
  const active = { count: 0 }
  const registry: ServiceRegistry = { services: new Map(), next: 0 }
  const fs = makeFsOps({ config, paths, guard })
  const sessionDeps = { config, paths, guard, dialer, brain, sessions, scope }
  const capabilities = nodeCapabilities(config, browser.available)

  const info: NodeInfoShape = {
    nodeId: config.nodeId,
    capabilities,
    activeInvocations: () => active.count,
    hello: ({ brainVerified, protocol }) => ({
      nodeId: config.nodeId,
      version: config.version,
      hostname: config.hostname,
      platform: config.platform,
      arch: config.arch,
      protocol,
      roots: paths.roots,
      capabilities: [...capabilities],
      tunnels: [...availableTunnels(config)],
      policy: { ceiling: policy.summary.ceiling, remoteManaged: policy.summary.remoteManaged },
      brainVerified,
    }),
  }

  const browserAllowed = Effect.suspend(() =>
    policy.ceilingFor("browser") === "never"
      ? Effect.fail(new PolicyRefused({ action: "browser", reason: "The node's policy does not allow the browser.", retry: false }))
      : Effect.void,
  )

  const handlers = NodeRpcs.of({
    "node.hello": ({ protocol }) =>
      Effect.gen(function* () {
        const chosen = negotiateProtocol({ min: MIN_SUPPORTED_PROTOCOL_VERSION, max: PROTOCOL_VERSION }, protocol)
        if (chosen === undefined) {
          return yield* new NotAuthenticated({ reason: `no common protocol version (node ${MIN_SUPPORTED_PROTOCOL_VERSION}-${PROTOCOL_VERSION})` })
        }
        return info.hello({ brainVerified: false, protocol: chosen })
      }),
    "fs.read": fs.read,
    "fs.download": makeFsDownload(sessionDeps),
    "fs.upload": makeFsUpload(sessionDeps),
    "fs.write": fs.write,
    "fs.edit": fs.edit,
    "fs.stat": fs.stat,
    "fs.list": fs.list,
    "fs.glob": fs.glob,
    "fs.grep": fs.grep,
    "fs.mkdir": fs.mkdir,
    "fs.move": fs.move,
    "fs.remove": fs.remove,
    "shell.exec": makeShellExec({ config, paths, guard, active }),
    "pty.open": makePtyOpen(sessionDeps),
    "tunnel.open": makeTunnelOpen(sessionDeps),
    "service.start": makeServiceStart(sessionDeps, registry),
    "service.stop": (p) => makeServiceStop(registry)(p),
    "forward.listen": makeForwardListen(sessionDeps, runFork),
    "browser.ensure": ({ botId }) => Effect.andThen(browserAllowed, browser.ensure(botId)),
    "browser.action": ({ inv, action }) =>
      guard({ inv, action: "browser", target: describeAction(action) }, browser.action(inv.botId, action)),
    "browser.screencast": ({ botId, streamId, streamToken, options }) =>
      Effect.gen(function* () {
        if (!browser.available) return yield* new BrowserUnavailable({ reason: "no Chromium or Chrome was found on this node" })
        const ready = yield* Deferred.make<string, BrowserUnavailable | TunnelFailed>()
        yield* FiberSet.run(
          sessions,
          Effect.scoped(
            Effect.gen(function* () {
              const socket = yield* dialer
                .dial({ ticket: { streamId, streamToken }, kind: "cdp-screencast" })
                .pipe(Effect.mapError((e) => new TunnelFailed({ kind: "cdp-screencast", reason: `stream refused: ${e.reason}` })))
              const io = yield* openDuplex(socket).pipe(
                Effect.mapError((e) => new TunnelFailed({ kind: "cdp-screencast", reason: `stream failed: ${e.message}` })),
              )
              yield* browser.screencast({
                botId,
                io,
                options,
                onStarted: (windowTargetId) => Effect.asVoid(Deferred.succeed(ready, windowTargetId)),
              })
            }),
          ).pipe(
            Effect.catchCause((cause) => {
              const e = Cause.squash(cause)
              return Deferred.fail(
                ready,
                e instanceof BrowserUnavailable || e instanceof TunnelFailed
                  ? e
                  : new TunnelFailed({ kind: "cdp-screencast", reason: Cause.hasInterruptsOnly(cause) ? "the node is shutting down" : String(e) }),
              )
            }),
            Effect.asVoid,
          ),
        )
        return { windowTargetId: yield* Deferred.await(ready) }
      }),
    "browser.input": ({ botId, event }) => browser.input(botId, event),
    "lease.set": ({ botId, holder }) => browser.setLease(botId, holder),
  })

  return { handlers, info }
})

/**
 * The handler layer for `NodeRpcs` (+ `NodeInfo`, `NodeHandlers`). Requires `BrainLink | StreamDialer`:
 * DialOut provides them for a remote node; brain-nodes provides them in-process for the local node.
 * The handlers are UNGATED (`node.hello` answers with `brainVerified: false`); a remote connection
 * must gate them (DialOut does).
 */
export const NodeHandlersLive = (
  config: NodeConfigInput | NodeConfigShape,
): Layer.Layer<NodeHandlersContext | NodeInfo | NodeHandlers, never, BrainLink | StreamDialer> =>
  NodeHandlersFromServices.pipe(
    Layer.provide(Layer.mergeAll(PathPolicyLive, NodePolicyLive, AuditLogLive, BrowserManagerLive)),
    Layer.provide(NodeConfigLive(config)),
  )

/** Same as `NodeHandlersLive`, with every node service taken from the environment (tests, custom wiring). */
export const NodeHandlersFromServices: Layer.Layer<
  NodeHandlersContext | NodeInfo | NodeHandlers,
  never,
  NodeConfig | PathPolicy | NodePolicy | AuditLog | BrowserManager | BrainLink | StreamDialer
> = Layer.effectContext(
  Effect.gen(function* () {
    const { handlers, info } = yield* makeNodeHandlers
    const ctx = yield* NodeRpcs.toHandlers(handlers)
    return ctx.pipe(Context.add(NodeInfo, info), Context.add(NodeHandlers, { handlers }))
  }),
)
