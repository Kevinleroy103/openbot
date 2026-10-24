import { describe, expect, test } from "bun:test"
import type { ProcessRecord } from "@openbot/core"
import { Deferred, Effect, Exit, Queue, Scope } from "effect"
import {
  type AppServerLauncher,
  connectAppServer,
  makeCodexRuntime,
  OPT_OUT_NOTIFICATIONS,
  threadIdOf,
  type ThreadMessage,
} from "../src/appServer.ts"
import { FakeAppServer, fakeLauncher, rpcError, run, waitUntil } from "./support.ts"

const binary = () => ({ path: "/usr/bin/codex", source: "config" as const, pathDirs: [] })

const drain = (mailbox: Queue.Dequeue<ThreadMessage, unknown>) =>
  Effect.map(Queue.clear(mailbox), (messages) => [...messages])

describe("app-server connection", () => {
  test("handshake: initialize with experimentalApi and opt-outs, then initialized", async () => {
    const result = await run(
      Effect.gen(function* () {
        const server = yield* FakeAppServer.make()
        const connection = yield* connectAppServer({
          transport: server.transport,
          clientInfo: { name: "openbot", title: "OpenBot", version: "1.2.3" },
        })
        yield* waitUntil(() => server.received.length === 2, "initialized")
        return { server, info: connection.info }
      }),
    )
    expect(result.server.received[0]).toEqual({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "openbot", title: "OpenBot", version: "1.2.3" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: OPT_OUT_NOTIFICATIONS },
      },
    })
    expect(result.server.received[1]).toEqual({ method: "initialized" })
    expect(result.info).toEqual({
      userAgent: "openbot/0.162.1 (Test OS; x86_64) test (openbot; 0.0.0)",
      version: "0.162.1",
      codexHome: "/tmp/codex-home",
      platformOs: "linux",
      platformFamily: "unix",
    })
  })

  test("routing by threadId: early messages are buffered; unknown threads' requests are refused", async () => {
    const result = await run(
      Effect.gen(function* () {
        const server = yield* FakeAppServer.make()
        const connection = yield* connectAppServer({ transport: server.transport })
        server.notify("thread/started", { thread: { id: "t1" } })
        server.notify("turn/started", { threadId: "t1", turn: { id: "u1" } })
        server.notify("account/updated", { authMode: "chatgpt" })
        const refused = server.request("item/commandExecution/requestApproval", { threadId: "nobody" })
        const reply = yield* Effect.promise(() => refused)
        const mailbox = yield* connection.openThreadMailbox("t1")
        server.notify("item/started", { threadId: "t1", turnId: "u1", item: { type: "agentMessage", id: "m" } })
        server.notify("item/started", { threadId: "t2", turnId: "u2", item: { type: "agentMessage", id: "m" } })
        const approval = server.request("item/fileChange/requestApproval", {
          threadId: "t1",
          turnId: "u1",
          itemId: "f",
        })
        yield* waitUntil(() => Queue.sizeUnsafe(mailbox) === 4)
        const messages = yield* drain(mailbox)
        const request = messages[3]
        if (request?._tag === "Request") yield* Deferred.succeed(request.reply, { result: { decision: "accept" } })
        const answered = yield* Effect.promise(() => approval)
        return { reply, messages, answered }
      }),
    )
    expect(result.reply).toMatchObject({ id: 0, error: { code: -32601 } })
    expect(result.messages.map((m) => (m._tag === "Closed" ? m._tag : `${m._tag}:${m.method}`))).toEqual([
      "Notification:thread/started",
      "Notification:turn/started",
      "Notification:item/started",
      "Request:item/fileChange/requestApproval",
    ])
    expect(result.answered).toEqual({ id: 1, result: { decision: "accept" } })
  })

  test("a second mailbox for the same thread takes over; the first one is closed", async () => {
    const result = await run(
      Effect.gen(function* () {
        const server = yield* FakeAppServer.make()
        const connection = yield* connectAppServer({ transport: server.transport })
        const first = yield* connection.openThreadMailbox("t1")
        const second = yield* connection.openThreadMailbox("t1")
        server.notify("turn/started", { threadId: "t1", turn: { id: "u1" } })
        yield* waitUntil(() => Queue.sizeUnsafe(second) === 1)
        const firstMessages = yield* drain(first)
        // An ended queue fails `take` with Done.
        const firstDone = Exit.isFailure(yield* Effect.exit(Queue.take(first)))
        return { first: firstMessages, second: yield* drain(second), firstDone }
      }),
    )
    expect(result.first).toEqual([{ _tag: "Closed", reason: "Another OpenBot session took over this Codex thread." }])
    expect(result.firstDone).toBe(true)
    expect(result.second.length).toBe(1)
  })

  test("when the process dies every mailbox gets Closed; later mailboxes are closed at once", async () => {
    const result = await run(
      Effect.gen(function* () {
        const server = yield* FakeAppServer.make()
        const connection = yield* connectAppServer({ transport: server.transport })
        const mailbox = yield* connection.openThreadMailbox("t1")
        server.close()
        const reason = yield* connection.closed
        const late = yield* connection.openThreadMailbox("t2")
        return { reason, messages: yield* drain(mailbox), late: yield* drain(late), closed: yield* connection.isClosed }
      }),
    )
    expect(result.reason).toBe("fake app-server exited")
    expect(result.messages).toEqual([{ _tag: "Closed", reason: "fake app-server exited" }])
    expect(result.late).toEqual([{ _tag: "Closed", reason: "fake app-server exited" }])
    expect(result.closed).toBe(true)
  })

  test("threadIdOf reads threadId or thread.id", () => {
    expect(threadIdOf({ threadId: "a" })).toBe("a")
    expect(threadIdOf({ thread: { id: "b" } })).toBe("b")
    expect(threadIdOf({})).toBeUndefined()
    expect(threadIdOf(null)).toBeUndefined()
  })
})

