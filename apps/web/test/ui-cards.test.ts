import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { chromium, type Browser, type Page } from "playwright-core"
import { chromiumPath, screenshotDir, startMock, type RunningMock } from "./shoot.ts"

const enabled = existsSync(chromiumPath)
const scenarios = ["comparison", "chart", "chart-stacked", "chart-fill", "plan", "choice", "agenda", "compact"] as const

async function loaded(page: Page) {
  await page.locator('[data-conversation="cnv_expense"] [data-entry]').first().waitFor()
}

async function show(page: Page, scenario: string) {
  await loaded(page)
  const cards = page.locator('[data-card="ui"]')
  const previous = (await cards.count())
    ? await cards.last().evaluate((element) => element.closest("[data-entry]")?.getAttribute("data-entry"))
    : null
  const box = page.getByRole("textbox", { name: "Message Expense Clerk" })
  await box.fill(`ui-${scenario}`)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  const handle = await page.waitForFunction((id) => {
    const elements = document.querySelectorAll('[data-card="ui"]')
    const entry = elements[elements.length - 1]?.closest("[data-entry]")?.getAttribute("data-entry")
    return entry && entry !== id ? entry : null
  }, previous)
  return page.locator(`[data-entry="${await handle.jsonValue()}"] [data-card="ui"]`)
}

