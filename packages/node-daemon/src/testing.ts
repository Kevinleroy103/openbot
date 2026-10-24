// Test helpers (subpath `@openbot/node-daemon/testing`). Not used by the daemon itself.
//
// `startTestBrain`: a minimal BRAIN on a real Bun HTTP/WebSocket server (BunHttpServer + HttpRouter), speaking
// the node protocol exactly like brain-nodes' NodeGateway: signed-upgrade verification with a replay
// cache, the direction mux (RpcServer(BrainRpcs) + RpcClient(NodeRpcs), node id stamped), the brain's
// `node.hello` signature, and one-time bearer tokens on `/node/stream/:id`.
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Socket from "effect/socket/Socket"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { RpcGroup } from "effect/rpc"
import {
  BrainRpcs,
  makePeer,
  makeReplayCache,
  mintStreamTicket,
  NodeRpcs,
  nodeStamp,
  parseStreamAuth,
  ProtocolHeaders,
  Routes,
  sign,
  signHello,
  stampedNodeId,
  type KeyPair,
  type NodeApprovalRequest,
  type NodeApprovalResponse,
  type NodeHeartbeat,
  type NodeHello,
  type Peer,
  type StreamTicket,
  verifyUpgradeAuth,
} from "@openbot/node-protocol"
import { closeCodeOf } from "./sockets.ts"

export const BRAIN_ORIGIN = "https://brain.test"

type Frame = string | Uint8Array

export interface BrainConnectionRecord {
  readonly nonce: string
  readonly peer: Peer<RpcGroup.Rpcs<typeof NodeRpcs>>
  hello: Result.Result<NodeHello, unknown> | undefined
  closeCode: number | undefined
}

export interface StreamEnd {
  readonly frames: Array<Frame>
  readonly writer: Socket.Writer
  closed: boolean
}

export type HelloMode = "valid" | "bad-signature" | "skip"

export interface TestBrain {
  readonly http: string
  readonly ws: string
  /** every accepted control connection, in order */
  readonly connections: Array<BrainConnectionRecord>
  /** upgrades refused with 401 */
  rejected: number
  helloMode: HelloMode
  /** close new (verified) connections with this code right away (e.g. 4401) */
  closeOnConnect: number | undefined
  /** paired public key the brain accepts (undefined: unknown node → 401) */
  nodePublicKey: string | undefined
  readonly approvals: Array<{ readonly request: NodeApprovalRequest; readonly stampedNodeId: string | undefined }>
  readonly events: Array<{ readonly type: string; readonly data: unknown; readonly stampedNodeId: string | undefined }>
  readonly heartbeats: Array<NodeHeartbeat>
  decide: (request: NodeApprovalRequest) => NodeApprovalResponse["decision"]
  /** brain end of every data stream the node dialed */
  readonly streams: Map<string, StreamEnd>
  /** mint a one-time stream ticket (valid until used) */
  readonly mintStream: () => StreamTicket
  /** wait until `n` control connections exist (and the n-th finished `node.hello`, unless skipped) */
  readonly awaitConnection: (n: number, timeoutMs?: number) => Effect.Effect<BrainConnectionRecord>
  readonly awaitStream: (streamId: string, timeoutMs?: number) => Effect.Effect<StreamEnd>
}

const waitUntil = <A>(probe: () => A | undefined, timeoutMs: number, what: string): Effect.Effect<A> =>
  Effect.gen(function* () {
    const end = Date.now() + timeoutMs
    while (true) {
      const v = probe()
      if (v !== undefined) return v
      if (Date.now() > end) return yield* Effect.die(new Error(`timed out waiting for ${what}`))
      yield* Effect.sleep(10)
    }
  })

