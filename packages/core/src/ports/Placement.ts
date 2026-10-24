/**
 * Placement port (architecture §3.3, D1.5): where a bot's harness runs and where its tools run.
 * Implemented by brain-nodes (`PlacementServiceLive`); a rule-following fake lives in `testing/`.
 *
 * The §3.3 rules themselves are pure and live here (`planPlacement`, `describePlacement`,
 * `workspacePathFor`) so brain-nodes' live implementation, the fake and `BotService.readContext`
 * (instruction preview) all agree.
 */
import type { Bot, BotId, HarnessCapabilities, NodeId, NodeSummary, PlacementMode } from "@openbot/contracts"
import { LOCAL_NODE_ID } from "@openbot/contracts"
import { hasCapability } from "@openbot/node-protocol"
import { Context, Effect, Result, Scope } from "effect"
import { type DataDirShape, joinPath } from "./DataDir.ts"
import { PlacementError } from "./errors.ts"
import type { HarnessDriver } from "./Harness.ts"

/** v1 modes (`contracts.PlacementMode`). Later: "claude-cli-on-node" | "opencode-on-node". */
export type { PlacementMode }

export type Toolset = "bot" | "node" | "browser" | "computer"
export const Toolsets: ReadonlyArray<Toolset> = ["bot", "node", "browser", "computer"]

export interface CodexEnvironment {
  readonly environmentId: string
  /** Internal relay URL, e.g. `ws://127.0.0.1:<internal>/relay/<nodeId>/codex.exec-server`. */
  readonly execServerUrl: string
  readonly authBearerToken: string
  /** cwd on the node. */
  readonly cwd: string
}

export interface ResolvedPlacement {
  readonly mode: PlacementMode
  /** `node_local` when colocated. */
  readonly hostNodeId: NodeId
  /** Absolute path ON the host node (see `workspacePathFor`). */
  readonly workspacePath: string
  /** cwd for the harness process (brain path; equals `workspacePath` for native-local). */
  readonly harnessCwd: string
  /** Extra environment for the harness process. */
  readonly env: Readonly<Record<string, string>>
  /** B1: disable the harness's built-in tools (they would run on the brain). */
  readonly disableBuiltinTools: boolean
  readonly codexEnvironment?: CodexEnvironment | undefined
  readonly toolsets: ReadonlyArray<Toolset>
  /** The `computer` screen is the host computer's own (a Mac's, `screen@1`), shared with the owner. */
  readonly sharedScreen?: boolean | undefined
  /** Describes where tools run, node OS, workspace. Appended to the instructions. */
  readonly promptAppend: string
  /** Tears down relays/tunnels. Also run automatically when the resolve scope closes. */
  readonly release: Effect.Effect<void>
}

/** The side-effect-free part of a placement (what `InstructionRenderer` and previews need). */
export type PlacementSummary = Pick<
  ResolvedPlacement,
  "mode" | "hostNodeId" | "workspacePath" | "toolsets" | "sharedScreen" | "promptAppend"
>

export interface PlacementInput {
  readonly bot: Bot
  readonly driver: HarnessDriver
}

export class PlacementService extends Context.Service<
  PlacementService,
  {
    /**
     * Rules (§3.3, `planPlacement`):
     * - host = node_local (or unset) → `native-local`;
     * - remote host: Codex + node advertises `codex.exec-server` → `codex-environment`;
     *   otherwise `brain-mcp-hands` with `disableBuiltinTools: true` and toolsets including "node";
     * - "browser"/"computer" toolsets when the host node advertises those capabilities.
     * Fails with `PlacementError` (offline host, unsupported mode, relay setup failure).
     */
    readonly resolve: (input: PlacementInput) => Effect.Effect<ResolvedPlacement, PlacementError, Scope.Scope>
  }
>()("openbot/core/PlacementService") {}

// ============================================================================ pure rules (§3.3 / D1.5)

/**
 * The bot's workspace on a node:
 * - local node → `<data>/bots/<botId>/workspace` (`DataDir.workspaceDir`);
 * - remote node → `<first root>/workspaces/<botId>` (D1.4 default root `~/openbot`).
 * Used by placement (host node) and by the gateway node tools for other bound nodes.
 */
