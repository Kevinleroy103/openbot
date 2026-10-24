// Shared test wiring: a real Bun HTTP/WebSocket server with the brain-nodes routes, the layer stack
// over in-memory repositories, and a fake REMOTE node that pairs, dials `/node` with a signed upgrade
// and serves `NodeRpcs` (inline handlers) over the direction mux.
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import type { Bot, NodeId } from "@openbot/contracts"
import { BotRepo, DataDir, InternalAddress } from "@openbot/core"
import {
  ApprovalServiceFake,
  MemoryBotRepo,
  MemoryNodeRepo,
  MemoryRequestRepo,
  MemoryTaskRepo,
  MemoryTurnRepo,
  SequentialIdGen,
} from "@openbot/core/testing"
import {
  BrainRpcs,
  type ComputerAction,
  type DesktopSupport,
  type ScreenSupport,
  DesktopUnavailable,
  encodeScreencastFrame,
  type ExecEvent,
  generateKeyPair,
  type KeyPair,
  LeaseHeld,
  makePeer,
  makeUpgradeAuth,
  type NodeHello,
  NodeRpcs,
  NotAuthenticated,
  PathDenied,
  type PairResponse,
  type Peer,
  Routes,
  formatStreamAuth,
  verifyHello,
} from "@openbot/node-protocol"
import { Context, Deferred, Effect, Layer, Scope, Stream } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import type { Rpc, RpcGroup } from "effect/rpc"
import * as Socket from "effect/socket/Socket"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  allowAllViewers,
  BrainIdentity,
  BrainNodesConfig,
  BrainNodesLive,
  LocalNodeDaemonLive,
  type LocalNodeDaemonOptions,
  NodeGatewayLive,
  NodeInternalRoutes,
  NodePublicRoutes,
  ViewerRoutes,
} from "../src/index.ts"

export const BRAIN_ORIGIN = "https://brain.test"

export const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect))

export const tempDir = (): { readonly path: string; readonly cleanup: () => void } => {
  const path = mkdtempSync(join(tmpdir(), "brain-nodes-"))
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}

/** InternalAddress backed by a Deferred: completed once the test server is bound. */
export class TestAddress extends Context.Service<TestAddress, Deferred.Deferred<string>>()("test/TestAddress") {}

export interface StackOptions {
  readonly dataRoot: string
  /** Register `node_local` (default false). */
  readonly localNode?: boolean
  /**
   * Run the real node-daemon handlers as the local node (`LocalNodeDaemonLive`) with these options.
   * Implies `localNode: true`.
   */
  readonly localDaemon?: LocalNodeDaemonOptions
  readonly streamTokenTtlMs?: number
  readonly brainKeys?: KeyPair
  /** Brain-side half-open detection (default: the production 20 s). */
  readonly livenessTimeoutMs?: number
  /** Idle desktops sleep after this long (default: the production 10 min). */
  readonly desktopIdleMs?: number
  /** The brain builds the node from this entry (`/node/install.sh`, `/node/download/:target`). */
  readonly nodeInstall?: { readonly entry: string }
  /** Extra port layers (e.g. a LiveHub mock feeding the local node's project folders). */
  readonly extra?: Layer.Layer<any>
}

/** Repositories + ids + config + approvals fake + every brain-nodes layer (layer 0 + gateway). */
export const brainStack = (options: StackOptions) => {
  const address = Layer.effect(TestAddress, Deferred.make<string>())
  const internal = Layer.effect(
    InternalAddress,
    Effect.map(TestAddress, (d) => InternalAddress.of({ baseUrl: Deferred.await(d) })),
  )
  const ports = Layer.mergeAll(
    MemoryNodeRepo,
    MemoryBotRepo,
    MemoryTurnRepo,
    MemoryTaskRepo,
    MemoryRequestRepo,
    DataDir.layer(options.dataRoot),
    BrainNodesConfig.layer({
      brainOrigin: BRAIN_ORIGIN,
      brainVersion: "0.0.0-test",
      localNode: { enabled: options.localNode ?? options.localDaemon !== undefined },
      streamTokenTtlMs: options.streamTokenTtlMs,
      helloTimeoutMs: 5_000,
      livenessTimeoutMs: options.livenessTimeoutMs,
      desktopIdleMs: options.desktopIdleMs,
      nodeInstall: options.nodeInstall,
    }),
    options.brainKeys === undefined ? BrainIdentity.layerEphemeral : BrainIdentity.layer(options.brainKeys),
    ApprovalServiceFake.layer(),
    options.extra ?? Layer.empty,
  ).pipe(Layer.provideMerge(internal), Layer.provideMerge(address), Layer.provideMerge(SequentialIdGen()))
  const top =
    options.localDaemon === undefined
      ? NodeGatewayLive
      : Layer.merge(NodeGatewayLive, LocalNodeDaemonLive(options.localDaemon))
  return top.pipe(Layer.provideMerge(BrainNodesLive), Layer.provideMerge(ports))
}

