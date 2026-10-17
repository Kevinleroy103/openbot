// E2E (W3.1): a group chat with 3 Demo bots (plain message → the lead answers; @mention routing;
// @everyone; message_bot between members stays in the group; approval cards in the group) and
// bot-to-bot `message_bot` from DMs (the recipient's DM gets the message and replies; the sender
// shows a "Messaged X" event line). Real brain, fake harness only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Browser, Locator } from "playwright-core"
import type { Bot, BotId, ConversationId, TranscriptEntry } from "@openbot/contracts"
import { type AppPage, type Brain, connectRpc, eventually, hasChromium, launchBrowser, openApp, type Rpc, startBrain, waitIdle } from "./brain.ts"

/** The exchange dialog's highlighted message(s), and whether the first is inside the scrolled view. */
const exchangeTarget = (dialog: Locator) =>
  dialog.getByTestId("exchange").evaluate((list) => {
    const view = list.parentElement!
    const box = view.getBoundingClientRect()
    const marked = [...list.querySelectorAll<HTMLElement>("[data-exchange-item][data-target]")]
    const first = marked[0]?.getBoundingClientRect()
    return {
      texts: marked.map((m) => m.innerText),
      inView: first !== undefined && first.top >= box.top && first.bottom <= box.bottom,
      scrollTop: view.scrollTop,
      scrollable: view.scrollHeight > view.clientHeight,
    }
  })

const botReplies = (entries: Iterable<TranscriptEntry>, after: string) => {
  const list = [...entries]
  const start = list.findIndex((e) => e.kind === "message" && e.role === "user" && e.text === after)
  return list.slice(start + 1).flatMap((e) => (e.kind === "message" && e.author.kind === "bot" ? [{ botId: e.author.botId, text: e.text }] : []))
}

