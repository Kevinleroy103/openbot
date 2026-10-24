import { describe, expect, test } from "bun:test"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { RpcClient } from "effect/rpc"
import * as Socket from "effect/socket/Socket"
import {
  generateKeyPair,
  isServerBound,
  makePeer,
  mux,
  NodeRpcs,
  PathDenied,
  BrainRpcs,
  signHello,
  StreamRefused,
} from "../src/index.ts"
import { makeMemorySocketPair, rawJsonPeer } from "../src/testing.ts"
import { connectedPeers, inv, NODE_ID, NodeHandlers, ORIGIN, type NodeState } from "./fixtures.ts"

const run = <A, E>(eff: Effect.Effect<A, E, any>) => Effect.runPromise(Effect.scoped(eff) as Effect.Effect<A, E>)

describe("direction mux", () => {
  test("classifies frames by direction", () => {
    expect(isServerBound({ jsonrpc: "2.0", id: 1, method: "fs.read", params: {} })).toBe(true)
    expect(isServerBound({ jsonrpc: "2.0", method: "@effect/rpc/Ping" })).toBe(true)
    expect(isServerBound({ jsonrpc: "2.0", method: "@effect/rpc/Ack", params: { requestId: 1 } })).toBe(true)
    expect(isServerBound({ jsonrpc: "2.0", method: "@effect/rpc/Interrupt", params: { requestId: 1 } })).toBe(true)
    expect(isServerBound({ jsonrpc: "2.0", method: "@effect/rpc/Pong" })).toBe(false)
    expect(isServerBound({ jsonrpc: "2.0", id: 1, result: null })).toBe(false)
    expect(isServerBound({ jsonrpc: "2.0", chunk: true, id: 1, result: [] })).toBe(false)
    expect(isServerBound({ jsonrpc: "2.0", id: 1, error: { _tag: "Cause", data: [] } })).toBe(false)
  })

  test("routes a mixed JSON-RPC batch to both sides and stamps requests", () =>
    run(
      Effect.gen(function* () {
        const pair = makeMemorySocketPair()
        const m = yield* mux(pair.b, { stamp: [["x-openbot-node-id", "nod_real"]] })
        const server = yield* rawJsonPeer(m.server)
        const client = yield* rawJsonPeer(m.client)
        yield* pair.a.writer.pipe(
          Effect.flatMap((w) =>
            w.write(
              JSON.stringify([
                {
                  jsonrpc: "2.0",
                  id: 7,
                  method: "node.event",
                  params: { type: "x", data: 1 },
                  headers: [
                    ["x-openbot-node-id", "evil"],
                    ["x-trace", "1"],
                  ],
                },
                { jsonrpc: "2.0", id: 3, result: "ok" },
              ]),
            ),
          ),
        )
        const req = (yield* server.next) as any
        expect(req.method).toBe("node.event")
        expect(req.headers).toEqual([
          ["x-openbot-node-id", "nod_real"],
          ["x-trace", "1"],
        ])
        const res = (yield* client.next) as any
        expect(res).toEqual({ jsonrpc: "2.0", id: 3, result: "ok" })
        expect(m.stats).toMatchObject({ toServer: 1, toClient: 1, stamped: 1, strippedSpoof: 1 })
      }),
    ))

  test("RpcServer + RpcClient both directions on one socket (hello, typed error, concurrency)", () =>
    run(
      Effect.gen(function* () {
        const { brain, node, brainState, hello, nodeState } = yield* connectedPeers
        // brain -> node: refused before hello
        const early = yield* Effect.flip(brain.client["fs.read"]({ inv: inv(), path: "/w/a.txt" }))
        expect(early._tag).toBe("NotAuthenticated")

        const h = yield* hello()
        expect(h.nodeId).toBe(NODE_ID)
        expect(h.brainVerified).toBe(true)
        expect(nodeState.verified).toBe(true)

        // both directions at once
        const [read, approval, denied] = yield* Effect.all(
          [
            brain.client["fs.read"]({ inv: inv(), path: "/w/a.txt" }),
            node.client["node.requestApproval"]({
              invocationId: "i1",
              botId: "bot_1",
              action: "run-command",
              target: "ls",
              reason: "ask",
            }),
            Effect.flip(brain.client["fs.read"]({ inv: inv(), path: "/etc/shadow" })),
          ],
          { concurrency: "unbounded" },
        )
        expect(read.content).toBe("content of /w/a.txt")
        expect(approval).toEqual({ decision: "allow-once", by: `brain-saw:${NODE_ID}` })
        expect(denied).toBeInstanceOf(PathDenied)
        expect((denied as PathDenied).reason).toBe("outside roots")

        // typed error node <- brain
        const refused = yield* Effect.flip(node.client["node.openStream"]({ kind: "mcp-http", botId: "bot_other" }))
        expect(refused).toBeInstanceOf(StreamRefused)

        // spoofed identity header from the node is replaced by the brain stamp
        yield* node.client["node.event"]({ type: "spoof", data: { a: 1 } }).pipe(
          RpcClient.withHeaders({ "x-openbot-node-id": "evil-node" }),
        )
        expect(brainState.events).toEqual([{ nodeId: NODE_ID, type: "spoof", data: { a: 1 } }])
        expect(brain.mux.stats.strippedSpoof).toBe(1)

        // union payloads survive the wire
        const nav = yield* brain.client["browser.action"]({
          inv: inv(),
          action: { _tag: "navigate", url: "https://example.com" },
        })
        expect(nav).toEqual({ text: "did navigate", url: "https://example.com" })
      }),
    ))

  test("streaming RPC: chunks flow, and a client-side interrupt stops the node handler", () =>
    run(
      Effect.gen(function* () {
        const { brain, hello, nodeState } = yield* connectedPeers
        yield* hello()
        const events = yield* brain.client["shell.exec"]({
          inv: inv(),
          command: "yes",
          cwd: ".",
          timeoutMs: 60_000,
        }).pipe(Stream.take(4), Stream.runCollect)
        expect(events[0]).toEqual({ _tag: "Started", pid: 100, pgid: 100 })
        expect(events.slice(1).map((e) => e._tag)).toEqual(["Output", "Output", "Output"])
        // Stream.take ended the consumer -> @effect/rpc/Interrupt -> node handler finalizer ran
        yield* Deferred.await(nodeState.execInterrupted).pipe(Effect.timeout("2 seconds"))
        const ticks = nodeState.execTicks
        yield* Effect.sleep("50 millis")
        expect(nodeState.execTicks).toBeLessThanOrEqual(ticks + 1)
      }),
    ))

  test("explicit fiber interrupt of a running stream also reaches the node", () =>
    run(
      Effect.gen(function* () {
        const { brain, hello, nodeState } = yield* connectedPeers
        yield* hello()
        const got = yield* Deferred.make<void>()
        const fiber = yield* brain.client["shell.exec"]({
          inv: inv(),
          command: "yes",
          cwd: ".",
          timeoutMs: 60_000,
        }).pipe(
          Stream.runForEach((e) =>
            e._tag === "Output" && e.seq >= 2 ? Deferred.succeed(got, undefined) : Effect.void,
          ),
          Effect.forkScoped,
        )
        yield* Deferred.await(got)
        yield* Fiber.interrupt(fiber)
        yield* Deferred.await(nodeState.execInterrupted).pipe(Effect.timeout("2 seconds"))
      }),
    ))

  test("connection drop fails in-flight calls, interrupts handlers and resolves `closed`", () =>
    run(
      Effect.gen(function* () {
        const { pair, brain, node, hello, nodeState } = yield* connectedPeers
        yield* hello()
        const inflight = yield* brain.client["shell.exec"]({
          inv: inv(),
          command: "yes",
          cwd: ".",
          timeoutMs: 60_000,
        }).pipe(Stream.runDrain, Effect.exit, Effect.forkScoped)
        yield* Effect.sleep("30 millis")
        pair.drop(1006, "network")
        const exit = yield* Fiber.join(inflight)
        expect(Exit.isFailure(exit)).toBe(true)
        const closedBrain = yield* brain.closed
        const closedNode = yield* node.closed
        expect(closedBrain.reason._tag).toBe("SocketCloseError")
        expect(closedNode.reason._tag).toBe("SocketCloseError")
        yield* Deferred.await(nodeState.execInterrupted).pipe(Effect.timeout("2 seconds"))
        // later calls fail fast
        const after = yield* Effect.exit(
          brain.client["fs.read"]({ inv: inv(), path: "/w/x" }).pipe(Effect.timeout("2 seconds")),
        )
        expect(Exit.isFailure(after)).toBe(true)
      }),
    ))

  test("mux.close sends a close code the peer observes", () =>
    run(
      Effect.gen(function* () {
        const { brain, node } = yield* connectedPeers
        yield* brain.mux.close(4401, "revoked")
        const err = yield* node.closed
        expect(err.reason._tag).toBe("SocketCloseError")
        expect((err.reason as Socket.SocketCloseError).code).toBe(4401)
      }),
    ))
})

