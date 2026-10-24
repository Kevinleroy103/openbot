import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import tailwind from "bun-plugin-tailwind"
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser, type Page } from "playwright-core"
import { chromiumPath, screenshotDir } from "./shoot.ts"
import choice from "./fixtures/ui/ui-choice.json"
import { UiCard } from "@openbot/contracts"
import { Schema } from "effect"

const enabled = existsSync(chromiumPath)

describe.skipIf(!enabled)("UI card renderer", () => {
  let work: string
  let browser: Browser
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "openbot-ui-card-"))
    const result = await Bun.build({
      entrypoints: [new URL("./ui-card-harness.html", import.meta.url).pathname],
      outdir: work,
      target: "browser",
      plugins: [tailwind],
    })
    if (!result.success) throw new AggregateError(result.logs, "UI card harness build failed")
    browser = await chromium.launch({ executablePath: chromiumPath })
    mkdirSync(screenshotDir, { recursive: true })
  }, 60_000)
  afterAll(async () => {
    await browser?.close()
    if (work) rmSync(work, { recursive: true, force: true })
  })

  async function open(fixture: string, width = 393, query = ""): Promise<Page> {
    const page = await browser.newPage({ viewport: { width, height: 852 }, deviceScaleFactor: 1 })
    page.setDefaultTimeout(10_000)
    await page.route("https://renderer.test/**", async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === "/api/attachments/att_gallery")
        return route.fulfill({
          contentType: "image/png",
          body: Buffer.from(await Bun.file(new URL("../public/apple-touch-icon.png", import.meta.url)).arrayBuffer()),
        })
      if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 404, body: "" })
      const file = Bun.file(join(work, url.pathname === "/" ? "ui-card-harness.html" : url.pathname.slice(1)))
      await route.fulfill({ contentType: file.type, body: Buffer.from(await file.arrayBuffer()) })
    })
    await page.goto(`https://renderer.test/?fixture=${fixture}${query}`)
    await page.locator('[data-card="ui"]').waitFor()
    await page.waitForFunction(() => typeof window.updateUiCard === "function")
    await page.evaluate(() => document.fonts.ready)
    return page
  }

  for (const theme of ["light", "dark"] as const) {
    test(`all blocks and unknown placeholder fit phone width in ${theme}`, async () => {
      const page = await open("everything", 393, `&theme=${theme}`)
      try {
        await page.getByText("Can't show this part", { exact: false }).waitFor()
        await page.getByRole("img", { name: /Line chart/ }).waitFor()
        await page
          .locator('[data-ui-block="chart"] svg text')
          .filter({ hasText: /^Tue$/ })
          .waitFor({ state: "detached" })
        expect(await page.locator('[data-ui-block="chart"] svg text').allTextContents()).toContain("Thu")
        expect(await page.getByRole("columnheader").count()).toBe(3)
        expect(await page.locator('input[type="checkbox"]:checked').count()).toBe(2)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({
          path: join(screenshotDir, `ui-renderer-everything-${theme}-phone.png`),
          fullPage: true,
        })
        await page.getByRole("checkbox", { name: "Chili", exact: false }).check()
        await page.getByRole("checkbox", { name: "Basil", exact: false }).uncheck()
        await page.getByRole("textbox", { name: "Notes" }).fill("First line\nSecond line")
        await page.getByRole("button", { name: "Ask for changes" }).click()
        await page.getByText("Answered", { exact: true }).waitFor()
        expect(await page.evaluate(() => window.lastUiAction)).toEqual({
          actionId: "change",
          values: { toppings: ["olives", "chili"], notes: "First line\nSecond line" },
        })
        expect(await page.getByRole("textbox").count()).toBe(0)
        expect(await page.getByRole("button", { name: "Looks good" }).isDisabled()).toBe(true)
      } finally {
        await page.close()
      }
    }, 30_000)
  }

  test("hostile content stays inert and long strings stay inside the phone", async () => {
    const page = await open("hostile")
    try {
      const outside: string[] = []
      await page.route("**/*", async (route) => {
        if (new URL(route.request().url()).origin !== "https://renderer.test") {
          outside.push(route.request().url())
          return route.abort()
        }
        await route.fallback()
      })
      await page.reload()
      await page.getByText("Missing attachment (image unavailable)", { exact: true }).waitFor()
      expect(await page.locator('a[href^="javascript:"], a[href^="data:"], a[href^="http:"]').count()).toBe(0)
      expect(await page.locator('img[src^="http"]').count()).toBe(0)
      expect(await page.locator("script:not([src]), b, i").count()).toBe(0)
      expect(await page.getByText("<script>alert(1)</script>", { exact: true }).count()).toBe(1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(outside).toEqual([])
      await page.screenshot({ path: join(screenshotDir, "ui-renderer-hostile-phone.png"), fullPage: true })
    } finally {
      await page.close()
    }
  }, 30_000)

  test("failure retains edits; a future card version renders only fallback", async () => {
    const page = await open("choice", 560, "&fail")
    try {
      await page.getByRole("textbox", { name: "Meeting title" }).fill("My edited title")
      await page.getByRole("button", { name: "Send choice" }).click()
      await page.getByRole("alert").waitFor()
      expect(await page.getByRole("textbox", { name: "Meeting title" }).inputValue()).toBe("My edited title")
      expect(await page.getByRole("button", { name: "Send choice" }).isEnabled()).toBe(true)
      await page.evaluate(() =>
        window.updateUiCard({
          type: "ui",
          version: 2,
          fallback: "Update OpenBot to use this card",
          blocks: [{ type: "input", id: "x", label: "Never shown" }],
          actions: [{ id: "x", label: "Never enabled" }],
        }),
      )
      await page.getByText("Update OpenBot to use this card", { exact: true }).waitFor()
      expect(await page.getByRole("textbox").count()).toBe(0)
      expect(await page.getByRole("button").count()).toBe(0)
    } finally {
      await page.close()
    }
  }, 30_000)

  test("live form updates reconcile edits, defaults, removed options and reused ids", async () => {
    const page = await open("choice", 393, "&fail")
    const initial = Schema.decodeUnknownSync(UiCard)(choice)
    try {
      await page.evaluate((card) => window.updateUiCard(card), {
        ...initial,
        blocks: initial.blocks.map((block) => {
          if (block.type === "input") return { ...block, default: "Updated default" }
          if (block.type === "choice") return { ...block, default: ["1330"] }
          return block
        }),
      })
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll("input")).some((input) => input.value === "Updated default"),
      )
      expect(await page.getByRole("textbox", { name: "Meeting title" }).inputValue()).toBe("Updated default")
      expect(await page.getByRole("radio", { name: "13:30 – 14:00" }).isChecked()).toBe(true)
      await page.getByRole("textbox", { name: "Meeting title" }).fill("Keep my edit")
      await page.getByRole("radio", { name: "15:00 – 15:30" }).check()
      await page.evaluate((card) => window.updateUiCard(card), {
        ...initial,
        blocks: initial.blocks.map((block) => {
          if (block.type === "choice")
            return { ...block, options: block.options.filter((option) => option.id !== "1500") }
          return block
        }),
      })
      await page.getByRole("radio", { name: "15:00 – 15:30" }).waitFor({ state: "detached" })
      expect(await page.getByRole("textbox", { name: "Meeting title" }).inputValue()).toBe("Keep my edit")
      await page.getByRole("button", { name: "Send choice" }).click()
      expect(await page.evaluate(() => window.lastUiAction?.values)).toEqual({ slot: [], title: "Keep my edit" })
      await page.evaluate((card) => window.updateUiCard(card), {
        ...initial,
        blocks: [{ type: "input", id: "new", label: "New field", default: "Fresh default" }],
      } satisfies UiCard)
      await page.getByRole("textbox", { name: "New field" }).waitFor()
      await page.getByRole("button", { name: "Send choice" }).click()
      expect(await page.evaluate(() => window.lastUiAction?.values)).toEqual({ new: "Fresh default" })
      await page.evaluate((card) => window.updateUiCard(card), initial)
      await page.getByRole("textbox", { name: "Meeting title" }).waitFor()
      expect(await page.getByRole("textbox", { name: "Meeting title" }).inputValue()).toBe("Design review")
      expect(await page.getByRole("radio", { name: "10:00 – 10:30" }).isChecked()).toBe(true)
      await page.getByRole("textbox", { name: "Meeting title" }).fill("Old text")
      await page.getByRole("radio", { name: "13:30 – 14:00" }).check()
      await page.evaluate((card) => window.updateUiCard(card), {
        ...initial,
        blocks: [
          { type: "input", id: "slot", label: "Reused slot", default: "Text default" },
          {
            type: "choice",
            id: "title",
            label: "Reused title",
            mode: "one",
            options: [{ id: "new", label: "New topic" }],
            default: ["new"],
          },
        ],
      } satisfies UiCard)
      await page.getByRole("textbox", { name: "Reused slot" }).waitFor()
      expect(await page.getByRole("textbox", { name: "Reused slot" }).inputValue()).toBe("Text default")
      expect(await page.getByRole("radio", { name: "New topic" }).isChecked()).toBe(true)
      await page.getByRole("button", { name: "Send choice" }).click()
      expect(await page.evaluate(() => window.lastUiAction?.values)).toEqual({ slot: "Text default", title: ["new"] })
    } finally {
      await page.close()
    }
  }, 30_000)

  test("a live image update retries after the previous attachment failed", async () => {
    const page = await open("choice")
    try {
      await page.evaluate(() =>
        window.updateUiCard({
          type: "ui",
          version: 1,
          fallback: "Diagram",
          blocks: [{ type: "image", attachmentId: "att_missing" as never, alt: "Diagram" }],
        }),
      )
      await page.getByText("Diagram (image unavailable)", { exact: true }).waitFor()
      await page.evaluate(() =>
        window.updateUiCard({
          type: "ui",
          version: 1,
          fallback: "Diagram",
          blocks: [{ type: "image", attachmentId: "att_gallery" as never, alt: "Diagram" }],
        }),
      )
      const image = page.getByRole("img", { name: "Diagram", exact: true })
      await image.waitFor()
      await image.evaluate((element: HTMLImageElement) => element.decode())
      expect(await image.getAttribute("src")).toBe("/api/attachments/att_gallery")
    } finally {
      await page.close()
    }
  }, 30_000)
})
