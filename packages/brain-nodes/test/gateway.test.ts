// End to end over a real Bun WebSocket: pairing → signed `/node` upgrade → `node.hello` (brain signature
// verified by the node with its pinned key) → `NodeDirectory.client` RPC round trip, BrainRpcs from the
// node with the brain-stamped identity, revocation (4401), and signed-upgrade negatives (401).
import { afterAll, describe, expect, test } from "bun:test"
import type { NodeId } from "@openbot/contracts"
import { NodeAdmin, NodeDirectory } from "@openbot/core"
import { ApprovalServiceFake } from "@openbot/core/testing"
import { CloseCodes, generateKeyPair, makeUpgradeAuth, Routes } from "@openbot/node-protocol"
import { Effect, Layer, Option, Stream } from "effect"
import { BrainIdentity, NodeRegistry } from "../src/index.ts"
import { BRAIN_ORIGIN, brainStack, connectTestNode, nodeKeys, pairOverHttp, run, startServer, tempDir } from "./helpers.ts"

const dir = tempDir()
afterAll(() => dir.cleanup())

/** HTTP status of a refused upgrade (the brain answers before upgrading). */
const upgradeStatus = (httpBase: string, authorization: string | undefined) =>
  Effect.promise(async () => {
    const headers: Record<string, string> = {
      connection: "upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    }
    if (authorization !== undefined) headers["authorization"] = authorization
    return (await fetch(`${httpBase}${Routes.control}`, { headers })).status
  })

const withBrain = <A, E>(effect: Effect.Effect<A, E, any>) =>
  run(effect.pipe(Effect.provide(Layer.fresh(brainStack({ dataRoot: dir.path }))) as any) as Effect.Effect<A, E, any>)

describe("pairing", () => {
  test("a pairing code is single use and yields the brain key and origin", () =>
    withBrain(
      Effect.gen(function*() {
        const server = yield* startServer
        const admin = yield* NodeAdmin
        const identity = yield* BrainIdentity
        const code = yield* admin.createPairingCode
        expect(code.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
        expect(code.command).toBe(`openbot-node pair ${BRAIN_ORIGIN} ${code.code}`)

        const keys = yield* nodeKeys
        const first = yield* pairOverHttp(server.http, code.code.toLowerCase(), keys)
        expect(first.status).toBe(200)
        expect(first.body.brainPublicKey).toBe(identity.publicKey)
        expect(first.body.brainOrigin).toBe(BRAIN_ORIGIN)
        expect(first.body.nodeId).toMatch(/^nod_/)

        const reused = yield* pairOverHttp(server.http, code.code, yield* nodeKeys)
        expect(reused.status).toBe(401)

        const badKey = yield* pairOverHttp(server.http, (yield* admin.createPairingCode).code, { publicKey: "nope", privateKey: "" })
        expect(badKey.status).toBe(400)

        // the paired node is listed (offline until it connects) with no approved capabilities yet
        const node = yield* (yield* NodeDirectory).get(first.body.nodeId as NodeId)
        expect(node).toMatchObject({ kind: "remote", status: "offline", label: "laptop", capabilities: [] })
      }),
    ))
})

describe("node control socket", () => {
  test("signed connect → node.hello → NodeDirectory.client round trip → revoke closes with 4401", () =>
    withBrain(
      Effect.gen(function*() {
        const server = yield* startServer
        const admin = yield* NodeAdmin
        const directory = yield* NodeDirectory
        const registry = yield* NodeRegistry
        const identity = yield* BrainIdentity
        const approvals = yield* ApprovalServiceFake

        const keys = yield* nodeKeys
        const paired = yield* pairOverHttp(server.http, (yield* admin.createPairingCode).code, keys)
        const nodeId = paired.body.nodeId as NodeId

        const changes: Array<string> = []
        yield* directory.changes.pipe(
          Stream.runForEach((c) => Effect.sync(() => changes.push(c.type === "node.upserted" ? `${c.type}:${c.node.status}` : c.type))),
          Effect.forkScoped({ startImmediately: true }),
        )

        const node = yield* connectTestNode({ wsBase: server.ws, nodeId, keys, brainPublicKey: paired.body.brainPublicKey })
        const conn = yield* registry.awaitConnection(nodeId).pipe(Effect.timeout("5 seconds"))
        expect(node.state.verified).toBe(true)
        expect(conn.hello.brainVerified).toBe(true)
        expect(identity.publicKey).toBe(paired.body.brainPublicKey)

        // first hello after pairing: declared capabilities are approved
        const summary = yield* directory.get(nodeId)
        expect(summary).toMatchObject({
          status: "online",
          capabilities: ["fs@1", "shell@1", "pty@1", "codex.exec-server@1"],
          roots: ["/home/u/openbot"],
          version: "9.9.9",
        })

        // brain → node RPC through the port
        const client = yield* directory.client(nodeId)
        const read = yield* client["fs.read"]({ inv: { invocationId: "i1", botId: "bot_1", runId: "r" }, path: "/home/u/openbot/a.txt" })
        expect(read.content).toBe("remote:/home/u/openbot/a.txt")
        const denied = yield* Effect.flip(client["fs.read"]({ inv: { invocationId: "i2", botId: "bot_1", runId: "r" }, path: "/etc/passwd" }))
        expect(denied._tag).toBe("PathDenied")
        const exec = yield* client["shell.exec"]({ inv: { invocationId: "i3", botId: "bot_1", runId: "r" }, command: "ls", cwd: "/", timeoutMs: 1000 }).pipe(
          Stream.runCollect,
        )
        expect(exec.map((e) => e._tag)).toEqual(["Started", "Output", "Exit"])

        // node → brain: approval with the STAMPED node id (never from the payload)
        const approval = yield* node.peer.client["node.requestApproval"]({
          invocationId: "i4",
          botId: "bot_1",
          runId: "bot_1:cnv_1",
          action: "run-command",
          target: "rm -rf build",
          reason: "ceiling ask",
        })
        expect(approval).toEqual({ decision: "allow-once", by: "rule" })
        const asked = yield* approvals.nodeRequests
        expect(asked).toHaveLength(1)
        expect(asked[0]!.nodeId).toBe(nodeId)
        expect(asked[0]!.request.target).toBe("rm -rf build")

        // node.event fans out with the stamped id
        const events: Array<unknown> = []
        yield* registry.events.pipe(
          Stream.take(1),
          Stream.runForEach((e) => Effect.sync(() => events.push(e))),
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* Effect.sleep("20 millis")
        yield* node.peer.client["node.event"]({ type: "audit", data: { ok: true } })
        yield* Effect.sleep("50 millis")
        expect(events).toEqual([{ nodeId, type: "audit", data: { ok: true } }])

        // revoke → 4401, node removed, client unavailable
        yield* admin.revoke(nodeId)
        const code = yield* node.closeCode.pipe(Effect.timeout("5 seconds"))
        expect(code).toBe(CloseCodes.revoked)
        expect(Option.isNone(yield* registry.connection(nodeId))).toBe(true)
        const offline = yield* Effect.flip(directory.client(nodeId))
        expect(offline._tag).toBe("NodeUnavailable")
        expect((yield* directory.list).map((n) => n.id)).not.toContain(nodeId)
        expect(changes).toContain("node.upserted:online")
        expect(changes).toContain("node.removed")

        // a revoked node that redials is told 4401 again (its signature still verifies)
        const again = yield* Effect.result(connectTestNode({ wsBase: server.ws, nodeId, keys, brainPublicKey: paired.body.brainPublicKey }))
        if (again._tag === "Success") {
          expect(yield* again.success.closeCode.pipe(Effect.timeout("5 seconds"))).toBe(CloseCodes.revoked)
        } else {
          const reason = again.failure.reason
          expect(reason._tag === "SocketCloseError" ? reason.code : -1).toBe(CloseCodes.revoked)
        }
      }),
    ))

  test("a newer connection replaces the old one (4000) and closing detaches the node", () =>
    withBrain(
      Effect.gen(function*() {
        const server = yield* startServer
        const admin = yield* NodeAdmin
        const directory = yield* NodeDirectory
        const registry = yield* NodeRegistry
        const keys = yield* nodeKeys
        const paired = yield* pairOverHttp(server.http, (yield* admin.createPairingCode).code, keys)
        const nodeId = paired.body.nodeId as NodeId

        const first = yield* connectTestNode({ wsBase: server.ws, nodeId, keys, brainPublicKey: paired.body.brainPublicKey })
        const c1 = yield* registry.awaitConnection(nodeId).pipe(Effect.timeout("5 seconds"))
        const second = yield* connectTestNode({ wsBase: server.ws, nodeId, keys, brainPublicKey: paired.body.brainPublicKey })
        const c2 = yield* registry.awaitConnection(nodeId, c1.connId).pipe(Effect.timeout("5 seconds"))
        expect(c2.connId).toBeGreaterThan(c1.connId)
        expect(yield* first.closeCode.pipe(Effect.timeout("5 seconds"))).toBe(CloseCodes.replaced)
        // the old connection's detach must not take the new one offline
        yield* Effect.sleep("50 millis")
        expect((yield* directory.get(nodeId)).status).toBe("online")

        yield* second.peer.mux.close(1000, "bye")
        yield* Effect.sleep("100 millis")
        const after = yield* directory.get(nodeId)
        expect(after.status).toBe("offline")
        expect(after.lastSeenAt).toBeGreaterThan(0)
      }),
    ))

  test("a half-open node (silent, no close frame) goes offline after livenessTimeoutMs", () =>
    run(
      Effect.gen(function*() {
        const server = yield* startServer
        const admin = yield* NodeAdmin
        const directory = yield* NodeDirectory
        const registry = yield* NodeRegistry
        const keys = yield* nodeKeys
        const paired = yield* pairOverHttp(server.http, (yield* admin.createPairingCode).code, keys)
        const nodeId = paired.body.nodeId as NodeId
        const silenced = { on: false }
        yield* connectTestNode({ wsBase: server.ws, nodeId, keys, brainPublicKey: paired.body.brainPublicKey, silenced, pingInterval: 100 })
        yield* registry.awaitConnection(nodeId).pipe(Effect.timeout("5 seconds"))
        // a live node (pinging) stays online well past the timeout
        yield* Effect.sleep("3 seconds")
        expect((yield* directory.get(nodeId)).status).toBe("online")
        // the node vanishes without closing (sleep, Wi-Fi drop): the brain notices
        silenced.on = true
        const offline = yield* Effect.gen(function*() {
          for (let i = 0; i < 800; i++) {
            const n = yield* directory.get(nodeId)
            if (n.status !== "online") return n
            yield* Effect.sleep("10 millis")
          }
          return yield* directory.get(nodeId)
        })
        expect(offline.status).toBe("offline")
      }).pipe(Effect.provide(Layer.fresh(brainStack({ dataRoot: dir.path, livenessTimeoutMs: 1_500 })))),
    ), 20_000)

  test("signed-upgrade negatives answer 401 without upgrading", () =>
    withBrain(
      Effect.gen(function*() {
        const server = yield* startServer
        const admin = yield* NodeAdmin
        const keys = yield* nodeKeys
        const paired = yield* pairOverHttp(server.http, (yield* admin.createPairingCode).code, keys)
        const nodeId = paired.body.nodeId

        expect(yield* upgradeStatus(server.http, undefined)).toBe(401)
        expect(yield* upgradeStatus(server.http, "Bearer abc")).toBe(401)

        // wrong key (another node's key signing for this id)
        const other = yield* Effect.orDie(generateKeyPair)
        const forged = yield* Effect.orDie(makeUpgradeAuth({ nodeId, privateKey: other.privateKey, brainOrigin: BRAIN_ORIGIN }))
        expect(yield* upgradeStatus(server.http, forged.header)).toBe(401)

        // wrong origin (signed for another brain)
        const elsewhere = yield* Effect.orDie(makeUpgradeAuth({ nodeId, privateKey: keys.privateKey, brainOrigin: "https://evil.test" }))
        expect(yield* upgradeStatus(server.http, elsewhere.header)).toBe(401)

        // unknown node id
        const unknown = yield* Effect.orDie(makeUpgradeAuth({ nodeId: "nod_unknown", privateKey: keys.privateKey, brainOrigin: BRAIN_ORIGIN }))
        expect(yield* upgradeStatus(server.http, unknown.header)).toBe(401)

        // replay: the same signed header works once
        const once = yield* Effect.orDie(makeUpgradeAuth({ nodeId, privateKey: keys.privateKey, brainOrigin: BRAIN_ORIGIN }))
        const node = yield* connectTestNode({
          wsBase: server.ws,
          nodeId,
          keys,
          brainPublicKey: paired.body.brainPublicKey,
          header: () => once.header,
        })
        // the hello nonce of the replayed header differs from what the test node signed, so the node
        // refuses the hello; the point here is the second use of the header:
        expect(yield* upgradeStatus(server.http, once.header)).toBe(401)
        yield* node.peer.mux.close(1000, "done")
      }),
    ))

  // also the regression test for a node dropping while it is being attached: closeAll runs right
  // after `awaitConnection`, possibly before `attach` has returned; the node must still go offline
  test("closeAll (brain shutdown) disconnects remote nodes with 1001", () =>
    withBrain(
      Effect.gen(function*() {
        const server = yield* startServer
        const admin = yield* NodeAdmin
        const directory = yield* NodeDirectory
        const registry = yield* NodeRegistry
        const keys = yield* nodeKeys
        const paired = yield* pairOverHttp(server.http, (yield* admin.createPairingCode).code, keys)
        const nodeId = paired.body.nodeId as NodeId
        const node = yield* connectTestNode({ wsBase: server.ws, nodeId, keys, brainPublicKey: paired.body.brainPublicKey })
        yield* registry.awaitConnection(nodeId).pipe(Effect.timeout("5 seconds"))
        yield* registry.closeAll()
        expect(yield* node.closeCode.pipe(Effect.timeout("5 seconds"))).toBe(1001)
        yield* Effect.sleep("50 millis")
        expect((yield* directory.get(nodeId)).status).toBe("offline")
      }),
    ))

  test("a node whose hello does not verify is closed with 4403", () =>
    withBrain(
      Effect.gen(function*() {
        const server = yield* startServer
        const admin = yield* NodeAdmin
        const registry = yield* NodeRegistry
        const keys = yield* nodeKeys
        const paired = yield* pairOverHttp(server.http, (yield* admin.createPairingCode).code, keys)
        // the node pinned a different brain key: it refuses the brain's hello
        const wrongPin = yield* Effect.orDie(generateKeyPair)
        const node = yield* connectTestNode({
          wsBase: server.ws,
          nodeId: paired.body.nodeId,
          keys,
          brainPublicKey: wrongPin.publicKey,
        })
        expect(yield* node.closeCode.pipe(Effect.timeout("5 seconds"))).toBe(CloseCodes.helloFailed)
        expect(node.state.verified).toBe(false)
        expect(Option.isNone(yield* registry.connection(paired.body.nodeId))).toBe(true)
      }),
    ))
})
