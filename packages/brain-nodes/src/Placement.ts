/**
 * `PlacementServiceLive` (architecture §3.3, §4.8; D1.5): where a bot session's harness runs and where
 * its tools run. The rules are the pure `planPlacement` from core (shared with the fake and previews):
 *
 *   host = node_local                                   → native-local (built-ins on the brain)
 *   remote host, Codex + node has codex.exec-server     → codex-environment (app-server on the brain,
 *                                                         built-ins on the node through a relay)
 *   remote host, otherwise                              → brain-mcp-hands (B1: built-ins off, gateway
 *                                                         node tools aimed at the host node)
 *   + "browser" / "computer" toolsets per host capability; "node" whenever other nodes are reachable.
 *
 * For `codex-environment` the placement holds a relay grant (`RelayService`) for the session's scope:
 * `execServerUrl = ws://127.0.0.1:<internal>/relay/<nodeId>/codex.exec-server`, `authBearerToken` =
 * the grant's token. The node tunnel itself is opened per relay connection (Codex reconnects re-open).
 */
import type { BotId, NodeId, NodeSummary } from "@openbot/contracts"
import { LOCAL_NODE_ID } from "@openbot/contracts"
import {
  DataDir,
  IdGen,
  describePlacement,
  NodeDirectory,
  PlacementError,
  type PlacementPlan,
  PlacementService,
  planPlacement,
  type ResolvedPlacement,
  workspacePathFor,
} from "@openbot/core"
import { Effect, Exit, Layer, Option, Result, Scope } from "effect"
import { mkdir } from "node:fs/promises"
import { RelayService } from "./Relay.ts"

/** Environment id the Codex adapter passes to `environment/add` and `thread/start.environments`. */
export const codexEnvironmentId = (nodeId: string, botId: string): string => `${nodeId}-${botId}`

/** The prompt append: the core description plus the other reachable nodes. */
export const placementPrompt = (
  plan: PlacementPlan,
  host: NodeSummary,
  workspacePath: string,
  others: ReadonlyArray<NodeSummary>,
): string => {
  const lines = [describePlacement(plan, host, workspacePath)]
  if (plan.mode === "brain-mcp-hands") {
    lines.push("Your built-in file and shell tools are turned off; the openbot node tools act on that computer.")
  }
  if (others.length > 0 && plan.toolsets.includes("node")) {
    const list = others.map((n) => `"${n.label}" (node: "${n.id}", ${n.platform}${n.status === "online" ? "" : ", offline"})`)
    lines.push(`You can also reach ${list.join(", ")} by passing its id as the \`node\` parameter of the openbot node tools.`)
  }
  return lines.join("\n")
}

/** How long placement waits for the host node to create the bot's workspace (best effort). */
export const REMOTE_WORKSPACE_TIMEOUT_MS = 10_000

export const makePlacementService = Effect.gen(function*() {
  const directory = yield* NodeDirectory
  const dataDir = yield* DataDir
  const relays = yield* RelayService
  const ids = yield* IdGen

  const ensureBrainDir = (path: string, botId: string, nodeId: string) =>
    Effect.tryPromise({
      try: () => mkdir(path, { recursive: true }),
      catch: (cause) =>
        new PlacementError({ botId, nodeId, reason: "setup-failed", message: `Cannot create ${path}`, cause }),
    })

  /**
   * Remote workspaces (`<root>/workspaces/<botId>`) must exist before node tools, tunnels or a pty
   * use them as cwd. Best effort: the node's own policy may refuse or ask, and placement never blocks
   * on it for long; the tools then report the node's error themselves.
   */
  const ensureNodeDir = (nodeId: NodeId, botId: BotId, path: string) =>
    Effect.gen(function*() {
      const client = yield* directory.client(nodeId)
      const inv = { invocationId: yield* ids.next("inv"), botId, runId: `placement-${botId}` }
      yield* client["fs.mkdir"]({ inv, path, recursive: true })
    }).pipe(
      Effect.timeout(REMOTE_WORKSPACE_TIMEOUT_MS),
      Effect.catchCause((cause) => Effect.logDebug("could not create the remote workspace", { nodeId, path, cause })),
    )

  return PlacementService.of({
    resolve: ({ bot, driver }) =>
      Effect.gen(function*() {
        const host = yield* directory.get(bot.hostNodeId).pipe(
          Effect.mapError((e) =>
            new PlacementError({ botId: bot.id, nodeId: bot.hostNodeId, reason: "node-unavailable", message: e.message })
          ),
        )
        const planned = planPlacement({ bot, driverKind: driver.kind, capabilities: driver.capabilities, hostNode: host })
        if (Result.isFailure(planned)) return yield* planned.failure
        const plan = planned.success

        const workspacePath = workspacePathFor({ node: host, botId: bot.id, dataDir })
        // the harness process always runs on the brain; its cwd must exist
        const harnessCwd = dataDir.workspaceDir(bot.id)
        yield* ensureBrainDir(harnessCwd, bot.id, host.id)
        if (host.id !== LOCAL_NODE_ID) yield* ensureNodeDir(host.id, bot.id, workspacePath)

        const others: Array<NodeSummary> = []
        for (const id of bot.boundNodeIds) {
          if (id === host.id) continue
          const node = yield* Effect.option(directory.get(id))
          if (Option.isSome(node)) others.push(node.value)
        }

        const releaseScope = yield* Scope.make()
        const release = Scope.close(releaseScope, Exit.void)
        yield* Effect.addFinalizer(() => release)

        let codexEnvironment: ResolvedPlacement["codexEnvironment"]
        if (plan.mode === "codex-environment") {
          const grant = yield* relays.grant({
            nodeId: host.id,
            botId: bot.id,
            kind: "codex.exec-server",
            cwd: workspacePath,
          }).pipe(Scope.provide(releaseScope))
          codexEnvironment = {
            environmentId: codexEnvironmentId(host.id, bot.id),
            execServerUrl: grant.url,
            authBearerToken: grant.token,
            cwd: workspacePath,
          }
        }

        const placement: ResolvedPlacement = {
          mode: plan.mode,
          hostNodeId: host.id,
          workspacePath,
          harnessCwd,
          env: {},
          disableBuiltinTools: plan.disableBuiltinTools,
          codexEnvironment,
          toolsets: plan.toolsets,
          promptAppend: placementPrompt(plan, host, workspacePath, others),
          release,
        }
        return placement
      }),
  })
})

export const PlacementServiceLive: Layer.Layer<PlacementService, never, NodeDirectory | DataDir | RelayService | IdGen> =
  Layer.effect(PlacementService, makePlacementService)
