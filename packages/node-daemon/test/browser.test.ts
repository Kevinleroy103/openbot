// BrowserManager through the real handlers: launch, per-bot windows, navigate/snapshot/click/type/
// key/scroll/screenshot/tabs, lease-gated input, screencast frames with ack pacing, graceful close.
// Skipped when no Chromium/Chrome is found. Always headless (never pops windows on a dev desktop).
import { afterAll, describe, expect, test } from "bun:test"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Socket from "effect/socket/Socket"
import { RpcTest, type RpcClient, type RpcGroup } from "effect/rpc"
import { mkdirSync } from "node:fs"
import * as path from "node:path"
import {
  decodeScreencastFrame,
  NodeRpcs,
  type BrowserActionResult,
  type ScreencastFrameMeta,
} from "@openbot/node-protocol"
import { detectBrowserExecutable, imageSize, NodeHandlersLive, type NodeConfigInput } from "../src/index.ts"
import { fakeLinks, inv, makeFakeBrain, run, tempDir } from "./helpers.ts"

const executable = process.env.OPENBOT_TEST_BROWSER ?? detectBrowserExecutable()
const browserTest = executable ? test : test.skip
const T = 60_000

const t = tempDir("browser-")
const root = path.join(t.path, "work")
mkdirSync(root, { recursive: true })

// ---------------------------------------------------------------- local pages
const cookieVisits: Array<string> = []
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url)
    const html = (body: string, headers?: Record<string, string>) =>
      new Response(`<!doctype html><html><head><meta charset="utf-8">${body}</html>`, {
        headers: { "content-type": "text/html", ...headers },
      })
    switch (url.pathname) {
      case "/":
        return html(`<title>OpenBot Test</title></head><body style="margin:0;height:3000px">
          <h1>Welcome</h1>
          <button onclick="document.title='Clicked'">Rename</button>
          <form onsubmit="event.preventDefault(); document.title='Hello ' + document.getElementById('n').value">
            <label for="n">Name</label><input id="n" type="text">
          </form>
          <a href="/second">Second page</a>
          <script>addEventListener('keydown', (e) => { if (e.key === 'k' && e.ctrlKey) document.title = 'Ctrl+K' })
          addEventListener('scroll', () => { document.body.dataset.y = String(scrollY) })</script></body>`)
      case "/second":
        return html(`<title>Second</title></head><body><p>second page</p></body>`)
      case "/anim":
        return html(`<title>Anim</title></head><body><div id="c" style="font-size:80px">0</div>
          <script>let n = 0; const f = () => { document.getElementById('c').textContent = String(n++); requestAnimationFrame(f) }; f()</script></body>`)
      case "/cookie":
        cookieVisits.push(req.headers.get("cookie") ?? "")
        return html(`<title>Cookie</title></head><body>cookie</body>`, {
          "set-cookie": "ob=persist; Max-Age=3600; Path=/",
        })
      default:
        return new Response("not found", { status: 404 })
    }
  },
})
const base = `http://127.0.0.1:${server.port}`

// ---------------------------------------------------------------- one browser for the suite
type NodeClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof NodeRpcs>>
class Client extends Context.Service<Client, NodeClient>()("test/BrowserClient") {}

const brain = makeFakeBrain()
const nodeConfig = (profileDir: string): NodeConfigInput => ({
  nodeId: "nod_browser",
  dataDir: path.join(t.path, "state"),
  roots: [root],
  detectBinaries: false,
  forwardAudit: false,
  browser: { enabled: true, executable, headless: true, profileDir, width: 1024, height: 700 },
})
const runtime = ManagedRuntime.make(
  Layer.effect(Client, RpcTest.makeClient(NodeRpcs)).pipe(
    Layer.provideMerge(NodeHandlersLive(nodeConfig(path.join(t.path, "profile-shared")))),
    Layer.provide(fakeLinks(brain)),
  ),
)
const withClient = <A, E>(f: (client: NodeClient) => Effect.Effect<A, E>) =>
  runtime.runPromise(Effect.flatMap(Client, f))

