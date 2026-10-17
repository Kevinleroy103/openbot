/**
 * Phone / tablet screenshots of the web app against the dev mock server, in Chromium with device
 * emulation (iPhone 15 Pro 393×852 @3x and iPad 820×1180 @2x, touch, iOS safe areas when the
 * Chromium build supports overriding them).
 *
 *   bun apps/web/test/shoot-mobile.ts [scene-prefix…] [--dark|--light]   → test/screenshots/mobile-*.png
 *
 * Env: OPENBOT_CHROMIUM (default /usr/bin/chromium).
 */
import { join } from "node:path"
import { type Browser, type BrowserContextOptions, chromium, type Locator, type Page } from "playwright-core"
import { chromiumPath, screenshotDir, startMock } from "./shoot.ts"

const IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"
const IPAD_UA = "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"

export interface Device {
  readonly name: string
  readonly options: BrowserContextOptions
  /** Safe-area insets of the device in a standalone (home screen) app. */
  readonly insets: { readonly top: number; readonly bottom: number }
}
export const IPHONE: Device = {
  name: "iphone",
  options: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IOS_UA },
  insets: { top: 59, bottom: 34 },
}
export const IPAD: Device = {
  name: "ipad",
  options: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPAD_UA },
  insets: { top: 24, bottom: 20 },
}

export interface DevicePage {
  readonly page: Page
  readonly errors: Array<string>
  readonly close: () => Promise<void>
}

