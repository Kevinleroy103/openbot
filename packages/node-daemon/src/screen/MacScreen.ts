// The computer's own screen (capability `screen@1`, macOS): its bots and the owner share it.
//
// - Actions: the `computer` tool's actions, planned like on the X11 desktops (../desktop/actions.ts,
//   Mac key names) and replayed through the helper process (./helper.ts: CoreGraphics events).
// - Screenshots: `screencapture` (main display) scaled by `sips` to the model's 1280-wide space;
//   zoom captures the region. The live view streams the same frames (`screen` stream).
// - Sharing: one bot at a time (another bot that acted in the last minute keeps it); never while the
//   owner holds the lease for any bot, or used the Mac in the last 20 seconds (HID idle time; the
//   helper's own events do not count).
// - Permissions: Screen Recording and Accessibility for this program. Missing ones are reported
//   (`node.hello.screen.missing`, `screen.ensure`). macOS is asked right when the node starts (the
//   owner just ran the installer at the Mac) and again on later uses, at most every 30 seconds.
import {
  type BrowserImage,
  type BrowserInputEvent,
  type ComputerAction,
  type ComputerResult,
  DesktopUnavailable,
  encodeScreencastFrame,
  LeaseHeld,
  type ScreenInfo,
  type ScreenSupport,
} from "@openbot/node-protocol"
import { Context, Deferred, Effect, Layer, Semaphore } from "effect"
import type { Scope } from "effect"
import { existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { NodeConfig, type NodeConfigShape } from "../config.ts"
import { planAction } from "../desktop/actions.ts"
import { makeGeometry, toApi, toScreen, type ScreenGeometry, type ZoomRect } from "../desktop/geometry.ts"
import { LeaseBook, type LeaseBookShape } from "../lease.ts"
import type { Duplex } from "../sockets.ts"
import type { MacButton, MacIdle, MacInfo, MacOp } from "./helper.ts"
import { domCodeToMac, domFlags, macKey } from "./macKeys.ts"
import { macSteps } from "./plan.ts"

/** The owner used the Mac this recently (seconds): bots wait. */
export const OWNER_ACTIVE_S = 20
/** Another bot acted this recently (ms): the screen is still its. */
export const BOT_EXCLUSIVE_MS = 60_000
/** Asking macOS for missing permissions again (its prompts) waits at least this long, ms. */
const ASK_AGAIN_MS = 30_000
/** Delay before the screenshot that follows an action, ms. */
const SETTLE_MS = 350
/** Live view: time between frames, ms (each capture takes a few hundred ms itself). */
const FRAME_INTERVAL_MS = 700
const SHOT_QUALITY = 75
const STREAM_QUALITY = 55

const SCREENCAPTURE = "/usr/sbin/screencapture"
const SIPS = "/usr/bin/sips"
const OSASCRIPT = "/usr/bin/osascript"

export interface MacScreenShape {
  /** `screen@1` is offered: macOS, enabled, and the helper answered */
  readonly offered: boolean
  /** for `node.hello.screen` (as of the node's start) */
  readonly support: ScreenSupport | undefined
  readonly ensure: (botId: string) => Effect.Effect<ScreenInfo, DesktopUnavailable>
  readonly act: (botId: string, action: ComputerAction) => Effect.Effect<ComputerResult, DesktopUnavailable | LeaseHeld>
  /** live frames onto `io` until it closes */
  readonly stream: (input: { readonly botId: string; readonly io: Duplex }) => Effect.Effect<void>
  /** the owner's input from the web viewer (needs the lease) */
  readonly input: (botId: string, event: BrowserInputEvent) => Effect.Effect<void, DesktopUnavailable | LeaseHeld>
}

export class MacScreen extends Context.Service<MacScreen, MacScreenShape>()("openbot/node-daemon/MacScreen") {}

// ------------------------------------------------------------------ helper process
export interface HelperClient {
  readonly call: (op: MacOp) => Promise<unknown>
  readonly close: () => void
}

/** The helper's command: this program's `screen-helper` when compiled, else Bun running ./helper.ts. */
export const defaultHelperArgv = (): ReadonlyArray<string> =>
  import.meta.url.includes("$bunfs")
    ? [process.execPath, "screen-helper"]
    : [process.execPath, fileURLToPath(new URL("./helper.ts", import.meta.url))]

/**
 * Runs the helper on demand (again after it exits); one JSON line per request. Each helper process
 * answers only its own requests: a closed one exiting never fails those sent to its successor.
 */
export const spawnHelper = (argv: ReadonlyArray<string>, timeoutMs = 15_000): HelperClient => {
  interface Pending {
    readonly resolve: (v: unknown) => void
    readonly reject: (e: Error) => void
    readonly timer: Timer
  }
  interface Running {
    readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">
    readonly pending: Map<number, Pending>
  }
  let current: Running | undefined
  let nextId = 1
  const start = (): Running => {
    const proc = Bun.spawn([...argv], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    const running: Running = { proc, pending: new Map() }
    current = running
    let stderr = ""
    const decoder = new TextDecoder()
    void (async () => {
      for await (const c of proc.stderr) stderr = (stderr + decoder.decode(c)).slice(-2_000)
    })().catch(() => undefined)
    void (async () => {
      let buffered = ""
      const out = new TextDecoder()
      for await (const c of proc.stdout) {
        buffered += out.decode(c, { stream: true })
        let nl: number
        while ((nl = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, nl)
          buffered = buffered.slice(nl + 1)
          try {
            const r = JSON.parse(line) as { id: number; ok: boolean; value?: unknown; error?: string }
            const waiting = running.pending.get(r.id)
            if (!waiting) continue
            running.pending.delete(r.id)
            clearTimeout(waiting.timer)
            if (r.ok) waiting.resolve(r.value)
            else waiting.reject(new Error(r.error ?? "the screen helper failed"))
          } catch {
            // not a response line
          }
        }
      }
    })().catch(() => undefined)
    void proc.exited.then((code) => {
      if (current === running) current = undefined
      const last = stderr.trim().split("\n").at(-1)
      const reason = `the screen helper stopped (exit ${code})${last ? `: ${last}` : ""}`
      for (const p of running.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error(reason))
      }
      running.pending.clear()
    })
    return running
  }
  return {
    call: (op) =>
      new Promise((resolve, reject) => {
        let running: Running
        try {
          running = current ?? start()
        } catch (e) {
          return reject(new Error(`the screen helper did not start: ${e instanceof Error ? e.message : String(e)}`))
        }
        const id = nextId++
        const timer = setTimeout(() => {
          running.pending.delete(id)
          reject(new Error(`the screen helper did not answer (${op.op})`))
        }, timeoutMs)
        running.pending.set(id, { resolve, reject, timer })
        running.proc.stdin.write(`${JSON.stringify({ id, ...op })}\n`)
        void running.proc.stdin.flush()
      }),
    close: () => {
      const running = current
      current = undefined
      if (!running) return
      try {
        void running.proc.stdin.end()
      } catch {
        // gone
      }
      setTimeout(() => running.proc.kill(), 1_000).unref()
    },
  }
}

// ------------------------------------------------------------------ system (screenshots, cursor)
export interface ScreenSystem {
  readonly exec: (
    argv: ReadonlyArray<string>,
    timeoutMs: number,
  ) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>
  readonly readFile: (path: string) => Promise<Uint8Array>
  readonly exists: (path: string) => boolean
  readonly remove: (path: string) => void
  readonly tmpdir: string
}

export const liveScreenSystem: ScreenSystem = {
  exec: async (argv, timeoutMs) => {
    const p = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => p.kill(), timeoutMs)
    const [code, stdout, stderr] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ])
    clearTimeout(timer)
    return { code, stdout, stderr }
  },
  readFile: async (p) => new Uint8Array(await Bun.file(p).arrayBuffer()),
  exists: existsSync,
  remove: (p) => rmSync(p, { force: true }),
  tmpdir: tmpdir(),
}