describe.skipIf(!enabled)("generative UI against the dev mock", () => {
  let mock: RunningMock
  let browser: Browser
  beforeAll(async () => {
    mock = await startMock(0, ["--fast"])
    browser = await chromium.launch({ executablePath: chromiumPath })
    mkdirSync(screenshotDir, { recursive: true })
  }, 30_000)
  afterAll(async () => {
    await browser?.close()
    await mock?.stop()
  })

  for (const theme of ["light", "dark"] as const) {
    for (const phone of [false, true]) {
      test(`reply layouts in ${theme}, ${phone ? "phone" : "desktop"}`, async () => {
        const context = await browser.newContext({
          viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 850 },
          colorScheme: theme,
          deviceScaleFactor: 1,
          isMobile: phone,
          hasTouch: phone,
          reducedMotion: "reduce",
        })
        const errors: string[] = []
        try {
          await context.addInitScript((value) => localStorage.setItem("openbot.theme", value), theme)
          const page = await context.newPage()
          page.setDefaultTimeout(15_000)
          page.on("pageerror", (error) => errors.push(error.message))
          await page.goto(`${mock.url}/#/c/cnv_expense`)
          await page.getByRole("textbox", { name: "Message Expense Clerk" }).waitFor()
          for (const scenario of scenarios) {
            const card = await show(page, scenario)
            await page.evaluate(() => document.fonts.ready)
            await card.scrollIntoViewIfNeeded()
            expect(await card.getAttribute("data-status")).toBe(
              ["plan", "choice"].includes(scenario) ? "pending" : "info",
            )
            if (scenario === "comparison") {
              expect(await card.getByText("My pick", { exact: true }).count()).toBe(1)
              expect(await card.getByRole("link", { name: "View morning flight" }).getAttribute("target")).toBe(
                "_blank",
              )
            }
            if (scenario === "chart") {
              expect(await card.getByRole("img", { name: /Bar chart/ }).count()).toBe(1)
              expect(await card.locator('svg text[x="36"]').allTextContents()).toEqual(["0", "5", "10"])
              expect(await card.locator("svg text").allTextContents()).toContain("Thu")
            }
            if (scenario === "chart-stacked") {
              const chart = card.getByRole("img", { name: /^Stacked bar chart \(min\)/ })
              expect(await chart.locator('text[x="36"]').allTextContents()).toEqual(["0", "5", "10"])
              expect(await chart.locator('text[font-weight="600"]').allTextContents()).toEqual(["5.8"])
              expect(await chart.locator("rect title").first().textContent()).toBe(
                "Typecheck: Mon, 2.1 min of 8.7 min total",
              )
            }
            if (scenario === "chart-fill") {
              const stacked = card.getByRole("img", { name: /^Stacked area chart/ })
              expect(await stacked.locator('text[font-weight="600"]').allTextContents()).toEqual(["2520"])
              const dense = card.getByRole("img", { name: /^Area chart \(ms\)/ })
              expect(await dense.locator("path").count()).toBe(2)
              expect(
                await dense.evaluate((svg) => svg.parentElement!.scrollWidth <= svg.parentElement!.clientWidth),
              ).toBe(true)
            }
            if (scenario === "agenda") expect(await card.locator("ol > li").count()).toBe(4)
            if (scenario === "compact") {
              const toggle = card.getByRole("button", { name: /All 6 checks passed/ })
              expect(await toggle.getAttribute("aria-expanded")).toBe("false")
              await card.screenshot({
                path: join(screenshotDir, `ui-compact-${theme}-${phone ? "phone" : "desktop"}-collapsed.png`),
              })
              await toggle.click()
              await card.getByText("Web typecheck", { exact: true }).waitFor()
              expect(await toggle.getAttribute("aria-expanded")).toBe("true")
              await card.scrollIntoViewIfNeeded()
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
            expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
            await page.screenshot({
              path: join(screenshotDir, `ui-${scenario}-${theme}-${phone ? "phone" : "desktop"}.png`),
            })
          }
          expect(errors).toEqual([])
        } finally {
          await context.close()
        }
      }, 120_000)
    }
  }

  test("choice and input go to the bot, stay answered after reload, and disable actions", async () => {
    const page = await browser.newPage()
    try {
      await page.goto(`${mock.url}/#/c/cnv_expense`)
      const card = await show(page, "choice")
      const entryId = await card.locator("xpath=..").getAttribute("data-entry")
      await card.getByRole("radio", { name: "13:30 – 14:00" }).check()
      await card.getByRole("textbox", { name: "Meeting title" }).fill("Launch review")
      await card.getByRole("button", { name: "Send choice" }).click()
      await page.locator(`[data-entry="${entryId}"] [data-card="ui"][data-status="resolved"]`).waitFor()
      await page
        .getByTestId("transcript")
        .getByText('Got "Send choice": slot = 13:30 – 14:00; title = Launch review.', { exact: true })
        .waitFor()
      await page.reload()
      const answered = page.locator(`[data-entry="${entryId}"] [data-card="ui"]`)
      await answered.getByText("Answered", { exact: true }).waitFor()
      await answered.getByText("13:30 – 14:00", { exact: true }).waitFor()
      await answered.getByText("Launch review", { exact: true }).waitFor()
      expect(await answered.getByRole("button", { name: "Send choice" }).isDisabled()).toBe(true)
      expect(await answered.getByRole("textbox").count()).toBe(0)
      expect(await answered.getByRole("radio").count()).toBe(0)
    } finally {
      await page.close()
    }
  }, 60_000)

  test("an action with no inputs sends empty values", async () => {
    const page = await browser.newPage()
    try {
      await page.goto(`${mock.url}/#/c/cnv_expense`)
      const card = await show(page, "plan")
      await card.getByRole("button", { name: "Review changes" }).click()
      await card.getByText("Answered", { exact: true }).waitFor()
      expect(await card.getByRole("button", { name: "Review changes" }).isDisabled()).toBe(true)
    } finally {
      await page.close()
    }
  }, 60_000)

  test("all twelve blocks, many choices and multiline values", async () => {
    const page = await browser.newPage()
    try {
      await page.goto(`${mock.url}/#/c/cnv_expense`)
      const card = await show(page, "everything")
      await card.getByRole("table").waitFor()
      await card.getByRole("img", { name: /Line chart/ }).waitFor()
      expect(await card.locator("img").count()).toBeGreaterThan(0)
      expect(await card.getByRole("checkbox").count()).toBe(4)
      const boxes = card.getByRole("checkbox")
      await boxes.nth(0).check()
      await boxes.nth(1).uncheck()
      const notes = card.locator("textarea")
      await notes.fill("First line\nSecond line")
      await card.getByRole("button", { name: "Ask for changes" }).click()
      await card.getByText("Answered", { exact: true }).waitFor()
      expect(await card.locator("textarea").count()).toBe(0)
      expect(await card.textContent()).toContain("First line\nSecond line")
      expect(await card.getByRole("button", { name: "Discard" }).isDisabled()).toBe(true)
    } finally {
      await page.close()
    }
  }, 60_000)

  test("live progress updates replace the same card", async () => {
    const page = await browser.newPage()
    try {
      await page.goto(`${mock.url}/#/c/cnv_expense`)
      await loaded(page)
      const rollouts = page.locator('[data-card="ui"][aria-label="Search rollout"]')
      const before = await rollouts.count()
      const card = await show(page, "progress")
      const entryId = await card.locator("xpath=..").getAttribute("data-entry")
      await card.getByText("Finished", { exact: true }).waitFor()
      expect(await rollouts.count()).toBe(before + 1)
      expect(await card.locator("xpath=..").getAttribute("data-entry")).toBe(entryId)
    } finally {
      await page.close()
    }
  }, 60_000)
})
