// ComputerService (D1.7, architecture §5.5): computer.status/ensure/lease over a remote node with a
// browser, the screencast relay (one node stream per bot fanned out to every viewer, late joiners get
// the last frame), the control lease mirrored with lease.set, and input only from the lease holder.
import { afterAll, describe, expect, test } from "bun:test"
import type { BotId, NodeId } from "@openbot/contracts"
import { ComputerPort, NodeAdmin } from "@openbot/core"
import { makeBot } from "@openbot/core/testing"
import { decodeScreencastFrame } from "@openbot/node-protocol"
import { Effect, Exit, Layer, Scope } from "effect"
import { ComputerService, type Duplex, type Frame, NodeRegistry, open } from "../src/index.ts"
import { brainStack, connectTestNode, dialWebSocket, nodeKeys, pairOverHttp, putBot, run, startServer, tempDir } from "./helpers.ts"

const dir = tempDir()
afterAll(() => dir.cleanup())

const upgradeStatus = (url: string) =>
  Effect.promise(async () =>
    (await fetch(url.replace(/^ws/, "http"), {
      headers: {
        connection: "upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    })).status
  )

/** Collect frames until `done(frames)` holds. */
const collect = (io: Duplex, done: (frames: ReadonlyArray<Frame>) => boolean) =>
  Effect.gen(function*() {
    const frames: Array<Frame> = []
    while (!done(frames)) frames.push(...(yield* io.pull))
    return frames
  }).pipe(Effect.timeout("5 seconds"))

const texts = (frames: ReadonlyArray<Frame>) => frames.filter((f): f is string => typeof f === "string").map((f) => JSON.parse(f))
const images = (frames: ReadonlyArray<Frame>) => frames.filter((f): f is Uint8Array => typeof f !== "string")

const connectBrowserNode = (wsBase: string, httpBase: string, capabilities: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const admin = yield* NodeAdmin
    const registry = yield* NodeRegistry
    const keys = yield* nodeKeys
    const paired = yield* pairOverHttp(httpBase, (yield* admin.createPairingCode).code, keys)
    const nodeId = paired.body.nodeId as NodeId
    // a child of the test scope: an open node socket would keep the test server from stopping
    const scope = yield* Scope.fork(yield* Effect.scope)
    const node = yield* connectTestNode({ wsBase, nodeId, keys, brainPublicKey: paired.body.brainPublicKey, capabilities }).pipe(
      Scope.provide(scope),
    )
    yield* registry.awaitConnection(nodeId).pipe(Effect.timeout("5 seconds"))
    return { nodeId, node, disconnect: Scope.close(scope, Exit.void) }
  })

describe("computer", () => {
  test("status → ensure → viewers share one screencast → lease → control input → release", () =>
    run(
      Effect.gen(function*() {
        const server = yield* startServer
        const computer = yield* ComputerPort
        const service = yield* ComputerService
        const { node, nodeId } = yield* connectBrowserNode(server.ws, server.http, ["fs@1", "shell@1", "browser@1"])
        const botId = "bot_web" as BotId
        yield* putBot(makeBot({ id: botId, name: "Webby", hostNodeId: nodeId }))

        expect(yield* computer.status(botId)).toEqual({
          botId,
          nodeId,
          controller: "bot",
          state: "absent",
          surface: "browser",
          viewPath: `/ws/computer/${botId}`,
        })
        const ensured = yield* computer.ensure(botId)
        expect(ensured.state).toBe("ready")
        expect(node.state.ensured).toEqual([botId])
        // ensure is idempotent once ready
        yield* computer.ensure(botId)
        expect(node.state.ensured).toEqual([botId])

        // control needs the lease first
        expect(yield* upgradeStatus(`${server.ws}/ws/computer/${botId}?mode=control`)).toBe(403)

        // first viewer starts the screencast
        const v1 = yield* open(yield* dialWebSocket(`${server.ws}/ws/computer/${botId}?mode=view`))
        const f1 = yield* collect(v1, (fs) => images(fs).length >= 1 && texts(fs).some((t) => t._tag === "Url"))
        expect(texts(f1)[0]).toEqual({ _tag: "Lease", holder: "bot" })
        expect(texts(f1)).toContainEqual({ _tag: "Url", url: "https://example.com/", title: "Example" })
        expect(decodeScreencastFrame(images(f1)[0]!)?.meta).toMatchObject({ seq: 1, mime: "image/jpeg" })

        // a late joiner gets the lease, the last URL and the last frame at once; still one node stream
        const v2 = yield* open(yield* dialWebSocket(`${server.ws}/ws/computer/${botId}?mode=view`))
        const f2 = yield* collect(v2, (fs) => fs.length >= 3)
        expect(texts(f2)).toEqual([{ _tag: "Lease", holder: "bot" }, { _tag: "Url", url: "https://example.com/", title: "Example" }])
        expect(images(f2)).toHaveLength(1)
        expect(node.state.screencasts).toEqual([botId])
        expect(yield* service.viewerCount(botId)).toBe(2)

        // view-mode input is ignored
        yield* v1.writer.write(JSON.stringify({ _tag: "text", text: "ignored" }))

        // take control: mirrored to the node, broadcast to viewers
        const taken = yield* computer.lease(botId, true)
        expect(taken.controller).toBe("user")
        expect(node.state.leases).toEqual([{ botId, holder: "user" }])
        expect(texts(yield* collect(v1, (fs) => fs.length >= 1))).toEqual([{ _tag: "Lease", holder: "user" }])

        const control = yield* open(yield* dialWebSocket(`${server.ws}/ws/computer/${botId}?mode=control`))
        yield* collect(control, (fs) => texts(fs).some((t) => t._tag === "Lease"))
        const click = { _tag: "mouse", type: "down", x: 10, y: 20, button: "left", clickCount: 1 }
        yield* control.writer.write(JSON.stringify(click))
        yield* control.writer.write("not json")
        yield* Effect.gen(function*() {
          while (node.state.inputs.length < 1) yield* Effect.sleep("10 millis")
        }).pipe(Effect.timeout("5 seconds"))
        yield* Effect.sleep("50 millis")
        expect(node.state.inputs).toEqual([click])

        // release: the node gets the lease back, control sockets close, viewers stay
        const released = yield* computer.lease(botId, false)
        expect(released.controller).toBe("bot")
        expect(node.state.leases.at(-1)).toEqual({ botId, holder: "bot" })
        const closed = yield* Effect.flip(Effect.forever(control.pull)).pipe(Effect.timeout("5 seconds"))
        expect(closed._tag).toBe("SocketError")
        expect(yield* service.viewerCount(botId)).toBe(2)
      }).pipe(Effect.provide(Layer.fresh(brainStack({ dataRoot: dir.path })))),
    ), 20_000)

  test("no browser → unsupported and Conflict; offline host → error; unknown bot → NotFound", () =>
    run(
      Effect.gen(function*() {
        const server = yield* startServer
        const computer = yield* ComputerPort
        const plain = yield* connectBrowserNode(server.ws, server.http, ["fs@1", "shell@1"])
        const botId = "bot_plain" as BotId
        yield* putBot(makeBot({ id: botId, name: "Plain", hostNodeId: plain.nodeId }))
        expect(yield* computer.status(botId)).toMatchObject({ state: "unsupported", surface: "none" })
        expect(yield* computer.ensure(botId)).toMatchObject({ state: "unsupported" })
        expect((yield* Effect.flip(computer.lease(botId, true)))._tag).toBe("Conflict")
        expect(yield* upgradeStatus(`${server.ws}/ws/computer/${botId}`)).toBe(409)

        const web = yield* connectBrowserNode(server.ws, server.http, ["fs@1", "browser@1"])
        const webBot = "bot_gone" as BotId
        yield* putBot(makeBot({ id: webBot, name: "Gone", hostNodeId: web.nodeId }))
        yield* web.disconnect
        yield* Effect.sleep("100 millis")
        const offline = yield* computer.status(webBot)
        expect(offline).toMatchObject({ state: "error", surface: "browser" })
        expect(offline.message).toContain("offline")
        expect((yield* Effect.flip(computer.ensure(webBot)))._tag).toBe("NodeUnavailable")
        expect(yield* upgradeStatus(`${server.ws}/ws/computer/${webBot}`)).toBe(503)

        expect((yield* Effect.flip(computer.status("bot_nobody" as BotId)))._tag).toBe("NotFound")
      }).pipe(Effect.provide(Layer.fresh(brainStack({ dataRoot: dir.path })))),
    ), 20_000)

  test("a window opened by a bot action (node event browser.opened) makes the screen ready; browser.closed clears it", () =>
    run(
      Effect.gen(function*() {
        const server = yield* startServer
        const computer = yield* ComputerPort
        const registry = yield* NodeRegistry
        const { node, nodeId } = yield* connectBrowserNode(server.ws, server.http, ["fs@1", "browser@1"])
        const botId = "bot_acting" as BotId
        yield* putBot(makeBot({ id: botId, name: "Actor", hostNodeId: nodeId }))
        expect((yield* computer.status(botId)).state).toBe("absent")

        // events from another node, or for another bot, change nothing
        yield* registry.publishEvent({ nodeId: "nod_other" as NodeId, type: "browser.opened", data: { botId, windowTargetId: "T0" } })
        expect((yield* computer.status(botId)).state).toBe("absent")

        yield* registry.publishEvent({ nodeId, type: "browser.opened", data: { botId, windowTargetId: "T1" } })
        const ready = yield* Effect.gen(function*() {
          for (let i = 0; i < 100; i++) {
            const s = yield* computer.status(botId)
            if (s.state === "ready") return s
            yield* Effect.sleep("10 millis")
          }
          return yield* computer.status(botId)
        })
        expect(ready).toMatchObject({ state: "ready", surface: "browser", nodeId })
        // already ready: ensure does not call the node again
        yield* computer.ensure(botId)
        expect(node.state.ensured).toEqual([])

        yield* registry.publishEvent({ nodeId, type: "browser.closed", data: { botId, reason: "the bot's window was closed" } })
        const absent = yield* Effect.gen(function*() {
          for (let i = 0; i < 100; i++) {
            const s = yield* computer.status(botId)
            if (s.state === "absent") return s
            yield* Effect.sleep("10 millis")
          }
          return yield* computer.status(botId)
        })
        expect(absent.state).toBe("absent")
      }).pipe(Effect.provide(Layer.fresh(brainStack({ dataRoot: dir.path })))),
    ), 20_000)

  test("the last viewer leaving stops the screencast; a new viewer gets a fresh one (no hub-lock deadlock)", () =>
    run(
      Effect.gen(function*() {
        const server = yield* startServer
        const computer = yield* ComputerPort
        const service = yield* ComputerService
        const { node, nodeId } = yield* connectBrowserNode(server.ws, server.http, ["fs@1", "browser@1"])
        const botId = "bot_rejoin" as BotId
        yield* putBot(makeBot({ id: botId, name: "Rejoin", hostNodeId: nodeId }))
        yield* computer.ensure(botId)

        const watchOnce = Effect.scoped(Effect.gen(function*() {
          const v = yield* open(yield* dialWebSocket(`${server.ws}/ws/computer/${botId}?mode=view`))
          return yield* collect(v, (fs) => images(fs).length >= 1)
        }))
        expect(images(yield* watchOnce)).toHaveLength(1)
        // the viewer closed: the hub goes away
        yield* Effect.gen(function*() {
          while ((yield* service.viewerCount(botId)) > 0) yield* Effect.sleep("10 millis")
        }).pipe(Effect.timeout("5 seconds"))
        // a new viewer is served (before the fix, leaving deadlocked on the hub lock)
        expect(images(yield* watchOnce)).toHaveLength(1)
        expect(node.state.screencasts).toEqual([botId, botId])
      }).pipe(Effect.provide(Layer.fresh(brainStack({ dataRoot: dir.path })))),
    ), 20_000)
})
