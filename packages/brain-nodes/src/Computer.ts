/**
 * `ComputerService` (architecture §4.8, §5.5; D1.7; remote-computer-control.md §5): the bot's live
 * browser on its host node, and the user's terminal there.
 *
 * - `ComputerPort` (`computer.status / ensure / lease`): `ensure` → `browser.ensure` on the host node.
 *   The brain owns the control LEASE and mirrors it with `lease.set`; while the user holds it the node
 *   refuses the bot's `browser.action` with `LeaseHeld` ("The user is controlling the browser").
 * - Viewer socket (`/ws/computer/:botId?mode=view|control`, public listener; the server checks the
 *   cookie, Origin and bot ACL first): one CDP screencast per bot is fanned out to every viewer
 *   (one node data stream per bot, not per viewer). Binary frames are `encodeScreencastFrame` frames,
 *   text frames are `ScreencastNotice` JSON, both forwarded verbatim. New viewers get the last frame
 *   and URL immediately (idle pages do not repaint). In `control` mode (lease holder only), text frames
 *   from the viewer are `BrowserInputEvent` JSON and go to `browser.input`.
 * - Terminal socket (`/ws/terminal/:botId?cols=&rows=`): `pty.open` in the bot's workspace on its host
 *   node (created first), spliced to the node's `pty` stream (binary = terminal bytes; text =
 *   `{"resize":{cols,rows}}` from the viewer, `{"exit":…}` from the node). For xterm.js, whose
 *   `onData` yields strings, any OTHER text frame from the viewer is forwarded as UTF-8 terminal
 *   bytes. On failure the viewer gets a text frame `{"error": "…"}` and a 1011 close.
 *
 * VNC (`desktop@1`) is designed only: such nodes report `surface: "desktop"`, `state: "unsupported"`.
 */
import type { BotId, ComputerState, ComputerStatus, NodeId, NodeSummary } from "@openbot/contracts"
import { Conflict, LOCAL_NODE_ID, NodeUnavailable, NotFound } from "@openbot/contracts"
import { BotRepo, ComputerPort, DataDir, IdGen, NodeDirectory, workspacePathFor } from "@openbot/core"
import {
  BrowserInputEvent,
  describeNodeError,
  hasCapability,
  type LeaseHolder,
  NodeEventTypes,
  PtyResize,
} from "@openbot/node-protocol"
import { Context, Effect, Exit, Fiber, Layer, Option, Result, Schema, Semaphore, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import type * as Socket from "effect/socket/Socket"
import { mkdir } from "node:fs/promises"
import { NodeRegistry } from "./NodeRegistry.ts"
import { closeWriter, type Duplex, type Frame, open, splice } from "./splice.ts"
import { openNodeStream, StreamBroker } from "./StreamBroker.ts"

type Handler = Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>

export type ViewerMode = "view" | "control"

export interface ComputerServiceShape {
  readonly status: (botId: BotId) => Effect.Effect<ComputerStatus, NotFound>
  readonly ensure: (botId: BotId) => Effect.Effect<ComputerStatus, NotFound | NodeUnavailable>
  readonly lease: (botId: BotId, take: boolean) => Effect.Effect<ComputerStatus, NotFound | NodeUnavailable | Conflict>
  /** `GET /ws/computer/:botId?mode=view|control` — call AFTER the server authorized the request. */
  readonly viewer: (input: { readonly botId: string; readonly mode: ViewerMode }) => Handler
  /** `GET /ws/terminal/:botId?cols=&rows=` — call AFTER the server authorized the request. */
  readonly terminal: (input: { readonly botId: string; readonly cols?: number | undefined; readonly rows?: number | undefined }) => Handler
  /** Viewers currently attached to a bot's screencast (tests, diagnostics). */
  readonly viewerCount: (botId: BotId) => Effect.Effect<number>
}

export class ComputerService extends Context.Service<ComputerService, ComputerServiceShape>()(
  "openbot/brain-nodes/ComputerService",
) {}

interface BotComputer {
  readonly nodeId: NodeId
  state: ComputerState
  message: string | undefined
  windowTargetId: string | undefined
}

interface Viewer {
  readonly id: number
  readonly mode: ViewerMode
  readonly writer: Socket.Writer
}

interface Hub {
  readonly botId: BotId
  readonly nodeId: NodeId
  readonly viewers: Map<number, Viewer>
  lastFrame: Uint8Array | undefined
  lastUrl: string | undefined
  fiber: Fiber.Fiber<void> | undefined
}

const surfaceOf = (capabilities: ReadonlyArray<string>): ComputerStatus["surface"] =>
  hasCapability(capabilities, "browser") ? "browser" : hasCapability(capabilities, "desktop") ? "desktop" : "none"

const decodeInput = Schema.decodeUnknownOption(Schema.fromJsonString(BrowserInputEvent))
const decodeNotice = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ _tag: Schema.String })),
)

