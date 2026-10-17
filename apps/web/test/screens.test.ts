// Visual + smoke test for the web app (W2.2) against the dev mock server, in Chromium via
// playwright-core at 1440x900 DPR 2. Screenshots land in apps/web/test/screenshots/.
// Skipped when Chromium is missing (OPENBOT_CHROMIUM, default /usr/bin/chromium).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { chromium, type Browser } from "playwright-core"
import { chromiumPath, openPage, screenshotDir, startMock, takeScreens, type RunningMock } from "./shoot.ts"

const hasChromium = existsSync(chromiumPath)

describe.skipIf(!hasChromium)("web app against the dev mock", () => {
  let mock: RunningMock
  let browser: Browser
  beforeAll(async () => {
    mock = await startMock(0, ["--fast"])
    browser = await chromium.launch({ executablePath: chromiumPath })
  }, 30_000)
  afterAll(async () => {
    await browser?.close()
    await mock?.stop()
  })

  test(
    "send a message and see a streamed reply",
    async () => {
      const { page, errors } = await openPage(browser, mock.url, "dark", "#/c/cnv_expense")
      const box = page.getByRole("textbox", { name: "Message Expense Clerk" })
      await box.fill("Give me a status update")
      await box.press("Enter")
      await page.getByTestId("transcript").getByText("Give me a status update").waitFor()
      // The activity row shows while the bot works, then the reply streams in.
      await page.locator('[role="status"]', { hasText: /Thinking|Reading|Running|Typing|Working|progress|Handling|Chipping|done/i }).first().waitFor({ timeout: 8000 })
      await page.screenshot({ path: join(screenshotDir, "smoke-working-dark.png") })
      await page.getByTestId("transcript").getByText("Here's where things stand").waitFor({ timeout: 15_000 })
      await page.locator('[data-steps="3"]').waitFor({ timeout: 15_000 })
      await page.screenshot({ path: join(screenshotDir, "smoke-reply-dark.png") })
      expect(errors).toEqual([])
      await page.context().close()
    },
    60_000,
  )

  test(
    "approve a card",
    async () => {
      const { page, errors } = await openPage(browser, mock.url, "light", "#/c/cnv_expense")
      const box = page.getByRole("textbox", { name: "Message Expense Clerk" })
      await box.fill("Please run the tests")
      await box.press("Enter")
      const card = page.locator('[data-card="approval"][data-status="pending"]')
      await card.waitFor({ timeout: 15_000 })
      await card.getByText("Needs approval").waitFor()
      await page.screenshot({ path: join(screenshotDir, "smoke-approval-light.png") })
      await card.getByRole("button", { name: "Allow once" }).click()
      await page.locator('[data-card="approval"][data-status="resolved"]').getByText("Allowed once").waitFor({ timeout: 8000 })
      await page.getByTestId("transcript").getByText("Ran npm test", { exact: false }).waitFor({ timeout: 15_000 })
      await page.screenshot({ path: join(screenshotDir, "smoke-approved-light.png") })
      expect(errors).toEqual([])
      await page.context().close()
    },
    60_000,
  )

  test(
    "answer a question card and interrupt a turn",
    async () => {
      const { page, errors } = await openPage(browser, mock.url, "dark", "#/c/cnv_chief")
      const question = page.locator('[data-card="question"][data-status="pending"]')
      await question.waitFor()
      await question.getByRole("button", { name: /Marina House/ }).click()
      await page.locator('[data-card="question"][data-status="resolved"]').waitFor({ timeout: 8000 })
      await page.getByTestId("transcript").getByText("I'll take it from here").waitFor({ timeout: 15_000 })
      const box = page.getByRole("textbox", { name: "Message Chief of Staff" })
      await box.fill("What's on the agenda today?")
      await box.press("Enter")
      const stop = page.getByRole("button", { name: "Stop" })
      await stop.waitFor({ timeout: 8000 })
      await stop.click()
      await stop.waitFor({ state: "detached", timeout: 8000 })
      expect(errors).toEqual([])
      await page.context().close()
    },
    60_000,
  )

  test(
    "attach a file and @mention a Bot in a group chat",
    async () => {
      const { page, errors } = await openPage(browser, mock.url, "dark", "#/c/cnv_launch")
      await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("launch notes") })
      await page.getByRole("button", { name: "Remove notes.txt" }).waitFor()
      const box = page.getByRole("textbox", { name: "Message Launch crew" })
      await box.click()
      await box.pressSequentially("@Data", { delay: 10 })
      await page.getByRole("menu", { name: "Mention a Bot" }).waitFor()
      await box.press("Enter")
      await box.pressSequentially("can you check these?", { delay: 5 })
      expect(await box.inputValue()).toBe("@Data Analyst can you check these?")
      await box.press("Enter")
      const transcript = page.getByTestId("transcript")
      await transcript.getByRole("link", { name: "notes.txt" }).waitFor({ timeout: 8000 })
      await transcript.getByText("— Data Analyst").waitFor({ timeout: 15_000 })
      await page.screenshot({ path: join(screenshotDir, "smoke-group-dark.png") })
      expect(errors).toEqual([])
      await page.context().close()
    },
    60_000,
  )

  test(
    "search palette, row context menu and new chat",
    async () => {
      const { page, errors } = await openPage(browser, mock.url, "light", "#/c/cnv_chief")
      await page.keyboard.press("Control+k")
      await page.getByRole("combobox").fill("scout")
      await page.keyboard.press("Enter")
      await page.locator('[data-conversation="cnv_scout"]').waitFor()
      await page.locator('[data-row="bot_travel"]').click({ button: "right" })
      await page.getByRole("menuitem", { name: "Pin" }).click()
      await page.locator('[data-bot="bot_travel"]').waitFor()
      await page.keyboard.press("Control+n")
      await page.getByRole("combobox", { name: "To" }).fill("Expense")
      await page.keyboard.press("Enter")
      await page.locator('[data-conversation="cnv_expense"]').waitFor()
      expect(errors).toEqual([])
      await page.context().close()
    },
    60_000,
  )

  test(
    "first run shows onboarding",
    async () => {
      const empty = await startMock(0, ["--empty"])
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" })
        const page = await context.newPage()
        const errors: string[] = []
        page.on("pageerror", (e) => errors.push(e.message))
        await page.goto(`${empty.url}/`)
        await page.waitForTimeout(2500)
        expect(await page.locator('nav[aria-label="Bots"]').count()).toBe(0)
        await page.screenshot({ path: join(screenshotDir, "smoke-onboarding-light.png") })
        expect(errors).toEqual([])
        await context.close()
      } finally {
        await empty.stop()
      }
    },
    60_000,
  )

  test(
    "screens look like Grok Bot (dark + light)",
    async () => {
      const res = await takeScreens({ only: ["01-chat", "03-details", "10-new-chat", "11-search", "19-mention", "30-steps", "36-error-tray"] })
      expect(res.files.length).toBe(14)
      expect(res.errors).toEqual([])
    },
    240_000,
  )
})
