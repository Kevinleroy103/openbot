// ComputerService (D1.7, architecture §5.5): computer.status/ensure/lease over a remote node with a
// browser, the screencast relay (one node stream per bot fanned out to every viewer, late joiners get
// the last frame), the control lease mirrored with lease.set, and input only from the lease holder.
import { afterAll, describe, expect, test } from "bun:test"
import type { BotId, NodeId } from "@openbot/contracts"
import { ComputerPort, NodeAdmin } from "@openbot/core"
import { makeBot } from "@openbot/core/testing"
import { decodeScreencastFrame, DesktopUnavailable } from "@openbot/node-protocol"
import { Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
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

// ============================================================================ desktop surface (desktop@1)

const closeCodeOf = (io: Duplex) =>
  Effect.flip(Effect.forever(io.pull)).pipe(
    Effect.map((e) => (e.reason._tag === "SocketCloseError" ? e.reason.code : undefined)),
    Effect.timeout("5 seconds"),
  )

const bytes = (frames: ReadonlyArray<Frame>) => frames.filter((f): f is Uint8Array => typeof f !== "string")
const text = (b: Uint8Array) => new TextDecoder().decode(b)

const connectDesktopNode = (
  wsBase: string,
  httpBase: string,
  capabilities: ReadonlyArray<string>,
  desktop?: { readonly missing: ReadonlyArray<string>; readonly width: number; readonly height: number },
) =>
  Effect.gen(function*() {
    const admin = yield* NodeAdmin
    const registry = yield* NodeRegistry
    const keys = yield* nodeKeys
    const paired = yield* pairOverHttp(httpBase, (yield* admin.createPairingCode).code, keys)
    const nodeId = paired.body.nodeId as NodeId
    const scope = yield* Scope.fork(yield* Effect.scope)
    const node = yield* connectTestNode({
      wsBase,
      nodeId,
      keys,
      brainPublicKey: paired.body.brainPublicKey,
      capabilities,
      ...(desktop === undefined ? {} : { desktop }),
    }).pipe(Scope.provide(scope))
    yield* registry.awaitConnection(nodeId).pipe(Effect.timeout("5 seconds"))
    return { nodeId, node, disconnect: Scope.close(scope, Exit.void) }
  })

describe("computer: desktop", () => {
  test("status → ensure (desktop.ensure) → VNC relay both ways, one node stream per viewer → lease → control → release → reset", () =>
    run(
      Effect.gen(function*() {
        const server = yield* startServer
        const computer = yield* ComputerPort
        const service = yield* ComputerService
        const { node, nodeId } = yield* connectDesktopNode(server.ws, server.http, ["fs@1", "browser@1", "desktop@1"], {
          missing: [],
          width: 1920,
          height: 1200,
        })
        const botId = "bot_desk" as BotId
        yield* putBot(makeBot({ id: botId, name: "Desk", hostNodeId: nodeId }))
        const changes = yield* Stream.runCollect(Stream.take(computer.leaseChanges, 3)).pipe(
          Effect.forkChild({ startImmediately: true }),
        )

        // desktop wins over browser; the size is known from node.hello before the desktop runs
        expect(yield* computer.status(botId)).toEqual({
          botId,
          nodeId,
          controller: "bot",
          state: "absent",
          surface: "desktop",
          viewPath: `/ws/computer/${botId}`,
          width: 1920,
          height: 1200,
        })
        const ensured = yield* computer.ensure(botId)
        expect(ensured).toMatchObject({ state: "ready", surface: "desktop", width: 1920, height: 1200 })
        expect(node.state.desktops).toEqual([botId])
        expect(node.state.ensured).toEqual([]) // no browser.ensure on a desktop node
        yield* computer.ensure(botId)
        expect(node.state.desktops).toEqual([botId])

        // control needs the lease first
        expect(yield* upgradeStatus(`${server.ws}/ws/computer/${botId}?mode=control`)).toBe(403)

        // two watchers: each gets its own vnc-view stream, raw bytes both ways
        const v1 = yield* open(yield* dialWebSocket(`${server.ws}/ws/computer/${botId}?mode=view`))
        const g1 = yield* collect(v1, (fs) => bytes(fs).length >= 1)
        expect(text(bytes(g1)[0]!)).toBe("RFB 003.008\n")
        const v2 = yield* open(yield* dialWebSocket(`${server.ws}/ws/computer/${botId}?mode=view`))
        yield* collect(v2, (fs) => bytes(fs).length >= 1)
        expect(node.state.vncStreams).toEqual([{ botId, mode: "view" }, { botId, mode: "view" }])
        expect(yield* service.viewerCount(botId)).toBe(2)
        yield* v1.writer.write(new Uint8Array([1, 2, 3]))
        const echoed = bytes(yield* collect(v1, (fs) => bytes(fs).length >= 1))
        expect([...echoed[0]!]).toEqual([0xee, 1, 2, 3])
        expect(node.state.vncReceived.map((b) => [...b])).toContainEqual([1, 2, 3])
        // a stray text frame goes on as bytes (VNC is binary)
        yield* v2.writer.write("hi")
        expect(text(bytes(yield* collect(v2, (fs) => bytes(fs).length >= 1))[0]!.subarray(1))).toBe("hi")

        // take control: mirrored to the node; a control viewer gets a vnc-control stream
        const taken = yield* computer.lease(botId, true)
        expect(taken.controller).toBe("user")
        expect(node.state.leases).toEqual([{ botId, holder: "user" }])
        const control = yield* open(yield* dialWebSocket(`${server.ws}/ws/computer/${botId}?mode=control`))
        yield* collect(control, (fs) => bytes(fs).length >= 1)
        expect(node.state.vncStreams.at(-1)).toEqual({ botId, mode: "control" })
        yield* control.writer.write(new Uint8Array([5, 0, 10, 0, 20])) // a PointerEvent
        expect([...bytes(yield* collect(control, (fs) => bytes(fs).length >= 1))[0]!]).toEqual([0xee, 5, 0, 10, 0, 20])

        // hand back: control viewers close with 1000, watchers stay
        const released = yield* computer.lease(botId, false)
        expect(released.controller).toBe("bot")
        expect(node.state.leases.at(-1)).toEqual({ botId, holder: "bot" })
        expect(yield* closeCodeOf(control)).toBe(1000)
        yield* Effect.gen(function*() {
          while ((yield* service.viewerCount(botId)) > 2) yield* Effect.sleep("10 millis")
        }).pipe(Effect.timeout("5 seconds"))
        yield* v1.writer.write(new Uint8Array([9]))
        expect([...bytes(yield* collect(v1, (fs) => bytes(fs).length >= 1))[0]!]).toEqual([0xee, 9])

        // reset (while the user holds control): every viewer closes with 1012, the desktop stops
        yield* computer.lease(botId, true)
        const reset = yield* computer.reset(botId)
        expect(reset).toMatchObject({ state: "absent", controller: "bot", surface: "desktop" })
        expect(node.state.stopped).toEqual([botId])
        expect(yield* closeCodeOf(v1)).toBe(1012)
        expect(yield* closeCodeOf(v2)).toBe(1012)

        const seen = [...(yield* Fiber.join(changes))]
        expect(seen).toEqual([
          { botId, holder: "user", cause: "lease" },
          { botId, holder: "bot", cause: "lease" },
          { botId, holder: "user", cause: "lease" },
        ])
        // the next viewer starts a fresh desktop
        const v3 = yield* open(yield* dialWebSocket(`${server.ws}/ws/computer/${botId}?mode=view`))
        yield* collect(v3, (fs) => bytes(fs).length >= 1)
        expect(node.state.desktops).toEqual([botId, botId])
      }).pipe(Effect.provide(Layer.fresh(brainStack({ dataRoot: dir.path })))),
    ), 20_000)

  test("reset publishes the end of the owner's control; a browser-only node has nothing to reset", () =>
    run(
      Effect.gen(function*() {
        const server = yield* startServer
        const computer = yield* ComputerPort
        const desk = yield* connectDesktopNode(server.ws, server.http, ["fs@1", "desktop@1"])
        const botId = "bot_reset" as BotId
        yield* putBot(makeBot({ id: botId, name: "Reset", hostNodeId: desk.nodeId }))
        yield* computer.ensure(botId)
        yield* computer.lease(botId, true)
        const changes = yield* Stream.runCollect(Stream.take(computer.leaseChanges, 1)).pipe(
          Effect.forkChild({ startImmediately: true }),
        )
        yield* computer.reset(botId)
        expect([...(yield* Fiber.join(changes))]).toEqual([{ botId, holder: "bot", cause: "reset" }])

        const web = yield* connectDesktopNode(server.ws, server.http, ["fs@1", "browser@1"])
        const webBot = "bot_webonly" as BotId
        yield* putBot(makeBot({ id: webBot, name: "Web", hostNodeId: web.nodeId }))
        yield* computer.ensure(webBot)
        expect(yield* computer.reset(webBot)).toMatchObject({ surface: "browser", state: "ready" })
        expect(web.node.state.stopped).toEqual([])
      }).pipe(Effect.provide(Layer.fresh(brainStack({ dataRoot: dir.path })))),
    ), 20_000)

  test("missing programs: browser surface kept with `missing`; none surface says so; a failed desktop.ensure reports them", () =>
    run(
      Effect.gen(function*() {
        const server = yield* startServer
        const computer = yield* ComputerPort
        const lacking = { missing: ["Xvfb", "x11vnc"], width: 1920, height: 1200 }

        const web = yield* connectDesktopNode(server.ws, server.http, ["fs@1", "browser@1"], lacking)
        const webBot = "bot_lacking" as BotId
        yield* putBot(makeBot({ id: webBot, name: "Lacking", hostNodeId: web.nodeId }))
        expect(yield* computer.status(webBot)).toMatchObject({ surface: "browser", state: "absent", missing: ["Xvfb", "x11vnc"] })
        expect((yield* computer.status(webBot)).width).toBeUndefined()

        const bare = yield* connectDesktopNode(server.ws, server.http, ["fs@1"], lacking)
        const bareBot = "bot_bare" as BotId
        yield* putBot(makeBot({ id: bareBot, name: "Bare", hostNodeId: bare.nodeId }))
        const none = yield* computer.status(bareBot)
        expect(none).toMatchObject({ surface: "none", state: "unsupported", missing: ["Xvfb", "x11vnc"] })
        expect(none.message).toContain("can't give Bare a screen yet")

        const broken = yield* connectDesktopNode(server.ws, server.http, ["fs@1", "desktop@1"])
        broken.node.state.desktopFailure = new DesktopUnavailable({ message: "Xvfb did not start", missing: ["xdotool"] })
        const brokenBot = "bot_broken" as BotId
        yield* putBot(makeBot({ id: brokenBot, name: "Broken", hostNodeId: broken.nodeId }))
        const failed = yield* computer.ensure(brokenBot)
        expect(failed).toMatchObject({ surface: "desktop", state: "error", missing: ["xdotool"] })
        expect(failed.message).toContain("Xvfb did not start")
        // a viewer is told why (1011 + reason)
        const v = yield* open(yield* dialWebSocket(`${server.ws}/ws/computer/${brokenBot}?mode=view`))
        expect(yield* closeCodeOf(v)).toBe(1011)
        // it works once the node can start it
        broken.node.state.desktopFailure = undefined
        expect(yield* computer.ensure(brokenBot)).toMatchObject({ state: "ready" })
        expect((yield* computer.status(brokenBot)).missing).toBeUndefined()
      }).pipe(Effect.provide(Layer.fresh(brainStack({ dataRoot: dir.path })))),
    ), 20_000)

  test("a control viewer whose lease ends before its stream opens is refused with 4403", () =>
    run(
      Effect.gen(function*() {
        const server = yield* startServer
        const computer = yield* ComputerPort
        const { nodeId } = yield* connectDesktopNode(server.ws, server.http, ["fs@1", "desktop@1"])
        const botId = "bot_race" as BotId
        yield* putBot(makeBot({ id: botId, name: "Race", hostNodeId: nodeId }))
        yield* computer.ensure(botId)
        yield* computer.lease(botId, true)
        // the node forgets the lease (e.g. it restarted): it refuses the control stream itself
        const registry = yield* NodeRegistry
        const conn = yield* registry.connection(nodeId)
        if (conn._tag === "Some") yield* conn.value.client["lease.set"]({ botId, holder: "bot" })
        const control = yield* open(yield* dialWebSocket(`${server.ws}/ws/computer/${botId}?mode=control`))
        expect(yield* closeCodeOf(control)).toBe(4403)
      }).pipe(Effect.provide(Layer.fresh(brainStack({ dataRoot: dir.path })))),
    ), 20_000)

  test("a screen started by a bot action (node event desktop.started) is ready; desktop.stopped clears it", () =>
    run(
      Effect.gen(function*() {
        const server = yield* startServer
        const computer = yield* ComputerPort
        const registry = yield* NodeRegistry
        const { node, nodeId } = yield* connectDesktopNode(server.ws, server.http, ["fs@1", "desktop@1"])
        const botId = "bot_desk_acting" as BotId
        yield* putBot(makeBot({ id: botId, name: "Desk", hostNodeId: nodeId }))
        const stateOf = (want: string) =>
          Effect.gen(function*() {
            for (let i = 0; i < 100; i++) {
              const s = yield* computer.status(botId)
              if (s.state === want) return s
              yield* Effect.sleep("10 millis")
            }
            return yield* computer.status(botId)
          })
        expect((yield* computer.status(botId)).state).toBe("absent")
        yield* registry.publishEvent({ nodeId: "nod_other" as NodeId, type: "desktop.started", data: { botId, display: ":100", width: 1920, height: 1200 } })
        expect((yield* computer.status(botId)).state).toBe("absent")
        yield* registry.publishEvent({ nodeId, type: "desktop.started", data: { botId, display: ":100", width: 1920, height: 1200 } })
        expect(yield* stateOf("ready")).toMatchObject({ state: "ready", surface: "desktop", nodeId })
        // already ready: ensure does not start it again
        yield* computer.ensure(botId)
        expect(node.state.desktops).toEqual([])
        yield* registry.publishEvent({ nodeId, type: "desktop.stopped", data: { botId } })
        expect((yield* stateOf("absent")).state).toBe("absent")
      }).pipe(Effect.provide(Layer.fresh(brainStack({ dataRoot: dir.path })))),
    ), 20_000)
})