describe("liveness (half-open connections)", () => {
  test("a silent peer resolves `closed` after livenessTimeout; frames keep it alive", () =>
    run(
      Effect.gen(function* () {
        const pair = makeMemorySocketPair()
        const m = yield* mux(pair.b, { livenessTimeout: 200 })
        yield* rawJsonPeer(m.client)
        const write = yield* pair.a.writer
        // the peer keeps talking for 500 ms: still alive
        for (let i = 0; i < 10; i++) {
          yield* write.write(JSON.stringify({ jsonrpc: "2.0", id: i, result: null }))
          yield* Effect.sleep("50 millis")
        }
        expect(yield* m.idleMs).toBeLessThan(200)
        expect(yield* Effect.timeoutOption(m.closed, "1 millis")).toMatchObject({ _tag: "None" })
        // then silence without a close frame (sleep/wake, NAT drop): the mux gives up
        const closed = yield* m.closed.pipe(Effect.timeout("2 seconds"))
        expect(closed.reason._tag).toBe("SocketCloseError")
        expect((closed.reason as Socket.SocketCloseError).code).toBe(1006)
        expect(closed.reason.message).toContain("liveness timeout")
      }),
    ))

  test("makePeer passes livenessTimeout: in-flight calls fail when the node goes silent", () =>
    run(
      Effect.gen(function* () {
        const pair = makeMemorySocketPair()
        const brain = yield* makePeer({
          socket: pair.b,
          serve: BrainRpcs,
          call: NodeRpcs,
          livenessTimeout: 150,
          pingInterval: 60_000,
        }).pipe(
          Effect.provide(
            BrainRpcs.toLayer({
              "node.requestApproval": () => Effect.succeed({ decision: "deny" as const, by: "test" }),
              "node.openStream": () => Effect.fail(new StreamRefused({ kind: "pty", reason: "no" })),
              "node.event": () => Effect.void,
              "node.heartbeat": () => Effect.void,
            }),
          ),
        )
        // the "node" never answers (half-open)
        yield* rawJsonPeer(pair.a)
        const call = yield* brain.client["fs.read"]({ inv: inv(), path: "/w/a.txt" }).pipe(
          Effect.exit,
          Effect.forkScoped,
        )
        const closed = yield* brain.closed.pipe(Effect.timeout("2 seconds"))
        expect(closed.reason.message).toContain("liveness timeout")
        expect(Exit.isFailure(yield* Fiber.join(call).pipe(Effect.timeout("2 seconds")))).toBe(true)
      }),
    ))
})

