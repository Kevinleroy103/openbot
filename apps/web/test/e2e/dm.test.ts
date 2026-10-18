// E2E (W3.1): onboarding → create a Demo bot → lands in its DM; streamed reply; approval card
// (Allow once / Deny / Always allow → rule in Settings › Permissions); question card (A/B/C and
// free text); failed turn → error tray → Retry (the same message again); interrupt via Stop. Real brain, fake harness only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Browser } from "playwright-core"
import type { BotId, ConversationId } from "@openbot/contracts"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { type AppPage, type Brain, connectRpc, eventually, hasChromium, launchBrowser, openApp, type Rpc, send, startBrain, waitIdle } from "./brain.ts"

describe.skipIf(!hasChromium)("e2e: onboarding and a direct chat", () => {
  let brain: Brain
  let browser: Browser
  let rpc: Rpc
  let app: AppPage
  let botId: BotId
  let convId: ConversationId
  const BOT = "Ada"

  beforeAll(async () => {
    // fake + claude: onboarding lists Claude (probe only, no model call) with the right label
    brain = await startBrain({ harnesses: "fake,claude" })
    browser = await launchBrowser()
    rpc = await connectRpc(brain)
  }, 60_000)

  afterAll(async () => {
    await app?.context.close()
    await rpc?.close()
    await browser?.close()
    await brain?.stop()
  })

  test("onboarding creates a Demo bot and lands in its DM", async () => {
    app = await openApp(browser, brain, { theme: "dark" })
    const { page } = app
    await page.getByTestId("onboarding").waitFor()
    await app.shot("e2e-01-onboarding-welcome")
    await page.getByTestId("onboarding-start").click()
    const harnesses = page.getByTestId("onboarding-harnesses")
    await harnesses.getByText("Demo", { exact: true }).first().waitFor({ timeout: 30_000 })
    await harnesses.getByText("Claude", { exact: true }).first().waitFor({ timeout: 30_000 })
    expect(await page.getByText("Claude Code").count()).toBe(0)
    await app.shot("e2e-02-onboarding-harnesses")
    await page.getByTestId("onboarding-next").click()
    const form = page.getByTestId("new-bot-form")
    await form.getByTestId("new-bot-name").fill(BOT)
    await form.getByTestId("harness-chip-fake").click()
    // Autonomy defaults to "Auto in workspace"; this suite exercises approval cards, so "Ask first"
    const autonomy = form.getByTestId("new-bot-autonomy")
    await autonomy.getByRole("button", { name: "Autonomy" }).getByText("Auto in workspace").waitFor()
    await autonomy.getByRole("button", { name: "Autonomy" }).click()
    await page.getByRole("menu", { name: "Autonomy" }).getByText("Full auto", { exact: true }).click()
    await autonomy.getByTestId("full-auto-warning").waitFor()
    await autonomy.getByRole("button", { name: "Autonomy" }).click()
    await page.getByRole("menu", { name: "Autonomy" }).getByText("Ask first", { exact: true }).click()
    await autonomy.getByText("Asks you before it runs commands or changes files.").waitFor()
    expect(await autonomy.getByTestId("full-auto-warning").count()).toBe(0)
    await app.shot("e2e-03-onboarding-create")
    await form.getByTestId("create-bot").click()
    // lands in the new bot's DM (not the New chat "To:" picker)
    await page.getByRole("textbox", { name: `Message ${BOT}` }).waitFor()
    expect(await page.getByRole("combobox", { name: "To" }).count()).toBe(0)
    expect(page.url()).toMatch(/#\/c\//)
    convId = decodeURIComponent(/#\/c\/([^/?#]+)/.exec(page.url())![1]!) as ConversationId
    const conv = await rpc.conversation(convId)
    expect(conv.conversation?.kind).toBe("direct")
    botId = (conv.conversation as { botId: BotId }).botId
    expect((await rpc.call((c) => c["bots.get"]({ botId }))).autonomy).toBe("ask")
    await app.shot("e2e-04-new-bot-dm")
    expect(app.errors).toEqual([])
  }, 90_000)

  test("a message streams a reply; steps, context usage and the sidebar preview are set", async () => {
    const { page } = app
    await send(page, BOT, "echo: Hello from the e2e suite, streaming word by word")
    const transcript = page.getByTestId("transcript")
    await transcript.getByText("echo: Hello from the e2e suite", { exact: false }).waitFor()
    await transcript.getByText("Hello from the e2e suite, streaming word by word", { exact: true }).waitFor()
    await waitIdle(page)
    // a tool turn gets the "1 step" disclosure (needs the entry's turnId + a terminal turn status)
    await send(page, BOT, 'tool: list_bots {}')
    await transcript.getByText("I called list_bots", { exact: false }).waitFor()
    await waitIdle(page)
    const steps = page.locator("[data-steps]").last()
    await steps.waitFor()
    expect(await steps.getAttribute("data-steps")).toBe("1")
    await steps.getByRole("button").first().click()
    await app.shot("e2e-05-dm-reply-steps")

    const state = await rpc.conversation(convId)
    const toolEntry = [...state.entries.values()].find((e) => e.kind === "tool-call")
    expect(toolEntry?.turnId).toBeDefined()
    const turn = state.turns.get(toolEntry!.turnId!)
    expect(turn?.status).toBe("completed")
    // the context ring: Conversation.sessions[].contextUsage
    const session = state.conversation?.sessions?.find((s) => s.botId === botId)
    expect(session?.active).toBe(true)
    expect(session?.contextUsage?.windowTokens).toBeGreaterThan(0)
    await page.getByLabel(/^Context \d+%/).first().waitFor()
    // sidebar preview: the last message
    const row = page.locator(`[data-row="${botId}"]`)
    await row.getByText("I called list_bots", { exact: false }).waitFor()
    expect(app.errors).toEqual([])
  }, 60_000)

  test("approval card: Allow once, Deny, Always allow → rule in Settings › Permissions", async () => {
    const { page } = app
    const transcript = page.getByTestId("transcript")
    // Allow once
    await send(page, BOT, "approve: npm test")
    let card = page.locator('[data-card="approval"][data-status="pending"]')
    await card.waitFor()
    await card.getByText("Needs approval").waitFor()
    const pending = await rpc.call((c) => c["requests.listPending"]({}))
    const request = pending.find((r) => r.kind === "command-approval")
    expect(request).toBeDefined()
    expect(request!.responseCapability.type).toBe("decision")
    const options = request!.responseCapability.type === "decision" ? request!.responseCapability.options.map((o) => o.id) : []
    expect(options).toContain("allow-once")
    expect(options).toContain("allow-always")
    expect(options).toContain("deny")
    expect(request!.suggestedRule).toBeDefined()
    await app.shot("e2e-06-approval-pending")
    await card.getByRole("button", { name: "Allow once" }).click()
    await page.locator('[data-card="approval"][data-status="resolved"]').getByText("Allowed once").waitFor()
    await transcript.getByText("Approved (allow-once)", { exact: false }).waitFor()
    await waitIdle(page)

    // Deny
    await send(page, BOT, "approve: rm -rf build")
    card = page.locator('[data-card="approval"][data-status="pending"]')
    await card.waitFor()
    await card.getByRole("button", { name: "Deny" }).click()
    await page.locator('[data-card="approval"][data-status="resolved"]').getByText("Denied").waitFor()
    await transcript.getByText("I did not run `rm -rf build`", { exact: false }).or(transcript.getByText("I did not run rm -rf build", { exact: false })).first().waitFor()
    await waitIdle(page)

    // Always allow → a rule
    await send(page, BOT, "approve: git status")
    card = page.locator('[data-card="approval"][data-status="pending"]')
    await card.waitFor()
    await card.getByRole("button", { name: "Always allow" }).click()
    const resolved = page.locator('[data-card="approval"][data-status="resolved"]').filter({ hasText: "Always allowed" })
    await resolved.waitFor()
    await resolved.getByText("Added to your Allow rules").waitFor()
    // the harness gets allow-once (the rule is the brain's business, ApprovalService)
    const approvedReplies = () => transcript.getByText("Approved (allow-once)", { exact: false }).count()
    await eventually(approvedReplies, (n) => n >= 2, { label: "the always-allowed reply" })
    await waitIdle(page)
    await app.shot("e2e-07-approval-always")
    const rules = await rpc.call((c) => c["rules.list"]({}))
    expect(rules.some((r) => r.action === "allow")).toBe(true)

    // the same command is now allowed without a card
    const cards = await page.locator('[data-card="approval"]').count()
    await send(page, BOT, "approve: git status")
    await eventually(approvedReplies, (n) => n >= 3, { label: "the auto-approved reply" })
    await waitIdle(page)
    expect(await page.locator('[data-card="approval"]').count()).toBe(cards)

    // every approval ran in its own turn (one step per turn)
    const st = await rpc.conversation(convId)
    const perTurn = new Map<string, number>()
    for (const e of st.entries.values()) if (e.kind === "tool-call" && e.turnId) perTurn.set(e.turnId, (perTurn.get(e.turnId) ?? 0) + 1)
    expect([...perTurn.values()].every((n) => n === 1)).toBe(true)

    // Settings › Permissions shows the rule
    await resolved.getByRole("button", { name: "Edit rule" }).click()
    const settings = page.getByTestId("settings-dialog")
    await settings.waitFor()
    await settings.getByTestId("rule-row").first().waitFor()
    await app.shot("e2e-08-permissions-rule")
    await page.keyboard.press("Escape")
    await settings.waitFor({ state: "detached" })
    expect(app.errors).toEqual([])
  }, 90_000)

  test("autonomy: Details › Brain → Auto in workspace runs in-workspace commands without a card", async () => {
    const { page } = app
    const transcript = page.getByTestId("transcript")
    const pane = page.getByTestId("details-pane")
    if ((await pane.count()) === 0) await page.getByRole("button", { name: "View conversation details" }).click()
    await pane.getByRole("tab", { name: "Details" }).click()
    const select = pane.getByRole("button", { name: "Autonomy" })
    await select.scrollIntoViewIfNeeded()
    await select.getByText("Ask first").waitFor()
    await select.click()
    await page.getByRole("menu", { name: "Autonomy" }).getByText("Auto in workspace", { exact: true }).click()
    await eventually(() => rpc.call((c) => c["bots.get"]({ botId })), (b) => b.autonomy === "workspace", { label: "autonomy saved" })
    await pane.getByTestId("autonomy-hint").getByText("Works freely in its own workspace", { exact: false }).waitFor()
    await app.shot("e2e-08b-autonomy-workspace")

    const cards = await page.locator('[data-card="approval"]').count()
    const approved = () => transcript.getByText("Approved (allow-once)", { exact: false }).count()
    const before = await approved()
    await send(page, BOT, "approve: bun test")
    await eventually(approved, (n) => n > before, { label: "auto-approved reply" })
    await waitIdle(page)
    expect(await page.locator('[data-card="approval"]').count()).toBe(cards)
    // no "auto-decided" line in the chat: the decision is a badge on the step it allowed
    expect(await transcript.getByText("Allowed in its workspace:", { exact: false }).count()).toBe(0)
    const steps = transcript.locator("[data-steps]").last()
    expect(await steps.getAttribute("data-auto")).toBe("1")
    await steps.getByRole("button").first().click()
    await steps.getByTestId("auto-badge").getByText("auto-allowed · workspace").waitFor()
    await app.shot("e2e-08c-auto-allowed-badge")

    // a git repo outside the workspace: the card offers "Allow in <repo root>"; it allows and adds the
    // folder to the Bot's project folders (Details › Brain), so work there no longer asks
    const repo = join(brain.dataDir, "projects", "snip")
    mkdirSync(join(repo, ".git"), { recursive: true })
    mkdirSync(join(repo, "src"), { recursive: true })
    await send(page, BOT, `approve: bun test @ ${repo}/src`)
    const card = page.locator('[data-card="approval"][data-status="pending"]')
    await card.waitFor()
    const allowIn = card.getByTestId("allow-in-folder")
    expect(await allowIn.innerText()).toBe("Allow in …/projects/snip")
    await card.getByRole("button", { name: "Allow once" }).waitFor()
    await card.getByRole("button", { name: "Always allow" }).waitFor()
    await card.getByRole("button", { name: "Deny" }).waitFor()
    await app.shot("e2e-08d-allow-in-folder")
    await allowIn.click()
    const done = page.locator('[data-card="approval"][data-status="resolved"]').filter({ hasText: "Allowed in folder" })
    await done.getByTestId("allowed-in-folder").getByText(repo).waitFor()
    await eventually(() => rpc.call((c) => c["bots.get"]({ botId })), (b) => b.projectFolders.includes(repo), { label: "folder added" })
    await waitIdle(page)
    const folders = pane.getByTestId("bot-project-folders")
    await folders.scrollIntoViewIfNeeded()
    await folders.locator(`[data-folder="${repo}"]`).waitFor()
    const cardsBefore = await page.locator('[data-card="approval"]').count()
    const approvedBefore = await approved()
    await send(page, BOT, `approve: bun run build @ ${repo}`)
    await eventually(approved, (n) => n > approvedBefore, { label: "auto-approved in the project folder" })
    await waitIdle(page)
    expect(await page.locator('[data-card="approval"]').count()).toBe(cardsBefore)
    // remove it again from Details › Brain
    await folders.getByRole("button", { name: `Remove ${repo}` }).click()
    await eventually(() => rpc.call((c) => c["bots.get"]({ botId })), (b) => b.projectFolders.length === 0, { label: "folder removed" })
    // and add one by hand (invalid input is refused in place)
    await folders.getByRole("textbox", { name: "Add a project folder" }).fill("~")
    await folders.getByRole("button", { name: "Add" }).click()
    await folders.getByRole("alert").waitFor()
    await folders.getByRole("textbox", { name: "Add a project folder" }).fill(`${repo}/`)
    await folders.getByRole("button", { name: "Add" }).click()
    await eventually(() => rpc.call((c) => c["bots.get"]({ botId })), (b) => b.projectFolders.join() === repo, { label: "folder added by hand" })
    await app.shot("e2e-08e-brain-project-folders")
    await folders.getByRole("button", { name: `Remove ${repo}` }).click()
    await eventually(() => rpc.call((c) => c["bots.get"]({ botId })), (b) => b.projectFolders.length === 0, { label: "folder removed again" })

    // back to Ask first for the rest of the suite
    await select.click()
    await page.getByRole("menu", { name: "Autonomy" }).getByText("Ask first", { exact: true }).click()
    await eventually(() => rpc.call((c) => c["bots.get"]({ botId })), (b) => b.autonomy === "ask", { label: "autonomy back to ask" })
    expect(app.errors).toEqual([])
  }, 90_000)

  test("Settings › Permissions: the default for new Bots and shared project folders", async () => {
    const { page } = app
    const pane = page.getByTestId("details-pane")
    if ((await pane.count()) === 0) await page.getByRole("button", { name: "View conversation details" }).click()
    await pane.getByRole("tab", { name: "Details" }).click()
    const editRules = pane.getByTestId("autonomy-hint").getByRole("button", { name: "Edit rules" })
    await editRules.scrollIntoViewIfNeeded()
    await editRules.click()
    const settings = page.getByTestId("settings-dialog")
    await settings.waitFor()
    const def = settings.getByTestId("default-autonomy")
    await def.getByText("Auto in workspace").waitFor()
    await def.getByRole("button", { name: "Default for new Bots" }).click()
    await page.getByRole("menu", { name: "Default for new Bots" }).getByText("Ask first", { exact: true }).click()
    await eventually(() => rpc.call((c) => c["settings.get"]()), (s) => s.defaultAutonomy === "ask", { label: "default autonomy saved" })

    const shared = settings.getByTestId("shared-project-folders")
    await shared.getByRole("textbox", { name: "Add a project folder" }).fill("~/projects/")
    await shared.getByRole("button", { name: "Add" }).click()
    await shared.locator('[data-folder="~/projects"]').waitFor()
    await eventually(() => rpc.call((c) => c["settings.get"]()), (s) => s.sharedProjectFolders.join() === "~/projects", { label: "shared folder saved" })
    await app.shot("e2e-08f-permissions-folders")
    await shared.getByRole("button", { name: "Remove ~/projects" }).click()
    await eventually(() => rpc.call((c) => c["settings.get"]()), (s) => s.sharedProjectFolders.length === 0, { label: "shared folder removed" })
    await def.getByRole("button", { name: "Default for new Bots" }).click()
    await page.getByRole("menu", { name: "Default for new Bots" }).getByText("Auto in workspace", { exact: true }).click()
    await eventually(() => rpc.call((c) => c["settings.get"]()), (s) => s.defaultAutonomy === "workspace", { label: "default autonomy restored" })
    await page.keyboard.press("Escape")
    await settings.waitFor({ state: "detached" })
    expect(app.errors).toEqual([])
  }, 60_000)

  test("question card: A/B/C key and free text", async () => {
    const { page } = app
    const transcript = page.getByTestId("transcript")
    await send(page, BOT, "ask: Which color? | Red | Green | Blue")
    let card = page.locator('[data-card="question"][data-status="pending"]')
    await card.waitFor()
    await card.getByText("Which color?").first().waitFor()
    await app.shot("e2e-09-question-pending")
    await card.focus()
    await page.keyboard.press("b")
    await page.locator('[data-card="question"][data-status="resolved"]').filter({ hasText: "Green" }).waitFor()
    await transcript.getByText("You answered: Green").waitFor()
    await waitIdle(page)

    await send(page, BOT, "ask: Where to? | Home | Office")
    card = page.locator('[data-card="question"][data-status="pending"]')
    await card.waitFor()
    const free = card.getByRole("textbox", { name: "Type your own answer" })
    await free.fill("The beach")
    await free.press("Enter")
    await page.locator('[data-card="question"][data-status="resolved"]').filter({ hasText: "The beach" }).waitFor()
    await transcript.getByText("You answered: The beach").waitFor()
    await waitIdle(page)
    await app.shot("e2e-10-question-answered")
    expect(app.errors).toEqual([])
  }, 60_000)

  test("failed turn → error tray → Retry", async () => {
    const { page } = app
    await send(page, BOT, "fail: the scripted failure")
    const tray = page.getByTestId("error-tray")
    await tray.waitFor()
    await tray.getByText("Bot failed to respond").waitFor()
    await tray.getByText("the scripted failure").waitFor()
    await app.shot("e2e-11-error-tray")
    const userMessages = async () => (await rpc.conversation(convId)).entries
    const countFails = async () => [...(await userMessages()).values()].filter((e) => e.kind === "message" && e.role === "user" && e.text === "fail: the scripted failure").length
    expect(await countFails()).toBe(1)
    const failedTurns = async () => [...(await rpc.conversation(convId)).turns.values()].filter((t) => t.status === "failed").length
    await tray.getByRole("button", { name: "Retry" }).click()
    // the Bot tries the same message again; nothing new is posted
    await eventually(failedTurns, (n) => n === 2, { label: "the retried turn" })
    expect(await countFails()).toBe(1)
    // the retry fails again (same script): the tray comes back for the new turn
    await tray.waitFor()
    expect(app.errors).toEqual([])
  }, 60_000)

  test("interrupt a slow reply with Stop", async () => {
    const { page } = app
    await send(page, BOT, `slow: ${Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ")}`)
    const transcript = page.getByTestId("transcript")
    await transcript.getByText("word2", { exact: false }).first().waitFor()
    const stop = page.getByRole("button", { name: "Stop" })
    await stop.waitFor()
    await app.shot("e2e-12-working")
    await stop.click()
    await stop.waitFor({ state: "detached" })
    const state = await eventually(() => rpc.conversation(convId), (s) => [...s.turns.values()].some((t) => t.status === "interrupted"), { label: "an interrupted turn" })
    const aborted = [...state.entries.values()].find((e) => e.kind === "message" && e.role === "bot" && e.text.startsWith("word0"))
    expect(aborted && aborted.kind === "message" ? aborted.streaming : true).toBe(false)
    await app.shot("e2e-13-interrupted")
    expect(app.errors).toEqual([])
  }, 60_000)

  test("unread replies: unreadCount + unreadBoundaryAt → NEW divider; activity labels carry the conversation", async () => {
    const { page } = app
    // leave the chat (New chat view), then a turn runs there
    await page.keyboard.press("Control+n")
    await page.getByRole("combobox", { name: "To" }).waitFor()
    const before = await rpc.conversation(convId)
    expect(before.conversation?.unreadCount).toBe(0)
    const roster = rpc.watchRoster()
    await rpc.call((c) => c["messages.send"]({ conversationId: convId, text: "slow: one two three four five six", clientNonce: `e2e-unread-${Date.now()}` }))
    const after = await eventually(() => rpc.conversation(convId), (s) => (s.conversation?.unreadCount ?? 0) > 0 && [...s.turns.values()].every((t) => t.status !== "running"), { label: "an unread reply" })
    expect(after.conversation?.unreadBoundaryAt).toBeDefined()
    // while it worked, the roster activity named the conversation and had a label ("Typing…")
    const busy = roster.activities().filter((a) => a.botId === botId && a.state !== "idle")
    expect(busy.length).toBeGreaterThan(0)
    expect(busy.every((a) => a.conversationId === convId)).toBe(true)
    expect(busy.some((a) => a.label === "Typing…")).toBe(true)
    // the sidebar row: unread dot + preview of the last message
    const summary = roster.state().conversations.get(convId)
    expect(summary?.unreadCount).toBeGreaterThan(0)
    expect(summary?.preview).toContain("one two three")
    await roster.stop()
    const row = page.locator(`[data-row="${botId}"]`)
    await row.getByRole("status").or(row.locator("[aria-label='Unread']")).first().waitFor().catch(() => undefined)
    await app.shot("e2e-14-unread-sidebar")
    await row.click()
    const divider = page.getByRole("separator", { name: "New messages" })
    await divider.waitFor()
    await app.shot("e2e-15-new-divider")
    // opening it marks it read on the server
    await eventually(() => rpc.conversation(convId), (s) => s.conversation?.unreadCount === 0, { label: "markRead" })
    expect(app.errors).toEqual([])
  }, 60_000)
})
