// BrowserManager (capability browser@1; docs/architecture.md §4.7, computer-and-tools.md §3.2):
//  - one Chromium/Chrome per node, launched lazily, persistent profile, loopback CDP;
//  - one window per bot (`Target.createTarget {newWindow: true}`), tabs tracked per bot;
//  - actions over raw CDP (navigate, snapshot with refs, click/type by ref or coordinates, key,
//    scroll, screenshot, tabs);
//  - screencast (`Page.startScreencast`) with ack pacing onto a `cdp-screencast` data stream;
//  - user takeover input (`Input.dispatch*`) gated by the control lease mirrored from the brain;
//  - graceful `Browser.close` on shutdown so cookies persist.
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FiberSet from "effect/FiberSet"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Socket from "effect/socket/Socket"
import * as path from "node:path"
import {
  BrowserActionFailed,
  BrowserUnavailable,
  encodeScreencastFrame,
  LeaseHeld,
  NodeEventTypes,
  BrainLink,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserEnsureResult,
  type BrowserInputEvent,
  type BrowserTab,
  type LeaseHolder,
  type LeaseState,
  type ScreencastNotice,
  type ScreencastOptions,
} from "@openbot/node-protocol"
import { NodeConfig, type BrowserConfig } from "../config.ts"
import { terminateGroup } from "../proc.ts"
import type { Duplex } from "../sockets.ts"
import { connectCdp, type CdpClient, type CdpError, type CdpEvent } from "./cdp.ts"
import { imageSize } from "./image.ts"
import { modifierBits, parseKeyCombo } from "./keys.ts"
import { clearStaleLock, launchBrowser, type LaunchedBrowser } from "./launch.ts"
import { renderSnapshot, type AXNode } from "./snapshot.ts"

export interface ScreencastInput {
  readonly botId: string
  readonly io: Duplex
  readonly options?: ScreencastOptions | undefined
  /** called once the first screencast is running (the RPC returns `{windowTargetId}` then) */
  readonly onStarted: (windowTargetId: string) => Effect.Effect<void>
}

export interface BrowserManagerShape {
  /** a browser executable is configured or was found, and the browser is enabled */
  readonly available: boolean
  readonly executable: string | undefined
  readonly ensure: (botId: string) => Effect.Effect<BrowserEnsureResult, BrowserUnavailable>
  readonly action: (
    botId: string,
    action: BrowserAction,
  ) => Effect.Effect<BrowserActionResult, BrowserUnavailable | BrowserActionFailed | LeaseHeld>
  readonly input: (botId: string, event: BrowserInputEvent) => Effect.Effect<void, BrowserUnavailable | LeaseHeld>
  readonly setLease: (botId: string, holder: LeaseHolder) => Effect.Effect<LeaseState>
  readonly lease: (botId: string) => LeaseState
  /** Runs a screencast onto `io` until the socket closes (or the browser goes away). */
  readonly screencast: (input: ScreencastInput) => Effect.Effect<void, BrowserUnavailable>
  /** Graceful `Browser.close`, then kill. Also runs when the layer's scope closes. */
  readonly shutdown: Effect.Effect<void>
  /** loopback DevTools port of the running browser, if any */
  readonly cdpPort: () => number | undefined
}

export class BrowserManager extends Context.Service<BrowserManager, BrowserManagerShape>()("openbot/node-daemon/BrowserManager") {}

interface Tab {
  readonly targetId: string
  readonly sessionId: string
  refs: Map<string, number>
}

interface BotWindow {
  readonly botId: string
  readonly tabs: Map<string, Tab>
  active: string
  readonly listeners: Set<() => void>
}

