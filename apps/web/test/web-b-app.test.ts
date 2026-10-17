// W2.3 acceptance inside the real app (W2.2's shell + the dev mock): open a bot's details from the
// chat header, edit its instructions, open Settings › Computers and create a pairing code, and open
// the computer view. Screenshots: test/screenshots/web-b-app-*.png. Skipped without Chromium.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { type Browser, chromium } from "playwright-core"
import { startWebBMock, type WebBMock } from "./web-b-mock.ts"

const chromiumPath = process.env.OPENBOT_CHROMIUM ?? "/usr/bin/chromium"
const shots = new URL("./screenshots", import.meta.url).pathname
const enabled = existsSync(chromiumPath)

let mock: WebBMock | undefined
let browser: Browser | undefined

beforeAll(async () => {
  if (!enabled) return
  mock = await startWebBMock()
  browser = await chromium.launch({ executablePath: chromiumPath })
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await mock?.stop()
})

for (const theme of ["dark", "light"] as const) {
  test.skipIf(!enabled)(
    `details, instructions, settings › computers pairing and computer view in the app (${theme})`,
    async () => {
      const errors: string[] = []
      const page = await browser!.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme })
      page.on("pageerror", (e) => errors.push(e.message))
      await page.addInitScript((t) => localStorage.setItem("openbot.theme", t), theme)
      await page.goto(mock!.url)
      // open a bot's direct chat from the sidebar, then its details from the header pill
      await page.getByText("Chief of Staff", { exact: true }).first().click({ timeout: 20_000 })
      await page.getByRole("button", { name: "View conversation details" }).click()
      const pane = page.getByTestId("details-pane")
      await pane.getByTestId("bot-name").waitFor({ timeout: 15_000 })

      await pane.getByTestId("edit-instructions").click()
      const text = `Answer in two lines at most (${theme}).`
      await pane.getByTestId("instructions-input").fill(text)
      await pane.getByTestId("save-instructions").click()
      await pane.getByTestId("instructions-text").getByText(text).waitFor({ timeout: 10_000 })
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(shots, `web-b-app-details-${theme}.png`) })

      // computer tab → full-screen view (the mock has no screen: empty state)
      await pane.getByRole("tab", { name: "Computer" }).click()
      await pane.getByTestId("screen-thumbnail").click()
      await page.getByTestId("computer-view").waitFor({ timeout: 10_000 })
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(shots, `web-b-app-computer-${theme}.png`) })
      await page.getByRole("button", { name: "Exit fullscreen" }).click()
      await page.getByTestId("computer-view").waitFor({ state: "detached" })

      // Settings › Computers → Pair a computer
      await page.keyboard.press("Control+Comma")
      await page.getByTestId("settings-dialog").waitFor({ timeout: 10_000 })
      await page.getByTestId("settings-nav-computers").click()
      await page.getByTestId("pair-computer").click()
      const code = page.getByTestId("pairing-code")
      await code.waitFor()
      let shown = ""
      for (let i = 0; i < 50 && shown.length < 8; i++) {
        shown = (await code.innerText()).replace(/[^A-Za-z0-9]/g, "")
        if (shown.length < 8) await Bun.sleep(100)
      }
      expect(shown.length).toBeGreaterThanOrEqual(8)
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(shots, `web-b-app-pairing-${theme}.png`) })
      expect(errors).toEqual([])
      await page.close()
    },
    60_000,
  )
}