/** The pointer in global display points (AppKit's origin is the bottom left of the main display). */
const CURSOR_SCRIPT =
  'ObjC.import("AppKit"); var p = $.NSEvent.mouseLocation; var h = $.NSScreen.screens.objectAtIndex(0).frame.size.height; JSON.stringify({x: Math.round(p.x), y: Math.round(h - p.y)})'
/** Shows macOS's Accessibility prompt for this program. */
const ACCESSIBILITY_PROMPT_SCRIPT =
  'ObjC.import("ApplicationServices"); $.AXIsProcessTrustedWithOptions($({AXTrustedCheckOptionPrompt: true}))'

export const missingPermissions = (info: MacInfo): ReadonlyArray<string> => [
  ...(info.screenRecording ? [] : ["Screen Recording"]),
  ...(info.accessibility ? [] : ["Accessibility"]),
]

export const permissionMessage = (missing: ReadonlyArray<string>): string =>
  `Allow ${missing.join(" and ")} for openbot-node on the Mac (System Settings › Privacy & Security), then try again.`

/** The owner's input → helper requests (coordinates in the frame's viewport, i.e. the API space). */
export const inputOps = (g: ScreenGeometry, event: BrowserInputEvent): ReadonlyArray<MacOp> => {
  switch (event._tag) {
    case "mouse": {
      const p = toScreen(g, event.x, event.y)
      const flags = domFlags(event.modifiers)
      const move: MacOp = { op: "move", x: p.x, y: p.y, flags }
      const button: MacButton = event.button === "right" ? "right" : event.button === "middle" ? "middle" : "left"
      switch (event.type) {
        case "move":
          return [move]
        case "down":
        case "up":
          return [move, { op: "button", button, down: event.type === "down", clicks: event.clickCount ?? 1, flags }]
        case "wheel":
          return [move, { op: "scroll", dx: -(event.deltaX ?? 0), dy: -(event.deltaY ?? 0), unit: "pixel", flags }]
      }
      return []
    }
    case "key": {
      const keyCode = domCodeToMac(event.code) ?? (event.key.length === 1 ? macKey(event.key)?.keyCode : undefined)
      if (keyCode === undefined) return event.type === "down" && event.text ? [{ op: "type", text: event.text }] : []
      return [{ op: "keyEvent", keyCode, down: event.type === "down", flags: domFlags(event.modifiers) }]
    }
    case "text":
      return event.text === "" ? [] : [{ op: "type", text: event.text }]
  }
}