const nodeErrorText = (e: unknown): string => {
  if (typeof e === "object" && e !== null && "_tag" in e) {
    const tag = (e as { _tag: string })._tag
    if (tag === "RpcClientError") return "the computer is unreachable"
    try {
      return describeNodeError(e as Parameters<typeof describeNodeError>[0])
    } catch {
      return tag
    }
  }
  return String(e)
}

const decodePtyResize = Schema.decodeUnknownOption(Schema.fromJsonString(PtyResize))
const isPtyResize = (text: string): boolean => text.startsWith("{") && Option.isSome(decodePtyResize(text))
const utf8 = new TextEncoder()

/**
 * Viewer → node frames of the terminal socket: binary and `{"resize":…}` pass verbatim; any other text
 * (xterm.js `onData` strings) becomes UTF-8 terminal bytes, since the node treats text as control.
 */
export const terminalInputFrame = (frame: Frame): Frame =>
  typeof frame !== "string" || isPtyResize(frame) ? frame : utf8.encode(frame)

/**
 * Any failure reaching a node, as the CONTRACT `NodeUnavailable{nodeId, message}` (the error the
 * `OpenBotRpcs` and the gateway render). node-protocol has its own `NodeUnavailable{nodeId, reason}`
 * and typed wire errors; those become the message text.
 */
export const toNodeUnavailable = (nodeId: NodeId, error: unknown): NodeUnavailable =>
  error instanceof NodeUnavailable ? error : new NodeUnavailable({ nodeId, message: nodeErrorText(error) })

const clampSize = (n: number | undefined, fallback: number, max: number) =>
  n === undefined || !Number.isFinite(n) || n < 1 ? fallback : Math.min(Math.floor(n), max)

