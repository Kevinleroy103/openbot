// E2E (W3.1): the details pane against the real brain: memory (`tool: remember` → the fact shows
// up live), routines (create in the pane → Run now → a run is recorded and posts into the DM),
// and attachments (upload → served at the upload url → the bot sees them). Fake harness only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Browser } from "playwright-core"
import type { BotId, ConversationId } from "@openbot/contracts"
import { type AppPage, type Brain, connectRpc, createBotViaUi, eventually, hasChromium, launchBrowser, openApp, type Rpc, send, startBrain, waitIdle } from "./brain.ts"

describe.skipIf(!hasChromium)("e2e: details pane, routines, memory, attachments", () => {
  let brain: Brain
  let browser: Browser
  let rpc: Rpc
  let app: AppPage
  let botId: BotId
  let convId: ConversationId
  const BOT = "Mira"

  beforeAll(async () => {
    brain = await startBrain()
    browser = await launchBrowser()
    rpc = await connectRpc(brain)
    // a first bot so the app skips onboarding; Mira is created in the UI
    await rpc.call((c) => c["bots.create"]({ name: "Helper", harness: { kind: "fake" }, clientNonce: "e2e-helper" }))
    app = await openApp(browser, brain, { theme: "dark" })
    await app.page.getByRole("textbox", { name: "Message Helper" }).waitFor()
    await createBotViaUi(app.page, BOT)
    convId = decodeURIComponent(/#\/c\/([^/?#]+)/.exec(app.page.url())![1]!) as ConversationId
    botId = ((await rpc.conversation(convId)).conversation as { botId: BotId }).botId
  }, 60_000)

  afterAll(async () => {
    await app?.context.close()
    await rpc?.close()
    await browser?.close()
    await brain?.stop()
  })

  test("memory: tool:remember shows the fact in the open details pane", async () => {
    const { page } = app
    await page.getByRole("button", { name: "View conversation details" }).click()
    const pane = page.getByTestId("details-pane")
    await pane.waitFor()
    await pane.getByText("Nothing remembered yet", { exact: false }).waitFor()
    await send(page, BOT, 'tool: remember {"title": "Prefers green tea", "body": "The owner drinks green tea every morning."}')
    await page.getByTestId("transcript").getByText("I called remember", { exact: false }).waitFor()
    await waitIdle(page)
    await pane.getByTestId("memory-fact").filter({ hasText: "Prefers green tea" }).waitFor()
    const memory = await rpc.call((c) => c["memory.get"]({ botId }))
    expect(memory.facts.map((f) => f.title)).toContain("Prefers green tea")
    await pane.getByTestId("memory-fact").filter({ hasText: "Prefers green tea" }).scrollIntoViewIfNeeded()
    await app.shot("e2e-30-memory")
    expect(app.errors).toEqual([])
  }, 60_000)

  test("routines: create in the details pane, Run now → a run is recorded and posts into the DM", async () => {
    const { page } = app
    const pane = page.getByTestId("details-pane")
    await pane.getByTestId("new-routine").click()
    const dialog = page.getByRole("dialog")
    await dialog.getByTestId("routine-name").fill("Morning briefing")
    await dialog.getByRole("textbox", { name: "Instruction" }).fill("echo: Briefing: all quiet overnight")
    await app.shot("e2e-31-routine-dialog")
    await dialog.getByTestId("save-routine").click()
    await dialog.waitFor({ state: "detached" })
    const row = pane.getByTestId("routine-row").filter({ hasText: "Morning briefing" })
    await row.waitFor()
    await row.hover()
    await row.getByRole("button", { name: "Routine actions" }).click()
    await page.getByRole("menuitem", { name: "Run now" }).click()
    await page.getByTestId("transcript").getByText("Briefing: all quiet overnight", { exact: true }).waitFor()
    await waitIdle(page)
    const [routine] = await rpc.call((c) => c["routines.list"]({ botId }))
    expect(routine?.name).toBe("Morning briefing")
    const runs = await eventually(() => rpc.call((c) => c["routines.runs"]({ routineId: routine!.id })), (r) => r.length > 0 && r[0]!.status !== "running", { label: "a finished run" })
    expect(runs[0]!.status).toBe("succeeded")
    expect(runs[0]!.firedBy).toBe("manual")
    // the run shows in the routine's history
    await row.getByRole("button", { name: /Morning briefing/ }).click()
    const editor = page.getByRole("dialog")
    await editor.getByText("Last runs").waitFor()
    await editor.getByLabel("Done").first().waitFor()
    await app.shot("e2e-32-routine-runs")
    await editor.getByRole("button", { name: "Cancel" }).click()
    await editor.waitFor({ state: "detached" })
    await app.shot("e2e-33-routine-dm")
    expect(app.errors).toEqual([])
  }, 60_000)

  test("attachments: upload, served at the upload url, the bot sees them", async () => {
    const { page } = app
    await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("launch notes for the e2e suite") })
    await page.getByRole("button", { name: "Remove notes.txt" }).waitFor()
    await send(page, BOT, "Here are my notes")
    const transcript = page.getByTestId("transcript")
    const link = transcript.getByRole("link", { name: "notes.txt" })
    await link.waitFor()
    await transcript.getByText("I received 1 attachment: notes.txt", { exact: false }).waitFor()
    await waitIdle(page)
    const href = await link.getAttribute("href")
    expect(href).toBeTruthy()
    // served to the logged-in browser
    const body = await page.evaluate(async (url) => (await fetch(url!)).text(), href)
    expect(body).toBe("launch notes for the e2e suite")
    // and not to anyone else
    const anon = await fetch(new URL(href!, brain.base))
    expect(anon.status).toBeGreaterThanOrEqual(400)
    await app.shot("e2e-34-attachment")
    expect(app.errors).toEqual([])
  }, 60_000)
})