/** A fresh device context on `url` + `route` (theme also seeded for the first paint). */
export const openDevice = async (browser: Browser, url: string, device: Device, theme: "dark" | "light", route = ""): Promise<DevicePage> => {
  const context = await browser.newContext({ ...device.options, colorScheme: theme })
  await context.addInitScript((t) => localStorage.setItem("openbot.theme", t), theme)
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  try {
    const cdp = await context.newCDPSession(page)
    await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets: { top: device.insets.top, bottom: device.insets.bottom, left: 0, right: 0 } } as never)
  } catch {
    // older Chromium: no safe-area emulation (env() resolves to 0)
  }
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`)
  })
  await page.goto(`${url}/${route}`)
  await page.evaluate(() => document.fonts.ready)
  return { page, errors, close: () => context.close() }
}

/** Touch long-press at the center of `target` (CDP touch events → pointer events). */
export const longPress = async (page: Page, target: Locator, ms = 700): Promise<void> => {
  const box = await target.boundingBox()
  if (!box) throw new Error("long-press target is not visible")
  const x = box.x + box.width / 2
  const y = box.y + Math.min(box.height / 2, 24)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
  await page.waitForTimeout(ms)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  await cdp.detach()
}

const settle = (page: Page, ms = 450) => page.waitForTimeout(ms)

interface Scene {
  readonly name: string
  readonly device: Device
  readonly route?: string
  /** Run against a mock with no Bots (first-run onboarding). */
  readonly empty?: boolean
  /** Steps; `shot(suffix)` saves mobile-<name>[-suffix]-<theme>.png. */
  readonly run: (page: Page, shot: (suffix?: string) => Promise<void>) => Promise<void>
}

const home = (page: Page) => page.getByRole("navigation", { name: "Bots" })

export const SCENES: ReadonlyArray<Scene> = [
  {
    name: "00-onboarding",
    device: IPHONE,
    empty: true,
    run: async (page, shot) => {
      await page.getByTestId("onboarding").waitFor()
      await settle(page, 600)
      await shot()
      await page.getByTestId("onboarding-start").tap()
      await settle(page, 800)
      await shot("harnesses")
    },
  },
  {
    name: "01-home",
    device: IPHONE,
    run: async (page, shot) => {
      await home(page).getByText("Chief of Staff").first().waitFor()
      await shot()
    },
  },
  {
    name: "02-dm",
    device: IPHONE,
    run: async (page, shot) => {
      await home(page).locator('[data-bot="bot_chief"]').tap()
      await page.getByRole("textbox", { name: "Message Chief of Staff" }).waitFor()
      await settle(page)
      await shot()
      // back to Home with the in-app back button
      await page.getByTestId("chat-back").tap()
      await home(page).getByText("Research Scout").first().waitFor()
      await settle(page)
      await shot("back")
    },
  },
  {
    name: "03-send",
    device: IPHONE,
    route: "#/c/cnv_expense",
    run: async (page, shot) => {
      const box = page.getByRole("textbox", { name: "Message Expense Clerk" })
      await box.tap()
      await box.fill("Give me a status update")
      await shot("typed")
      await page.getByRole("button", { name: "Send" }).tap()
      await page.getByTestId("transcript").getByText("Here's where things stand").waitFor({ timeout: 20_000 })
      await settle(page, 800)
      await shot()
    },
  },
  {
    name: "04-details",
    device: IPHONE,
    route: "#/c/cnv_chief",
    run: async (page, shot) => {
      await page.getByRole("button", { name: "View conversation details" }).tap()
      await page.getByTestId("details-pane").waitFor()
      await settle(page)
      await shot()
      await page.getByTestId("avatar-button").tap()
      await page.getByTestId("avatar-sheet").waitFor()
      await settle(page)
      await shot("avatar")
    },
  },
  {
    name: "05-settings",
    device: IPHONE,
    run: async (page, shot) => {
      await page.getByRole("button", { name: "Account" }).tap()
      await page.getByRole("menuitem", { name: /Settings/ }).tap()
      await page.getByTestId("settings-dialog").waitFor()
      await settle(page)
      await shot("list")
      await page.getByTestId("settings-nav-general").tap()
      await page.getByTestId("settings-page-general").waitFor()
      await settle(page)
      await shot("general")
      await page.getByTestId("settings-back").tap()
      await page.getByTestId("settings-nav-computers").tap()
      await page.getByTestId("settings-page-computers").waitFor()
      await settle(page, 800)
      await shot("computers")
    },
  },
  {
    name: "06-new-chat",
    device: IPHONE,
    run: async (page, shot) => {
      await page.getByRole("button", { name: "New chat", exact: true }).tap()
      await page.getByRole("combobox", { name: "To" }).waitFor()
      await settle(page)
      await shot()
    },
  },
  {
    name: "07-search",
    device: IPHONE,
    run: async (page, shot) => {
      await page.getByRole("button", { name: "Search", exact: true }).tap()
      await page.getByRole("combobox").first().waitFor()
      await settle(page)
      await shot()
    },
  },
  {
    name: "08-group",
    device: IPHONE,
    route: "#/c/cnv_launch",
    run: async (page, shot) => {
      await page.getByTestId("transcript").locator(".ob-msg").first().waitFor()
      await settle(page)
      await shot()
    },
  },
  {
    name: "09-approval",
    device: IPHONE,
    route: "#/c/cnv_expense",
    run: async (page, shot) => {
      const box = page.getByRole("textbox", { name: "Message Expense Clerk" })
      await box.fill("Please run the tests")
      await page.getByRole("button", { name: "Send" }).tap()
      const card = page.locator('[data-card="approval"][data-status="pending"]').last()
      await card.waitFor({ timeout: 20_000 })
      await card.scrollIntoViewIfNeeded()
      await settle(page)
      await shot()
      await card.getByRole("button", { name: "Allow once" }).tap()
      await page.locator('[data-card="approval"][data-status="resolved"]').last().waitFor({ timeout: 10_000 })
      await settle(page, 600)
      await shot("allowed")
    },
  },
  {
    name: "10-long-press",
    device: IPHONE,
    route: "#/c/cnv_chief",
    run: async (page, shot) => {
      const bubble = page.locator(".ob-msg[data-entry] [data-side]").last()
      await bubble.waitFor()
      await longPress(page, bubble)
      await page.getByTestId("message-sheet").waitFor()
      await settle(page)
      await shot("message")
    },
  },
  {
    name: "11-row-menu",
    device: IPHONE,
    run: async (page, shot) => {
      const row = home(page).locator('[data-row="bot_scout"]')
      await row.waitFor()
      await longPress(page, row)
      await page.getByTestId("row-sheet").waitFor()
      await settle(page)
      await shot()
    },
  },
  {
    name: "12-computer",
    device: IPHONE,
    route: "#/c/cnv_chief",
    run: async (page, shot) => {
      await page.getByTestId("chat-computer").tap()
      await page.getByTestId("computer-view").waitFor()
      await settle(page, 800)
      await shot()
    },
  },
  {
    name: "13-forms",
    device: IPHONE,
    route: "#/c/cnv_travel",
    run: async (page, shot) => {
      await settle(page, 600)
      await shot()
    },
  },
  {
    name: "14-new-bot",
    device: IPHONE,
    route: "#/new",
    run: async (page, shot) => {
      await page.getByRole("option", { name: /Create new Bot/ }).tap()
      await page.getByTestId("new-bot-form").waitFor()
      await settle(page)
      await shot()
    },
  },
  {
    name: "20-tablet-chat",
    device: IPAD,
    route: "#/c/cnv_chief",
    run: async (page, shot) => {
      await page.getByRole("textbox", { name: "Message Chief of Staff" }).waitFor()
      await settle(page)
      await shot()
      await page.getByRole("button", { name: "View conversation details" }).tap()
      await page.getByTestId("details-pane").waitFor()
      await settle(page)
      await shot("details")
    },
  },
]

if (import.meta.main) {
  const args = process.argv.slice(2)
  const themes: ReadonlyArray<"dark" | "light"> = args.includes("--light") ? ["light"] : args.includes("--dark") ? ["dark"] : ["dark", "light"]
  const wanted = args.filter((a) => !a.startsWith("--"))
  const mock = await startMock(0, ["--fast"])
  let emptyMock: Awaited<ReturnType<typeof startMock>> | undefined
  const browser = await chromium.launch({ executablePath: chromiumPath })
  let failed = 0
  try {
    for (const scene of SCENES.filter((s) => wanted.length === 0 || wanted.some((w) => s.name.startsWith(w)))) {
      for (const theme of themes) {
        if (scene.empty) emptyMock ??= await startMock(0, ["--fast", "--empty"])
        const { page, errors, close } = await openDevice(browser, scene.empty ? emptyMock!.url : mock.url, scene.device, theme, scene.route ?? "")
        const shot = async (suffix?: string) => {
          await page.screenshot({ path: join(screenshotDir, `mobile-${scene.name}${suffix ? `-${suffix}` : ""}-${theme}.png`) })
        }
        try {
          await scene.run(page, shot)
          console.log(`ok   ${scene.name} (${theme})${errors.length ? `  errors: ${errors.join(" | ")}` : ""}`)
        } catch (e) {
          failed++
          await shot("FAILED").catch(() => {})
          console.log(`FAIL ${scene.name} (${theme}): ${(e as Error).message.split("\n")[0]}${errors.length ? `  errors: ${errors.join(" | ")}` : ""}`)
        } finally {
          await close()
        }
      }
    }
  } finally {
    await browser.close()
    await mock.stop()
    await emptyMock?.stop()
  }
  process.exit(failed ? 1 : 0)
}