/**
 * Serve the brain-nodes routes (public + internal + viewer routes with an allow-all authorizer) on an
 * ephemeral port. Completes `TestAddress` with the base URL.
 */
export const startServer = Effect.gen(function* () {
  const routes = Layer.mergeAll(NodePublicRoutes, NodeInternalRoutes, ViewerRoutes(allowAllViewers))
  const context = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(BunHttpServer.layer({ port: 0, hostname: "127.0.0.1", websocket: { idleTimeout: 0 } })),
    ),
  )
  const server = Context.get(context, HttpServer.HttpServer)
  const address = server.address
  if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address")
  const base = `http://127.0.0.1:${address.port}`
  yield* Deferred.succeed(yield* TestAddress, base)
  return { http: base, ws: base.replace(/^http/, "ws") }
})

export const putBot = (bot: Bot) => Effect.flatMap(BotRepo, (repo) => Effect.orDie(repo.upsert(bot)))

// ============================================================================ fake remote node

export interface TestNodeState {
  verified: boolean
  readonly approvals: Array<unknown>
  readonly ensured: Array<string>
  readonly screencasts: Array<string>
  readonly tunnels: Array<{ kind: string; cwd: string; botId: string }>
  readonly ptys: Array<{ cols: number; rows: number; cwd: string }>
  readonly leases: Array<{ botId: string; holder: string }>
  readonly inputs: Array<unknown>
  /** desktop@1: `desktop.ensure` / `desktop.stop` calls (bot ids), `computer.act` actions */
  readonly desktops: Array<string>
  readonly stopped: Array<string>
  readonly acts: Array<{ botId: string; action: ComputerAction }>
  /** `computer.stream` calls, and the bytes each VNC stream received from the brain */
  readonly vncStreams: Array<{ botId: string; mode: string }>
  readonly vncReceived: Array<Uint8Array>
  /** `desktop.ensure` fails with this when set (programs missing) */
  desktopFailure?: DesktopUnavailable | undefined
  /** screen@1: `screen.ensure` / `screen.stream` calls (bot ids), owner input */
  readonly screenEnsured: Array<string>
  readonly screenStreams: Array<string>
  readonly screenInputs: Array<unknown>
  /** `screen.ensure` fails with this when set (permissions missing) */
  screenFailure?: DesktopUnavailable | undefined
}

/** What the fake node's VNC server sends first (an RFB ProtocolVersion). */
export const RFB_GREETING = new TextEncoder().encode("RFB 003.008\n")

export type NodeRpcHandlers = Rpc.ToHandler<RpcGroup.Rpcs<typeof NodeRpcs>>

const unused = () => Effect.die("unused in this test")