describe("app-server runtime (one per CODEX_HOME)", () => {
  test("one shared process, recorded in the ledger; restarted on next use after it died", async () => {
    const ledger: Array<string> = []
    const result = await run(
      Effect.gen(function* () {
        const { launcher, launches } = fakeLauncher(() => FakeAppServer.make())
        const withPid: AppServerLauncher = (spec) =>
          Effect.map(launcher(spec), (launched) => ({ ...launched, pid: 4000 + launches.length }))
        let prepared = 0
        const scope = yield* Scope.make()
        const runtime = yield* makeCodexRuntime({
          binary,
          launcher: withPid,
          codexHome: "/data/codex-home",
          beforeStart: Effect.sync(() => void prepared++),
          ledger: {
            record: (entry: ProcessRecord) =>
              Effect.sync(() => void ledger.push(`+${entry.pid}:${entry.pgid}:${entry.kind}`)),
            remove: (pid: number) => Effect.sync(() => void ledger.push(`-${pid}`)),
          },
        }).pipe(Scope.provide(scope))
        const a = yield* runtime.acquire
        const b = yield* runtime.acquire
        const same = a === b
        launches[0]!.server.close()
        yield* a.closed
        yield* waitUntil(() => ledger.includes("-4001"), "ledger removal")
        const c = yield* runtime.acquire
        const current = yield* runtime.current
        yield* Scope.close(scope, Exit.void)
        return {
          same,
          restarted: c !== a,
          current: current === c,
          launches: launches.length,
          prepared,
          specs: launches.map((l) => l.spec),
        }
      }),
    )
    expect(result.same).toBe(true)
    expect(result.restarted).toBe(true)
    expect(result.current).toBe(true)
    expect(result.launches).toBe(2)
    expect(result.prepared).toBe(2)
    expect(result.specs[0]).toMatchObject({ args: ["app-server"], codexHome: "/data/codex-home" })
    expect(ledger).toEqual(["+4001:4001:codex-app-server", "-4001", "+4002:4002:codex-app-server", "-4002"])
  })

  test("withConnection: a short-lived process when none runs, the shared one otherwise", async () => {
    const result = await run(
      Effect.gen(function* () {
        const { launcher, launches } = fakeLauncher(() => FakeAppServer.make())
        const runtime = yield* makeCodexRuntime({ binary, launcher, codexHome: "/c" })
        const probe = runtime.withConnection((connection) => connection.request("account/read", {}))
        yield* probe
        const shortLived = launches[0]!.server
        yield* waitUntil(() => shortLived.received.length > 0)
        const afterProbe = yield* runtime.current
        yield* runtime.acquire
        yield* probe
        return { launches: launches.length, afterProbe }
      }),
    )
    expect(result.afterProbe).toBeUndefined()
    expect(result.launches).toBe(2) // the probe's own process, then the shared one (reused by the 2nd probe)
  })

  test("not installed and initialize failures are HarnessErrors", async () => {
    const result = await run(
      Effect.gen(function* () {
        const none = yield* makeCodexRuntime({
          binary: () => undefined,
          launcher: fakeLauncher(() => FakeAppServer.make()).launcher,
          codexHome: "/c",
        })
        const missing = yield* Effect.exit(none.acquire)
        const broken = yield* makeCodexRuntime({
          binary,
          launcher: fakeLauncher(() =>
            FakeAppServer.make({ initialize: () => rpcError(-32600, "Already initialized?") }),
          ).launcher,
          codexHome: "/c",
        })
        const failed = yield* Effect.exit(broken.acquire)
        return { missing, failed }
      }),
    )
    const failure = (exit: Exit.Exit<unknown, unknown>) => {
      const reason = Exit.isFailure(exit) ? exit.cause.reasons.find((r) => r._tag === "Fail") : undefined
      return reason && "error" in reason ? reason.error : undefined
    }
    expect(failure(result.missing)).toMatchObject({ code: "not-installed" })
    expect(failure(result.failed)).toMatchObject({
      code: "open-failed",
      message: expect.stringContaining("did not initialize"),
    })
  })
})
