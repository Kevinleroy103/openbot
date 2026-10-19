// E2E: Slack (D3.4) against the real brain and a fake Slack (OPENBOT_SLACK_API_URL). Settings › Slack
// connects with pasted tokens and shows live messages on; a Bot's draft shows as a "Slack message"
// card that the owner edits and sends (the fake Slack receives it as the owner, mentions resolved);
// the routine editor offers a Slack trigger, and a Slack DM starts that routine. Screenshots: e2e-8x-*.png.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Bot } from "@openbot/contracts"
import type { Browser } from "playwright-core"
import { FAKE_APP_TOKEN, FAKE_USER_TOKEN, type FakeSlack, messageEnvelope, startFakeSlack } from "../../../server/test/fixtures/fakeSlack.ts"
import { type AppPage, type Brain, connectRpc, eventually, hasChromium, launchBrowser, openApp, type Rpc, send, startBrain, waitIdle } from "./brain.ts"

describe.skipIf(!hasChromium)("e2e: Slack", () => {
  let slack: FakeSlack
  let brain: Brain
  let browser: Browser
  let rpc: Rpc
  let app: AppPage
  let otto: Bot

  beforeAll(async () => {
    slack = startFakeSlack()
    brain = await startBrain({ env: { OPENBOT_SLACK_API_URL: slack.url } })
    browser = await launchBrowser()
    rpc = await connectRpc(brain)
    otto = await rpc.call((c) => c["bots.create"]({ name: "Otto", harness: { kind: "fake" }, clientNonce: "e2e-slack-otto", introduce: false }))
    app = await openApp(browser, brain, { theme: "dark", route: `#/c/${otto.directConversationId}` })
    await app.page.getByRole("textbox", { name: "Message Otto" }).waitFor()
  }, 60_000)

  afterAll(async () => {
    await app?.context.close()
    await rpc?.close()
    await browser?.close()
    await brain?.stop()
    slack?.stop()
  })

  test("Settings › Slack: paste the tokens and connect", async () => {
    const { page } = app
    await page.getByRole("button", { name: "Computers" }).click()
    await page.getByTestId("settings-nav-slack").click()
    const steps = page.getByTestId("slack-connect")
    await steps.waitFor()
    await app.shot("e2e-80-slack-connect")
    await steps.getByRole("textbox", { name: "User OAuth Token" }).fill("xoxp-wrong")
    await page.getByTestId("slack-connect-button").click()
    await steps.getByText("Slack didn't accept that User OAuth Token.").waitFor()
    await steps.getByRole("textbox", { name: "User OAuth Token" }).fill(FAKE_USER_TOKEN)
    await steps.getByRole("textbox", { name: "App-level token" }).fill(FAKE_APP_TOKEN)
    await page.getByTestId("slack-connect-button").click()
    const connected = page.getByTestId("slack-connected")
    await connected.getByText("Acme", { exact: true }).waitFor()
    await connected.getByText("As Owner · acme.slack.com").waitFor()
    await connected.getByText("On", { exact: true }).waitFor()
    await app.shot("e2e-81-slack-connected")
    expect(await rpc.call((c) => c["slack.status"]())).toMatchObject({ connected: true, team: "Acme", events: "live" })
    await page.getByRole("button", { name: "Close settings" }).click()
    expect(app.errors).toEqual([])
  }, 60_000)

  test("a Bot's draft: edit it and send it as yourself", async () => {
    const { page } = app
    await send(page, "Otto", 'tool: slack_draft {"to":"#general","text":"The deploy is fixed.","thread":"1729340000.000100"}')
    const card = page.locator('[data-card="slack-draft"]')
    await card.waitFor()
    await waitIdle(page)
    await card.getByText("Ready to send").waitFor()
    await card.getByText("Alice Smith: Can someone look at the deploy?").waitFor()
    const box = card.getByRole("textbox", { name: "Message" })
    expect(await box.inputValue()).toBe("The deploy is fixed.")
    await box.fill("The deploy is fixed, thanks @Alice Smith!")
    await card.scrollIntoViewIfNeeded()
    await app.shot("e2e-82-slack-draft")
    await card.getByRole("button", { name: "Send message" }).click()
    await card.getByText("Sent", { exact: true }).waitFor()
    await card.getByRole("link", { name: "Open in Slack" }).waitFor()
    expect(slack.posted).toEqual([{ channel: "C_GENERAL", text: "The deploy is fixed, thanks <@U_ALICE>!", thread_ts: "1729340000.000100" }])
    await app.shot("e2e-83-slack-sent")
    expect(app.errors).toEqual([])
  }, 60_000)

  test("a routine on Slack DMs runs when someone writes", async () => {
    const { page } = app
    await page.getByRole("button", { name: "View conversation details" }).click()
    const pane = page.getByTestId("details-pane")
    await pane.getByTestId("new-routine").click()
    const dialog = page.getByRole("dialog")
    await dialog.getByTestId("routine-name").fill("Slack replies")
    await dialog.getByRole("textbox", { name: "Instruction" }).fill("echo: Someone wrote on Slack")
    await dialog.getByRole("tab", { name: "Slack" }).click()
    await dialog.getByText("reads the message with your instruction", { exact: false }).waitFor()
    await app.shot("e2e-84-slack-routine")
    await dialog.getByTestId("save-routine").click()
    await dialog.waitFor({ state: "detached" })
    await pane.getByTestId("routine-row").filter({ hasText: "When someone messages you on Slack" }).waitFor()
    const [routine] = await rpc.call((c) => c["routines.list"]({ botId: otto.id }))
    expect(routine?.trigger).toEqual({ type: "slack", on: "dm" })

    slack.push(messageEnvelope({ channel: "D_ALICE", channel_type: "im", user: "U_ALICE", text: "got a minute?" }))
    const runs = await eventually(
      () => rpc.call((c) => c["routines.runs"]({ routineId: routine!.id })),
      (r) => r.length > 0 && r[0]!.status !== "running",
      { label: "a Slack-started run", timeout: 30_000 },
    )
    expect(runs[0]).toMatchObject({ firedBy: "event", status: "succeeded" })
    await page.getByTestId("transcript").getByText("Someone wrote on Slack", { exact: true }).waitFor()
    expect(app.errors).toEqual([])
  }, 60_000)
})
