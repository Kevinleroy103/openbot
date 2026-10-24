// Shared test wiring: fake NodeRpcs / BrainRpcs handlers and a connected brain <-> node peer pair.
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import {
  BrainRpcs,
  DesktopUnavailable,
  generateKeyPair,
  makePeer,
  nodeStamp,
  NodeRpcs,
  NotAuthenticated,
  PathDenied,
  signHello,
  StreamRefused,
  stampedNodeId,
  verifyHello,
  type ExecEvent,
  type KeyPair,
  type Invocation,
} from "../src/index.ts"
import { makeMemorySocketPair } from "../src/testing.ts"

export const NODE_ID = "nod_test1"
export const ORIGIN = "https://brain.example"
export const inv = (botId = "bot_1"): Invocation => ({ invocationId: crypto.randomUUID(), botId, runId: "run_1" })

export interface NodeState {
  readonly brainPublicKey: string
  readonly upgradeNonce: string
  verified: boolean
  readonly execInterrupted: Deferred.Deferred<void>
  execTicks: number
}

const unused = () => Effect.die("unused in this test")

export const NodeHandlers = (state: NodeState) =>
  NodeRpcs.toLayer({
    "node.hello": (req) =>
      Effect.gen(function* () {
        const ok = yield* verifyHello({
          brainPublicKey: state.brainPublicKey,
          nodeId: NODE_ID,
          nonce: state.upgradeNonce,
          brainOrigin: ORIGIN,
          brainSig: req.brainSig,
        })
        if (!ok) return yield* new NotAuthenticated({ reason: "brain signature does not verify" })
        state.verified = true
        return {
          nodeId: NODE_ID,
          version: "0.0.0-test",
          hostname: "test-host",
          platform: "linux",
          arch: "x64",
          protocol: 1,
          roots: [{ id: "work", path: "/home/u/openbot", mode: "rw" as const }],
          capabilities: ["fs@1", "shell@1", "browser@1"],
          tunnels: [],
          policy: { ceiling: "ask" as const, remoteManaged: false },
          brainVerified: true,
        }
      }),
    "fs.read": ({ path }) =>
      state.verified
        ? path.startsWith("/etc")
          ? Effect.fail(new PathDenied({ path, reason: "outside roots" }))
          : Effect.succeed({
              content: `content of ${path}`,
              encoding: "utf8" as const,
              sha256: "00",
              size: 3,
              truncated: false,
            })
        : Effect.fail(new NotAuthenticated({ reason: "node.hello first" })),
    "fs.download": unused,
    "fs.upload": unused,
    "fs.write": unused,
    "fs.edit": unused,
    "fs.stat": unused,
    "fs.list": unused,
    "fs.glob": unused,
    "fs.grep": unused,
    "fs.mkdir": unused,
    "fs.move": unused,
    "fs.remove": unused,
    "shell.exec": () =>
      Stream.concat(
        Stream.make<Array<ExecEvent>>({ _tag: "Started", pid: 100, pgid: 100 }),
        Stream.fromEffectRepeat(
          Effect.gen(function* () {
            yield* Effect.sleep("5 millis")
            const seq = state.execTicks++
            return { _tag: "Output", stream: "stdout", data: `tick${seq}\n`, seq } as ExecEvent
          }),
        ),
      ).pipe(Stream.onExit(() => Deferred.succeed(state.execInterrupted, undefined))),
    "pty.open": unused,
    "tunnel.open": unused,
    "service.start": unused,
    "service.stop": unused,
    "forward.listen": unused,
    "browser.ensure": unused,
    "browser.action": ({ action }) =>
      Effect.succeed({ text: `did ${action._tag}`, url: action._tag === "navigate" ? action.url : undefined }),
    "browser.screencast": unused,
    "browser.input": unused,
    "lease.set": ({ botId, holder }) => Effect.succeed({ botId, holder, since: 1 }),
    "desktop.ensure": () => Effect.fail(new DesktopUnavailable({ message: "no desktop in tests", missing: ["Xvfb"] })),
    "desktop.stop": () => Effect.void,
    "computer.act": () => Effect.fail(new DesktopUnavailable({ message: "no desktop in tests" })),
    "computer.stream": () => Effect.fail(new DesktopUnavailable({ message: "no desktop in tests" })),
    "screen.ensure": () =>
      Effect.fail(new DesktopUnavailable({ message: "no screen in tests", missing: ["Screen Recording"] })),
    "screen.stream": () => Effect.fail(new DesktopUnavailable({ message: "no screen in tests" })),
    "screen.input": () => Effect.fail(new DesktopUnavailable({ message: "no screen in tests" })),
  })

export interface BrainState {
  readonly events: Array<{ nodeId: string | undefined; type: string; data: unknown }>
}

export const BrainHandlers = (state: BrainState) =>
  BrainRpcs.toLayer({
    "node.requestApproval": (req, { headers }) =>
      Effect.succeed({
        decision: req.action === "run-command" ? ("allow-once" as const) : ("deny" as const),
        by: `brain-saw:${stampedNodeId(headers)}`,
      }),
    "node.openStream": ({ kind, botId }) =>
      botId === "bot_1"
        ? Effect.succeed({ streamId: "s1", streamToken: "t".repeat(22) })
        : Effect.fail(new StreamRefused({ kind, reason: `bot ${botId} is not bound to this node` })),
    "node.event": ({ type, data }, { headers }) =>
      Effect.sync(() => {
        state.events.push({ nodeId: stampedNodeId(headers), type, data })
      }),
    "node.heartbeat": () => Effect.void,
  })

/** A connected brain <-> node pair over an in-memory socket, both as Effect RPC peers. */
export const connectedPeers = Effect.gen(function* () {
  const pair = makeMemorySocketPair()
  const brainKeys: KeyPair = yield* generateKeyPair
  const nodeState: NodeState = {
    brainPublicKey: brainKeys.publicKey,
    upgradeNonce: "nonce-from-upgrade",
    verified: false,
    execInterrupted: yield* Deferred.make<void>(),
    execTicks: 0,
  }
  const brainState: BrainState = { events: [] }
  const nodeCtx = yield* Layer.build(NodeHandlers(nodeState))
  const brainCtx = yield* Layer.build(BrainHandlers(brainState))
  const node = yield* makePeer({ socket: pair.a, serve: NodeRpcs, call: BrainRpcs }).pipe(Effect.provide(nodeCtx))
  const brain = yield* makePeer({
    socket: pair.b,
    serve: BrainRpcs,
    call: NodeRpcs,
    stamp: nodeStamp(NODE_ID),
    pingTimeout: 15_000,
  }).pipe(Effect.provide(brainCtx))
  const hello = () =>
    Effect.flatMap(
      signHello({
        brainPrivateKey: brainKeys.privateKey,
        nodeId: NODE_ID,
        nonce: nodeState.upgradeNonce,
        brainOrigin: ORIGIN,
      }),
      (brainSig) => brain.client["node.hello"]({ protocol: { min: 1, max: 1 }, brainVersion: "test", brainSig }),
    )
  return { pair, node, brain, nodeState, brainState, brainKeys, hello }
})