export const startTestBrain = (options: {
  readonly brainKeys: KeyPair
  readonly nodeId: string
  readonly nodePublicKey: string
}) =>
  Effect.gen(function* () {
    const replay = makeReplayCache()
    const tickets = new Map<string, string>()
    const brain: TestBrain = {
      http: "",
      ws: "",
      connections: [],
      rejected: 0,
      helloMode: "valid",
      closeOnConnect: undefined,
      nodePublicKey: options.nodePublicKey,
      approvals: [],
      events: [],
      heartbeats: [],
      decide: () => "allow-once",
      streams: new Map(),
      mintStream: () => {
        const t = mintStreamTicket()
        tickets.set(t.streamId, t.streamToken)
        return t
      },
      awaitConnection: (n, timeoutMs = 5000) =>
        waitUntil(
          () => {
            const c = brain.connections[n - 1]
            return c && (brain.helloMode === "skip" || c.hello !== undefined) ? c : undefined
          },
          timeoutMs,
          `connection #${n}`,
        ),
      awaitStream: (id, timeoutMs = 5000) => waitUntil(() => brain.streams.get(id), timeoutMs, `stream ${id}`),
    }

    const brainHandlers = yield* BrainRpcs.toHandlers({
      "node.requestApproval": (request, { headers }) =>
        Effect.sync(() => {
          brain.approvals.push({ request, stampedNodeId: stampedNodeId(headers) })
          return { decision: brain.decide(request), by: "owner" }
        }),
      "node.openStream": () => Effect.sync(() => brain.mintStream()),
      "node.event": ({ type, data }, { headers }) =>
        Effect.sync(() => void brain.events.push({ type, data, stampedNodeId: stampedNodeId(headers) })),
      "node.heartbeat": (hb) => Effect.sync(() => void brain.heartbeats.push(hb)),
    })

    const control = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const verified = yield* Effect.result(
        verifyUpgradeAuth({
          header: request.headers[ProtocolHeaders.authorization],
          brainOrigin: BRAIN_ORIGIN,
          lookupKey: (id) => Effect.succeed(id === options.nodeId ? brain.nodePublicKey : undefined),
          replay,
        }),
      )
      if (Result.isFailure(verified)) {
        brain.rejected++
        return HttpServerResponse.text(verified.failure.message, { status: 401 })
      }
      const socket = yield* Effect.orDie(request.upgrade)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const peer = yield* makePeer({
            socket,
            serve: BrainRpcs,
            call: NodeRpcs,
            stamp: nodeStamp(options.nodeId),
            pingTimeout: 15_000,
            disableFatalDefects: true,
          }).pipe(Effect.provide(brainHandlers))
          const record: BrainConnectionRecord = {
            nonce: verified.success.nonce,
            peer,
            hello: undefined,
            closeCode: undefined,
          }
          brain.connections.push(record)
          if (brain.helloMode !== "skip") {
            const brainSig =
              brain.helloMode === "valid"
                ? yield* Effect.orDie(
                    signHello({
                      brainPrivateKey: options.brainKeys.privateKey,
                      nodeId: options.nodeId,
                      nonce: verified.success.nonce,
                      brainOrigin: BRAIN_ORIGIN,
                    }),
                  )
                : yield* Effect.orDie(sign(options.brainKeys.privateKey, "not the hello message"))
            record.hello = yield* Effect.result(
              peer.client["node.hello"]({ protocol: { min: 1, max: 1 }, brainVersion: "0.0.0-test", brainSig }).pipe(
                Effect.timeout("5 seconds"),
              ),
            )
          }
          if (brain.closeOnConnect !== undefined) yield* peer.mux.close(brain.closeOnConnect, "test close")
          // BunHttpServer interrupts this route when the socket closes (gotcha G2), so code after
          // `peer.closed` may never run: record the close from a detached fiber
          yield* Effect.forkDetach(Effect.map(peer.closed, (e) => void (record.closeCode = closeCodeOf(e))))
          yield* peer.closed
        }),
      )
      return HttpServerResponse.empty()
    })

    const stream = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const id = (yield* HttpRouter.params)["id"] ?? ""
      const token = parseStreamAuth(request.headers[ProtocolHeaders.authorization])
      const expected = tickets.get(id)
      if (!token || expected !== token) return HttpServerResponse.text("bad stream token", { status: 401 })
      tickets.delete(id)
      const socket = yield* Effect.orDie(request.upgrade)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reader = yield* socket.reader
          const writer = yield* socket.writer
          const end: StreamEnd = { frames: [], writer, closed: false }
          brain.streams.set(id, end)
          yield* Effect.forever(
            Effect.flatMap(reader.pull, (frames) => Effect.sync(() => void end.frames.push(...frames))),
          ).pipe(Effect.ignore)
          end.closed = true
        }),
      )
      return HttpServerResponse.empty()
    })

    const routes = HttpRouter.use(
      Effect.fnUntraced(function* (router) {
        yield* router.add("GET", Routes.control, control)
        yield* router.add("GET", Routes.streamPattern as `/${string}`, stream)
      }),
    )
    const ctx = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(BunHttpServer.layer({ port: 0, hostname: "127.0.0.1", websocket: { idleTimeout: 0 } })),
      ),
    )
    const server = Context.get(ctx, HttpServer.HttpServer)
    const address = server.address
    if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address")
    const http = `http://127.0.0.1:${address.port}`
    return Object.assign(brain, { http, ws: http.replace(/^http/, "ws") }) as TestBrain
  })