const unavailable = (message: string, missing?: ReadonlyArray<string>) =>
  new DesktopUnavailable({ message, ...(missing && missing.length > 0 ? { missing: [...missing] } : {}) })
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

export const makeMacScreen = (input: {
  readonly config: NodeConfigShape
  readonly leases?: LeaseBookShape | undefined
  readonly helper?: HelperClient | undefined
  readonly system?: ScreenSystem | undefined
  readonly now?: (() => number) | undefined
}): Effect.Effect<MacScreenShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { config, leases } = input
    const disabled: MacScreenShape = {
      offered: false,
      support: undefined,
      ensure: () => Effect.fail(unavailable("This computer has no screen to share.")),
      act: () => Effect.fail(unavailable("This computer has no screen to share.")),
      stream: () => Effect.void,
      input: () => Effect.fail(unavailable("This computer has no screen to share.")),
    }
    if (config.platform !== "darwin" || config.screen?.enabled === false) return disabled
    const sys = input.system ?? liveScreenSystem
    const now = input.now ?? Date.now
    const helper = input.helper ?? spawnHelper(config.screen?.helper ?? defaultHelperArgv())
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => helper.call({ op: "release" }).catch(() => undefined)).pipe(
        Effect.timeoutOption(2_000),
        Effect.andThen(Effect.sync(() => helper.close())),
      ),
    )
    const call = <A>(op: MacOp) =>
      Effect.tryPromise({ try: () => helper.call(op) as Promise<A>, catch: (e) => unavailable(messageOf(e)) })

    const first = yield* Effect.result(call<MacInfo>({ op: "info" }))
    if (first._tag === "Failure") {
      yield* Effect.logWarning("the Mac screen helper did not start", { reason: first.failure.message })
      return {
        ...disabled,
        support: { missing: [`the screen helper (${first.failure.message})`], width: 0, height: 0 },
      }
    }
    let info = first.success
    let geometry = makeGeometry(info.width, info.height)
    let askedAt = Number.NEGATIVE_INFINITY
    const lock = yield* Semaphore.make(1)
    const inputLock = yield* Semaphore.make(1)
    let lastBot: { readonly botId: string; readonly at: number } | undefined
    const userHolds = new Set<string>()
    if (leases) {
      leases.subscribe((s) => {
        if (s.holder === "user") userHolds.add(s.botId)
        else userHolds.delete(s.botId)
        // whoever gets the screen next starts with nothing held
        void helper.call({ op: "release" }).catch(() => undefined)
      })
    }

    /** Current display and permissions (a fresh helper while permissions are missing: macOS caches them per process). */
    const refresh = Effect.gen(function* () {
      if (missingPermissions(info).length > 0) helper.close()
      info = yield* call<MacInfo>({ op: "info" })
      geometry = makeGeometry(info.width, info.height)
      return info
    })

    /** macOS's own prompts for what is missing (each with a button to the right settings pane). */
    const askForPermissions = (current: MacInfo) =>
      Effect.gen(function* () {
        if (now() - askedAt < ASK_AGAIN_MS) return
        askedAt = now()
        if (!current.screenRecording) yield* Effect.ignore(call({ op: "requestScreenRecording" }))
        if (!current.accessibility) {
          yield* Effect.promise(() =>
            sys.exec([OSASCRIPT, "-l", "JavaScript", "-e", ACCESSIBILITY_PROMPT_SCRIPT], 10_000).catch(() => undefined),
          )
        }
      })

    const requirePermissions = Effect.gen(function* () {
      const current = yield* refresh
      const missing = missingPermissions(current)
      if (missing.length === 0) return current
      yield* askForPermissions(current)
      return yield* Effect.fail(unavailable(permissionMessage(missing), missing))
    })

    // right away, while the owner is at the Mac (they just installed or updated the node)
    if (missingPermissions(info).length > 0) yield* Effect.forkScoped(askForPermissions(info))

    const capture = (zoom: ZoomRect | undefined, quality: number) =>
      Effect.tryPromise({
        try: async () => {
          const id = `${process.pid}-${now()}-${Math.random().toString(36).slice(2, 8)}`
          const raw = path.join(sys.tmpdir, `openbot-screen-${id}.jpg`)
          const out = path.join(sys.tmpdir, `openbot-screen-${id}-out.jpg`)
          const width = zoom ? zoom.outWidth : geometry.apiWidth
          const height = zoom ? zoom.outHeight : geometry.apiHeight
          try {
            const region = zoom ? ["-R", `${zoom.x},${zoom.y},${zoom.width},${zoom.height}`] : ["-m"]
            const shot = await sys.exec([SCREENCAPTURE, "-x", "-t", "jpg", ...region, raw], 15_000)
            if (shot.code !== 0 || !sys.exists(raw)) throw new Error(shot.stderr.trim() || "screencapture failed")
            const scaled = await sys.exec(
              [
                SIPS,
                "-s",
                "format",
                "jpeg",
                "-s",
                "formatOptions",
                String(quality),
                "-z",
                String(height),
                String(width),
                raw,
                "--out",
                out,
              ],
              15_000,
            )
            if (scaled.code !== 0 || !sys.exists(out)) throw new Error(scaled.stderr.trim() || "sips failed")
            return { bytes: await sys.readFile(out), width, height }
          } finally {
            sys.remove(raw)
            sys.remove(out)
          }
        },
        catch: (e) => unavailable(`could not take a screenshot: ${messageOf(e)}`),
      })

    const screenshot = (zoom?: ZoomRect) =>
      Effect.map(capture(zoom, SHOT_QUALITY), (s): BrowserImage => ({
        mimeType: "image/jpeg",
        data: Buffer.from(s.bytes).toString("base64"),
        width: s.width,
        height: s.height,
      }))

    const cursor = Effect.tryPromise({
      try: async () => {
        const r = await sys.exec([OSASCRIPT, "-l", "JavaScript", "-e", CURSOR_SCRIPT], 10_000)
        const p = JSON.parse(r.stdout.trim()) as { x: number; y: number }
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error(r.stderr.trim() || "no position")
        return p
      },
      catch: (e) => unavailable(`cannot read the mouse position: ${messageOf(e)}`),
    })

    const held = (botId: string, reason: string) => new LeaseHeld({ botId, holder: "user", reason })

    const act = (
      botId: string,
      action: ComputerAction,
    ): Effect.Effect<ComputerResult, DesktopUnavailable | LeaseHeld> =>
      Effect.gen(function* () {
        yield* requirePermissions
        const plan = planAction(geometry, action, { mac: true })
        if (typeof plan === "string") return { text: `ERROR: ${plan}` }
        const steps = macSteps(plan)
        if (typeof steps === "string") return { text: `ERROR: ${steps}` }
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (userHolds.size > 0)
              return yield* held(botId, "The owner is controlling this screen. Wait until they hand it back.")
            const idle = yield* call<MacIdle>({ op: "idle" })
            // input after this helper's last event came from someone at the Mac
            if (idle.idle < OWNER_ACTIVE_S && idle.idle + 0.5 < idle.sincePost) {
              return yield* held(
                botId,
                "The owner is using this computer right now. Try again in a few minutes, or ask them in the chat.",
              )
            }
            if (lastBot && lastBot.botId !== botId && now() - lastBot.at < BOT_EXCLUSIVE_MS) {
              return yield* held(botId, "Another Bot is using this screen right now. Try again in a minute.")
            }
            lastBot = { botId, at: now() }
            if (steps.needsPointer) {
              const p = yield* Effect.option(cursor)
              if (p._tag === "Some") yield* call({ op: "move", x: p.value.x, y: p.value.y })
            }
            const run = Effect.forEach(
              steps.steps,
              (step) => (step.op === "sleep" ? Effect.sleep(step.ms) : Effect.asVoid(call(step))),
              { discard: true },
            )
            yield* steps.held.length > 0 ? run.pipe(Effect.ensuring(Effect.ignore(call({ op: "release" })))) : run
            lastBot = { botId, at: now() }
            if (plan.cursor) {
              const p = yield* cursor
              const a = toApi(geometry, p.x, p.y)
              return { text: `X=${a.x}, Y=${a.y}` }
            }
            if (plan.image === "none") return { text: plan.text }
            if (plan.image === "after") yield* Effect.sleep(SETTLE_MS)
            const image = yield* screenshot(typeof plan.image === "object" ? plan.image.zoom : undefined)
            return { text: plan.text, image }
          }),
        )
      })

    const stream = ({ io }: { readonly botId: string; readonly io: Duplex }): Effect.Effect<void> =>
      Effect.scoped(
        Effect.gen(function* () {
          const ended = (reason: string) => Effect.ignore(io.writer.write(JSON.stringify({ _tag: "Ended", reason })))
          const ready = yield* Effect.result(requirePermissions)
          if (ready._tag === "Failure") return yield* ended(ready.failure.message)
          const closed = yield* Deferred.make<void>()
          // the viewer side only closes: drain it until it does
          yield* Effect.forkScoped(
            Effect.forever(io.pull).pipe(Effect.ensuring(Deferred.succeed(closed, undefined)), Effect.ignore),
          )
          let seq = 0
          while (!(yield* Deferred.isDone(closed))) {
            const started = now()
            const frame = yield* Effect.result(capture(undefined, STREAM_QUALITY))
            if (frame._tag === "Failure") return yield* ended(frame.failure.message)
            const meta = {
              seq: seq++,
              mime: "image/jpeg",
              width: frame.success.width,
              height: frame.success.height,
              viewportWidth: geometry.apiWidth,
              viewportHeight: geometry.apiHeight,
              timestamp: Date.now(),
            }
            const sent = yield* Effect.result(io.writer.write(encodeScreencastFrame(meta, frame.success.bytes)))
            if (sent._tag === "Failure") return
            const wait = Math.max(100, FRAME_INTERVAL_MS - (now() - started))
            yield* Effect.raceFirst(Effect.sleep(wait), Deferred.await(closed))
          }
        }),
      ).pipe(Effect.catchCause((cause) => Effect.logDebug("screen stream ended", { cause })))

    const inputFn = (botId: string, event: BrowserInputEvent): Effect.Effect<void, DesktopUnavailable | LeaseHeld> =>
      Effect.gen(function* () {
        if (leases && leases.get(botId).holder !== "user") {
          return yield* new LeaseHeld({ botId, holder: "bot", reason: "Take control of the screen first." })
        }
        const ops = inputOps(geometry, event)
        yield* inputLock.withPermits(1)(Effect.forEach(ops, (op) => Effect.asVoid(call(op)), { discard: true }))
      })

    return {
      offered: true,
      support: { missing: [...missingPermissions(info)], width: info.width, height: info.height },
      ensure: () => Effect.map(requirePermissions, (i) => ({ width: i.width, height: i.height })),
      act,
      stream,
      input: inputFn,
    } satisfies MacScreenShape
  })

export const MacScreenLive: Layer.Layer<MacScreen, never, NodeConfig | LeaseBook> = Layer.effect(
  MacScreen,
  Effect.gen(function* () {
    const config = yield* NodeConfig
    const leases = yield* LeaseBook
    return MacScreen.of(yield* makeMacScreen({ config, leases }))
  }),
)
