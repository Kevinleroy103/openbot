// Node-side policy ceiling (D1.4, remote-prior-art.md §4.8, layer 2). The brain's ApprovalService
// always decides first; the node then applies its own ceiling, which the brain cannot raise:
//   never  -> refuse (model-readable, "do not retry")
//   ask    -> BrainLink.requestApproval (node.requestApproval); deny -> refuse
//   always -> run
// `run-command` additionally honours deny patterns (never) and ask patterns (always -> ask).
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { BrainLink, PolicyRefused, type Invocation, type PolicyCeiling } from "@openbot/node-protocol"
import { NodeConfig, type NodeAction, type NodePolicyConfig } from "./config.ts"

export interface PolicyDecision {
  readonly ceiling: PolicyCeiling
  /** "node" when the ceiling allowed it, "brain:<by>" when it was asked, "cached" for allow-always grants */
  readonly by: string
  readonly asked: boolean
}

export interface PolicyCheck {
  readonly inv:
    | Invocation
    | { readonly botId: string; readonly invocationId?: string; readonly runId?: string; readonly toolCallId?: string }
  readonly action: NodeAction
  readonly target: string
  readonly reason?: string | undefined
}

export interface NodePolicyShape {
  readonly check: (input: PolicyCheck) => Effect.Effect<PolicyDecision, PolicyRefused>
  /** Effective ceiling for an action (and, for `run-command`, a command line). */
  readonly ceilingFor: (action: NodeAction, target?: string) => PolicyCeiling
  readonly summary: { readonly ceiling: PolicyCeiling; readonly remoteManaged: boolean }
}

export class NodePolicy extends Context.Service<NodePolicy, NodePolicyShape>()("openbot/node-daemon/NodePolicy") {}

const compile = (sources: ReadonlyArray<string>): ReadonlyArray<RegExp> =>
  sources.flatMap((s) => {
    try {
      return [new RegExp(s)]
    } catch {
      return []
    }
  })

export const makeNodePolicy = (config: NodePolicyConfig, brain: BrainLink["Service"]): NodePolicyShape => {
  const ask = compile(config.askCommands)
  const deny = compile(config.denyCommands)
  /** allow-always grants from the brain, per bot + action + target (in memory, this process only) */
  const grants = new Set<string>()

  const ceilingFor = (action: NodeAction, target?: string): PolicyCeiling => {
    const base = config.actions[action] ?? config.ceiling
    if (action !== "run-command" || target === undefined) return base
    if (deny.some((r) => r.test(target))) return "never"
    if (base === "always" && ask.some((r) => r.test(target))) return "ask"
    return base
  }

  const check: NodePolicyShape["check"] = (input) =>
    Effect.gen(function* () {
      const ceiling = ceilingFor(input.action, input.target)
      if (ceiling === "always") return { ceiling, by: "node", asked: false }
      if (ceiling === "never") {
        return yield* new PolicyRefused({
          action: input.action,
          reason:
            input.action === "run-command" && (config.actions["run-command"] ?? config.ceiling) !== "never"
              ? "This command matches the node's deny-list."
              : `The node's policy does not allow ${input.action}.`,
          retry: false,
        })
      }
      const key = `${input.inv.botId}\u0000${input.action}\u0000${input.target}`
      if (grants.has(key)) return { ceiling, by: "cached", asked: false }
      const inv = input.inv as Partial<Invocation> & { botId: string }
      const res = yield* brain.requestApproval({
        invocationId: inv.invocationId ?? "",
        botId: inv.botId,
        runId: inv.runId,
        toolCallId: inv.toolCallId,
        action: input.action,
        target: input.target,
        reason: input.reason ?? `The node's policy asks before ${input.action}.`,
      })
      if (res.decision === "deny") {
        return yield* new PolicyRefused({
          action: input.action,
          reason:
            res.by === "unreachable"
              ? "The node could not reach the brain to ask for approval."
              : `Denied by ${res.by}.`,
          retry: false,
        })
      }
      if (res.decision === "allow-always") grants.add(key)
      return { ceiling, by: `brain:${res.by}`, asked: true }
    })

  return { check, ceilingFor, summary: { ceiling: config.ceiling, remoteManaged: false } }
}

export const NodePolicyLive: Layer.Layer<NodePolicy, never, NodeConfig | BrainLink> = Layer.effect(
  NodePolicy,
  Effect.gen(function* () {
    const config = yield* NodeConfig
    const brain = yield* BrainLink
    return NodePolicy.of(makeNodePolicy(config.policy, brain))
  }),
)
