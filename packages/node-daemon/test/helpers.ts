// Shared test wiring: the real `NodeHandlersLive` with in-memory node-side seams (BrainLink,
// StreamDialer over makeMemorySocketPair) and an RpcTest client, so every test goes through the
// same handler path the brain uses for the local node.
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import type * as Socket from "effect/socket/Socket"
import { RpcTest } from "effect/rpc"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import {
  BrainLink,
  NodeRpcs,
  StreamDialer,
  StreamRefused,
  type Invocation,
  type NodeApprovalRequest,
  type NodeApprovalResponse,
} from "@openbot/node-protocol"
import { makeMemorySocketPair } from "@openbot/node-protocol/testing"
import { NodeHandlersLive, NodeInfo, type NodeConfigInput } from "../src/index.ts"

export const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect))

/** A fresh temp dir (realpath'd, so containment checks compare canonical paths). */
export const tempDir = (prefix = "node-daemon-"): { readonly path: string; readonly cleanup: () => void } => {
  const p = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  return { path: p, cleanup: () => rmSync(p, { recursive: true, force: true }) }
}

let invSeq = 0
export const inv = (botId = "bot_1", toolCallId?: string): Invocation => ({
  invocationId: `inv_${++invSeq}`,
  botId,
  runId: `${botId}:conv_1`,
  ...(toolCallId ? { toolCallId } : {}),
})

/** Brain-side state of the in-memory links. */
export interface FakeBrain {
  readonly approvals: Array<NodeApprovalRequest>
  readonly events: Array<{ readonly type: string; readonly data: unknown }>
  /** brain end of every data stream the node dialed, by stream id */
  readonly streams: Map<string, Socket.Socket>
  decide: (request: NodeApprovalRequest) => NodeApprovalResponse["decision"]
  /** node-initiated streams (`BrainLink.openStream`) */
  readonly opened: Array<{ readonly kind: string; readonly botId: string; readonly streamId: string }>
  refuseStreams: boolean
}

let streamSeq = 0

export const makeFakeBrain = (): FakeBrain => ({
  approvals: [],
  events: [],
  streams: new Map(),
  decide: () => "allow-once",
  opened: [],
  refuseStreams: false,
})

export const fakeLinks = (brain: FakeBrain): Layer.Layer<BrainLink | StreamDialer> =>
  Layer.merge(
    Layer.succeed(BrainLink, {
      requestApproval: (request) =>
        Effect.sync(() => {
          brain.approvals.push(request)
          return { decision: brain.decide(request), by: "test" }
        }),
      openStream: ({ kind, botId }) =>
        Effect.suspend(() => {
          if (brain.refuseStreams) return Effect.fail(new StreamRefused({ kind, reason: "refused by the test brain" }))
          const ticket = { streamId: `ns_${++streamSeq}`, streamToken: "tok" }
          brain.opened.push({ kind, botId, streamId: ticket.streamId })
          return Effect.succeed(ticket)
        }),
      event: (type, data) => Effect.sync(() => void brain.events.push({ type, data })),
    }),
    Layer.succeed(StreamDialer, {
      dial: ({ ticket, kind }) =>
        Effect.suspend(() => {
          if (ticket.streamToken === "expired")
            return Effect.fail(new StreamRefused({ kind, reason: "expired ticket" }))
          const pair = makeMemorySocketPair()
          brain.streams.set(ticket.streamId, pair.b)
          return Effect.succeed(pair.a)
        }),
    }),
  )

export interface TestNodeOptions extends Partial<NodeConfigInput> {
  readonly dataDir: string
}

/** Build the real handlers and an RpcTest client for them. */
export const makeTestNode = (options: TestNodeOptions) =>
  Effect.gen(function* () {
    const brain = makeFakeBrain()
    const config: NodeConfigInput = {
      nodeId: "nod_test",
      detectBinaries: false,
      forwardAudit: false,
      ...options,
      browser: { enabled: false, headless: true, ...options.browser },
    }
    const ctx = yield* Layer.build(NodeHandlersLive(config).pipe(Layer.provide(fakeLinks(brain))))
    const client = yield* RpcTest.makeClient(NodeRpcs).pipe(Effect.provide(ctx))
    return { client, brain, info: Context.get(ctx, NodeInfo), context: ctx }
  })
