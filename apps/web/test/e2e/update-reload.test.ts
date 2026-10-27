// E2E: an update restarts the brain into a new web app; an open page reloads into it by itself and
// keeps its chat and draft. Real brain, fake harness; the brain comes back with `--dev`, whose web
// build differs from the first one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Browser } from "playwright-core"
import { type AppPage, type Brain, connectRpc, hasChromium, launchBrowser, openApp, startBrain } from "./brain.ts"

describe.skipIf(!hasChromium)("e2e: a new web app after an update", () => {
  let brain: Brain
  let browser: Browser
  let app: AppPage

  beforeAll(async () => {
    brain = await startBrain({ harnesses: "fake" })
    const rpc = await connectRpc(brain)
    await rpc.call((c) =>
      c["bots.create"]({ name: "Otto", harness: { kind: "fake" }, clientNonce: "e2e-update-otto", introduce: false }),
    )
    await rpc.close()
    browser = await launchBrowser()
    app = await openApp(browser, brain)
  }, 60_000)

  afterAll(async () => {
    await app?.context.close()
    await browser?.close()
    await brain?.stop()
  })

  /** Marks the page that runs now: a reload drops the mark. */
  const mark = () => app.page.evaluate(() => Object.assign(window, { marked: true }))
  const marked = () => app.page.evaluate(() => "marked" in window)

  test("a restart with the same web app leaves the page alone", async () => {
    await mark()
    const checked = app.page.waitForResponse(`${brain.base}/`)
    await brain.restart()
    await (await checked).finished()
    expect(await marked()).toBe(true)
  }, 60_000)

  test("the open page reloads into the new web app with its chat and draft", async () => {
    const { page } = app
    const composer = page.getByRole("textbox", { name: "Message Otto" })
    await composer.fill("half a thought")
    const chat = page.url()
    const entry = () => page.evaluate(() => document.querySelector('script[type="module"]')?.getAttribute("src"))
    const loaded = await entry()
    await mark()

    await brain.restart(["--dev"])

    await page.waitForFunction(() => !("marked" in window), undefined, { timeout: 30_000 })
    expect(await entry()).not.toBe(loaded)
    expect(page.url()).toBe(chat)
    expect(await composer.inputValue()).toBe("half a thought")
  }, 60_000)
})