interface Running {
  readonly launched: LaunchedBrowser
  readonly cdp: CdpClient
  readonly scope: Scope.Closeable
  readonly bots: Map<string, BotWindow>
  readonly closedListeners: Set<() => void>
  closing: boolean
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

export interface BrowserManagerOptions {
  readonly logFile?: string | undefined
  /**
   * Node events for the brain (`BrainLink.event`): `browser.opened {botId, windowTargetId}` when a
   * bot's window is created, `browser.closed {botId, reason}` when it goes away (its last tab
   * closed, or the browser exited).
   */
  readonly onEvent?: ((type: string, data: unknown) => Effect.Effect<void>) | undefined
}

export const makeBrowserManager = (config: BrowserConfig, options?: BrowserManagerOptions) =>
  Effect.gen(function* () {
    // An orphaned browser of a previous run (brain / daemon SIGKILLed) still holds the profile: free it
    // at startup, not only at the next (lazy) launch.
    if (config.enabled) yield* Effect.ignore(Effect.try(() => clearStaleLock(config.profileDir)))
    const lock = yield* Semaphore.make(1)
    const runFork = yield* FiberSet.makeRuntime<never>()
    const emit = (type: string, data: Record<string, unknown>) => {
      if (!options?.onEvent) return
      try {
        runFork(Effect.ignore(options.onEvent(type, data)))
      } catch {
        // the manager is shutting down
      }
    }
    const emitClosed = (botId: string, reason: string) => emit(NodeEventTypes.browserClosed, { botId, reason })
    const leases = new Map<string, LeaseState>()
    let running: Running | undefined
    const available = config.enabled && config.executable !== undefined

    const notify = (set: Set<() => void>) => {
      for (const l of [...set]) l()
    }

    const removeTab = (r: Running, targetId: string) => {
      for (const w of r.bots.values()) {
        if (!w.tabs.delete(targetId)) continue
        if (w.active === targetId) {
          const next = w.tabs.keys().next()
          w.active = next.done ? "" : next.value
        }
        if (w.tabs.size === 0) {
          r.bots.delete(w.botId)
          emitClosed(w.botId, "the bot's window was closed")
        }
        notify(w.listeners)
      }
    }

    const attach = (cdp: CdpClient, targetId: string) =>
      Effect.gen(function* () {
        const { sessionId } = yield* cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })
        yield* cdp.send("Page.enable", {}, sessionId)
        return { targetId, sessionId, refs: new Map<string, number>() } satisfies Tab
      })

    const onEvent = (r: Running) => (e: CdpEvent) => {
      if (e.method === "Target.targetDestroyed") removeTab(r, e.params.targetId)
      else if (e.method === "Target.detachedFromTarget" && e.params.targetId) {
        for (const w of r.bots.values()) {
          const t = w.tabs.get(e.params.targetId)
          if (t && t.sessionId === e.params.sessionId) removeTab(r, e.params.targetId)
        }
      } else if (e.method === "Target.targetCreated") {
        // popups opened by a bot's tab belong to that bot
        const info = e.params.targetInfo
        if (!info || info.type !== "page" || !info.openerId) return
        for (const w of r.bots.values()) {
          if (!w.tabs.has(info.openerId) || w.tabs.has(info.targetId)) continue
          runFork(
            attach(r.cdp, info.targetId).pipe(
              Effect.tap((tab) => Effect.sync(() => void w.tabs.set(tab.targetId, tab))),
              Effect.ignore,
            ),
          )
        }
      }
    }

    const start: Effect.Effect<Running, BrowserUnavailable> = Effect.gen(function* () {
      const launched = yield* launchBrowser(config, options?.logFile)
      const scope = yield* Scope.make()
      const cdp = yield* connectCdp(launched.wsUrl).pipe(
        Scope.provide(scope),
        Effect.tapError(() => Effect.andThen(Scope.close(scope, Exit.void), terminateGroup(launched.proc, 200))),
        Effect.mapError((e) => new BrowserUnavailable({ reason: `cannot connect to the browser: ${e.message}` })),
      )
      const r: Running = { launched, cdp, scope, bots: new Map(), closedListeners: new Set(), closing: false }
      cdp.on(onEvent(r))
      yield* cdp.send("Target.setDiscoverTargets", { discover: true }).pipe(Effect.ignore)
      cdp.closed.then(() => {
        if (running === r) running = undefined
        for (const w of r.bots.values()) {
          notify(w.listeners)
          emitClosed(w.botId, r.closing ? "the node closed the browser" : "the browser exited")
        }
        notify(r.closedListeners)
      })
      return r
    })