export const makeComputerService = Effect.gen(function*() {
  const bots = yield* BotRepo
  const directory = yield* NodeDirectory
  const registry = yield* NodeRegistry
  const broker = yield* StreamBroker
  const dataDir = yield* DataDir
  const ids = yield* IdGen
  const layerScope = yield* Effect.scope

  const computers = new Map<BotId, BotComputer>()
  const controllers = new Map<BotId, LeaseHolder>()
  const hubs = new Map<BotId, Hub>()
  const hubLock = yield* Semaphore.make(1)
  const ensureLocks = new Map<BotId, Semaphore.Semaphore>()
  let viewerSeq = 0

  const getBot = (botId: BotId) =>
    Effect.flatMap(Effect.orDie(bots.get(botId)), (bot) =>
      Option.isSome(bot) ? Effect.succeed(bot.value) : Effect.fail(new NotFound({ entity: "bot", id: botId })))

  const controllerOf = (botId: BotId): LeaseHolder => controllers.get(botId) ?? "bot"

  const statusOf = (botId: BotId) =>
    Effect.gen(function*() {
      const bot = yield* getBot(botId)
      const nodeId = bot.hostNodeId
      const node = yield* Effect.option(directory.get(nodeId))
      const base = { botId, nodeId, controller: controllerOf(botId) } as const
      if (Option.isNone(node)) {
        return { ...base, state: "error", surface: "none", message: `Can't reach ${bot.name}'s computer` } satisfies ComputerStatus
      }
      const surface = surfaceOf(node.value.capabilities)
      if (surface === "none") {
        return {
          ...base,
          state: "unsupported",
          surface,
          message: `${node.value.label} has no browser for ${bot.name}`,
        } satisfies ComputerStatus
      }
      if (surface === "desktop") {
        return { ...base, state: "unsupported", surface, message: "The desktop view is not available yet" } satisfies ComputerStatus
      }
      const viewPath = `/ws/computer/${botId}`
      if (node.value.status !== "online") {
        return {
          ...base,
          state: "error",
          surface,
          viewPath,
          message: `Can't reach ${bot.name}'s screen: ${node.value.label} is offline`,
        } satisfies ComputerStatus
      }
      const c = computers.get(botId)
      const current = c !== undefined && c.nodeId === nodeId ? c : undefined
      return {
        ...base,
        state: current?.state ?? "absent",
        surface,
        viewPath,
        ...(current?.message === undefined ? {} : { message: current.message }),
      } satisfies ComputerStatus
    })

  const setComputer = (botId: BotId, nodeId: NodeId, patch: Partial<Omit<BotComputer, "nodeId">>) =>
    Effect.sync(() => {
      const prev = computers.get(botId)
      const base: BotComputer = prev !== undefined && prev.nodeId === nodeId
        ? prev
        : { nodeId, state: "absent", message: undefined, windowTargetId: undefined }
      computers.set(botId, { ...base, ...patch })
    })

  const lockFor = (botId: BotId) =>
    Effect.suspend(() => {
      const existing = ensureLocks.get(botId)
      if (existing !== undefined) return Effect.succeed(existing)
      return Effect.map(Semaphore.make(1), (s) => {
        ensureLocks.set(botId, s)
        return s
      })
    })

  // ---------------------------------------------------------------- viewers (fan-out)
  const broadcast = (hub: Hub, frame: Frame, filter?: (v: Viewer) => boolean) =>
    Effect.forEach(
      [...hub.viewers.values()].filter((v) => filter === undefined || filter(v)),
      (v) => Effect.ignore(v.writer.write(frame)),
      { discard: true },
    )

  const notice = (body: Record<string, unknown>) => JSON.stringify(body)

  const closeViewers = (hub: Hub, code: number, reason: string, filter?: (v: Viewer) => boolean) =>
    Effect.forEach(
      [...hub.viewers.values()].filter((v) => filter === undefined || filter(v)),
      (v) => closeWriter(v.writer, code, reason),
      { discard: true },
    )

  const mirrorLease = (botId: BotId, nodeId: NodeId, holder: LeaseHolder) =>
    Effect.flatMap(directory.client(nodeId), (client) => client["lease.set"]({ botId, holder }))

  // ---------------------------------------------------------------- ComputerPort
  const ensure: ComputerServiceShape["ensure"] = (botId) =>
    Effect.gen(function*() {
      const lock = yield* lockFor(botId)
      return yield* lock.withPermits(1)(
        Effect.gen(function*() {
          const s = yield* statusOf(botId)
          if (s.state === "unsupported" || s.state === "ready") return s
          const client = yield* directory.client(s.nodeId)
          yield* setComputer(botId, s.nodeId, { state: "starting", message: undefined })
          const ensured = yield* Effect.result(client["browser.ensure"]({ botId }))
          if (Result.isFailure(ensured)) {
            yield* setComputer(botId, s.nodeId, { state: "error", message: nodeErrorText(ensured.failure) })
          } else {
            yield* setComputer(botId, s.nodeId, {
              state: "ready",
              message: undefined,
              windowTargetId: ensured.success.windowTargetId,
            })
            if (controllerOf(botId) === "user") yield* Effect.ignore(mirrorLease(botId, s.nodeId, "user"))
          }
          return yield* statusOf(botId)
        }),
      )
    })

  const lease: ComputerServiceShape["lease"] = (botId, take) =>
    Effect.gen(function*() {
      const s = yield* statusOf(botId)
      if (s.surface !== "browser" || s.state === "unsupported") {
        return yield* new Conflict({ reason: "This computer has no live browser view" })
      }
      const holder: LeaseHolder = take ? "user" : "bot"
      const mirrored = yield* Effect.result(mirrorLease(botId, s.nodeId, holder))
      if (Result.isFailure(mirrored)) return yield* toNodeUnavailable(s.nodeId, mirrored.failure)
      controllers.set(botId, holder)
      const hub = hubs.get(botId)
      if (hub !== undefined) {
        yield* broadcast(hub, notice({ _tag: "Lease", holder }))
        if (!take) yield* closeViewers(hub, 1000, "control released", (v) => v.mode === "control")
      }
      return yield* statusOf(botId)
    })

  // ---------------------------------------------------------------- screencast hub
  /** Pump the bot's screencast to every viewer until the node stream ends or the hub stops. */
  const runHub = (hub: Hub) =>
    Effect.scoped(
      Effect.gen(function*() {
        const ensured = yield* Effect.result(ensure(hub.botId))
        if (Result.isFailure(ensured) || ensured.success.state !== "ready") {
          const message = Result.isFailure(ensured)
            ? ensured.failure.message
            : ensured.success.message ?? "The browser is not available"
          return yield* broadcast(hub, notice({ _tag: "Ended", reason: message }))
        }
        const client = yield* directory.client(hub.nodeId)
        const opened = yield* Effect.result(
          openNodeStream(broker, {
            nodeId: hub.nodeId,
            kind: "cdp-screencast",
            open: (ticket) =>
              client["browser.screencast"]({ botId: hub.botId, streamId: ticket.streamId, streamToken: ticket.streamToken }),
          }),
        )
        if (Result.isFailure(opened)) {
          return yield* broadcast(hub, notice({ _tag: "Ended", reason: nodeErrorText(opened.failure) }))
        }
        const node = yield* open(opened.success.socket)
        const pumped = yield* Effect.exit(
          Effect.forever(
            Effect.flatMap(node.pull, (frames) =>
              Effect.forEach(frames, (frame) => {
                if (typeof frame === "string") {
                  const tag = decodeNotice(frame)
                  if (Option.isSome(tag) && tag.value._tag === "Url") hub.lastUrl = frame
                } else {
                  hub.lastFrame = frame
                }
                return broadcast(hub, frame)
              }, { discard: true })),
          ),
        )
        if (Exit.isFailure(pumped)) {
          yield* broadcast(hub, notice({ _tag: "Ended", reason: "The screen stream ended" }))
        }
      }),
    ).pipe(
      Effect.catchCause((cause) => Effect.logDebug("screencast hub ended", { botId: hub.botId, cause })),
      Effect.ensuring(
        hubLock.withPermits(1)(
          Effect.suspend(() => {
            if (hubs.get(hub.botId) === hub) hubs.delete(hub.botId)
            // viewers fall back to reconnecting; they get a fresh hub
            return closeViewers(hub, 1011, "screen stream ended")
          }),
        ),
      ),
    )

  const joinHub = (botId: BotId, nodeId: NodeId, viewer: Omit<Viewer, "id">) =>
    hubLock.withPermits(1)(
      Effect.gen(function*() {
        let hub = hubs.get(botId)
        if (hub !== undefined && hub.nodeId !== nodeId) {
          // the bot moved to another node: stop the old stream
          if (hub.fiber !== undefined) yield* Fiber.interrupt(hub.fiber)
          hubs.delete(botId)
          hub = undefined
        }
        const v: Viewer = { ...viewer, id: ++viewerSeq }
        if (hub === undefined) {
          const created: Hub = { botId, nodeId, viewers: new Map([[v.id, v]]), lastFrame: undefined, lastUrl: undefined, fiber: undefined }
          hubs.set(botId, created)
          created.fiber = yield* Effect.forkIn(runHub(created), layerScope, { startImmediately: true })
          return { hub: created, viewer: v }
        }
        hub.viewers.set(v.id, v)
        return { hub, viewer: v }
      }),
    )

  /**
   * The last viewer stops the hub. The hub fiber is interrupted OUTSIDE the lock: its own finalizer
   * takes `hubLock`, so interrupting it while holding the lock would deadlock (every later viewer and
   * the brain's shutdown would hang).
   */
  const leaveHub = (hub: Hub, viewer: Viewer) =>
    hubLock.withPermits(1)(
      Effect.sync(() => {
        hub.viewers.delete(viewer.id)
        if (hub.viewers.size === 0 && hubs.get(hub.botId) === hub) {
          hubs.delete(hub.botId)
          return hub.fiber
        }
        return undefined
      }),
    ).pipe(Effect.flatMap((fiber) => (fiber === undefined ? Effect.void : Fiber.interrupt(fiber))))

  const runViewer = (socket: Socket.Socket, botId: BotId, nodeId: NodeId, mode: ViewerMode) =>
    Effect.scoped(
      Effect.gen(function*() {
        const io: Duplex = yield* open(socket)
        // joining and registering the leave are one step (a viewer can drop at any moment)
        const { hub } = yield* Effect.acquireRelease(
          joinHub(botId, nodeId, { mode, writer: io.writer }),
          (joined) => leaveHub(joined.hub, joined.viewer),
        )
        // late joiners see the current state at once
        yield* Effect.ignore(io.writer.write(notice({ _tag: "Lease", holder: controllerOf(botId) })))
        if (hub.lastUrl !== undefined) yield* Effect.ignore(io.writer.write(hub.lastUrl))
        if (hub.lastFrame !== undefined) yield* Effect.ignore(io.writer.write(hub.lastFrame))
        yield* Effect.forever(
          Effect.flatMap(io.pull, (frames) =>
            Effect.forEach(frames, (frame) => {
              if (mode !== "control" || typeof frame !== "string" || controllerOf(botId) !== "user") return Effect.void
              const event = decodeInput(frame)
              if (Option.isNone(event)) return Effect.void
              return directory.client(nodeId).pipe(
                Effect.flatMap((client) => client["browser.input"]({ botId, event: event.value })),
                Effect.ignore,
              )
            }, { discard: true })),
        )
      }),
    ).pipe(Effect.ignore)

  const viewer: ComputerServiceShape["viewer"] = ({ botId, mode }) =>
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const s = yield* Effect.result(statusOf(botId as BotId))
      if (Result.isFailure(s)) return HttpServerResponse.text("unknown bot", { status: 404 })
      const st = s.success
      if (st.surface !== "browser" || st.state === "unsupported") {
        return HttpServerResponse.text(st.message ?? "no live view", { status: 409 })
      }
      if (st.state === "error" && st.message !== undefined && Option.isNone(yield* Effect.option(directory.client(st.nodeId)))) {
        return HttpServerResponse.text(st.message, { status: 503 })
      }
      if (mode === "control" && st.controller !== "user") {
        return HttpServerResponse.text("Take control first", { status: 403 })
      }
      const upgraded = yield* Effect.result(request.upgrade)
      if (Result.isFailure(upgraded)) return HttpServerResponse.text("expected a WebSocket upgrade", { status: 400 })
      yield* runViewer(upgraded.success, botId as BotId, st.nodeId, mode)
      return HttpServerResponse.empty()
    })

  // ---------------------------------------------------------------- terminal
  const runTerminal = (socket: Socket.Socket, botId: BotId, node: NodeSummary, cols: number, rows: number) =>
    Effect.scoped(
      Effect.gen(function*() {
        const io = yield* open(socket)
        const fail = (message: string) =>
          Effect.andThen(Effect.ignore(io.writer.write(JSON.stringify({ error: message }))), closeWriter(io.writer, 1011, message))
        const client = yield* Effect.result(directory.client(node.id))
        if (Result.isFailure(client)) return yield* fail(client.failure.message)
        const cwd = workspacePathFor({ node, botId, dataDir })
        const inv = { invocationId: yield* ids.next("inv"), botId, runId: `terminal-${botId}` }
        if (node.id === LOCAL_NODE_ID) {
          yield* Effect.promise(() => mkdir(cwd, { recursive: true }).catch(() => undefined))
        } else {
          // best effort: the node reports its own error from pty.open when this fails
          yield* client.success["fs.mkdir"]({ inv, path: cwd, recursive: true }).pipe(
            Effect.timeout("10 seconds"),
            Effect.ignore,
          )
        }
        const opened = yield* Effect.result(
          openNodeStream(broker, {
            nodeId: node.id,
            kind: "pty",
            open: (ticket) =>
              client.success["pty.open"]({ inv, cols, rows, cwd, streamId: ticket.streamId, streamToken: ticket.streamToken }),
          }),
        )
        if (Result.isFailure(opened)) return yield* fail(nodeErrorText(opened.failure))
        const remote = yield* open(opened.success.socket)
        yield* splice(io, remote, { mapAB: terminalInputFrame })
      }),
    ).pipe(Effect.catchCause((cause) => Effect.logDebug("terminal ended", { botId, cause })))

  const terminal: ComputerServiceShape["terminal"] = ({ botId, cols, rows }) =>
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const bot = yield* Effect.option(getBot(botId as BotId))
      if (Option.isNone(bot)) return HttpServerResponse.text("unknown bot", { status: 404 })
      const node = yield* Effect.option(directory.get(bot.value.hostNodeId))
      if (Option.isNone(node) || node.value.status !== "online") {
        return HttpServerResponse.text(`Can't reach ${bot.value.name}'s computer`, { status: 503 })
      }
      if (!hasCapability(node.value.capabilities, "pty")) {
        return HttpServerResponse.text(`${node.value.label} has no terminal`, { status: 409 })
      }
      const upgraded = yield* Effect.result(request.upgrade)
      if (Result.isFailure(upgraded)) return HttpServerResponse.text("expected a WebSocket upgrade", { status: 400 })
      // detached: the route fiber is interrupted when the viewer closes (G2); drain the pty first
      const fiber = yield* Effect.forkDetach(
        runTerminal(upgraded.success, bot.value.id, node.value, clampSize(cols, 80, 1000), clampSize(rows, 24, 500)),
      )
      yield* Fiber.await(fiber)
      return HttpServerResponse.empty()
    })

  // ---------------------------------------------------------------- node lifecycle
  // a node that comes back online gets the user's leases again; one that goes away loses its windows
  yield* directory.changes.pipe(
    Stream.runForEach((change) =>
      Effect.gen(function*() {
        if (change.type === "node.removed") {
          for (const [botId, c] of computers) if (c.nodeId === change.nodeId) computers.delete(botId)
          return
        }
        const node = change.node
        for (const [botId, c] of [...computers]) {
          if (c.nodeId !== node.id) continue
          if (node.status !== "online") computers.set(botId, { ...c, state: "absent", windowTargetId: undefined })
        }
        if (node.status === "online") {
          for (const [botId, holder] of controllers) {
            if (holder !== "user") continue
            const bot = yield* Effect.option(getBot(botId))
            if (Option.isSome(bot) && bot.value.hostNodeId === node.id) yield* Effect.ignore(mirrorLease(botId, node.id, "user"))
          }
        }
      })
    ),
    Effect.forkIn(layerScope, { startImmediately: true }),
  )
  yield* registry.events.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        const data = (typeof event.data === "object" && event.data !== null ? event.data : {}) as Record<string, unknown>
        const botId = typeof data["botId"] === "string" ? (data["botId"] as BotId) : undefined
        if (botId === undefined) return
        const c = computers.get(botId)
        if (event.type === NodeEventTypes.browserClosed && c !== undefined && c.nodeId === event.nodeId) {
          computers.set(botId, { ...c, state: "absent", windowTargetId: undefined })
        }
        // a bot action (gateway `browser` tool) opened the window: the screen is there to watch
        if (event.type === NodeEventTypes.browserOpened) {
          const windowTargetId = typeof data["windowTargetId"] === "string" ? data["windowTargetId"] : undefined
          if (c === undefined || c.nodeId !== event.nodeId || c.state !== "starting") {
            computers.set(botId, { nodeId: event.nodeId, state: "ready", message: undefined, windowTargetId })
          }
        }
      })
    ),
    Effect.forkIn(layerScope, { startImmediately: true }),
  )

  const service = ComputerService.of({
    status: statusOf,
    ensure,
    lease,
    viewer,
    terminal,
    viewerCount: (botId) => Effect.sync(() => hubs.get(botId)?.viewers.size ?? 0),
  })
  return service
})

/** `ComputerPort` (for the `computer.*` RPCs) plus the viewer/terminal socket handlers. Layer 0. */
export const ComputerServiceLive: Layer.Layer<
  ComputerPort | ComputerService,
  never,
  BotRepo | NodeDirectory | NodeRegistry | StreamBroker | DataDir | IdGen
> = Layer.effectContext(
  Effect.map(makeComputerService, (service) =>
    Context.make(ComputerService, service).pipe(
      Context.add(ComputerPort, ComputerPort.of({ status: service.status, ensure: service.ensure, lease: service.lease })),
    )),
)