export const workspacePathFor = (input: {
  readonly node: Pick<NodeSummary, "id" | "roots">
  readonly botId: BotId
  readonly dataDir: Pick<DataDirShape, "workspaceDir">
}): string =>
  input.node.id === LOCAL_NODE_ID
    ? input.dataDir.workspaceDir(input.botId)
    : joinPath(input.node.roots[0] ?? "~/openbot", "workspaces", input.botId)

export interface PlacementPlan {
  readonly mode: PlacementMode
  readonly disableBuiltinTools: boolean
  readonly toolsets: ReadonlyArray<Toolset>
  /** see `ResolvedPlacement.sharedScreen` */
  readonly sharedScreen?: boolean | undefined
}

/**
 * The §3.3 / D1.5 placement rules as a pure function:
 * - host offline → `node-unavailable`;
 * - host = node_local → `native-local`;
 * - remote host: Codex + driver implements `codex-environment` + node has `codex.exec-server`
 *   → `codex-environment`; otherwise `brain-mcp-hands` (built-ins off, "node" toolset) when the
 *   driver implements it; otherwise `unsupported-placement`;
 * - "node" toolset whenever the bot can reach a node other than where its native tools run;
 * - "browser" / "computer" when the host node advertises `browser` / `desktop` (or `screen`: a Mac's
 *   own screen, `sharedScreen`).
 */
export const planPlacement = (input: {
  readonly bot: Bot
  readonly driverKind: string
  readonly capabilities: HarnessCapabilities
  readonly hostNode: NodeSummary
}): Result.Result<PlacementPlan, PlacementError> => {
  const { bot, capabilities, driverKind, hostNode } = input
  if (hostNode.status !== "online") {
    return Result.fail(
      new PlacementError({
        botId: bot.id,
        nodeId: hostNode.id,
        reason: "node-unavailable",
        message: `Node ${hostNode.label} is ${hostNode.status}`,
      }),
    )
  }
  const caps = hostNode.capabilities
  const extras: Array<Toolset> = []
  if (hasCapability(caps, "browser")) extras.push("browser")
  const desktop = hasCapability(caps, "desktop")
  const sharedScreen = !desktop && hasCapability(caps, "screen")
  if (desktop || sharedScreen) extras.push("computer")
  const reachesOtherNodes = bot.boundNodeIds.some((id) => id !== hostNode.id)

  if (hostNode.id === LOCAL_NODE_ID) {
    return Result.succeed({
      mode: "native-local",
      disableBuiltinTools: false,
      toolsets: ["bot", ...(reachesOtherNodes ? (["node"] as const) : []), ...extras],
      ...(sharedScreen ? { sharedScreen } : {}),
    })
  }
  if (
    driverKind === "codex" &&
    capabilities.remotePlacements.includes("codex-environment") &&
    hasCapability(caps, "codex.exec-server")
  ) {
    return Result.succeed({
      mode: "codex-environment",
      disableBuiltinTools: false,
      toolsets: ["bot", ...(reachesOtherNodes ? (["node"] as const) : []), ...extras],
      ...(sharedScreen ? { sharedScreen } : {}),
    })
  }
  if (capabilities.remotePlacements.includes("brain-mcp-hands")) {
    return Result.succeed({
      mode: "brain-mcp-hands",
      disableBuiltinTools: true,
      toolsets: ["bot", "node", ...extras],
      ...(sharedScreen ? { sharedScreen } : {}),
    })
  }
  return Result.fail(
    new PlacementError({
      botId: bot.id,
      nodeId: hostNode.id,
      reason: "unsupported-placement",
      message: `The ${driverKind} harness cannot run tools on ${hostNode.label}`,
    }),
  )
}

/** Default `promptAppend` text for a plan (implementations may add detail, e.g. node OS hints). */
export const describePlacement = (plan: PlacementPlan, hostNode: NodeSummary, workspacePath: string): string =>
  plan.mode === "native-local"
    ? `Your tools run on this computer (${hostNode.platform}) in ${workspacePath}.`
    : `Your tools run on the computer "${hostNode.label}" (${hostNode.platform}) in ${workspacePath}. ` +
      (plan.mode === "brain-mcp-hands"
        ? "Use the openbot node tools (shell, read_file, write_file, edit_file, list_dir, glob, grep)."
        : "Your built-in tools execute there.")