describe.skipIf(!hasChromium)("e2e: group chat and bot-to-bot", () => {
  let brain: Brain
  let browser: Browser
  let rpc: Rpc
  let app: AppPage
  const bots: Record<string, Bot> = {}
  let groupId: ConversationId
  const GROUP = "Alpha, Bravo & Charlie"

  beforeAll(async () => {
    brain = await startBrain()
    browser = await launchBrowser()
    rpc = await connectRpc(brain)
    for (const name of ["Alpha", "Bravo", "Charlie"]) {
      bots[name] = await rpc.call((c) => c["bots.create"]({ name, harness: { kind: "fake" }, clientNonce: `e2e-${name}` }))
    }
    app = await openApp(browser, brain, { theme: "light", route: `#/c/${bots["Alpha"]!.directConversationId}` })
  }, 60_000)

  afterAll(async () => {
    await app?.context.close()
    await rpc?.close()
    await browser?.close()
    await brain?.stop()
  })

  test("create a group of 3 in the UI; a plain message goes to the lead", async () => {
    const { page } = app
    await page.getByRole("textbox", { name: "Message Alpha" }).waitFor()
    await page.keyboard.press("Control+n")
    await page.getByRole("option", { name: "Create group chat" }).click()
    const form = page.getByTestId("new-group-form")
    await form.waitFor()
    for (const name of ["Alpha", "Bravo", "Charlie"]) await form.getByTestId("group-candidate").filter({ hasText: name }).click()
    await app.shot("e2e-20-new-group")
    await form.getByTestId("create-group").click()
    const box = page.getByRole("textbox", { name: `Message ${GROUP}` })
    await box.waitFor()
    groupId = decodeURIComponent(/#\/c\/([^/?#]+)/.exec(page.url())![1]!) as ConversationId
    const conv = await rpc.conversation(groupId)
    expect(conv.conversation?.kind).toBe("group")

    await box.fill("echo: hello team")
    await box.press("Enter")
    await page.getByTestId("transcript").getByText("hello team", { exact: true }).waitFor()
    await waitIdle(page)
    const state = await eventually(() => rpc.conversation(groupId), (s) => botReplies(s.entries.values(), "echo: hello team").length > 0)
    const lead = (state.conversation as { leadBotId?: BotId }).leadBotId ?? bots["Alpha"]!.id
    expect(botReplies(state.entries.values(), "echo: hello team")).toEqual([{ botId: lead, text: "hello team" }])
    await app.shot("e2e-21-group-lead")
    expect(app.errors).toEqual([])
  }, 60_000)

  test("@mention routes to the mentioned bot only", async () => {
    const { page } = app
    const box = page.getByRole("textbox", { name: `Message ${GROUP}` })
    await box.click()
    await box.pressSequentially("@Bra", { delay: 15 })
    await page.getByRole("menu", { name: "Mention a Bot" }).waitFor()
    await app.shot("e2e-22-group-mention-picker")
    await box.press("Enter")
    await box.pressSequentially("echo: bravo here", { delay: 5 })
    expect(await box.inputValue()).toBe("@Bravo echo: bravo here")
    await box.press("Enter")
    await page.getByTestId("transcript").getByText("bravo here", { exact: true }).waitFor()
    await waitIdle(page)
    const state = await rpc.conversation(groupId)
    expect(botReplies(state.entries.values(), "@Bravo echo: bravo here")).toEqual([{ botId: bots["Bravo"]!.id, text: "bravo here" }])
    expect(app.errors).toEqual([])
  }, 60_000)

  test("@everyone reaches every member", async () => {
    const { page } = app
    const box = page.getByRole("textbox", { name: `Message ${GROUP}` })
    await box.fill("@everyone echo: roll call")
    await box.press("Enter")
    const state = await eventually(
      () => rpc.conversation(groupId),
      (s) => botReplies(s.entries.values(), "@everyone echo: roll call").length >= 3 && [...s.turns.values()].every((t) => t.status !== "running" && t.status !== "queued"),
      { label: "three replies" },
    )
    const replies = botReplies(state.entries.values(), "@everyone echo: roll call")
    expect(new Set(replies.map((r) => r.botId))).toEqual(new Set(["Alpha", "Bravo", "Charlie"].map((n) => bots[n]!.id)))
    expect(replies.every((r) => r.text === "roll call")).toBe(true)
    await waitIdle(page)
    await app.shot("e2e-23-group-everyone")
    expect(app.errors).toEqual([])
  }, 60_000)

  test("in the group: message_bot to a member stays in the group and is answered there (no DM side channel)", async () => {
    const { page } = app
    const bravo = bots["Bravo"]!
    const box = page.getByRole("textbox", { name: `Message ${GROUP}` })
    const text = `@Alpha tool: message_bot ${JSON.stringify({ to: "Bravo", text: "echo: on it, in the group", urgency: "urgent" })}`
    await box.fill(text)
    await box.press("Enter")
    const transcript = page.getByTestId("transcript")
    // Alpha's reply does not @mention Bravo, so the noted message_bot text is posted on its own (once)
    await transcript.getByText("echo: on it, in the group", { exact: false }).first().waitFor({ timeout: 20_000 })
    const state = await eventually(
      () => rpc.conversation(groupId),
      (s) => botReplies(s.entries.values(), text).some((r) => r.botId === bravo.id && r.text === "on it, in the group"),
      { label: "Bravo answers in the group", timeout: 20_000 },
    )
    expect(botReplies(state.entries.values(), text).some((r) => r.botId === bots["Alpha"]!.id && r.text.startsWith("@Bravo"))).toBe(true)
    await waitIdle(page)
    const dm = await rpc.conversation(bravo.directConversationId)
    expect([...dm.entries.values()].some((e) => e.kind === "message" && e.text.includes("on it, in the group"))).toBe(false)
    await app.shot("e2e-23b-group-message-bot")
    expect(app.errors).toEqual([])
  }, 60_000)

  test("in the group: an approval card shows in the group and is answered there", async () => {
    const { page } = app
    const charlie = bots["Charlie"]!
    await rpc.call((c) => c["bots.update"]({ botId: charlie.id, patch: { autonomy: "ask" } }))
    const box = page.getByRole("textbox", { name: `Message ${GROUP}` })
    await box.fill("@Charlie approve: deploy the site")
    await box.press("Enter")
    const card = page.getByTestId("transcript").locator('[data-card="approval"][data-status="pending"]')
    await card.waitFor({ timeout: 20_000 })
    const [request] = await rpc.call((c) => c["requests.listPending"]({ conversationId: groupId }))
    expect(request?.conversationId).toBe(groupId)
    expect(await rpc.call((c) => c["requests.listPending"]({ conversationId: charlie.directConversationId }))).toHaveLength(0)
    await app.shot("e2e-23c-group-approval")
    await card.getByRole("button", { name: "Allow once" }).click()
    await page.getByTestId("transcript").locator('[data-card="approval"][data-status="resolved"]').getByText("Allowed once").waitFor()
    await eventually(
      () => rpc.conversation(groupId),
      (s) => botReplies(s.entries.values(), "@Charlie approve: deploy the site").some((r) => r.botId === charlie.id && r.text.includes("Approved (allow-once)")),
      { label: "Charlie continues in the group", timeout: 20_000 },
    )
    await waitIdle(page)
    expect(app.errors).toEqual([])
  }, 60_000)

  test("bot-to-bot: collapsed 'N messages with' lines, 'Messaged' lines, and the exchange dialog", async () => {
    const { page } = app
    const alpha = bots["Alpha"]!
    const bravo = bots["Bravo"]!
    await page.locator(`[data-row="${alpha.id}"]`).click()
    const box = page.getByRole("textbox", { name: "Message Alpha" })
    await box.waitFor()
    // Alpha → Bravo; Bravo's script messages Alpha back; Alpha echoes it
    const back = JSON.stringify({ to: "Alpha", text: "echo: Thanks back, Alpha" })
    await box.fill(`tool: message_bot ${JSON.stringify({ to: "Bravo", text: `tool: message_bot ${back}`, urgency: "urgent" })}`)
    await box.press("Enter")
    const transcript = page.getByTestId("transcript")
    await transcript.getByText("Messaged", { exact: false }).first().waitFor()
    // Bravo's message arrives in Alpha's chat as ONE collapsed line, then Alpha's own reply bubble
    const line = transcript.locator(`button[data-exchange="${bravo.id}"]`).filter({ hasText: "message with" })
    await line.waitFor({ timeout: 20_000 })
    await transcript.getByText("Thanks back, Alpha", { exact: true }).waitFor({ timeout: 20_000 })
    await waitIdle(page)
    expect(await line.innerText()).toMatch(/1 message with\s*Bravo/)
    expect(await transcript.locator(`[data-side="bot"]`).filter({ hasText: "echo: Thanks back" }).count()).toBe(0)
    // Alpha's reply in its own DM is for the owner: no "to @Bravo" label
    expect(await transcript.getByTestId("addressee-chip").count()).toBe(0)
    await app.shot("e2e-24-b2b-sender-light")

    // the exchange: both directions, in order
    await line.click()
    const dialog = page.getByRole("dialog", { name: "Alpha and Bravo" })
    const items = dialog.locator("[data-exchange-item]")
    await eventually(() => items.count(), (n) => n === 2, { label: "two messages in the exchange" })
    expect(await items.nth(0).innerText()).toContain("Alpha")
    expect(await items.nth(0).innerText()).toContain("tool: message_bot")
    expect(await items.nth(1).innerText()).toContain("echo: Thanks back, Alpha")
    // it opens at the clicked line's message (Bravo's), lit up
    await dialog.locator("[data-exchange-item][data-target]").waitFor()
    expect((await exchangeTarget(dialog)).texts).toEqual([expect.stringContaining("echo: Thanks back, Alpha")])
    await app.shot("e2e-25-b2b-exchange-light")
    await dialog.getByRole("button", { name: "Open Bravo's chat" }).click()
    await dialog.waitFor({ state: "detached" })
    await page.getByRole("textbox", { name: "Message Bravo" }).waitFor()

    // Bravo's chat: Alpha's message is a collapsed line too; the "Messaged Alpha" line opens the same view
    const bravoTranscript = page.getByTestId("transcript")
    const fromAlpha = bravoTranscript.locator(`button[data-exchange="${alpha.id}"]`).filter({ hasText: "message with" })
    await fromAlpha.waitFor()
    await bravoTranscript.locator(`[data-exchange="${alpha.id}"]`).filter({ hasText: "Alpha" }).last().click()
    const fromBravo = page.getByRole("dialog", { name: "Bravo and Alpha" })
    await fromBravo.locator("[data-exchange-item][data-target]").waitFor()
    // "Messaged Alpha" stands for the message it delivered
    expect((await exchangeTarget(fromBravo)).texts).toEqual([expect.stringContaining("echo: Thanks back, Alpha")])
    await page.keyboard.press("Escape")
    await app.shot("e2e-26-b2b-recipient-light")

    // a longer exchange: the dialog opens scrolled to the clicked line's message, not at the top
    await page.locator(`[data-row="${alpha.id}"]`).click()
    await box.waitFor()
    const NOTES = 14
    const notes = Array.from({ length: NOTES }, (_, i) =>
      `tool: message_bot ${JSON.stringify({ to: "Bravo", text: `Note ${i + 1} of ${NOTES} for the exchange view`, urgency: "background" })}`)
    await box.fill(notes.join("\n"))
    await box.press("Enter")
    const messaged = transcript.locator(`[data-exchange="${bravo.id}"]`).filter({ hasNotText: "message with" })
    await eventually(() => messaged.count(), (n) => n === NOTES + 1, { label: "a Messaged line per note", timeout: 30_000 })
    await waitIdle(page, 30_000)
    for (const note of [NOTES, 3]) {
      await messaged.nth(note).click()
      const long = page.getByRole("dialog", { name: "Alpha and Bravo" })
      await long.locator("[data-exchange-item][data-target]").waitFor()
      const opened = await exchangeTarget(long)
      expect(opened.texts).toEqual([expect.stringContaining(`Note ${note} of ${NOTES}`)])
      expect(opened.scrollable).toBe(true)
      expect(opened.inView).toBe(true)
      expect(opened.scrollTop).toBeGreaterThan(0)
      if (note === NOTES) await app.shot("e2e-26b-b2b-exchange-long-light")
      await page.keyboard.press("Escape")
      await long.waitFor({ state: "detached" })
    }

    // dark theme: a second page on the same brain
    const dark = await openApp(browser, brain, { theme: "dark", route: `#/c/${alpha.directConversationId}` })
    const darkLine = dark.page.getByTestId("transcript").locator(`button[data-exchange="${bravo.id}"]`).filter({ hasText: "message with" })
    await darkLine.waitFor()
    await dark.shot("e2e-24-b2b-sender-dark")
    await darkLine.click()
    await dark.page.getByRole("dialog", { name: "Alpha and Bravo" }).locator("[data-exchange-item]").nth(1).waitFor()
    await dark.shot("e2e-25-b2b-exchange-dark")
    expect(dark.errors).toEqual([])
    await dark.context.close()
    expect(app.errors).toEqual([])
  }, 150_000)

  test("bot-to-bot (background): wakes an idle recipient, which replies in its DM", async () => {
    const { page } = app
    await page.locator(`[data-row="${bots["Alpha"]!.id}"]`).click()
    const box = page.getByRole("textbox", { name: "Message Alpha" })
    await box.waitFor()
    await box.fill('tool: message_bot {"to": "Charlie", "text": "echo: Background note received"}')
    await box.press("Enter")
    await waitIdle(page)
    const charlie = bots["Charlie"]!
    await eventually(
      () => rpc.conversation(charlie.directConversationId),
      (s) => [...s.entries.values()].some((e) => e.kind === "message" && e.author.kind === "bot" && e.author.botId === charlie.id && e.text === "Background note received"),
      { label: "Charlie's reply", timeout: 20_000 },
    )
    await page.locator(`[data-row="${charlie.id}"]`).click()
    await page.getByTestId("transcript").getByText("Background note received", { exact: true }).waitFor()
    // Charlie's reply is shown as a normal reply (no "to @Alpha" label)
    expect(await page.getByTestId("transcript").getByTestId("addressee-chip").count()).toBe(0)
    await app.shot("e2e-27-b2b-background")
    expect(app.errors).toEqual([])
  }, 60_000)

  test("one mind: while Alpha works in the group, its DM says so and queues the owner's message", async () => {
    const { page } = app
    const alpha = bots["Alpha"]!
    await page.locator(`[data-row="${groupId}"]`).click()
    const groupBox = page.getByRole("textbox", { name: `Message ${GROUP}` })
    await groupBox.fill("@Alpha slow: working on the group task, one careful word at a time, please wait for me")
    const watch = rpc.watchRoster()
    await groupBox.press("Enter")
    await eventually(
      async () => watch.state(),
      (r) => r.activities.get(alpha.id)?.conversationId === groupId && r.activities.get(alpha.id)?.state !== "idle",
      { label: "Alpha busy in the group", timeout: 20_000 },
    )
    await watch.stop()
    await page.locator(`[data-row="${alpha.id}"]`).click()
    const dmBox = page.getByRole("textbox", { name: "Message Alpha" })
    await dmBox.fill("echo: back in the DM")
    await dmBox.press("Enter")
    const strip = page.getByTestId("busy-elsewhere")
    await strip.getByText(`Busy in “${GROUP}” · your message is queued`).waitFor({ timeout: 10_000 })
    await app.shot("e2e-28-busy-elsewhere")
    // after the group turn, the queued DM message runs and is answered in the DM
    await page.getByTestId("transcript").getByText("back in the DM", { exact: true }).waitFor({ timeout: 30_000 })
    await strip.waitFor({ state: "detached", timeout: 10_000 })
    await waitIdle(page)
    expect(app.errors).toEqual([])
  }, 60_000)

  test("Delete group… from the sidebar menu removes the group, keeps the bots and navigates away", async () => {
    const { page } = app
    const alpha = bots["Alpha"]!
    await page.locator(`[data-row="${alpha.id}"]`).click()
    await page.getByRole("textbox", { name: "Message Alpha" }).waitFor()
    await page.locator(`[data-row="${groupId}"]`).click()
    await page.getByRole("textbox", { name: `Message ${GROUP}` }).waitFor()
    await page.locator(`[data-row="${groupId}"]`).click({ button: "right" })
    await page.getByRole("menuitem", { name: "Delete group…" }).click()
    await app.shot("e2e-29-delete-group-confirm")
    await page.getByRole("menuitem", { name: "Delete group", exact: true }).click()
    await page.locator(`[data-row="${groupId}"]`).waitFor({ state: "detached", timeout: 10_000 })
    // back to the previous conversation (Alpha's DM)
    await page.getByRole("textbox", { name: "Message Alpha" }).waitFor({ timeout: 10_000 })
    for (const bot of Object.values(bots)) expect((await rpc.call((c) => c["bots.get"]({ botId: bot.id }))).name).toBe(bot.name)
    expect(app.errors).toEqual([])
  }, 60_000)
})