    const getRunning: Effect.Effect<Running, BrowserUnavailable> = Effect.suspend(() => {
      if (!available) {
        return Effect.fail(
          new BrowserUnavailable({ reason: config.enabled ? "no Chromium or Chrome was found on this node" : "the browser is disabled on this node" }),
        )
      }
      if (running && running.cdp.isOpen() && !running.closing) return Effect.succeed(running)
      return Effect.gen(function* () {
        if (running) yield* stop(running)
        running = yield* start
        return running
      })
    })

    const newTab = (r: Running, url: string, newWindow: boolean) =>
      Effect.gen(function* () {
        const { targetId } = yield* r.cdp.send<{ targetId: string }>("Target.createTarget", {
          url,
          newWindow,
          ...(newWindow ? { width: config.width, height: config.height } : {}),
        })
        return yield* attach(r.cdp, targetId)
      })

    /** The bot's window, created on first use. Serialized so concurrent calls share one window. */
    const windowFor = (botId: string): Effect.Effect<{ r: Running; w: BotWindow }, BrowserUnavailable> =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (!SAFE_ID.test(botId)) return yield* new BrowserUnavailable({ reason: "invalid bot id" })
          const r = yield* getRunning
          const existing = r.bots.get(botId)
          if (existing && existing.tabs.size > 0 && existing.tabs.has(existing.active)) return { r, w: existing }
          const tab = yield* newTab(r, "about:blank", true).pipe(
            Effect.mapError((e) => new BrowserUnavailable({ reason: `cannot open a window: ${e.message}` })),
          )
          const w: BotWindow = existing ?? { botId, tabs: new Map(), active: "", listeners: new Set() }
          w.tabs.set(tab.targetId, tab)
          w.active = tab.targetId
          r.bots.set(botId, w)
          notify(w.listeners)
          // the brain's computer view learns the window exists even when a bot action opened it
          emit(NodeEventTypes.browserOpened, { botId, windowTargetId: tab.targetId })
          return { r, w }
        }),
      )

    const viewport = (r: Running, sid: string) =>
      r.cdp.send<any>("Page.getLayoutMetrics", {}, sid).pipe(
        Effect.map((m) => ({
          width: Math.round(m.cssLayoutViewport?.clientWidth ?? m.layoutViewport?.clientWidth ?? config.width),
          height: Math.round(m.cssLayoutViewport?.clientHeight ?? m.layoutViewport?.clientHeight ?? config.height),
          contentWidth: Math.ceil(m.cssContentSize?.width ?? m.contentSize?.width ?? config.width),
          contentHeight: Math.ceil(m.cssContentSize?.height ?? m.contentSize?.height ?? config.height),
        })),
      )

    const ensure = (botId: string) =>
      Effect.gen(function* () {
        const { r, w } = yield* windowFor(botId)
        const tab = w.tabs.get(w.active)!
        const vp = yield* viewport(r, tab.sessionId).pipe(Effect.orElseSucceed(() => ({ width: config.width, height: config.height })))
        return { windowTargetId: tab.targetId, cdpPort: r.launched.port, width: vp.width, height: vp.height } satisfies BrowserEnsureResult
      })

    const lease = (botId: string): LeaseState => leases.get(botId) ?? { botId, holder: "bot", since: 0 }

    const setLease = (botId: string, holder: LeaseHolder) =>
      Effect.sync(() => {
        const prev = lease(botId)
        const next: LeaseState = prev.holder === holder && prev.since > 0 ? prev : { botId, holder, since: Date.now() }
        leases.set(botId, next)
        const w = running?.bots.get(botId)
        if (w) notify(w.listeners)
        return next
      })

    // ------------------------------------------------------------ actions
    const fail = (action: string, reason: string) => new BrowserActionFailed({ action, reason })

    const pageInfo = (r: Running, sid: string) =>
      r.cdp
        .send<any>("Runtime.evaluate", { expression: "JSON.stringify([location.href, document.title])", returnByValue: true }, sid)
        .pipe(
          Effect.map((res) => {
            try {
              const [url, title] = JSON.parse(String(res.result?.value ?? "[]")) as [string, string]
              return { url: url ?? "", title: title ?? "" }
            } catch {
              return { url: "", title: "" }
            }
          }),
          Effect.orElseSucceed(() => ({ url: "", title: "" })),
        )

    const center = (r: Running, sid: string, action: string, ref: string, refs: Map<string, number>) =>
      Effect.gen(function* () {
        const backendNodeId = refs.get(ref)
        if (backendNodeId === undefined) return yield* fail(action, `unknown ref ${ref}; take a new snapshot first`)
        yield* r.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }, sid).pipe(Effect.ignore)
        const box = yield* r.cdp
          .send<any>("DOM.getBoxModel", { backendNodeId }, sid)
          .pipe(Effect.mapError(() => fail(action, `element ${ref} is not visible or no longer exists; take a new snapshot`)))
        const q: Array<number> = box.model?.content ?? box.model?.border ?? []
        if (q.length < 8) return yield* fail(action, `element ${ref} has no box`)
        const xs = [q[0]!, q[2]!, q[4]!, q[6]!]
        const ys = [q[1]!, q[3]!, q[5]!, q[7]!]
        return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
      })

    const pressKey = (r: Running, sid: string, combo: string) =>
      Effect.gen(function* () {
        const k = parseKeyCombo(combo)
        if (!k) return yield* fail("key", `unknown key ${JSON.stringify(combo)}`)
        const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, nativeVirtualKeyCode: k.windowsVirtualKeyCode, modifiers: k.modifiers }
        yield* r.cdp.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) }, sid)
        yield* r.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sid)
      })

    const settle = Effect.sleep(150)

    const tabsOf = (r: Running, w: BotWindow) =>
      Effect.forEach([...w.tabs.values()], (t) =>
        r.cdp.send<any>("Target.getTargetInfo", { targetId: t.targetId }).pipe(
          Effect.map((res): BrowserTab => ({ tabId: t.targetId, url: res.targetInfo?.url ?? "", title: res.targetInfo?.title ?? "", active: t.targetId === w.active })),
          Effect.orElseSucceed((): BrowserTab => ({ tabId: t.targetId, url: "", title: "", active: t.targetId === w.active })),
        ),
      )

    const tabsText = (tabs: ReadonlyArray<BrowserTab>) =>
      tabs.length === 0 ? "No tabs." : tabs.map((t) => `${t.active ? "*" : "-"} [${t.tabId}] ${t.title || "(untitled)"} — ${t.url}`).join("\n")

    const doAction = (botId: string, action: BrowserAction): Effect.Effect<BrowserActionResult, BrowserUnavailable | BrowserActionFailed | CdpError> =>
      Effect.gen(function* () {
        const { r, w } = yield* windowFor(botId)
        const tabId = "tabId" in action && action.tabId ? action.tabId : w.active
        const tab = w.tabs.get(tabId)
        if (!tab) return yield* fail(action._tag, `unknown tab ${tabId}; use tabs list`)
        const sid = tab.sessionId
        const cdp = r.cdp
        switch (action._tag) {
          case "navigate": {
            let url = action.url.trim()
            if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`
            const { result, event } = yield* cdp.waitFor(
              (e) => e.sessionId === sid && e.method === "Page.loadEventFired",
              cdp.send<any>("Page.navigate", { url }, sid),
              config.navigationTimeoutMs,
            )
            if (result.errorText) return yield* fail("navigate", `${result.errorText} (${url})`)
            tab.refs = new Map()
            const info = yield* pageInfo(r, sid)
            const loading = result.loaderId && !event ? " (still loading)" : ""
            return { text: `Navigated to ${info.url || url}${loading}\nTitle: ${info.title || "(untitled)"}\nUse snapshot to read the page.`, url: info.url || url, title: info.title }
          }
          case "snapshot": {
            yield* cdp.send("Accessibility.enable", {}, sid).pipe(Effect.ignore)
            const { nodes } = yield* cdp.send<{ nodes: ReadonlyArray<AXNode> }>("Accessibility.getFullAXTree", {}, sid)
            const snap = renderSnapshot(nodes)
            tab.refs = snap.refs
            const info = yield* pageInfo(r, sid)
            return { text: `Page: ${info.title || "(untitled)"} — ${info.url}\n${snap.text || "(empty page)"}`, url: info.url, title: info.title }
          }
          case "click": {
            const point =
              action.ref !== undefined
                ? yield* center(r, sid, "click", action.ref, tab.refs)
                : action.x !== undefined && action.y !== undefined
                  ? { x: action.x, y: action.y }
                  : yield* fail("click", "give a ref from the last snapshot, or x and y")
            const button = action.button ?? "left"
            const clickCount = Math.max(1, Math.floor(action.clickCount ?? 1))
            yield* cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" }, sid)
            for (let i = 1; i <= clickCount; i++) {
              yield* cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button, clickCount: i }, sid)
              yield* cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button, clickCount: i }, sid)
            }
            yield* settle
            const info = yield* pageInfo(r, sid)
            const what = action.ref ?? `(${Math.round(point.x)}, ${Math.round(point.y)})`
            return { text: `Clicked ${what}${clickCount > 1 ? ` ×${clickCount}` : ""}.\nPage: ${info.title || "(untitled)"} — ${info.url}`, url: info.url, title: info.title }
          }
          case "type": {
            if (action.ref !== undefined) {
              const backendNodeId = tab.refs.get(action.ref)
              if (backendNodeId === undefined) return yield* fail("type", `unknown ref ${action.ref}; take a new snapshot first`)
              yield* cdp.send("DOM.focus", { backendNodeId }, sid).pipe(Effect.mapError(() => fail("type", `element ${action.ref} cannot be focused`)))
            }
            if (action.clear) {
              yield* cdp.send(
                "Runtime.evaluate",
                {
                  expression:
                    "(() => { const e = document.activeElement; if (!e) return; if ('value' in e) { e.value = ''; e.dispatchEvent(new Event('input', {bubbles: true})) } else if (e.isContentEditable) e.textContent = '' })()",
                },
                sid,
              )
            }
            if (action.text.length > 0) yield* cdp.send("Input.insertText", { text: action.text }, sid)
            if (action.submit) yield* pressKey(r, sid, "Enter")
            yield* settle
            const info = yield* pageInfo(r, sid)
            return {
              text: `Typed ${action.text.length} characters${action.ref ? ` into ${action.ref}` : ""}${action.submit ? " and pressed Enter" : ""}.\nPage: ${info.title || "(untitled)"} — ${info.url}`,
              url: info.url,
              title: info.title,
            }
          }
          case "key": {
            yield* pressKey(r, sid, action.key)
            yield* settle
            return { text: `Pressed ${action.key}.` }
          }
          case "scroll": {
            const vp = yield* viewport(r, sid)
            const point =
              action.ref !== undefined
                ? yield* center(r, sid, "scroll", action.ref, tab.refs)
                : { x: action.x ?? vp.width / 2, y: action.y ?? vp.height / 2 }
            const px = Math.round(Math.max(0.1, action.amount ?? 3) * 100)
            const dx = action.direction === "left" ? -px : action.direction === "right" ? px : 0
            const dy = action.direction === "up" ? -px : action.direction === "down" ? px : 0
            yield* cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: dx, deltaY: dy }, sid)
            yield* settle
            return { text: `Scrolled ${action.direction} by ${px}px.` }
          }
          case "screenshot": {
            const format = action.format ?? "jpeg"
            const params: Record<string, unknown> = { format, fromSurface: true }
            if (format !== "png") params.quality = Math.max(1, Math.min(100, Math.floor(action.quality ?? 70)))
            if (action.fullPage) {
              const vp = yield* viewport(r, sid)
              params.captureBeyondViewport = true
              params.clip = { x: 0, y: 0, width: vp.contentWidth, height: Math.min(vp.contentHeight, 16_000), scale: 1 }
            }
            const { data } = yield* cdp.send<{ data: string }>("Page.captureScreenshot", params, sid)
            const size = imageSize(Buffer.from(data, "base64"))
            const info = yield* pageInfo(r, sid)
            const mimeType = size?.mime ?? `image/${format}`
            return {
              text: `Screenshot of ${info.url || "the page"} (${size?.width ?? "?"}x${size?.height ?? "?"}).`,
              url: info.url,
              title: info.title,
              image: { mimeType, data, width: size?.width ?? 0, height: size?.height ?? 0 },
            }
          }
          case "tabs": {
            switch (action.op) {
              case "list":
                break
              case "new": {
                const t = yield* newTab(r, action.url ?? "about:blank", false)
                w.tabs.set(t.targetId, t)
                w.active = t.targetId
                notify(w.listeners)
                break
              }
              case "select": {
                if (!action.tabId || !w.tabs.has(action.tabId)) return yield* fail("tabs", `unknown tab ${action.tabId ?? "(none)"}`)
                w.active = action.tabId
                yield* cdp.send("Target.activateTarget", { targetId: action.tabId }).pipe(Effect.ignore)
                notify(w.listeners)
                break
              }
              case "close": {
                const target = action.tabId ?? w.active
                if (!w.tabs.has(target)) return yield* fail("tabs", `unknown tab ${target}`)
                yield* cdp.send("Target.closeTarget", { targetId: target })
                removeTab(r, target)
                break
              }
            }
            const tabs = yield* tabsOf(r, w)
            return { text: tabsText(tabs), tabs }
          }
        }
      })

    const action = (botId: string, a: BrowserAction): Effect.Effect<BrowserActionResult, BrowserUnavailable | BrowserActionFailed | LeaseHeld> =>
      Effect.gen(function* () {
        const l = lease(botId)
        if (l.holder === "user") return yield* new LeaseHeld({ botId, holder: "user", reason: "The user is controlling the browser" })
        return yield* doAction(botId, a).pipe(
          Effect.catchTag("CdpError", (e): Effect.Effect<never, BrowserActionFailed | BrowserUnavailable> =>
            running && running.cdp.isOpen()
              ? Effect.fail(fail(a._tag, e.message))
              : Effect.fail(new BrowserUnavailable({ reason: `the browser closed: ${e.message}` })),
          ),
        )
      })

    const input = (botId: string, event: BrowserInputEvent) =>
      Effect.gen(function* () {
        const l = lease(botId)
        if (l.holder !== "user") return yield* new LeaseHeld({ botId, holder: "bot", reason: "take control before sending input" })
        const { r, w } = yield* windowFor(botId)
        const tab = w.tabs.get(w.active)
        if (!tab) return yield* new BrowserUnavailable({ reason: "the bot has no open tab" })
        const sid = tab.sessionId
        const send = (method: string, params: Record<string, unknown>) =>
          r.cdp.send(method, params, sid).pipe(Effect.mapError((e) => new BrowserUnavailable({ reason: e.message })))
        switch (event._tag) {
          case "mouse": {
            const type = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased", wheel: "mouseWheel" }[event.type]
            yield* send("Input.dispatchMouseEvent", {
              type,
              x: event.x,
              y: event.y,
              button: event.button ?? (event.type === "down" || event.type === "up" ? "left" : "none"),
              clickCount: event.clickCount ?? (event.type === "down" || event.type === "up" ? 1 : 0),
              modifiers: modifierBits(event.modifiers),
              ...(event.type === "wheel" ? { deltaX: event.deltaX ?? 0, deltaY: event.deltaY ?? 0 } : {}),
            })
            return
          }
          case "key": {
            const k = parseKeyCombo(event.key)
            const text = event.text ?? (event.type === "down" && k?.text && event.key.length === 1 ? k.text : undefined)
            yield* send("Input.dispatchKeyEvent", {
              type: event.type === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown",
              key: event.key,
              code: event.code ?? k?.code ?? "",
              windowsVirtualKeyCode: k?.windowsVirtualKeyCode ?? 0,
              modifiers: modifierBits(event.modifiers),
              ...(text && event.type === "down" ? { text, unmodifiedText: text } : {}),
            })
            return
          }
          case "text": {
            yield* send("Input.insertText", { text: event.text })
            return
          }
        }
      })

    // ------------------------------------------------------------ screencast
    type Item = { readonly data: Uint8Array | string; readonly ack?: (() => void) | undefined }

    const screencast = (sc: ScreencastInput): Effect.Effect<void, BrowserUnavailable> =>
      Effect.scoped(
        Effect.gen(function* () {
          const out = yield* Queue.unbounded<Item, Cause.Done>()
          const socketClosed = yield* Deferred.make<void>()
          // drain the socket (viewers never send on this stream); completes on close
          yield* Effect.forkScoped(
            Effect.forever(sc.io.pull).pipe(Effect.ignore, Effect.andThen(Deferred.succeed(socketClosed, undefined))),
          )
          yield* Effect.forkScoped(
            Effect.forever(
              Effect.gen(function* () {
                const item = yield* Queue.take(out)
                yield* sc.io.writer.write(item.data)
                item.ack?.()
              }),
            ).pipe(Effect.ignore, Effect.andThen(Deferred.succeed(socketClosed, undefined))),
          )
          const notice = (n: ScreencastNotice) => Queue.offerUnsafe(out, { data: JSON.stringify(n) })
          let seq = 0
          let started = false
          const opts = sc.options ?? {}
          const format = opts.format ?? "jpeg"
          let ended: string | undefined

          while (!(yield* Deferred.isDone(socketClosed))) {
            const { r, w } = yield* windowFor(sc.botId)
            const tab = w.tabs.get(w.active)!
            const changed = yield* Deferred.make<"changed" | "browser-closed">()
            const onChange = () => Deferred.doneUnsafe(changed, Exit.succeed("changed" as const))
            const onClosed = () => Deferred.doneUnsafe(changed, Exit.succeed("browser-closed" as const))
            w.listeners.add(onChange)
            r.closedListeners.add(onClosed)
            const result = yield* Effect.gen(function* () {
              const { sessionId: sid } = yield* r.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: tab.targetId, flatten: true })
              yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  yield* r.cdp.send("Page.stopScreencast", {}, sid).pipe(Effect.ignore)
                  yield* r.cdp.send("Target.detachFromTarget", { sessionId: sid }).pipe(Effect.ignore)
                }),
              )
              const pushFrame = (bytes: Uint8Array, meta: { deviceWidth?: number; deviceHeight?: number; timestamp?: number }, ack?: () => void) => {
                const size = imageSize(bytes)
                const frame = encodeScreencastFrame(
                  {
                    seq: seq++,
                    mime: size?.mime ?? `image/${format}`,
                    width: size?.width ?? 0,
                    height: size?.height ?? 0,
                    viewportWidth: Math.round(meta.deviceWidth ?? config.width),
                    viewportHeight: Math.round(meta.deviceHeight ?? config.height),
                    timestamp: Math.round((meta.timestamp ?? Date.now() / 1000) * 1000),
                  },
                  bytes,
                )
                Queue.offerUnsafe(out, { data: frame, ack })
              }
              const off = r.cdp.on((e) => {
                if (e.sessionId !== sid) return
                if (e.method === "Page.screencastFrame") {
                  const ack = () => r.cdp.sendUnsafe("Page.screencastFrameAck", { sessionId: e.params.sessionId }, sid)
                  // slow viewer: drop the frame but keep Chromium flowing
                  if (Queue.sizeUnsafe(out) > 2) return ack()
                  pushFrame(Buffer.from(String(e.params.data), "base64"), e.params.metadata ?? {}, ack)
                } else if (e.method === "Page.loadEventFired" || e.method === "Page.navigatedWithinDocument") {
                  runFork(
                    pageInfo(r, sid).pipe(Effect.tap((info) => Effect.sync(() => notice({ _tag: "Url", url: info.url, title: info.title })))),
                  )
                }
              })
              yield* Effect.addFinalizer(() => Effect.sync(off))
              yield* r.cdp.send("Page.enable", {}, sid)
              notice({ _tag: "Lease", holder: lease(sc.botId).holder })
              const info = yield* pageInfo(r, sid)
              notice({ _tag: "Url", url: info.url, title: info.title })
              // idle pages do not repaint: push one still frame first
              const vp = yield* viewport(r, sid).pipe(Effect.orElseSucceed(() => ({ width: config.width, height: config.height })))
              const still = yield* r.cdp
                .send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: opts.quality ?? 60 }, sid)
                .pipe(Effect.option)
              if (still._tag === "Some") pushFrame(Buffer.from(still.value.data, "base64"), { deviceWidth: vp.width, deviceHeight: vp.height })
              yield* r.cdp.send(
                "Page.startScreencast",
                {
                  format,
                  quality: opts.quality ?? 60,
                  maxWidth: opts.maxWidth ?? config.width,
                  maxHeight: opts.maxHeight ?? config.height,
                  everyNthFrame: opts.everyNthFrame ?? 1,
                },
                sid,
              )
              if (!started) {
                started = true
                yield* sc.onStarted(tab.targetId)
              }
              return yield* Effect.raceFirst(Deferred.await(changed), Deferred.await(socketClosed).pipe(Effect.as("socket-closed" as const)))
            }).pipe(
              Effect.scoped,
              Effect.ensuring(
                Effect.sync(() => {
                  w.listeners.delete(onChange)
                  r.closedListeners.delete(onClosed)
                }),
              ),
              Effect.catchTag("CdpError", (e) =>
                r.cdp.isOpen() ? Effect.succeed("changed" as const) : Effect.fail(new BrowserUnavailable({ reason: e.message })),
              ),
            )
            if (result === "socket-closed") break
            if (result === "browser-closed") {
              ended = "the browser closed"
              break
            }
            // "changed": the active tab moved or closed; re-attach (a closed window is recreated)
            if (!r.bots.get(sc.botId)) {
              ended = "the bot's window was closed"
              break
            }
          }
          if (ended !== undefined) {
            notice({ _tag: "Ended", reason: ended })
            // let the writer flush the notice, then close the stream
            for (let i = 0; i < 20 && Queue.sizeUnsafe(out) > 0; i++) yield* Effect.sleep(10)
            yield* Effect.ignore(sc.io.writer.write(new Socket.CloseEvent(1000, "ended")))
          }
        }),
      )

    // ------------------------------------------------------------ shutdown
    const stop = (r: Running): Effect.Effect<void> =>
      Effect.gen(function* () {
        r.closing = true
        if (r.cdp.isOpen()) {
          yield* r.cdp.send("Browser.close", {}, undefined, 3000).pipe(Effect.ignore)
          yield* Effect.promise(() => r.launched.proc.exited).pipe(Effect.timeoutOption(5000))
        }
        yield* terminateGroup(r.launched.proc, 1000)
        yield* Scope.close(r.scope, Exit.void)
        if (running === r) running = undefined
      })

    const shutdown = lock.withPermits(1)(Effect.suspend(() => (running ? stop(running) : Effect.void)))

    yield* Effect.addFinalizer(() => shutdown)

    return {
      available,
      executable: config.executable,
      ensure,
      action,
      input,
      setLease,
      lease,
      screencast,
      shutdown,
      cdpPort: () => running?.launched.port,
    } satisfies BrowserManagerShape
  })

export const BrowserManagerLive: Layer.Layer<BrowserManager, never, NodeConfig | BrainLink> = Layer.effect(
  BrowserManager,
  Effect.gen(function* () {
    const config = yield* NodeConfig
    const brain = yield* BrainLink
    return BrowserManager.of(
      yield* makeBrowserManager(config.browser, { logFile: path.join(config.dataDir, "browser.log"), onEvent: brain.event }),
    )
  }),
)