/** Pair a fresh key with the brain over HTTP (`POST /node/pair`). */
export const pairOverHttp = (httpBase: string, code: string, keys: KeyPair, hostname = "laptop") =>
  Effect.promise(async () => {
    const res = await fetch(`${httpBase}${Routes.pair}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        publicKey: keys.publicKey,
        hostname,
        platform: "linux",
        arch: "x64",
        nodeVersion: "9.9.9",
      }),
    })
    return { status: res.status, body: (await res.json()) as PairResponse & { error?: string } }
  })

/** Dial a WebSocket (Bun client) with headers; the socket is scoped to the caller. */
export const dialWebSocket = (url: string, headers?: Record<string, string>) =>
  Socket.makeWebSocket(url, { headers, openTimeout: 5_000 }).pipe(Effect.provide(BunSocket.layerWebSocketConstructor))

/**
 * NodeRpcs handlers of the fake node: hello verifies the brain signature with the pinned key and the
 * upgrade nonce; every other RPC is refused until then.
 */
export const testNodeHandlers = (input: {
  readonly nodeId: string
  readonly brainPublicKey: string
  readonly brainOrigin: string
  readonly nonce: string
  readonly wsBase: string
  readonly capabilities: ReadonlyArray<string>
  readonly state: TestNodeState
  readonly desktop?: DesktopSupport | undefined
  readonly screen?: ScreenSupport | undefined
}) => {
  const { state } = input
  const leaseOf = (botId: string) => state.leases.filter((l) => l.botId === botId).at(-1)?.holder ?? "bot"
  const gate = <A, E>(effect: Effect.Effect<A, E>) =>
    state.verified ? effect : Effect.fail(new NotAuthenticated({ reason: "node.hello first" }))
  /** Echo a data stream verbatim (dialed like a real node: `/node/stream/:id` + bearer). */
  const echoStream = (streamId: string, streamToken: string, prefix: string) =>
    Effect.forkDetach(
      Effect.scoped(
        Effect.gen(function* () {
          const socket = yield* dialWebSocket(`${input.wsBase}${Routes.stream(streamId)}`, {
            authorization: formatStreamAuth(streamToken),
          })
          const reader = yield* socket.reader
          const writer = yield* socket.writer
          yield* writer.write(`${prefix}:ready`)
          yield* Effect.forever(
            Effect.flatMap(reader.pull, (frames) =>
              Effect.forEach(frames, (f) => writer.write(typeof f === "string" ? `${prefix}:${f}` : f), {
                discard: true,
              }),
            ),
          )
        }),
      ).pipe(Effect.ignore),
    )
  return NodeRpcs.toLayer({
    "node.hello": (req) =>
      Effect.gen(function* () {
        const ok = yield* verifyHello({
          brainPublicKey: input.brainPublicKey,
          nodeId: input.nodeId,
          nonce: input.nonce,
          brainOrigin: input.brainOrigin,
          brainSig: req.brainSig,
        })
        if (!ok) return yield* new NotAuthenticated({ reason: "brain signature does not verify" })
        state.verified = true
        return {
          nodeId: input.nodeId,
          version: "9.9.9",
          hostname: "laptop",
          platform: "linux",
          arch: "x64",
          protocol: 1,
          roots: [{ id: "work", path: "/home/u/openbot", mode: "rw" as const }],
          capabilities: [...input.capabilities],
          tunnels: ["codex.exec-server"],
          policy: { ceiling: "ask" as const, remoteManaged: false },
          brainVerified: true,
          ...(input.desktop === undefined ? {} : { desktop: input.desktop }),
          ...(input.screen === undefined ? {} : { screen: input.screen }),
        } satisfies NodeHello
      }),
    "fs.read": ({ path }) =>
      gate(
        path.startsWith("/etc")
          ? Effect.fail(new PathDenied({ path, reason: "outside roots" }))
          : Effect.succeed({
              content: `remote:${path}`,
              encoding: "utf8" as const,
              sha256: "00",
              size: 1,
              truncated: false,
            }),
      ),
    "fs.download": unused,
    "fs.upload": unused,
    "fs.write": unused,
    "fs.edit": unused,
    "fs.stat": unused,
    "fs.list": unused,
    "fs.glob": unused,
    "fs.grep": unused,
    "fs.mkdir": () => gate(Effect.void),
    "fs.move": unused,
    "fs.remove": unused,
    "shell.exec": ({ command }) =>
      state.verified
        ? Stream.make<Array<ExecEvent>>(
            { _tag: "Started", pid: 7, pgid: 7 },
            { _tag: "Output", stream: "stdout", data: `ran ${command}\n`, seq: 0 },
            { _tag: "Exit", code: 0, signal: null, timedOut: false, durationMs: 1 },
          )
        : Stream.fail(new NotAuthenticated({ reason: "node.hello first" })),
    "pty.open": ({ cols, cwd, rows, streamId, streamToken }) =>
      gate(
        Effect.gen(function* () {
          state.ptys.push({ cols, rows, cwd })
          yield* echoStream(streamId, streamToken, "pty")
          return { pid: 42 }
        }),
      ),
    "tunnel.open": ({ cwd, inv, kind, streamId, streamToken }) =>
      gate(
        Effect.gen(function* () {
          state.tunnels.push({ kind, cwd, botId: inv.botId })
          yield* echoStream(streamId, streamToken, kind)
          return { pid: 43 }
        }),
      ),
    "service.start": unused,
    "service.stop": unused,
    "forward.listen": unused,
    "browser.ensure": ({ botId }) =>
      gate(
        Effect.sync(() => {
          state.ensured.push(botId)
          return { windowTargetId: `win-${botId}`, width: 1280, height: 800 }
        }),
      ),
    "browser.action": unused,
    "browser.screencast": ({ botId, streamId, streamToken }) =>
      gate(
        Effect.gen(function* () {
          state.screencasts.push(botId)
          // like the real node: dial the stream, send the URL and one frame, then keep it open
          yield* Effect.forkDetach(
            Effect.scoped(
              Effect.gen(function* () {
                const socket = yield* dialWebSocket(`${input.wsBase}${Routes.stream(streamId)}`, {
                  authorization: formatStreamAuth(streamToken),
                })
                const writer = yield* socket.writer
                const reader = yield* socket.reader
                yield* writer.write(JSON.stringify({ _tag: "Url", url: "https://example.com/", title: "Example" }))
                const meta = {
                  seq: 1,
                  mime: "image/jpeg",
                  width: 2,
                  height: 2,
                  viewportWidth: 2,
                  viewportHeight: 2,
                  timestamp: 1,
                }
                yield* writer.write(encodeScreencastFrame(meta, new Uint8Array([0xff, 0xd8, 0xff, 0xd9])))
                yield* Effect.forever(reader.pull)
              }),
            ).pipe(Effect.ignore),
          )
          return { windowTargetId: `win-${botId}` }
        }),
      ),
    "browser.input": ({ event }) => gate(Effect.sync(() => void state.inputs.push(event))),
    "lease.set": ({ botId, holder }) =>
      gate(
        Effect.sync(() => {
          state.leases.push({ botId, holder })
          return { botId, holder, since: 1 }
        }),
      ),
    "desktop.ensure": ({ botId }) =>
      gate(
        state.desktopFailure !== undefined
          ? Effect.fail(state.desktopFailure)
          : Effect.sync(() => {
              state.desktops.push(botId)
              return { botId, display: ":101", width: 1920, height: 1200 }
            }),
      ),
    "desktop.stop": ({ botId }) =>
      gate(
        Effect.sync(() => {
          state.stopped.push(botId)
          // stopping a desktop ends the user's control (like the real node)
          state.leases.push({ botId, holder: "bot" })
        }),
      ),
    "computer.act": ({ action, inv }) =>
      gate(
        leaseOf(inv.botId) === "user"
          ? Effect.fail(
              new LeaseHeld({ botId: inv.botId, holder: "user", reason: "the user is controlling the screen" }),
            )
          : Effect.sync(() => {
              state.acts.push({ botId: inv.botId, action })
              return { text: `did ${action.action}` }
            }),
      ),
    "computer.stream": ({ botId, mode, streamId, streamToken }) =>
      gate(
        mode === "control" && leaseOf(botId) !== "user"
          ? Effect.fail(new LeaseHeld({ botId, holder: "bot", reason: "take control first" }))
          : Effect.gen(function* () {
              state.vncStreams.push({ botId, mode })
              // like x11vnc behind the node: greet, then answer every binary frame (0xEE + the bytes)
              yield* Effect.forkDetach(
                Effect.scoped(
                  Effect.gen(function* () {
                    const socket = yield* dialWebSocket(`${input.wsBase}${Routes.stream(streamId)}`, {
                      authorization: formatStreamAuth(streamToken),
                    })
                    const reader = yield* socket.reader
                    const writer = yield* socket.writer
                    yield* writer.write(RFB_GREETING)
                    yield* Effect.forever(
                      Effect.flatMap(reader.pull, (frames) =>
                        Effect.forEach(
                          frames,
                          (f) => {
                            if (typeof f === "string") return Effect.void
                            state.vncReceived.push(f)
                            const reply = new Uint8Array(f.byteLength + 1)
                            reply[0] = 0xee
                            reply.set(f, 1)
                            return writer.write(reply)
                          },
                          { discard: true },
                        ),
                      ),
                    )
                  }),
                ).pipe(Effect.ignore),
              )
            }),
      ),
    "screen.ensure": ({ botId }) =>
      gate(
        state.screenFailure !== undefined
          ? Effect.fail(state.screenFailure)
          : Effect.sync(() => {
              state.screenEnsured.push(botId)
              return { width: 1440, height: 900 }
            }),
      ),
    "screen.stream": ({ botId, streamId, streamToken }) =>
      gate(
        Effect.gen(function* () {
          state.screenStreams.push(botId)
          // like a Mac: dial the stream, send a frame, keep it open
          yield* Effect.forkDetach(
            Effect.scoped(
              Effect.gen(function* () {
                const socket = yield* dialWebSocket(`${input.wsBase}${Routes.stream(streamId)}`, {
                  authorization: formatStreamAuth(streamToken),
                })
                const writer = yield* socket.writer
                const reader = yield* socket.reader
                const meta = {
                  seq: 1,
                  mime: "image/jpeg",
                  width: 1280,
                  height: 800,
                  viewportWidth: 1280,
                  viewportHeight: 800,
                  timestamp: 1,
                }
                yield* writer.write(encodeScreencastFrame(meta, new Uint8Array([0xff, 0xd8, 0xff, 0xd9])))
                yield* Effect.forever(reader.pull)
              }),
            ).pipe(Effect.ignore),
          )
        }),
      ),
    "screen.input": ({ botId, event }) =>
      gate(
        leaseOf(botId) !== "user"
          ? Effect.fail(new LeaseHeld({ botId, holder: "bot", reason: "take control first" }))
          : Effect.sync(() => void state.screenInputs.push(event)),
      ),
  })
}

export interface TestNode {
  readonly peer: Peer<RpcGroup.Rpcs<typeof BrainRpcs>>
  readonly state: TestNodeState
  /** close code the node saw (resolves when the connection ends) */
  readonly closeCode: Effect.Effect<number | undefined>
}

export const newNodeState = (): TestNodeState => ({
  verified: false,
  approvals: [],
  tunnels: [],
  ptys: [],
  leases: [],
  inputs: [],
  ensured: [],
  screencasts: [],
  desktops: [],
  stopped: [],
  acts: [],
  vncStreams: [],
  vncReceived: [],
  screenEnsured: [],
  screenStreams: [],
  screenInputs: [],
})

/** Dial `/node` with a signed upgrade and serve NodeRpcs. The connection lives in the caller's scope. */
export const connectTestNode = (input: {
  readonly wsBase: string
  readonly nodeId: string
  readonly keys: KeyPair
  readonly brainPublicKey: string
  readonly brainOrigin?: string
  readonly capabilities?: ReadonlyArray<string>
  readonly state?: TestNodeState
  /** tamper with the upgrade header (negative tests) */
  readonly header?: (header: string) => string
  /** Half-open simulation: while `silenced.on`, everything the node writes is dropped (no close frame). */
  readonly silenced?: { on: boolean }
  /** The node's client ping interval (default 5 s). */
  readonly pingInterval?: number
  /** What the node reports about desktops in `node.hello`. */
  readonly desktop?: DesktopSupport
  /** What a Mac reports about its own screen in `node.hello`. */
  readonly screen?: ScreenSupport
}): Effect.Effect<TestNode, Socket.SocketError, Scope.Scope> =>
  Effect.gen(function* () {
    const brainOrigin = input.brainOrigin ?? BRAIN_ORIGIN
    const auth = yield* Effect.orDie(
      makeUpgradeAuth({ nodeId: input.nodeId, privateKey: input.keys.privateKey, brainOrigin }),
    )
    const header = input.header ? input.header(auth.header) : auth.header
    const dialed = yield* dialWebSocket(`${input.wsBase}${Routes.control}`, { authorization: header })
    const silenced = input.silenced
    const socket =
      silenced === undefined
        ? dialed
        : Socket.make({
            reader: dialed.reader,
            writer: Effect.map(dialed.writer, (w): Socket.Writer => ({
              write: (chunk) => (silenced.on ? Effect.void : w.write(chunk)),
              writeAll: (chunks) => (silenced.on ? Effect.void : w.writeAll(chunks)),
            })),
          })
    const state = input.state ?? newNodeState()
    const handlers = yield* Layer.build(
      testNodeHandlers({
        nodeId: input.nodeId,
        brainPublicKey: input.brainPublicKey,
        brainOrigin,
        nonce: auth.nonce,
        wsBase: input.wsBase,
        capabilities: input.capabilities ?? ["fs@1", "shell@1", "pty@1", "codex.exec-server@1"],
        state,
        desktop: input.desktop,
        screen: input.screen,
      }),
    )
    const peer = yield* makePeer({ socket, serve: NodeRpcs, call: BrainRpcs, pingInterval: input.pingInterval }).pipe(
      Effect.provide(handlers),
    )
    const closeCode = Effect.map(peer.closed, (e) => (e.reason._tag === "SocketCloseError" ? e.reason.code : undefined))
    return { peer, state, closeCode }
  })

/** A fresh node key pair. */
export const nodeKeys = Effect.orDie(generateKeyPair)

export type { NodeId }
