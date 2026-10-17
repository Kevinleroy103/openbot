// DialOut end to end: the real node (RemoteNodeLive: handlers + gate + links + dial loop) against a
// test brain on a real Bun WebSocket server using node-protocol auth.
import { afterAll, describe, expect, test } from "bun:test"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { mkdirSync, readFileSync } from "node:fs"
import * as path from "node:path"
import { generateKeyPair, type KeyPair } from "@openbot/node-protocol"
import { DialOut, RemoteNodeLive, type DialOutConfig, type DialState, type NodeConfigInput } from "../src/index.ts"
import { BRAIN_ORIGIN, startTestBrain, type TestBrain } from "../src/testing.ts"
import { inv, run, tempDir } from "./helpers.ts"

const t = tempDir("dialout-")
afterAll(t.cleanup)
const root = path.join(t.path, "work")
mkdirSync(root, { recursive: true })
const NODE_ID = "nod_remote1"

const keys = Effect.runPromise(Effect.all([generateKeyPair, generateKeyPair]))

interface Setup {
  readonly brain: TestBrain
  readonly dialOut: DialOut["Service"]
  readonly nodeKeys: KeyPair
}

/** Start a brain, then a remote node dialing it. Everything is scoped to the test. */
const setup = (options?: {
  readonly node?: Partial<NodeConfigInput>
  readonly dial?: Partial<DialOutConfig>
  readonly before?: (brain: TestBrain) => void
  readonly pinnedBrainKey?: string
}) =>
  Effect.gen(function* () {
    const [brainKeys, nodeKeys] = yield* Effect.promise(() => keys)
    const brain = yield* startTestBrain({ brainKeys, nodeId: NODE_ID, nodePublicKey: nodeKeys.publicKey })
    options?.before?.(brain)
    const dataDir = path.join(t.path, `state-${Math.random().toString(36).slice(2, 8)}`)
    const layer = RemoteNodeLive({
      node: {
        nodeId: NODE_ID,
        dataDir,
        roots: [root],
        detectBinaries: false,
        browser: { enabled: false },
        ...options?.node,
      },
      dial: {
        identity: {
          nodeId: NODE_ID,
          privateKey: nodeKeys.privateKey,
          brainPublicKey: options?.pinnedBrainKey ?? brainKeys.publicKey,
          brainOrigin: BRAIN_ORIGIN,
          brainUrl: brain.http,
        },
        backoff: { initialMs: 20, maxMs: 200, resetAfterMs: 10_000 },
        heartbeatMs: 100,
        helloTimeoutMs: 2_000,
        ...options?.dial,
      },
    })
    const ctx = yield* Layer.build(layer)
    return { brain, dialOut: Context.get(ctx, DialOut), nodeKeys, dataDir } satisfies Setup & { dataDir: string }
  })

const awaitState = (dialOut: DialOut["Service"], pred: (s: DialState) => boolean, timeoutMs = 5000) =>
  dialOut.changes.pipe(
    Stream.filter(pred),
    Stream.take(1),
    Stream.runHead,
    Effect.flatMap((o) => (o._tag === "Some" ? Effect.succeed(o.value) : Effect.die(new Error("state stream ended")))),
    Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.flatMap(dialOut.state, (s) => Effect.die(new Error(`state is ${JSON.stringify(s)}`))) }),
  )