afterAll(async () => {
  await runtime.dispose()
  server.stop(true)
  t.cleanup()
})

const act = (client: NodeClient, botId: string, action: Parameters<NodeClient["browser.action"]>[0]["action"]) =>
  client["browser.action"]({ inv: inv(botId), action })

const refOf = (snapshot: string, re: RegExp): string => {
  const m = re.exec(snapshot)
  if (!m) throw new Error(`no match for ${re} in snapshot:\n${snapshot}`)
  return m[1]!
}

const titleOf = (client: NodeClient, botId: string) =>
  Effect.map(
    act(client, botId, { _tag: "tabs", op: "list" }),
    (r: BrowserActionResult) => r.tabs?.find((x) => x.active)?.title ?? "",
  )

const waitTitle = (client: NodeClient, botId: string, want: string) =>
  Effect.gen(function* () {
    let title = ""
    for (let i = 0; i < 50; i++) {
      title = yield* titleOf(client, botId)
      if (title === want) return title
      yield* Effect.sleep(50)
    }
    return title
  })

describe("BrowserManager", () => {
  browserTest(
    "ensure opens one window per bot",
    () =>
      withClient((client) =>
        Effect.gen(function* () {
          const a = yield* client["browser.ensure"]({ botId: "bot_a" })
          const b = yield* client["browser.ensure"]({ botId: "bot_b" })
          expect(a.windowTargetId).not.toBe(b.windowTargetId)
          expect(a.cdpPort).toBeGreaterThan(0)
          expect(a.width).toBe(1024)
          const again = yield* client["browser.ensure"]({ botId: "bot_a" })
          expect(again.windowTargetId).toBe(a.windowTargetId)
        }),
      ),
    T,
  )

  browserTest(
    "navigate, snapshot with refs, click and type by ref, key combos, scroll",
    () =>
      withClient((client) =>
        Effect.gen(function* () {
          const nav = yield* act(client, "bot_a", { _tag: "navigate", url: `${base}/` })
          expect(nav.title).toBe("OpenBot Test")
          expect(nav.text).toContain("Navigated to")

          const snap = yield* act(client, "bot_a", { _tag: "snapshot" })
          expect(snap.text).toContain('heading "Welcome"')
          const button = refOf(snap.text, /button "Rename" \[ref=(e\d+)\]/)
          const textbox = refOf(snap.text, /textbox "Name"[^\n]*\[ref=(e\d+)\]/)
          expect(snap.text).toMatch(/link "Second page"/)

          yield* act(client, "bot_a", { _tag: "click", ref: button })
          expect(yield* waitTitle(client, "bot_a", "Clicked")).toBe("Clicked")

          const typed = yield* act(client, "bot_a", { _tag: "type", ref: textbox, text: "Ada", submit: true })
          expect(typed.text).toContain("pressed Enter")
          expect(yield* waitTitle(client, "bot_a", "Hello Ada")).toBe("Hello Ada")

          // the field shows the value in a fresh snapshot
          const snap2 = yield* act(client, "bot_a", { _tag: "snapshot" })
          expect(snap2.text).toMatch(/textbox "Name": "Ada"/)

          yield* act(client, "bot_a", { _tag: "key", key: "Control+k" })
          expect(yield* waitTitle(client, "bot_a", "Ctrl+K")).toBe("Ctrl+K")

          const scrolled = yield* act(client, "bot_a", { _tag: "scroll", direction: "down", amount: 5 })
          expect(scrolled.text).toContain("500px")

          const stale = yield* Effect.flip(act(client, "bot_a", { _tag: "click", ref: "e9999" }))
          expect(stale._tag).toBe("BrowserActionFailed")

          // clicking a link navigates
          const link = refOf(snap2.text, /link "Second page" \[ref=(e\d+)\]/)
          yield* act(client, "bot_a", { _tag: "click", ref: link })
          expect(yield* waitTitle(client, "bot_a", "Second")).toBe("Second")
        }),
      ),
    T,
  )

  browserTest(
    "screenshot returns a real image with its size",
    () =>
      withClient((client) =>
        Effect.gen(function* () {
          yield* act(client, "bot_b", { _tag: "navigate", url: `${base}/` })
          const shot = yield* act(client, "bot_b", { _tag: "screenshot" })
          expect(shot.image?.mimeType).toBe("image/jpeg")
          expect(shot.image?.width).toBe(1024)
          const bytes = Buffer.from(shot.image!.data, "base64")
          expect(imageSize(bytes)?.height).toBe(shot.image!.height)
          const png = yield* act(client, "bot_b", { _tag: "screenshot", format: "png", fullPage: true })
          expect(png.image?.mimeType).toBe("image/png")
          expect(png.image!.height).toBeGreaterThan(700)
        }),
      ),
    T,
  )

  browserTest(
    "tabs: new, list, select, close",
    () =>
      withClient((client) =>
        Effect.gen(function* () {
          const created = yield* act(client, "bot_b", { _tag: "tabs", op: "new", url: `${base}/second` })
          expect(created.tabs?.length).toBe(2)
          const active = created.tabs!.find((x) => x.active)!
          const other = created.tabs!.find((x) => !x.active)!
          const sel = yield* act(client, "bot_b", { _tag: "tabs", op: "select", tabId: other.tabId })
          expect(sel.tabs?.find((x) => x.active)?.tabId).toBe(other.tabId)
          const closed = yield* act(client, "bot_b", { _tag: "tabs", op: "close", tabId: active.tabId })
          expect(closed.tabs?.map((x) => x.tabId)).toEqual([other.tabId])
          // bot_a's window is untouched
          const aTabs = yield* act(client, "bot_a", { _tag: "tabs", op: "list" })
          expect(aTabs.tabs?.some((x) => x.tabId === other.tabId)).toBe(false)
        }),
      ),
    T,
  )

  browserTest(
    "opening a window tells the brain (browser.opened); closing a bot's last tab closes it (browser.closed)",
    () =>
      withClient((client) =>
        Effect.gen(function* () {
          const w = yield* client["browser.ensure"]({ botId: "bot_d" })
          yield* act(client, "bot_d", { _tag: "tabs", op: "close", tabId: w.windowTargetId })
          for (let i = 0; i < 50 && !brain.events.some((e) => e.type === "browser.closed"); i++) yield* Effect.sleep(20)
          expect(brain.events).toContainEqual({
            type: "browser.closed",
            data: { botId: "bot_d", reason: "the bot's window was closed" },
          })
          // the next use opens a fresh window
          const again = yield* client["browser.ensure"]({ botId: "bot_d" })
          expect(again.windowTargetId).not.toBe(w.windowTargetId)
          // every new window is announced (the brain's computer view goes "ready" after bot actions)
          expect(brain.events).toContainEqual({
            type: "browser.opened",
            data: { botId: "bot_d", windowTargetId: w.windowTargetId },
          })
          expect(brain.events).toContainEqual({
            type: "browser.opened",
            data: { botId: "bot_d", windowTargetId: again.windowTargetId },
          })
        }),
      ),
    T,
  )

  browserTest(
    "lease: while the user holds it, bot actions fail with LeaseHeld and input is accepted",
    () =>
      withClient((client) =>
        Effect.gen(function* () {
          const refused = yield* Effect.flip(
            client["browser.input"]({ botId: "bot_a", event: { _tag: "text", text: "x" } }),
          )
          expect(refused._tag).toBe("LeaseHeld")
          yield* act(client, "bot_a", { _tag: "navigate", url: `${base}/` })
          const lease = yield* client["lease.set"]({ botId: "bot_a", holder: "user" })
          expect(lease.holder).toBe("user")
          const held = yield* Effect.flip(act(client, "bot_a", { _tag: "snapshot" }))
          expect(held._tag).toBe("LeaseHeld")
          // user input goes through Input.dispatch* (the page reacts to Ctrl+K)
          yield* client["browser.input"]({
            botId: "bot_a",
            event: { _tag: "key", type: "down", key: "k", modifiers: { ctrl: true } },
          })
          yield* client["browser.input"]({
            botId: "bot_a",
            event: { _tag: "key", type: "up", key: "k", modifiers: { ctrl: true } },
          })
          yield* client["browser.input"]({ botId: "bot_a", event: { _tag: "mouse", type: "move", x: 10, y: 10 } })
          yield* client["lease.set"]({ botId: "bot_a", holder: "bot" })
          expect(yield* waitTitle(client, "bot_a", "Ctrl+K")).toBe("Ctrl+K")
        }),
      ),
    T,
  )

  browserTest(
    "screencast: binary frames with metadata, notices, and continuous frames (ack pacing)",
    () =>
      withClient((client) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* act(client, "bot_a", { _tag: "navigate", url: `${base}/anim` })
            const started = yield* client["browser.screencast"]({
              botId: "bot_a",
              streamId: "sc_1",
              streamToken: "tok",
              options: { quality: 50, maxWidth: 640, maxHeight: 480 },
            })
            expect(started.windowTargetId.length).toBeGreaterThan(0)
            const socket = brain.streams.get("sc_1")!
            const reader = yield* socket.reader
            const frames: Array<ScreencastFrameMeta> = []
            const notices: Array<{ _tag: string }> = []
            const t0 = Date.now()
            while (frames.length < 6 && Date.now() - t0 < 10_000) {
              const batch = yield* reader.pull.pipe(Effect.timeoutOption(5000))
              if (batch._tag === "None") break
              for (const f of batch.value) {
                if (typeof f === "string") notices.push(JSON.parse(f))
                else {
                  const decoded = decodeScreencastFrame(f)
                  expect(decoded).toBeDefined()
                  expect(imageSize(decoded!.image)?.mime).toBe("image/jpeg")
                  frames.push(decoded!.meta)
                }
              }
            }
            // more frames than the one still frame: Chromium only keeps sending when frames are acked
            expect(frames.length).toBeGreaterThanOrEqual(6)
            expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i))
            expect(frames[1]!.width).toBeLessThanOrEqual(640)
            expect(frames[0]!.viewportWidth).toBe(1024)
            expect(notices.some((n) => n._tag === "Lease")).toBe(true)
            expect(notices.some((n) => n._tag === "Url")).toBe(true)
            // the viewer leaves: the screencast stops (the node does not keep pushing)
            const writer = yield* socket.writer
            yield* writer.write(new Socket.CloseEvent(1000, "bye"))
          }),
        ),
      ),
    T,
  )

  browserTest(
    "graceful Browser.close on shutdown: the browser exits and cookies persist in the profile",
    () =>
      run(
        Effect.gen(function* () {
          const profileDir = path.join(t.path, "profile-cookies")
          const once = Effect.scoped(
            Effect.gen(function* () {
              const ctx = yield* Layer.build(
                NodeHandlersLive(nodeConfig(profileDir)).pipe(Layer.provide(fakeLinks(makeFakeBrain()))),
              )
              const client = yield* RpcTest.makeClient(NodeRpcs).pipe(Effect.provide(ctx))
              const ensured = yield* client["browser.ensure"]({ botId: "bot_c" })
              yield* act(client, "bot_c", { _tag: "navigate", url: `${base}/cookie` })
              return ensured.cdpPort!
            }),
          )
          const port1 = yield* once
          // after the scope closed, the DevTools endpoint is gone
          const alive = yield* Effect.promise(() =>
            fetch(`http://127.0.0.1:${port1}/json/version`).then(
              () => true,
              () => false,
            ),
          )
          expect(alive).toBe(false)
          yield* once
          expect(cookieVisits.length).toBe(2)
          expect(cookieVisits[0]).toBe("")
          expect(cookieVisits[1]).toContain("ob=persist")
        }),
      ),
    T,
  )
})
