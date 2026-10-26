import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { chromium, type Browser } from "playwright-core"
import { chromiumPath, startMock, type RunningMock } from "./shoot.ts"
import { longPress } from "./shoot-mobile.ts"

const enabled = existsSync(chromiumPath)
let mock: RunningMock
let browser: Browser

beforeAll(async () => {
  if (!enabled) return
  mock = await startMock()
  browser = await chromium.launch({ executablePath: chromiumPath })
}, 30_000)

afterAll(async () => {
  await browser?.close()
  await mock?.stop()
})

for (const action of [
  "reaction",
  "reaction chip",
  "reaction sheet",
  "stop",
  "hide",
  "theme",
  "palette theme",
  "palette steps",
] as const) {
  test.skipIf(!enabled)(
    `a rejected ${action} shows its RPC error`,
    async () => {
      const phone = action === "reaction sheet"
      const context = await browser.newContext({
        viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
        hasTouch: phone,
        isMobile: phone,
      })
      try {
        const page = await context.newPage()
        let tag = "messages.react"
        if (action === "stop") tag = "turns.interrupt"
        if (action === "hide") tag = "conversations.setHidden"
        if (action === "theme" || action.startsWith("palette")) tag = "settings.update"
        const errorText = `${action} was refused`
        await page.routeWebSocket("**/rpc", (socket) => {
          const server = socket.connectToServer()
          socket.onMessage((message) => {
            const request = JSON.parse(String(message))
            if (request["_tag"] !== "Request" || request.tag !== tag) {
              server.send(message)
              return
            }
            socket.send(
              JSON.stringify({
                _tag: "Exit",
                requestId: request.id,
                exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "Internal", message: errorText } }] },
              }),
            )
          })
        })
        await page.goto(`${mock.url}/#/c/cnv_chief`)
        const transcript = page.getByTestId("transcript")
        await transcript.getByText("Booked: marina house", { exact: false }).waitFor()
        if (action === "reaction") {
          const message = page.locator(".ob-msg[data-entry]", { hasText: "Booked: marina house" }).first()
          await message.hover()
          await message.getByRole("button", { name: "React", exact: true }).click()
          await page.getByRole("button", { name: "🎉", exact: true }).click()
        } else if (action === "reaction chip") {
          await page.getByTestId("reaction").first().click()
        } else if (action === "reaction sheet") {
          await longPress(
            page,
            transcript.locator("[data-side]").filter({ hasText: "Booked: marina house" }).first(),
            700,
            page.getByTestId("message-sheet"),
          )
          await page.getByTestId("message-sheet").getByRole("button", { name: "React 🎉", exact: true }).click()
        } else if (action === "stop") {
          const box = page.getByRole("textbox", { name: "Message Chief of Staff" })
          await box.fill("Check the latest status")
          await box.press("Enter")
          await page.getByRole("button", { name: "Stop", exact: true }).click()
        } else if (action === "theme") {
          await page.getByRole("button", { name: "Account", exact: true }).click()
          await page.getByRole("menuitemradio", { name: "Light", exact: true }).click()
        } else if (action.startsWith("palette")) {
          await page.keyboard.press("Control+k")
          await page.getByRole("combobox").fill(action === "palette theme" ? "Switch to" : "steps")
          await page
            .getByRole("option", { name: action === "palette theme" ? /Switch to .* theme/ : /steps under replies/ })
            .click()
        } else {
          await page.locator('[data-row="cnv_launch"]').click({ button: "right" })
          await page.getByRole("menuitem", { name: "Hide from sidebar" }).click()
        }
        await page.getByText(errorText, { exact: true }).waitFor()
        expect(await page.getByText(errorText, { exact: true }).isVisible()).toBe(true)
      } finally {
        await context.close()
      }
    },
    30_000,
  )
}
