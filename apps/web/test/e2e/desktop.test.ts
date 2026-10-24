// E2E: the desktop app's side of the web app. "Allow this computer" (`#/connect-device?code=…` →
// the app's poll gets its code), system notifications (a Bot finishing in another chat notifies; the
// chat you look at does not) and Settings › General › Apps. Real brain, fake harness; the browser's
// `Notification` is recorded instead of shown.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Browser } from "playwright-core"
import type { ConversationId } from "@openbot/contracts"
import {
  type AppPage,
  type Brain,
  connectRpc,
  eventually,
  hasChromium,
  launchBrowser,
  openApp,
  type Rpc,
  startBrain,
} from "./brain.ts"

const recordNotifications = () => {
  if (!location.protocol.startsWith("http")) return
  const shown: Array<{ title: string; body?: string; tag?: string; icon?: string }> = []
  ;(window as unknown as { __shown: typeof shown }).__shown = shown
  class Recorded {
    static permission = "granted"
    static requestPermission = async () => "granted"
    onclick: (() => void) | null = null
    constructor(title: string, options?: { body?: string; tag?: string; icon?: string }) {
      shown.push({ title, ...options })
    }
    close() {}
  }
  ;(window as unknown as { Notification: unknown }).Notification = Recorded
  localStorage.setItem("openbot.notifications", "on")
}