describe("foreign (non-Effect) peer: wire rules from docs/node-protocol.md", () => {
  test("hello, streaming with explicit Ack, Interrupt, typed error, ping", () =>
    run(
      Effect.gen(function* () {
        const pair = makeMemorySocketPair()
        const brainKeys = yield* generateKeyPair
        const nodeState: NodeState = {
          brainPublicKey: brainKeys.publicKey,
          upgradeNonce: "n0nce",
          verified: false,
          execInterrupted: yield* Deferred.make<void>(),
          execTicks: 0,
        }
        // Effect node on side a; hand-written JSON-RPC "brain" on side b
        const nodeCtx = yield* Layer.build(NodeHandlers(nodeState))
        yield* makePeer({ socket: pair.a, serve: NodeRpcs, call: BrainRpcs }).pipe(Effect.provide(nodeCtx))
        const raw = yield* rawJsonPeer(pair.b)
        // answer the node client's pings; ignore everything else that is not ours
        const skipPing = (m: any) =>
          m.method === "@effect/rpc/Ping" ? raw.send({ jsonrpc: "2.0", method: "@effect/rpc/Pong" }) : Effect.void

        const brainSig = yield* signHello({
          brainPrivateKey: brainKeys.privateKey,
          nodeId: NODE_ID,
          nonce: "n0nce",
          brainOrigin: ORIGIN,
        })
        yield* raw.send({
          jsonrpc: "2.0",
          id: 1,
          method: "node.hello",
          params: { protocol: { min: 1, max: 1 }, brainVersion: "foreign", brainSig },
        })
        const hello = yield* raw.nextWhere((m) => m.id === 1, skipPing)
        expect(hello.result.brainVerified).toBe(true)
        expect(hello.result.capabilities).toContain("fs@1")

        // typed error shape
        yield* raw.send({ jsonrpc: "2.0", id: 2, method: "fs.read", params: { inv: inv(), path: "/etc/passwd" } })
        const err = yield* raw.nextWhere((m) => m.id === 2, skipPing)
        expect(err.error._tag).toBe("Cause")
        expect(err.error.data[0]._tag).toBe("Fail")
        expect(err.error.data[0].error).toMatchObject({ _tag: "PathDenied", path: "/etc/passwd" })

        // streaming: exactly one chunk until we Ack
        yield* raw.send({
          jsonrpc: "2.0",
          id: 3,
          method: "shell.exec",
          params: { inv: inv(), command: "yes", cwd: ".", timeoutMs: 1000 },
        })
        const c1 = yield* raw.nextWhere((m) => m.id === 3, skipPing)
        expect(c1.chunk).toBe(true)
        expect(Array.isArray(c1.result)).toBe(true)
        yield* Effect.sleep("60 millis")
        const extra = raw.buffered().filter((m: any) => m.id === 3)
        expect(extra.length).toBe(0) // server waits for the Ack
        let chunks = 1
        while (chunks < 3) {
          yield* raw.send({ jsonrpc: "2.0", method: "@effect/rpc/Ack", params: { requestId: 3 } })
          const c = yield* raw.nextWhere((m) => m.id === 3, skipPing)
          expect(c.chunk).toBe(true)
          chunks++
        }
        yield* raw.send({ jsonrpc: "2.0", method: "@effect/rpc/Interrupt", params: { requestId: 3 } })
        const end = yield* raw.nextWhere((m) => m.id === 3 && !m.chunk, skipPing)
        expect(end.error._tag).toBe("Cause")
        expect(end.error.data.some((r: any) => r._tag === "Interrupt")).toBe(true)
        yield* Deferred.await(nodeState.execInterrupted).pipe(Effect.timeout("2 seconds"))

        // ping from the foreign side is answered with a Pong
        yield* raw.send({ jsonrpc: "2.0", method: "@effect/rpc/Ping" })
        const pong = yield* raw.nextWhere((m) => m.method === "@effect/rpc/Pong", skipPing)
        expect(pong.method).toBe("@effect/rpc/Pong")
      }),
    ))

  test("foreign brain-side server: the Effect node's client calls reach it and get answers", () =>
    run(
      Effect.gen(function* () {
        const pair = makeMemorySocketPair()
        // Effect node client on side a; raw brain on side b answers node.requestApproval
        const nodeState: NodeState = {
          brainPublicKey: "",
          upgradeNonce: "",
          verified: false,
          execInterrupted: yield* Deferred.make<void>(),
          execTicks: 0,
        }
        const nodeCtx = yield* Layer.build(NodeHandlers(nodeState))
        const node = yield* makePeer({ socket: pair.a, serve: NodeRpcs, call: BrainRpcs }).pipe(Effect.provide(nodeCtx))
        const raw = yield* rawJsonPeer(pair.b)
        const answer = yield* node.client["node.requestApproval"]({
          invocationId: "i",
          botId: "b",
          action: "write-file",
          target: "/x",
          reason: "r",
        }).pipe(Effect.forkScoped)
        const req = yield* raw.nextWhere((m) => m.method === "node.requestApproval")
        expect(req.params).toEqual({ invocationId: "i", botId: "b", action: "write-file", target: "/x", reason: "r" })
        yield* raw.send({ jsonrpc: "2.0", id: req.id, result: { decision: "deny", by: "foreign" } })
        expect(yield* Fiber.join(answer)).toEqual({ decision: "deny", by: "foreign" })
        // notifications-style void RPC answered with result null
        const ev = yield* node.client["node.event"]({ type: "t", data: null }).pipe(Effect.forkScoped)
        const evReq = yield* raw.nextWhere((m) => m.method === "node.event")
        yield* raw.send({ jsonrpc: "2.0", id: evReq.id, result: null })
        yield* Fiber.join(ev)
      }),
    ))
})
