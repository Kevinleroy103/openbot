// Live desktop test (D1.7): a real bot screen through the real handlers: Xvfb + window manager +
// x11vnc, the bot's Chromium on that screen, computer.act (screenshot, clicks, typing, keys,
// cursor_position, zoom), the shared lease, VNC streams (RFB banner; control closes when the lease
// returns) and complete cleanup on desktop.stop and on node shutdown.
//
// Runs only when the programs exist: in `OPENBOT_DESKTOP_PATH`, on PATH (Xvfb, x11vnc, xdotool,
// xfwm4 + plank, ImageMagick), or in the rootless copies of the research proofs
// (vendor/scratch/computer/xroot/usr/bin with openbox, run with their own libraries).
// The browser part also needs Chromium (`OPENBOT_TEST_BROWSER` or PATH).
import { afterAll, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Exit from "effect/Exit"
import * as Socket from "effect/socket/Socket"
import { RpcTest } from "effect/rpc"
import { existsSync, mkdirSync } from "node:fs"
import * as path from "node:path"
import { NodeRpcs, type ComputerAction } from "@openbot/node-protocol"
import {
  desktopNodeKey,
  desktopPathFromEnv,
  desktopPrefixEnv,
  detectBrowserExecutable,
  detectDesktopPrograms,
  displayLockPath,
  markedPids,
  NodeHandlersLive,
  type NodeConfigInput,
} from "../src/index.ts"
import { fakeLinks, inv, makeFakeBrain, run, tempDir } from "./helpers.ts"

const which = (dirs: ReadonlyArray<string>) => {
  const PATH = [...dirs, process.env.PATH ?? ""].join(":")
  return (name: string) => Bun.which(name, { PATH }) ?? undefined
}
// programs: `OPENBOT_DESKTOP_PATH` when set, else the system's, else the rootless research copies
const vendorBin = path.resolve(import.meta.dir, "../../../vendor/scratch/computer/xroot/usr/bin")
const extraPath: ReadonlyArray<string> =
  desktopPathFromEnv().length > 0
    ? desktopPathFromEnv()
    : detectDesktopPrograms(which([])).missing.length === 0 || !existsSync(vendorBin)
      ? []
      : [vendorBin]
const detected = detectDesktopPrograms(which(extraPath))
const executable = process.env.OPENBOT_TEST_BROWSER ?? detectBrowserExecutable()
const live = detected.missing.length === 0 && process.platform === "linux"
const liveTest = live ? test : test.skip
const browserTest = live && executable ? test : test.skip
const T = 90_000

const t = tempDir("desktop-live-")
const root = path.join(t.path, "work", "{botId}")
mkdirSync(path.join(t.path, "work", "bot_live"), { recursive: true })

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () =>
    new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>start</title></head><body style="margin:0">
      <button style="position:fixed;left:0;top:0;width:50vw;height:100vh;font-size:40px" onclick="document.title='clicked'">CLICK</button>
      <textarea style="position:fixed;left:50vw;top:0;width:50vw;height:100vh;font-size:40px" oninput="document.title='typed:'+this.value"></textarea>
      </body></html>`,
      { headers: { "content-type": "text/html" } },
    ),
})

afterAll(() => {
  server.stop(true)
  t.cleanup()
})

const config = (dataDir: string): NodeConfigInput => ({
  nodeId: "nod_desktop",
  dataDir,
  roots: [root],
  detectBinaries: false,
  forwardAudit: false,
  browser: { enabled: executable !== undefined, executable, headless: true },
  desktop: { enabled: true, path: extraPath, env: desktopPrefixEnv(extraPath), settleMs: 250, displayBase: 140 },
})

const buildNode = (dataDir: string) =>
  Effect.gen(function* () {
    const brain = makeFakeBrain()
    const scope = yield* Scope.make()
    const ctx = yield* Layer.buildWithScope(
      NodeHandlersLive(config(dataDir)).pipe(Layer.provide(fakeLinks(brain))),
      scope,
    )
    const client = yield* RpcTest.makeClient(NodeRpcs).pipe(Effect.provide(ctx), Scope.provide(scope))
    return { client, brain, scope, close: Scope.close(scope, Exit.void) }
  })

/** Brain end of a data stream: frames received, closed flag, writer. */
const collect = (socket: Socket.Socket) =>
  Effect.gen(function* () {
    const reader = yield* socket.reader
    const writer = yield* socket.writer
    const end = { frames: [] as Array<string | Uint8Array>, closed: false, writer }
    yield* Effect.forkScoped(
      Effect.forever(Effect.flatMap(reader.pull, (fs) => Effect.sync(() => void end.frames.push(...fs)))).pipe(
        Effect.ignore,
        Effect.andThen(Effect.sync(() => void (end.closed = true))),
      ),
    )
    return end
  })

const text = (frames: ReadonlyArray<string | Uint8Array>) =>
  frames.map((f) => (typeof f === "string" ? f : new TextDecoder().decode(f))).join("")

const waitFor = (pred: () => boolean, ms = 5000) =>
  Effect.gen(function* () {
    const end = Date.now() + ms
    while (!pred() && Date.now() < end) yield* Effect.sleep(25)
    return pred()
  })

const markerOf = (dataDir: string, botId: string) => `${desktopNodeKey(dataDir)}/${botId}/`

describe("desktop (live)", () => {
  browserTest(
    "a bot screen: computer actions on the bot's own browser, VNC streams, lease, full cleanup",
    () =>
      run(
        Effect.gen(function* () {
          const dataDir = path.join(t.path, "state-1")
          const node = yield* buildNode(dataDir)
          const { client, brain } = node
          const botId = "bot_live"
          const act = (action: ComputerAction) => client["computer.act"]({ inv: inv(botId), action })

          const hello = yield* client["node.hello"]({ protocol: { min: 1, max: 1 }, brainVersion: "t", brainSig: "" })
          expect(hello.capabilities).toContain("desktop@1")
          expect(hello.desktop).toEqual({ missing: [], width: 1920, height: 1200 })

          // concurrent ensures share one start
          const [a, b] = yield* Effect.all([client["desktop.ensure"]({ botId }), client["desktop.ensure"]({ botId })], {
            concurrency: 2,
          })
          expect(a.display).toBe(b.display)
          expect(a.display).toMatch(/^:\d+$/)
          expect({ width: a.width, height: a.height }).toEqual({ width: 1920, height: 1200 })
          const displayNumber = Number(a.display.slice(1))
          expect(existsSync(displayLockPath(displayNumber))).toBe(true)

          // the bot's browser runs on its screen
          yield* client["browser.action"]({
            inv: inv(botId),
            action: { _tag: "navigate", url: `http://127.0.0.1:${server.port}/` },
          })
          const title = () =>
            client["browser.action"]({ inv: inv(botId), action: { _tag: "tabs", op: "list" } }).pipe(
              Effect.map((r) => r.tabs?.find((x) => x.active)?.title ?? ""),
            )
          const waitTitle = (want: string) =>
            Effect.gen(function* () {
              let got = ""
              for (let i = 0; i < 80; i++) {
                got = yield* title()
                if (got === want) return got
                yield* Effect.sleep(50)
              }
              return got
            })

          const shot = yield* act({ action: "screenshot" })
          expect(shot.image?.mimeType).toBe("image/jpeg")
          expect({ w: shot.image?.width, h: shot.image?.height }).toEqual({ w: 1280, h: 800 })
          expect(shot.text).toContain("1280x800")

          // a click in API space lands on the page's left half (the button)
          const click = yield* act({ action: "left_click", coordinate: [320, 400] })
          expect(click.text).toBe("Clicked at (320, 400).")
          expect(click.image?.width).toBe(1280)
          expect(yield* waitTitle("clicked")).toBe("clicked")

          // typing into the textarea (right half)
          yield* act({ action: "left_click", coordinate: [960, 400] })
          const typed = yield* act({ action: "type", text: "hello" })
          expect(typed.text).toBe("Typed 5 characters.")
          expect(yield* waitTitle("typed:hello")).toBe("typed:hello")
          yield* act({ action: "key", text: "ctrl+a" })
          yield* act({ action: "key", text: "BackSpace" })
          expect(yield* waitTitle("typed:")).toBe("typed:")

          // the pointer in API space
          yield* act({ action: "mouse_move", coordinate: [100, 200] })
          const pos = yield* act({ action: "cursor_position" })
          expect(pos.text).toBe("X=100, Y=200")
          expect(pos.image).toBeUndefined()

          // zoom: a crop at screen resolution, fitted into the screenshot box
          const zoom = yield* act({ action: "zoom", region: [0, 0, 100, 50] })
          expect({ w: zoom.image?.width, h: zoom.image?.height }).toEqual({ w: 1280, h: 640 })
          const bad = yield* act({ action: "left_click", coordinate: [5000, 1] })
          expect(bad.text).toStartWith("ERROR:")

          // watching: the view-only VNC server answers with the RFB banner
          yield* client["computer.stream"]({ botId, mode: "view", streamId: "vnc_view", streamToken: "tok" })
          const view = yield* collect(brain.streams.get("vnc_view")!)
          expect(yield* waitFor(() => text(view.frames).startsWith("RFB 003.008"))).toBe(true)

          // control needs the lease
          const refused = yield* Effect.flip(
            client["computer.stream"]({ botId, mode: "control", streamId: "vnc_c0", streamToken: "tok" }),
          )
          expect(refused._tag).toBe("LeaseHeld")
          yield* client["lease.set"]({ botId, holder: "user" })
          const held = yield* Effect.flip(act({ action: "screenshot" }))
          expect(held._tag).toBe("LeaseHeld")
          yield* client["computer.stream"]({ botId, mode: "control", streamId: "vnc_c1", streamToken: "tok" })
          const control = yield* collect(brain.streams.get("vnc_c1")!)
          expect(yield* waitFor(() => text(control.frames).startsWith("RFB 003.008"))).toBe(true)
          // "I'm done": the control stream closes, the watcher stays
          yield* client["lease.set"]({ botId, holder: "bot" })
          expect(yield* waitFor(() => control.closed)).toBe(true)
          expect(view.closed).toBe(false)
          expect((yield* act({ action: "screenshot" })).image).toBeDefined()

          // stop: the browser closes, every process on the screen is gone, the display is free
          const marker = markerOf(dataDir, botId)
          expect(markedPids(marker).length).toBeGreaterThan(0)
          yield* client["desktop.stop"]({ botId })
          expect(yield* waitFor(() => markedPids(marker).length === 0)).toBe(true)
          expect(existsSync(displayLockPath(displayNumber))).toBe(false)
          expect(yield* waitFor(() => view.closed)).toBe(true)

          // the next use starts a fresh screen; closing the node stops it
          const again = yield* client["desktop.ensure"]({ botId })
          expect(again.display).toMatch(/^:\d+$/)
          expect(markedPids(marker).length).toBeGreaterThan(0)
          yield* node.close
          expect(yield* waitFor(() => markedPids(marker).length === 0)).toBe(true)
          expect(existsSync(displayLockPath(Number(again.display.slice(1))))).toBe(false)
        }),
      ),
    T,
  )

  liveTest(
    "without a browser: a desktop starts, screenshots work, and two bots get two displays",
    () =>
      run(
        Effect.gen(function* () {
          const dataDir = path.join(t.path, "state-2")
          const node = yield* buildNode(dataDir)
          const [one, two] = yield* Effect.all(
            [node.client["desktop.ensure"]({ botId: "bot_one" }), node.client["desktop.ensure"]({ botId: "bot_two" })],
            { concurrency: 2 },
          )
          expect(one.display).not.toBe(two.display)
          const shot = yield* node.client["computer.act"]({ inv: inv("bot_two"), action: { action: "screenshot" } })
          expect(shot.image?.width).toBe(1280)
          yield* node.close
          expect(yield* waitFor(() => markedPids(`${desktopNodeKey(dataDir)}/`).length === 0)).toBe(true)
        }),
      ),
    T,
  )
})
