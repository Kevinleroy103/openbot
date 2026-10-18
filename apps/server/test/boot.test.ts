// Brain lifecycle: restart with boot recovery and persistent sessions, the data-dir lock,
// `--no-local-node`, and a fast graceful shutdown with open sockets and a connected node.
import { describe, expect, test } from "bun:test"
import { LOCAL_NODE_ID, pendingRequestsOf, type RuntimeRequest, type Turn } from "@openbot/contracts"
import { makeKeyStore, pairNode, RemoteNodeLive } from "@openbot/node-daemon"
import { Effect, Exit, Layer, Ref, Scope, Stream } from "effect"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eventually, login, rpcClient, startServer, watchConversation } from "./helpers.ts"

describe("boot", () => {
  test("restart: a turn waiting on approval is interrupted, its request expired, the bot continues; the session survives", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openbot-boot-test-"))
    try {
      const first = await startServer({ dataDir })
      const cookie = await login(first.base, first.ownerToken)
      const { botId, conversationId } = await first.run(Effect.gen(function*() {
        const client = yield* rpcClient(`${first.wsBase}/rpc`, { cookie, origin: first.base })
        const bot = yield* client["bots.create"]({ name: "Sleeper", harness: { kind: "fake" }, autonomy: "ask", clientNonce: "boot-1" })
        const convo = yield* watchConversation(client, bot.directConversationId)
        yield* client["messages.send"]({ conversationId: bot.directConversationId, text: "approve: deploy", clientNonce: "b1" })
        yield* eventually(Ref.get(convo.state), (s) => pendingRequestsOf(s).length === 1, { label: "pending approval" })
        return { botId: bot.id, conversationId: bot.directConversationId }
      }))
      await first.close({ keepData: true })

      const second = await startServer({ dataDir })
      try {
        // same owner token, and the cookie from before the restart is still a session
        expect(second.ownerToken).toBe(first.ownerToken)
        expect(await (await fetch(`${second.base}/api/auth/status`, { headers: { cookie } })).json()).toEqual({ authenticated: true })
        await second.run(Effect.gen(function*() {
          const client = yield* rpcClient(`${second.wsBase}/rpc`, { cookie, origin: second.base })
          expect((yield* client["bots.get"]({ botId })).name).toBe("Sleeper")
          const convo = yield* watchConversation(client, conversationId)
          const state = yield* eventually(Ref.get(convo.state), (s) => s.synchronized, { label: "synchronized" })
          const requests: Array<RuntimeRequest> = [...state.requests.values()]
          expect(pendingRequestsOf(state)).toHaveLength(0)
          expect(requests.some((r) => r.status === "expired" || r.status === "cancelled")).toBe(true)
          const turns: Array<Turn> = [...state.turns.values()]
          expect(turns.filter((t) => t.trigger === "user").map((t) => t.status)).toEqual(["interrupted"])
          // the cut-off bot continues where it was (a system turn), then is idle again
          yield* eventually(Ref.get(convo.state), (s) => {
            const all = [...s.turns.values()]
            return all.some((t) => t.trigger === "system" && t.status === "completed") &&
              all.every((t) => !["queued", "running", "waiting"].includes(t.status))
          }, { label: "resumed" })
          // the bot works again after the restart
          yield* client["messages.send"]({ conversationId, text: "echo: back again", clientNonce: "b2" })
          yield* eventually(
            Ref.get(convo.state),
            (s) => [...s.entries.values()].some((e) => e.kind === "message" && e.role === "bot" && e.text.includes("back again")),
            { label: "reply after restart" },
          )
        }))
      } finally {
        await second.close({ keepData: true })
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 60_000)

  test("a data dir locked by another live brain is refused; a stale lock is taken over", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "openbot-lock-test-"))
    try {
      await Bun.write(join(dataDir, "brain.pid"), `${process.ppid}\n`)
      const refused = await startServer({ dataDir }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(String((refused as { message?: string })?.message ?? refused)).toContain("another OpenBot brain")

      await Bun.write(join(dataDir, "brain.pid"), "999999999\n")
      const server = await startServer({ dataDir })
      expect((await Bun.file(join(dataDir, "brain.pid")).text()).trim()).toBe(String(process.pid))
      await server.close({ keepData: true })
      expect(await Bun.file(join(dataDir, "brain.pid")).exists()).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)

  test("a port already in use is refused (no SO_REUSEPORT sharing)", async () => {
    const first = await startServer()
    try {
      const port = Number(new URL(first.base).port)
      const refused = await startServer({ config: { port } }).then(
        (second) => second.close().then(() => "started"),
        (error: unknown) => String(error),
      )
      expect(refused).not.toBe("started")
      expect(refused).toMatch(/ServeError|in use/i)
    } finally {
      await first.close()
    }
  }, 30_000)

  test("--no-local-node: no node_local", async () => {
    const server = await startServer({ config: { localNode: false } })
    try {
      const cookie = await login(server.base, server.ownerToken)
      await server.run(Effect.gen(function*() {
        const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base })
        const nodes = yield* client["nodes.list"]()
        expect(nodes.some((n) => n.id === LOCAL_NODE_ID)).toBe(false)
      }))
    } finally {
      await server.close()
    }
  }, 30_000)

  test("shutdown is quick with an open /rpc socket, a live subscription and a connected node", async () => {
    const server = await startServer()
    const cookie = await login(server.base, server.ownerToken)
    const clientScope = Effect.runSync(Scope.make())
    const machine = mkdtempSync(join(tmpdir(), "openbot-shutdown-node-"))
    try {
      await server.run(Effect.gen(function*() {
        const client = yield* rpcClient(`${server.wsBase}/rpc`, { cookie, origin: server.base }).pipe(
          Effect.provideService(Scope.Scope, clientScope),
        )
        yield* client["roster.subscribe"]({}).pipe(Stream.runDrain, Effect.forkIn(clientScope))
        const pairing = yield* client["nodes.createPairingCode"]()
        mkdirSync(join(machine, "root"), { recursive: true })
        const identity = yield* pairNode({
          brainUrl: server.base,
          code: pairing.code,
          keyStore: makeKeyStore(join(machine, "data")),
          hostname: "box",
        })
        yield* Layer.buildWithScope(
          RemoteNodeLive({
            node: {
              nodeId: identity.nodeId,
              dataDir: join(machine, "data"),
              roots: [join(machine, "root")],
              detectBinaries: false,
              browser: { enabled: false },
              forwardAudit: false,
            },
            dial: { identity, heartbeatMs: 0 },
          }),
          clientScope,
        )
        yield* eventually(client["nodes.list"](), (all) => all.some((n) => n.id === identity.nodeId && n.status === "online"), {
          label: "node online",
        })
      }))
      const started = Date.now()
      await server.close()
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      await Effect.runPromise(Scope.close(clientScope, Exit.void))
      rmSync(machine, { recursive: true, force: true })
    }
  }, 30_000)
})
