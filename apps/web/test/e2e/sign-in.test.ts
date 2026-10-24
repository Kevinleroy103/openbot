// E2E: "Sign in with another device". A browser on the login page asks to sign in and shows a number;
// a signed-in app (another browser here) shows the request and picks that number; the first browser
// lands in the app. A wrong number cancels the request. Real brain, fake harness.
// Screenshots: e2e-100-*.png.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Browser, Page } from "playwright-core"
import { join } from "node:path"
import {
  type AppPage,
  type Brain,
  connectRpc,
  hasChromium,
  launchBrowser,
  openApp,
  shotsDir,
  startBrain,
} from "./brain.ts"

describe.skipIf(!hasChromium)("e2e: sign in with another device", () => {
  let brain: Brain
  let browser: Browser
  let owner: AppPage

  beforeAll(async () => {
    brain = await startBrain({ harnesses: "fake" })
    // a Bot, so the app opens on its sidebar rather than the first-run welcome
    const rpc = await connectRpc(brain)
    await rpc.call((c) =>
      c["bots.create"]({ name: "Otto", harness: { kind: "fake" }, clientNonce: "e2e-sign-in-otto", introduce: false }),
    )
    await rpc.close()
    browser = await launchBrowser()
    owner = await openApp(browser, brain, { theme: "dark" })
    await owner.page.getByRole("navigation", { name: "Bots" }).waitFor()
  }, 60_000)

  afterAll(async () => {
    await owner?.context.close()
    await browser?.close()
    await brain?.stop()
  })

  /** A fresh browser (no session) on the login page, asking to sign in: the number it shows. */
  const ask = async (): Promise<{ page: Page; close: () => Promise<void>; number: string }> => {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 }, colorScheme: "dark" })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await page.goto(`${brain.base}/`)
    await page.getByRole("button", { name: "Sign in with another device" }).click()
    const number = page.locator("#device-match")
    await page.waitForFunction(() => /^\d{2}$/.test(document.getElementById("device-match")?.textContent ?? ""))
    return { page, close: () => context.close(), number: await number.innerText() }
  }

  test("the signed-in app picks the number the browser shows; the browser opens OpenBot", async () => {
    const other = await ask()
    try {
      await other.page.screenshot({ path: join(shotsDir, "e2e-100-sign-in-asking.png") })
      const prompt = owner.page.getByRole("dialog", { name: "Let a browser sign in?" })
      await prompt.waitFor()
      await owner.shot("e2e-101-sign-in-prompt")
      await prompt.getByRole("button", { name: `The browser shows ${other.number}` }).click()
      await prompt.waitFor({ state: "detached" })
      // the browser that asked is in
      await other.page.getByRole("navigation", { name: "Bots" }).waitFor({ timeout: 20_000 })
      expect(owner.errors).toEqual([])
    } finally {
      await other.close()
    }
  }, 60_000)

  test("a wrong number cancels the request; the browser says so", async () => {
    const other = await ask()
    try {
      const prompt = owner.page.getByRole("dialog", { name: "Let a browser sign in?" })
      await prompt.waitFor()
      const wrong = prompt
        .getByTestId("sign-in-choices")
        .getByRole("button")
        .filter({ hasNotText: other.number })
        .first()
      await wrong.click()
      await prompt.waitFor({ state: "detached" })
      await other.page.getByText("That request was turned down or cancelled.").waitFor({ timeout: 10_000 })
      await other.page.screenshot({ path: join(shotsDir, "e2e-102-sign-in-cancelled.png") })
      expect(await other.page.getByRole("navigation", { name: "Bots" }).count()).toBe(0)
    } finally {
      await other.close()
    }
  }, 60_000)
})