describe("DialOut", () => {
  test("signed upgrade + verified node.hello; brain drives fs and a streaming shell.exec over the wire", () =>
    run(
      Effect.gen(function* () {
        const { brain, dialOut } = yield* setup({ node: { forwardAudit: true } })
        yield* awaitState(dialOut, (s) => s._tag === "Verified")
        const conn = yield* brain.awaitConnection(1)
        expect(conn.hello?._tag).toBe("Success")
        const hello = (conn.hello as { success: { nodeId: string; brainVerified: boolean; roots: ReadonlyArray<{ path: string }>; capabilities: ReadonlyArray<string> } }).success
        expect(hello.nodeId).toBe(NODE_ID)
        expect(hello.brainVerified).toBe(true)
        expect(hello.roots[0]?.path).toBe(root)
        expect(hello.capabilities).toContain("shell@1")

        const client = conn.peer.client
        yield* client["fs.write"]({ inv: inv(), path: "remote.txt", content: "over the wire" })
        expect(readFileSync(path.join(root, "remote.txt"), "utf8")).toBe("over the wire")
        const denied = yield* Effect.flip(client["fs.read"]({ inv: inv(), path: "/etc/hostname" }))
        expect(denied._tag).toBe("PathDenied")

        // streaming RPC with chunk acks through the mux
        const events = yield* Stream.runCollect(
          client["shell.exec"]({ inv: inv(), command: "for i in 1 2 3 4 5; do echo n$i; done", cwd: root, timeoutMs: 5000 }),
        )
        const out = events.flatMap((e) => (e._tag === "Output" ? [e.data] : [])).join("")
        expect(out).toBe("n1\nn2\nn3\nn4\nn5\n")
        expect(events[events.length - 1]?._tag).toBe("Exit")

        // heartbeats and forwarded audit events arrive, stamped with the authenticated node id
        yield* Effect.sleep(250)
        expect(brain.heartbeats.length).toBeGreaterThan(0)
        const audit = brain.events.filter((e) => e.type === "audit")
        expect(audit.length).toBeGreaterThan(0)
        expect(audit.every((e) => e.stampedNodeId === NODE_ID)).toBe(true)
      }),
    ))

  test("the gate: every RPC is NotAuthenticated before node.hello", () =>
    run(
      Effect.gen(function* () {
        const { brain } = yield* setup({ before: (b) => void (b.helloMode = "skip"), dial: { helloTimeoutMs: 10_000 } })
        const conn = yield* brain.awaitConnection(1)
        const read = yield* Effect.flip(conn.peer.client["fs.read"]({ inv: inv(), path: "remote.txt" }))
        expect(read._tag).toBe("NotAuthenticated")
        const exec = yield* Effect.flip(
          Stream.runCollect(conn.peer.client["shell.exec"]({ inv: inv(), command: "touch pwned", cwd: root, timeoutMs: 1000 })),
        )
        expect(exec._tag).toBe("NotAuthenticated")
        const lease = yield* Effect.flip(conn.peer.client["lease.set"]({ botId: "bot_1", holder: "user" }))
        expect(lease._tag).toBe("NotAuthenticated")
      }),
    ))

  test("a hello signed by the wrong key fails with NotAuthenticated and the node closes with 4403", () =>
    run(
      Effect.gen(function* () {
        const { brain, dialOut } = yield* setup({ before: (b) => void (b.helloMode = "bad-signature") })
        const conn = yield* brain.awaitConnection(1)
        expect(conn.hello?._tag).toBe("Failure")
        expect(String((conn.hello as { failure: unknown }).failure)).toContain("NotAuthenticated")
        // the node closed the connection with 4403 and redials
        const waiting = yield* awaitState(dialOut, (s) => s._tag === "Waiting")
        expect(waiting._tag === "Waiting" && waiting.closeCode).toBe(4403)
        yield* brain.awaitConnection(2)
      }),
    ))

  test("a brain impostor (node pinned a different brain key) cannot drive the node", () =>
    run(
      Effect.gen(function* () {
        const other = yield* generateKeyPair
        const { brain } = yield* setup({ pinnedBrainKey: other.publicKey })
        const conn = yield* brain.awaitConnection(1)
        expect(conn.hello?._tag).toBe("Failure")
        const e = yield* Effect.flip(conn.peer.client["fs.write"]({ inv: inv(), path: "impostor.txt", content: "x" }))
        expect(e._tag === "NotAuthenticated" || e._tag === "RpcClientError").toBe(true)
      }),
    ))

  test("node policy `ask` round-trips node.requestApproval to the brain (stamped node id, run and tool-call ids)", () =>
    run(
      Effect.gen(function* () {
        const { brain, dialOut } = yield* setup({ node: { policy: { ceiling: "ask" } } })
        yield* awaitState(dialOut, (s) => s._tag === "Verified")
        const client = (yield* brain.awaitConnection(1)).peer.client
        brain.decide = () => "deny"
        const call = inv("bot_7", "toolu_42")
        const e = yield* Effect.flip(client["fs.write"]({ inv: call, path: "ask.txt", content: "x" }))
        expect(e._tag).toBe("PolicyRefused")
        expect(brain.approvals[0]?.stampedNodeId).toBe(NODE_ID)
        expect(brain.approvals[0]?.request).toMatchObject({
          invocationId: call.invocationId,
          botId: "bot_7",
          runId: call.runId,
          toolCallId: "toolu_42",
          action: "write-file",
        })
        brain.decide = () => "allow-once"
        yield* client["fs.write"]({ inv: inv("bot_7"), path: "ask.txt", content: "approved" })
        expect(readFileSync(path.join(root, "ask.txt"), "utf8")).toBe("approved")
      }),
    ))

  test("pty.open dials /node/stream/:id with the one-time token; terminal bytes flow both ways", () =>
    run(
      Effect.gen(function* () {
        const { brain, dialOut } = yield* setup()
        yield* awaitState(dialOut, (s) => s._tag === "Verified")
        const client = (yield* brain.awaitConnection(1)).peer.client
        const ticket = brain.mintStream()
        const { pid } = yield* client["pty.open"]({ inv: inv(), cols: 100, rows: 30, cwd: root, shell: "/bin/sh", ...ticket })
        expect(pid).toBeGreaterThan(0)
        const end = yield* brain.awaitStream(ticket.streamId)
        yield* end.writer.write(new TextEncoder().encode("stty size; echo wire-$((6*7))\n"))
        const text = () => end.frames.map((f) => (typeof f === "string" ? "" : new TextDecoder().decode(f))).join("")
        for (let i = 0; i < 250 && !text().includes("wire-42"); i++) yield* Effect.sleep(20)
        expect(text()).toContain("30 100")
        expect(text()).toContain("wire-42")
        // a reused ticket is refused by the brain: pty.open fails with TunnelFailed
        const reuse = yield* Effect.flip(client["pty.open"]({ inv: inv(), cols: 80, rows: 24, cwd: root, shell: "/bin/sh", ...ticket }))
        expect(reuse._tag).toBe("TunnelFailed")
        yield* end.writer.write(new TextEncoder().encode("exit\n"))
      }),
    ))

  test("redials with a fresh nonce after a drop, and is verified again", () =>
    run(
      Effect.gen(function* () {
        const { brain, dialOut } = yield* setup()
        yield* awaitState(dialOut, (s) => s._tag === "Verified")
        const first = yield* brain.awaitConnection(1)
        yield* first.peer.mux.close(4000, "replaced")
        yield* awaitState(dialOut, (s) => s._tag === "Waiting")
        const second = yield* brain.awaitConnection(2)
        expect(second.nonce).not.toBe(first.nonce)
        yield* awaitState(dialOut, (s) => s._tag === "Verified")
        expect(dialOut.verifiedConnections()).toBe(2)
        yield* second.peer.client["fs.write"]({ inv: inv(), path: "after-redial.txt", content: "ok" })
      }),
    ))

  test("a disconnect interrupts in-flight handlers and kills their process groups", () =>
    run(
      Effect.gen(function* () {
        const { brain, dialOut } = yield* setup()
        yield* awaitState(dialOut, (s) => s._tag === "Verified")
        const conn = yield* brain.awaitConnection(1)
        const out: Array<string> = []
        yield* conn.peer.client["shell.exec"]({ inv: inv(), command: "sleep 60 & echo bg=$! leader=$$; sleep 60", cwd: root, timeoutMs: 120_000 }).pipe(
          Stream.runForEach((e) => Effect.sync(() => void (e._tag === "Output" && out.push(e.data)))),
          Effect.ignore,
          Effect.forkScoped({ startImmediately: true }),
        )
        for (let i = 0; i < 300 && !/bg=\d+/.test(out.join("")); i++) yield* Effect.sleep(10)
        const m = /bg=(\d+) leader=(\d+)/.exec(out.join(""))
        expect(m).not.toBeNull()
        const pids = [Number(m![1]), Number(m![2])]
        const alive = (pid: number) => {
          try {
            process.kill(pid, 0)
            return true
          } catch {
            return false
          }
        }
        expect(pids.every(alive)).toBe(true)
        yield* conn.peer.mux.close(1011, "brain going away")
        for (let i = 0; i < 300 && pids.some(alive); i++) yield* Effect.sleep(10)
        expect(pids.some(alive)).toBe(false)
      }),
    ))

  test("liveness: a connection that goes silent is dropped and redialed", () =>
    run(
      Effect.gen(function* () {
        // a "brain" that accepts the upgrade and then never sends a frame (half-open)
        let upgrades = 0
        const silent = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch: (req, server) => (server.upgrade(req) ? (upgrades++, undefined) : new Response("no", { status: 400 })),
          websocket: { message() {} },
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => silent.stop(true)))
        const { dialOut } = yield* setup({
          dial: { controlUrl: `ws://127.0.0.1:${silent.port}/node`, livenessTimeoutMs: 300, helloTimeoutMs: 30_000 },
        })
        const waiting = yield* awaitState(dialOut, (s) => s._tag === "Waiting", 5000)
        expect(waiting._tag === "Waiting" && waiting.reason).toContain("no frames from the brain")
        yield* awaitState(dialOut, (s) => s._tag === "Connected", 5000)
        expect(upgrades).toBeGreaterThanOrEqual(2)
      }),
    ))

  test("an unknown key gets 401 and the node keeps redialing with growing backoff", () =>
    run(
      Effect.gen(function* () {
        const { brain, dialOut } = yield* setup({ before: (b) => void (b.nodePublicKey = undefined) })
        const delays: Array<number> = []
        yield* dialOut.changes.pipe(
          Stream.filter((s) => s._tag === "Waiting"),
          Stream.take(4),
          Stream.runForEach((s) => Effect.sync(() => void (s._tag === "Waiting" && delays.push(s.delayMs)))),
          Effect.timeout("5 seconds"),
        )
        expect(brain.rejected).toBeGreaterThanOrEqual(4)
        expect(brain.connections.length).toBe(0)
        // 20 ms base doubling, ±50 % jitter, capped at 200 ms
        expect(delays[3]!).toBeGreaterThanOrEqual(80)
        expect(Math.max(...delays)).toBeLessThanOrEqual(200)
        // pairing again (the brain learns the key) lets the next dial through
        brain.nodePublicKey = (yield* Effect.promise(() => keys))[1].publicKey
        yield* awaitState(dialOut, (s) => s._tag === "Verified")
      }),
    ))

  test("close code 4401 (revoked) stops the dial loop for good", () =>
    run(
      Effect.gen(function* () {
        const { brain, dialOut } = yield* setup({ before: (b) => void (b.closeOnConnect = 4401) })
        const final = yield* dialOut.done.pipe(Effect.timeout("5 seconds"))
        expect(final._tag).toBe("Revoked")
        yield* Effect.sleep(300)
        expect(brain.connections.length).toBe(1)
        expect((yield* dialOut.state)._tag).toBe("Revoked")
      }),
    ))
})
