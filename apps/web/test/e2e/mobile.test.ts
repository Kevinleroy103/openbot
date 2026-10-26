// E2E: the phone layout (iPhone 15 Pro, 393×852 @3x, touch) against the real brain with Demo bots.
// Home list → tap a Bot → full-screen chat with the floating back / name pill; send from the touch
// composer (Send button, Return makes a newline); reply streams in; details as a full-screen page
// (Back closes it); approval card tapped; long-press menus (bubble and Home row) as action sheets;
// Settings list → page drill-down; New chat; in-app back and browser Back return Home; a group chat.
// Real brain, fake harness only. Screenshots: e2e/screenshots/e2e-mobile-*.png.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Browser, BrowserContext, Page } from "playwright-core"
import type { Bot } from "@openbot/contracts"
import { longPress } from "../shoot-mobile.ts"
import {
  type Brain,
  connectRpc,
  eventually,
  hasChromium,
  launchBrowser,
  type Rpc,
  shotsDir,
  startBrain,
  waitIdle,
} from "./brain.ts"

const IPHONE = {
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
} as const

describe.skipIf(!hasChromium)("e2e: phone layout", () => {
  let brain: Brain
  let browser: Browser
  let rpc: Rpc
  let context: BrowserContext
  let page: Page
  const errors: Array<string> = []
  const bots: Record<string, Bot> = {}
  const shot = async (name: string) => {
    await page.waitForTimeout(350)
    await page.screenshot({ path: `${shotsDir}/e2e-mobile-${name}.png` })
  }
  const home = () => page.getByRole("navigation", { name: "Bots" })
  const onHome = async () => {
    await home().locator("[data-row], [data-bot]").first().waitFor()
    await eventually(
      async () => page.evaluate(() => location.hash),
      (h) => !/^#\/(c\/|new)/.test(h),
      { label: "the Home hash" },
    )
    expect(await page.getByRole("button", { name: "Back", exact: true }).count()).toBe(0)
  }

  beforeAll(async () => {
    brain = await startBrain()
    browser = await launchBrowser()
    rpc = await connectRpc(brain)
    for (const name of ["Ada", "Bea"]) {
      bots[name] = await rpc.call((c) =>
        c["bots.create"]({
          name,
          harness: { kind: "fake" },
          autonomy: "ask",
          clientNonce: `e2e-mobile-${name}`,
          introduce: false,
        }),
      )
    }
    context = await browser.newContext({ ...IPHONE, colorScheme: "dark" })
    page = await context.newPage()
    page.setDefaultTimeout(15_000)
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`)
    })
    await page.goto(brain.loginUrl)
    await page.evaluate(() => document.fonts.ready)
  }, 60_000)

  afterAll(async () => {
    await context?.close()
    await rpc?.close()
    await browser?.close()
    await brain?.stop()
  })

  test("starts on Home: the full-width list, no chat", async () => {
    await onHome()
    const nav = await home().boundingBox()
    expect(nav?.width).toBe(393)
    expect(await page.getByRole("textbox", { name: /^Message / }).count()).toBe(0)
    await shot("01-home")
  }, 30_000)

  test("open a DM, send with the touch composer, the reply streams in", async () => {
    await home().locator(`[data-row="${bots["Ada"]!.id}"], [data-bot="${bots["Ada"]!.id}"]`).first().tap()
    const box = page.getByRole("textbox", { name: "Message Ada" })
    await box.waitFor()
    expect(page.url()).toContain(`#/c/${encodeURIComponent(bots["Ada"]!.directConversationId)}`)
    // full-screen chat: the floating back button and the centered name pill
    await page.getByRole("button", { name: "Back", exact: true }).waitFor()
    await page.waitForTimeout(500) // the push transition
    const pill = await page.getByRole("button", { name: "View conversation details" }).boundingBox()
    expect(Math.abs(pill!.x + pill!.width / 2 - 393 / 2)).toBeLessThan(4)
    // the composer spans the screen and its field is 16 px (no iOS zoom on focus)
    expect(await box.evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px")
    const composer = await box.boundingBox()
    expect(composer!.x + composer!.width).toBeGreaterThan(300)
    // Return inserts a newline on a phone; the Send button sends
    await box.tap()
    await box.fill("echo: hello from")
    await box.press("Enter")
    await box.pressSequentially("the phone", { delay: 5 })
    expect(await box.inputValue()).toBe("echo: hello from\nthe phone")
    await page.getByRole("button", { name: "Send", exact: true }).tap()
    await page.getByTestId("transcript").getByText("hello from", { exact: false }).last().waitFor()
    await waitIdle(page)
    const conv = await eventually(
      () => rpc.conversation(bots["Ada"]!.directConversationId),
      (s) =>
        [...s.entries.values()].some((e) => e.kind === "message" && e.author.kind === "bot" && e.text === "hello from"),
      { label: "Ada's reply" },
    )
    expect(
      [...conv.entries.values()].some(
        (e) => e.kind === "message" && e.role === "user" && e.text === "echo: hello from\nthe phone",
      ),
    ).toBe(true)
    await shot("02-dm-reply")
  }, 60_000)

  test("details open full screen; Back (browser) closes them, not the chat", async () => {
    await page.getByRole("button", { name: "View conversation details" }).tap()
    const pane = page.getByTestId("details-pane")
    await pane.waitFor()
    const box = await pane.boundingBox()
    expect(box?.width).toBe(393)
    await shot("03-details")
    await page.goBack()
    await pane.waitFor({ state: "detached" })
    await page.getByRole("textbox", { name: "Message Ada" }).waitFor()
  }, 30_000)

  test("approval card: tap Allow once", async () => {
    const box = page.getByRole("textbox", { name: "Message Ada" })
    await box.fill("approve: git status")
    await page.getByRole("button", { name: "Send", exact: true }).tap()
    const card = page.locator('[data-card="approval"][data-status="pending"]')
    await card.waitFor()
    const allow = card.getByRole("button", { name: "Allow once" })
    expect((await allow.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await shot("04-approval")
    await allow.tap()
    await page.locator('[data-card="approval"][data-status="resolved"]').getByText("Allowed once").waitFor()
    await waitIdle(page)
  }, 60_000)

  test("long-press a bubble → action sheet → Reply", async () => {
    // no hover toolbar on touch
    expect(await page.locator(".ob-msg-actions").first().isVisible()).toBe(false)
    const bubble = page.locator(".ob-msg[data-entry] [data-side]").filter({ hasText: "the phone" }).last()
    await longPress(page, bubble, 700, page.getByTestId("message-sheet"))
    const sheet = page.getByTestId("message-sheet")
    await sheet.waitFor()
    // lifting the finger did not trigger an item under it
    await page.waitForTimeout(300)
    expect(await sheet.isVisible()).toBe(true)
    await shot("05-message-sheet")
    await sheet.getByRole("menuitem", { name: "Reply" }).tap()
    await sheet.waitFor({ state: "detached" })
    await page.getByText("Replying to", { exact: false }).waitFor()
    await page.getByRole("button", { name: "Cancel reply" }).tap()
  }, 30_000)

  test("in-app back returns Home; browser Forward reopens the chat; browser Back returns Home again", async () => {
    await page.getByRole("button", { name: "Back", exact: true }).tap()
    await onHome()
    await page.goForward()
    await page.getByRole("textbox", { name: "Message Ada" }).waitFor()
    await page.goBack()
    await onHome()
    await shot("06-back-home")
  }, 30_000)

  test("long-press a Home row → its menu as an action sheet", async () => {
    const row = home().locator(`[data-row="${bots["Bea"]!.id}"], [data-bot="${bots["Bea"]!.id}"]`).first()
    await longPress(page, row, 700, page.getByTestId("row-sheet"))
    const sheet = page.getByTestId("row-sheet")
    await sheet.waitFor()
    await page.waitForTimeout(300)
    expect(await sheet.isVisible()).toBe(true)
    // nothing was chosen by lifting the finger (the first item is "Pin")
    expect((await rpc.call((c) => c["bots.get"]({ botId: bots["Bea"]!.id }))).pinned).toBe(false)
    expect(await sheet.getByRole("menuitem", { name: "Mark as Unread" }).isVisible()).toBe(true)
    await shot("07-row-sheet")
    await page.getByTestId("action-sheet-scrim").tap({ position: { x: 20, y: 40 } })
    await sheet.waitFor({ state: "detached" })
    // the long-press did not open the chat
    await onHome()
  }, 30_000)

  test("Settings: list → page → back to the list → close", async () => {
    await page.getByRole("button", { name: "Account" }).tap()
    await page.getByRole("menuitem", { name: /Settings/ }).tap()
    await page.getByTestId("settings-dialog").waitFor()
    await page.getByTestId("settings-nav-permissions").tap()
    await page.getByTestId("settings-page-permissions").waitFor()
    await shot("08-settings-page")
    await page.getByTestId("settings-back").tap()
    await page.getByTestId("settings-nav-general").waitFor()
    await page.getByRole("button", { name: "Close settings" }).tap()
    await page.getByTestId("settings-dialog").waitFor({ state: "detached" })
    await onHome()
  }, 30_000)

  test("New chat: pick two Bots with + and create a group; it opens full screen", async () => {
    await page.getByRole("button", { name: "New chat", exact: true }).tap()
    await page.getByRole("combobox", { name: "To" }).waitFor()
    await page.getByRole("button", { name: "Add Ada" }).tap()
    await page.getByRole("button", { name: "Add Bea" }).tap()
    await shot("09-new-chat-group")
    await page.getByTestId("new-chat-create-group").tap()
    const box = page.getByRole("textbox", { name: /^Message Ada, Bea/ })
    await box.waitFor()
    await box.fill("echo: hi both")
    await page.getByRole("button", { name: "Send", exact: true }).tap()
    await page.getByTestId("transcript").getByText("hi both", { exact: true }).last().waitFor()
    await waitIdle(page)
    await shot("10-group")
    await page.getByRole("button", { name: "Back", exact: true }).tap()
    await onHome()
    expect(errors).toEqual([])
  }, 60_000)
})