describe.skipIf(!hasChromium)("e2e: the desktop app's side of the web app", () => {
  let brain: Brain
  let browser: Browser
  let rpc: Rpc
  let app: AppPage
  let adaDm: ConversationId
  let bobDm: ConversationId

  beforeAll(async () => {
    brain = await startBrain()
    browser = await launchBrowser()
    rpc = await connectRpc(brain)
    const ada = await rpc.call((c) =>
      c["bots.create"]({ name: "Ada", harness: { kind: "fake" }, clientNonce: "e2e-desktop-ada", introduce: false }),
    )
    const bob = await rpc.call((c) =>
      c["bots.create"]({ name: "Bob", harness: { kind: "fake" }, clientNonce: "e2e-desktop-bob", introduce: false }),
    )
    adaDm = ada.directConversationId as ConversationId
    bobDm = bob.directConversationId as ConversationId
    app = await openApp(browser, brain, { theme: "dark" })
    await app.context.addInitScript(recordNotifications)
  }, 60_000)

  afterAll(async () => {
    await app?.context.close()
    await rpc?.close()
    await browser?.close()
    await brain?.stop()
  })

  test("Allow this computer: the app's code is allowed here, and its poll gets a session", async () => {
    const { page } = app
    const post = (path: string, body: unknown) =>
      fetch(`${brain.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json())
    const started = (await post("/api/auth/device/start", {})) as { deviceCode: string; userCode: string }
    await page.goto("about:blank")
    await page.goto(`${brain.base}/#/connect-device?code=${started.userCode}`)
    const dialog = page.getByRole("dialog")
    await dialog.getByText("Allow the OpenBot app on this computer?").waitFor()
    await dialog.getByText(started.userCode).waitFor()
    await app.shot("e2e-70-connect-device")
    await dialog.getByRole("button", { name: "Allow" }).click()
    await page.getByText("The desktop app is connected", { exact: false }).waitFor()
    const polled = (await post("/api/auth/device/poll", { deviceCode: started.deviceCode })) as {
      status: string
      code: string
    }
    expect(polled.status).toBe("approved")
    const login = (await post("/api/auth/app-login", { code: polled.code })) as { sessionToken?: string }
    expect(login.sessionToken).toBeString()
    expect(app.errors).toEqual([])
  }, 60_000)

  test("notifications: a Bot finishing in another chat notifies; the chat on screen does not", async () => {
    const { page } = app
    await page.goto(`${brain.base}/#/c/${encodeURIComponent(adaDm)}`)
    await page.getByRole("textbox", { name: "Message Ada" }).waitFor()
    const shown = () =>
      page.evaluate(
        () => (window as unknown as { __shown: Array<{ title: string; body?: string; icon?: string }> }).__shown,
      )
    const focused = await page.evaluate(() => document.hasFocus())
    await rpc.call((c) =>
      c["messages.send"]({ conversationId: bobDm, text: "echo: the report is ready", clientNonce: "e2e-desktop-1" }),
    )
    const notes = await eventually(shown, (n) => n.some((x) => x.title === "Bob"), { label: "Bob's notification" })
    const bob = notes.find((x) => x.title === "Bob")
    expect(bob?.body).toContain("the report is ready")
    // the Bot's avatar as the icon
    expect(bob?.icon).toStartWith("data:image/png;base64,")
    await Bun.write(
      new URL("./screenshots/e2e-76-notification-icon.png", import.meta.url).pathname,
      Buffer.from(bob!.icon!.split(",")[1]!, "base64"),
    )
    await rpc.call((c) =>
      c["messages.send"]({ conversationId: adaDm, text: "echo: on screen", clientNonce: "e2e-desktop-2" }),
    )
    await page.getByTestId("transcript").getByText("on screen").first().waitFor()
    await page.waitForTimeout(500)
    if (focused) expect((await shown()).some((x) => x.title === "Ada")).toBe(false)
    expect(app.errors).toEqual([])
  }, 60_000)

  test("the macOS app: no title bar; the window's buttons' corner stays clear and the top strip moves the window", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" })
    await context.addInitScript(() => {
      ;(window as unknown as { openbotDesktop: unknown }).openbotDesktop = {
        version: "0.1.0",
        platform: "darwin",
        setBadgeCount: () => {},
        focus: () => {},
        signOut: () => {},
      }
    })
    const page = await context.newPage()
    await page.goto(brain.loginUrl)
    await page
      .getByRole("textbox", { name: /Message/ })
      .first()
      .waitFor()
    expect(await page.evaluate(() => document.documentElement.dataset.desktop)).toBe("darwin")
    const strip = await page.evaluate(() => {
      const el = document.querySelector(".ob-titlebar")
      return el
        ? { height: el.getBoundingClientRect().height, region: getComputedStyle(el).getPropertyValue("app-region") }
        : undefined
    })
    expect(strip?.height).toBe(52)
    const header = await page.evaluate(
      () => getComputedStyle(document.querySelector(".ob-sidebar-header")!).paddingInlineStart,
    )
    expect(header).toBe("84px")
    // where macOS draws the window's buttons (x 18, y 23), for the screenshot
    await page.evaluate(() => {
      const lights = document.createElement("div")
      lights.style.cssText = "position:fixed;left:18px;top:23px;display:flex;gap:8px;z-index:99999"
      for (const color of ["#ff5f57", "#febc2e", "#28c840"]) {
        const dot = document.createElement("span")
        dot.style.cssText = `width:12px;height:12px;border-radius:6px;background:${color}`
        lights.append(dot)
      }
      document.body.append(lights)
    })
    await page.screenshot({ path: new URL("./screenshots/e2e-72-macos-window.png", import.meta.url).pathname })
    await context.close()
  }, 60_000)

  test("app updates: a downloaded update shows Restart to update in the sidebar; Settings checks on demand", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" })
    await context.addInitScript(() => {
      const w = window as unknown as { openbotDesktop: unknown; __installed: number }
      w.__installed = 0
      let listener: ((s: unknown) => void) | undefined
      w.openbotDesktop = {
        version: "0.1.0",
        build: "aaaaaaaaaaaa",
        platform: "linux",
        setBadgeCount: () => {},
        focus: () => {},
        signOut: () => {},
        updateState: async () => ({ status: "idle" }),
        onUpdate: (l: (s: unknown) => void) => {
          listener = l
          setTimeout(() => listener?.({ status: "ready", build: "bbbbbbbbbbbb" }), 300)
          return () => void (listener = undefined)
        },
        checkForUpdates: async () => ({ status: "up-to-date" }),
        installUpdate: () => void w.__installed++,
      }
    })
    const page = await context.newPage()
    await page.goto(brain.loginUrl)
    const restart = page.getByTestId("desktop-update")
    await restart.waitFor()
    expect(await restart.textContent()).toContain("Restart to update")
    await page.screenshot({ path: new URL("./screenshots/e2e-73-desktop-update.png", import.meta.url).pathname })
    await restart.click()
    expect(await page.evaluate(() => (window as unknown as { __installed: number }).__installed)).toBe(1)
    await page.keyboard.press("Control+,")
    await page.getByTestId("desktop-check-updates").click()
    await page.getByText("OpenBot is up to date.").waitFor()
    await context.close()
  }, 60_000)

  test("quick send from a browser (the bookmarklet's popup): the page and selection go to the Bot picked", async () => {
    const page = await app.context.newPage()
    const q = new URLSearchParams({
      url: "https://x.com/someone/status/42",
      title: "A post about agents",
      text: "the part I liked",
    })
    await page.goto(`${brain.base}/#/quick-send?${q}`)
    const card = page.getByTestId("quick-send")
    await card.waitFor()
    await card.getByText("A post about agents").waitFor()
    await card.getByText("the part I liked").waitFor()
    await card.getByTestId("quick-send-to").click()
    await card.getByRole("option", { name: "Bob" }).click()
    await card.getByLabel("Note").fill("echo: worth a look?")
    await page.screenshot({ path: new URL("./screenshots/e2e-74-quick-send-browser.png", import.meta.url).pathname })
    await card.getByLabel("Note").press("Enter")
    await card.getByText("Sent to Bob").waitFor()
    const state = await eventually(
      () => rpc.conversation(bobDm),
      (s) =>
        [...s.entries.values()].some(
          (e) => e.kind === "message" && e.role === "user" && e.text.includes("x.com/someone/status/42"),
        ),
      { label: "the quick send message" },
    )
    const sent = [...state.entries.values()].find(
      (e) => e.kind === "message" && e.role === "user" && e.text.includes("x.com/someone/status/42"),
    )
    expect(sent?.kind === "message" ? sent.text : "").toBe(
      "echo: worth a look?\n\nA post about agents\nhttps://x.com/someone/status/42\n\n> the part I liked",
    )
    await page.close()
  }, 60_000)

  test("quick send in the desktop app's panel: what it opened with (page, copy, image), sent with the image attached", async () => {
    const context = await browser.newContext({ viewport: { width: 700, height: 500 }, colorScheme: "dark" })
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg=="
    await context.addInitScript((image) => {
      const w = window as unknown as { openbotDesktop: unknown; __closed: number }
      w.__closed = 0
      const prefill = {
        id: 1,
        link: { url: "https://news.ycombinator.com/item?id=1", title: "Show HN: OpenBot", from: "Safari" },
        clipboard: { text: "copied from Slack: ship it friday" },
      }
      w.openbotDesktop = {
        version: "0.1.0",
        platform: "darwin",
        setBadgeCount: () => {},
        focus: () => {},
        signOut: () => {},
        quickSend: {
          prefill: async () => prefill,
          onPrefill: () => () => {},
          resize: () => {},
          close: () => void w.__closed++,
          screenshot: async () => image,
          info: async () => ({ shortcut: "⌥⌘O", registered: true, canScreenshot: true, platform: "darwin" }),
          installShortcut: async () => ({ ok: true }),
        },
      }
    }, png)
    const page = await context.newPage()
    await page.goto(brain.loginUrl)
    await page.goto(`${brain.base}/#/quick-send`)
    await page.reload()
    const card = page.getByTestId("quick-send")
    await card.getByText("Show HN: OpenBot").waitFor()
    await card.getByText("copied from Slack: ship it friday").waitFor()
    expect(await page.evaluate(() => document.documentElement.dataset.quickSend)).toBe("panel")
    await card.getByRole("button", { name: "Add a screenshot" }).click()
    await card.getByRole("img", { name: "Screenshot" }).waitFor()
    await card.getByTestId("quick-send-to").click()
    await card.getByRole("option", { name: "Ada" }).click()
    await page.screenshot({ path: new URL("./screenshots/e2e-75-quick-send-panel.png", import.meta.url).pathname })
    await card.getByTestId("quick-send-send").click()
    await card.getByText("Sent to Ada").waitFor()
    await eventually(
      () => page.evaluate(() => (window as unknown as { __closed: number }).__closed),
      (n) => n === 1,
      { label: "the panel closed" },
    )
    const state = await eventually(
      () => rpc.conversation(adaDm),
      (s) =>
        [...s.entries.values()].some(
          (e) => e.kind === "message" && e.role === "user" && e.text.includes("Show HN: OpenBot"),
        ),
      { label: "the panel's message" },
    )
    const sent = [...state.entries.values()].find(
      (e) => e.kind === "message" && e.role === "user" && e.text.includes("Show HN: OpenBot"),
    )
    expect(sent?.kind === "message" ? sent.text : "").toBe(
      "Show HN: OpenBot\nhttps://news.ycombinator.com/item?id=1\n\n> copied from Slack: ship it friday",
    )
    expect(sent?.kind === "message" ? sent.attachments.map((a) => a.mime) : []).toEqual(["image/png"])
    await context.close()
  }, 60_000)

  test("Settings › General › Apps: the desktop app, the iPhone app and notifications on this device", async () => {
    const { page } = app
    await page.keyboard.press("Control+,")
    await page.getByTestId("settings-dialog").waitFor()
    const download = page.getByTestId("desktop-download")
    await download.waitFor()
    expect(await download.textContent()).toContain("Download for")
    await page.getByText("Notifications on this device").waitFor()
    await page.getByText("iPhone app").waitFor()
    const bookmarklet = await page.getByTestId("quick-send-bookmarklet").getAttribute("href")
    expect(bookmarklet).toStartWith("javascript:")
    expect(bookmarklet).toContain(`${brain.base}/#/quick-send?`)
    await download.scrollIntoViewIfNeeded()
    await app.shot("e2e-71-settings-apps")
    expect(app.errors).toEqual([])
  }, 60_000)
})
