// E2E: the `/skill` command in the message box (D5.5) against the real brain with the Demo (fake)
// harness: typing `/` offers the Bot's skills (an argument hint beside the one that has it), Enter
// completes it, and exactly a real command is colored; the message goes out as typed. Screenshots:
// e2e/screenshots/e2e-skills-command-*.png.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Browser } from "playwright-core"
import type { Bot, SkillName } from "@openbot/contracts"
import {
  type AppPage,
  type Brain,
  connectRpc,
  hasChromium,
  launchBrowser,
  openApp,
  type Rpc,
  startBrain,
} from "./brain.ts"

describe.skipIf(!hasChromium)("e2e: /skill command", () => {
  let brain: Brain
  let browser: Browser
  let rpc: Rpc
  let nova: Bot
  let app: AppPage

  beforeAll(async () => {
    brain = await startBrain()
    browser = await launchBrowser()
    rpc = await connectRpc(brain)
    nova = await rpc.call((c) =>
      c["bots.create"]({ name: "Nova", harness: { kind: "fake" }, clientNonce: "e2e-skills-nova", introduce: false }),
    )
    const name = (n: string) => n as SkillName
    await rpc.call((c) =>
      c["skills.upsert"]({
        name: name("grill-me"),
        description: "A relentless interview to sharpen a plan.",
        body: "Ask hard questions.",
        disableModelInvocation: true,
      }),
    )
    await rpc.call((c) =>
      c["skills.upsert"]({ name: name("weekly-report"), description: "The Friday status report.", body: "Collect." }),
    )
    await rpc.call((c) => c["skills.assign"]({ name: name("grill-me"), botIds: [nova.id] }))
    await rpc.call((c) => c["skills.assign"]({ name: name("weekly-report"), botIds: [nova.id] }))
    app = await openApp(browser, brain, { theme: "dark", route: `#/c/${nova.directConversationId}` })
  }, 60_000)

  afterAll(async () => {
    await app?.context.close()
    await rpc?.close()
    await browser?.close()
    await brain?.stop()
  })

  test("typing / offers the Bot's skills, filters them and completes one", async () => {
    const box = app.page.getByRole("textbox", { name: "Message Nova" })
    await box.click()
    await box.pressSequentially("/")
    const menu = app.page.getByRole("menu", { name: "Use a skill" })
    await menu.getByText("/grill-me").waitFor()
    await menu.getByText("/weekly-report").waitFor()
    await app.shot("e2e-skills-command-1-menu")
    await box.pressSequentially("gri")
    await menu.getByText("/grill-me").waitFor()
    expect(await menu.getByText("/weekly-report").count()).toBe(0)
    await box.press("Enter")
    expect(await box.inputValue()).toBe("/grill-me ")
    await app.page.getByTestId("composer-command").waitFor()
  })

  test("a real command is colored, text after it is not; an unknown one is plain", async () => {
    const { page } = app
    const box = page.getByRole("textbox", { name: "Message Nova" })
    await box.pressSequentially("my launch plan")
    const colored = page.getByTestId("composer-command")
    expect(await colored.locator("span").first().textContent()).toBe("/grill-me")
    // the colored layer sits exactly over the textarea
    const [layer, field] = await Promise.all([colored.boundingBox(), box.boundingBox()])
    expect(Math.abs(layer!.x - field!.x)).toBeLessThan(1)
    expect(Math.abs(layer!.y - field!.y)).toBeLessThan(1)
    expect(Math.abs(layer!.width - field!.width)).toBeLessThan(1)
    await app.shot("e2e-skills-command-2-colored")

    await box.fill("/not-a-skill my launch plan")
    expect(await page.getByTestId("composer-command").count()).toBe(0)
    await box.fill("please /grill-me")
    expect(await page.getByTestId("composer-command").count()).toBe(0)
  })

  test("the message goes out as typed", async () => {
    const { page } = app
    const box = page.getByRole("textbox", { name: "Message Nova" })
    await box.fill("/grill-me my launch plan")
    await box.press("Enter")
    await page.getByTestId("transcript").getByText("/grill-me my launch plan").waitFor()
    expect(await box.inputValue()).toBe("")
    expect(app.errors).toEqual([])
  })

  test("moving within a command completes the whole token and keeps the arguments", async () => {
    const { page } = app
    const box = page.getByRole("textbox", { name: "Message Nova" })
    const menu = page.getByRole("menu", { name: "Use a skill" })
    await box.fill("/gri")
    await box.press("ArrowLeft")
    await box.press("Tab")
    expect(await box.inputValue()).toBe("/grill-me ")

    await box.fill("/gri my launch plan")
    expect(await menu.count()).toBe(0)
    await box.press("Home")
    await box.press("ArrowRight")
    await box.press("ArrowRight")
    await menu.getByText("/grill-me").waitFor()
    await menu.getByText("/grill-me").click()
    expect(await box.inputValue()).toBe("/grill-me my launch plan")
    expect(await box.evaluate((t: HTMLTextAreaElement) => t.selectionStart)).toBe("/grill-me ".length)
  })

  test("Home dismisses the picker so Enter sends the unchanged input", async () => {
    const { page } = app
    const box = page.getByRole("textbox", { name: "Message Nova" })
    await box.fill("/gri")
    await page.getByRole("menu", { name: "Use a skill" }).waitFor()
    await box.press("Home")
    expect(await page.getByRole("menu", { name: "Use a skill" }).count()).toBe(0)
    await box.press("Enter")
    await page.getByTestId("transcript").getByText("/gri", { exact: true }).waitFor()
    expect(await box.inputValue()).toBe("")
  })

  test("a selection dismisses the picker and collapsing it updates the query", async () => {
    const { page } = app
    const box = page.getByRole("textbox", { name: "Message Nova" })
    const menu = page.getByRole("menu", { name: "Use a skill" })
    await box.fill("/gri")
    await box.press("Shift+Home")
    expect(await menu.count()).toBe(0)
    await box.press("ArrowRight")
    await menu.getByText("/grill-me").waitFor()
    await box.press("Home")
    await box.press("ArrowRight")
    await menu.getByText("/weekly-report").waitFor()
    await box.press("ArrowDown")
    await box.press("Tab")
    expect(await box.inputValue()).toBe("/weekly-report ")
  })

  test("IME keys neither complete a skill nor send the message", async () => {
    const { page } = app
    const box = page.getByRole("textbox", { name: "Message Nova" })
    await box.fill("/gri")
    await box.dispatchEvent("compositionstart")
    const accepted = await box.evaluate((t) =>
      t.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }),
      ),
    )
    expect(accepted).toBe(true)
    expect(await box.inputValue()).toBe("/gri")
    await page.getByRole("menu", { name: "Use a skill" }).waitFor()
    await box.dispatchEvent("compositionend")
    await box.press("Enter")
    expect(await box.inputValue()).toBe("/grill-me ")
    await box.dispatchEvent("compositionstart")
    await box.dispatchEvent("keydown", { key: "Enter", isComposing: true })
    expect(await box.inputValue()).toBe("/grill-me ")
    await box.dispatchEvent("compositionend")
  })

  test("leading whitespace supports completion and command highlighting", async () => {
    const { page } = app
    const box = page.getByRole("textbox", { name: "Message Nova" })
    for (const whitespace of ["  ", "\t", "\n", "\u00a0"]) {
      await box.fill(`${whitespace}/gri`)
      await page.getByRole("menu", { name: "Use a skill" }).getByText("/grill-me").waitFor()
      await box.press("Tab")
      expect(await box.inputValue()).toBe(`${whitespace}/grill-me `)
      await page.getByTestId("composer-command").waitFor()
      expect(await page.getByTestId("composer-command").textContent()).toBe(`${whitespace}/grill-me `)
    }
    expect(app.errors).toEqual([])
  })

  test("completion spans the composer and keeps skill names whole at desktop and phone widths", async () => {
    const skills = [
      {
        name: "engineering-practices" as SkillName,
        description:
          "Use for engineering work: writing or changing code, tests or config, answering review feedback, and before handing work off or pushing.",
      },
      {
        name: "vercel-composition-patterns" as SkillName,
        description:
          "React composition patterns that scale. Use when refactoring components, designing reusable APIs, or building flexible component libraries.",
      },
    ]
    for (const skill of skills) {
      await rpc.call((c) => c["skills.upsert"]({ ...skill, body: "Review the code." }))
      await rpc.call((c) => c["skills.assign"]({ name: skill.name, botIds: [nova.id] }))
    }
    for (const width of [1440, 393, 320]) {
      for (const theme of ["light", "dark"] as const) {
        const layout = await openApp(browser, brain, {
          theme,
          route: `#/c/${nova.directConversationId}`,
          context: { viewport: { width, height: 900 }, isMobile: width < 600, hasTouch: width < 600 },
        })
        try {
          const { page } = layout
          const box = page.getByRole("textbox", { name: "Message Nova" })
          await box.fill("/")
          const menu = page.getByRole("menu", { name: "Use a skill" })
          await menu.getByText(`/${skills[1]!.name}`, { exact: true }).waitFor()
          const [panel, composer, actions] = await Promise.all([
            menu.boundingBox(),
            page.getByTestId("composer").boundingBox(),
            page.getByRole("button", { name: "Composer actions" }).boundingBox(),
          ])
          const left = width < 600 ? actions!.x : composer!.x
          expect(Math.abs(panel!.x - left)).toBeLessThanOrEqual(1)
          expect(Math.abs(panel!.x + panel!.width - composer!.x - composer!.width)).toBeLessThanOrEqual(1)
          for (const skill of skills) {
            const name = menu.getByText(`/${skill.name}`, { exact: true })
            const description = menu.getByText(skill.description, { exact: true })
            expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
            expect(await description.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
            expect(await description.evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis")
            const [label, detail] = await Promise.all([name.boundingBox(), description.boundingBox()])
            expect(label!.x + label!.width).toBeLessThanOrEqual(detail!.x)
            expect(detail!.x + detail!.width).toBeLessThan(panel!.x + panel!.width)
          }
          expect(await menu.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
          expect(await page.locator("html").getAttribute("data-theme")).toBe(theme)
          expect(layout.errors).toEqual([])
          await layout.shot(`e2e-skills-command-width-${width}-${theme}`)
        } finally {
          await layout.context.close()
        }
      }
    }
  }, 60_000)
})
