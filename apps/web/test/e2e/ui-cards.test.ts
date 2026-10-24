// E2E: generative UI cards against the real brain. The Demo bot's `tool: show_ui` / `tool: update_ui`
// lines go through the real MCP gateway: every block renders, an answer reaches the Bot once and stays
// answered after a reload, update_ui changes the same card live, and a refused card posts nothing.
// Screenshots: e2e-ui-*.png.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Bot, EntryId, TranscriptEntryOf } from "@openbot/contracts"
import { Effect } from "effect"
import { copyFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { Browser } from "playwright-core"
import {
  type AppPage,
  type Brain,
  connectRpc,
  eventually,
  hasChromium,
  launchBrowser,
  openApp,
  type Rpc,
  send,
  startBrain,
  waitIdle,
} from "./brain.ts"

const choiceCard = {
  title: "Choose a meeting time",
  subtitle: "Sun, 25 Oct · 30 min · Europe/Tirane",
  blocks: [
    { fields: [{ label: "With", value: "Mira" }] },
    {
      choice: {
        id: "slot",
        label: "Meeting time",
        mode: "one",
        options: [
          { id: "1000", label: "10:00 – 10:30", badge: "Recommended" },
          { id: "1330", label: "13:30 – 14:00" },
          { id: "1500", label: "15:00 – 15:30" },
        ],
        default: ["1000"],
      },
    },
    { input: { id: "title", label: "Meeting title", default: "Design review" } },
  ],
  actions: [{ id: "send", label: "Send choice", style: "primary" }],
  fallback: "Choose a meeting time with Mira on Sun 25 Oct: 10:00–10:30, 13:30–14:00 or 15:00–15:30.",
}

const rollout = (subtitle: string, done: number) => ({
  title: "Search rollout",
  subtitle,
  blocks: [
    {
      checklist: ["Build web bundle", "Run migrations", "Roll out to 10%", "Roll out to everyone"].map((label, i) => {
        if (i < done) return { label, status: "done" }
        return { label, status: i === done ? "active" : "upcoming" }
      }),
    },
  ],
  fallback: `Search rollout: ${subtitle}.`,
})

describe.skipIf(!hasChromium)("e2e: generative UI cards", () => {
  let brain: Brain
  let browser: Browser
  let rpc: Rpc
  let app: AppPage
  let iris: Bot
  let choiceId: EntryId

  const uiCards = async () => {
    const state = await rpc.conversation(iris.directConversationId)
    return [...state.entries.values()].filter(
      (e): e is TranscriptEntryOf<"card"> => e.kind === "card" && e.card.type === "ui",
    )
  }
  const botReplies = async () => {
    const state = await rpc.conversation(iris.directConversationId)
    return [...state.entries.values()].flatMap((e) => (e.kind === "message" && e.role === "bot" ? [e.text] : []))
  }
  const cardView = (id: EntryId) => app.page.locator(`[data-entry="${id}"] [data-card="ui"]`)

  const directive = async (tool: string, args: unknown) => {
    await send(app.page, "Iris", `tool: ${tool} ${JSON.stringify(args)}`)
    await waitIdle(app.page)
  }

  const showUi = async (args: unknown): Promise<EntryId> => {
    const before = new Set((await uiCards()).map((e) => e.id))
    await directive("show_ui", args)
    const cards = await eventually(uiCards, (cs) => cs.some((e) => !before.has(e.id)), { label: "the new ui card" })
    const id = cards.find((e) => !before.has(e.id))!.id
    await cardView(id).waitFor()
    return id
  }

  beforeAll(async () => {
    brain = await startBrain()
    browser = await launchBrowser()
    rpc = await connectRpc(brain)
    iris = await rpc.call((c) =>
      c["bots.create"]({ name: "Iris", harness: { kind: "fake" }, clientNonce: "e2e-ui-iris", introduce: false }),
    )
    const output = join(brain.dataDir, "bots", iris.id, "workspace", "output")
    mkdirSync(output, { recursive: true })
    copyFileSync(new URL("../../public/apple-touch-icon.png", import.meta.url).pathname, join(output, "icon.png"))
    app = await openApp(browser, brain, { theme: "dark", route: `#/c/${iris.directConversationId}` })
    await app.page.getByRole("textbox", { name: "Message Iris" }).waitFor()
  }, 60_000)

  afterAll(async () => {
    await app?.context.close()
    await rpc?.close()
    await browser?.close()
    await brain?.stop()
  })

  test("show_ui: every block type renders from the flat tool blocks", async () => {
    const id = await showUi({
      title: "Block gallery",
      subtitle: "Every block type",
      blocks: [
        { text: "Some **bold words**, `inline code` and [the docs](https://example.com/docs)." },
        { fields: [{ label: "Owner", value: "Mira" }] },
        {
          stats: [
            { label: "Median", value: "5m 12s", delta: "38% faster", tone: "good" },
            { label: "Runs", value: "42" },
          ],
        },
        {
          table: {
            columns: ["Check", "Time"],
            rows: [
              ["Typecheck", "41s"],
              ["Lint", "12s"],
              ["Tests", "3m 2s"],
            ],
          },
        },
        {
          options: {
            items: [
              { id: "ba", title: "British Airways", value: "€148" },
              { id: "wizz", title: "Wizz Air", value: "€92", badge: "Cheapest" },
            ],
            pick: "ba",
          },
        },
        {
          checklist: [
            { label: "Build", status: "done" },
            { label: "Deploy", status: "active" },
            { label: "Announce", status: "upcoming" },
            { label: "Migrate", status: "failed" },
          ],
        },
        {
          timeline: [
            { time: "09:00", title: "Focus time", tag: "Protected" },
            { time: "10:30", title: "Design review" },
            { time: "14:00", title: "Weekly planning" },
          ],
        },
        {
          chart: {
            kind: "line",
            unit: "min",
            series: [
              { name: "Web", points: ["Mon", "Tue", "Wed"].map((x, i) => ({ x, y: 8 - i })) },
              { name: "Mobile", points: ["Mon", "Tue", "Wed"].map((x, i) => ({ x, y: 9 - i })) },
            ],
            highlight: "Tue",
          },
        },
        { image: { path: "output/icon.png", alt: "The OpenBot app icon" } },
        { link: { label: "Open the docs", url: "https://example.com/docs" } },
        {
          choice: {
            id: "toppings",
            label: "Toppings",
            mode: "many",
            options: ["olives", "basil", "chilli", "garlic"].map((o) => ({ id: o, label: o })),
            default: ["olives", "basil"],
          },
        },
        { input: { id: "notes", label: "Notes", placeholder: "Anything else?", multiline: true } },
      ],
      actions: [
        { id: "ok", label: "Looks good", style: "primary" },
        { id: "change", label: "Ask for changes", style: "secondary" },
        { id: "discard", label: "Discard", style: "danger" },
      ],
      fallback: "A gallery of every block type.",
    })
    const card = cardView(id)
    expect(await card.getAttribute("data-status")).toBe("pending")
    await card.getByText("bold words", { exact: true }).waitFor()
    await card.getByText("Mira", { exact: true }).waitFor()
    await card.getByText("38% faster", { exact: true }).waitFor()
    expect(await card.getByRole("table").getByRole("row").count()).toBe(4)
    await card.getByText("My pick", { exact: true }).waitFor()
    await card.getByText("Migrate", { exact: true }).waitFor()
    expect(await card.locator('[data-ui-block="timeline"] > li').count()).toBe(3)
    await card.getByRole("img", { name: /Line chart/ }).waitFor()
    const image = card.getByRole("img", { name: "The OpenBot app icon" })
    await image.scrollIntoViewIfNeeded()
    await eventually(
      () => image.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0)),
      (width) => width > 0,
      { label: "the imported image to load" },
    )
    expect(await card.getByRole("link", { name: "Open the docs" }).getAttribute("target")).toBe("_blank")
    expect(await card.getByRole("checkbox", { checked: true }).count()).toBe(2)
    await card.getByRole("textbox", { name: "Notes" }).waitFor()
    expect(await card.locator('[data-ui-block="unknown"]').count()).toBe(0)
    await card.scrollIntoViewIfNeeded()
    await app.shot("e2e-ui-01-gallery")
    expect(app.errors).toEqual([])
  }, 60_000)

  test("cards.act: the answer reaches the Bot once and stays answered after a reload", async () => {
    const { page } = app
    choiceId = await showUi(choiceCard)
    const card = cardView(choiceId)
    await card.getByRole("radio", { name: "13:30 – 14:00" }).check()
    await card.getByRole("textbox", { name: "Meeting title" }).fill("Launch review")
    await card.getByRole("button", { name: "Send choice" }).click()
    await page.locator(`[data-entry="${choiceId}"] [data-card="ui"][data-status="resolved"]`).waitFor()

    const answered = (await uiCards()).find((e) => e.id === choiceId)!
    expect(answered.state).toMatchObject({
      status: "resolved",
      answer: { actionId: "send", values: { slot: ["1330"], title: "Launch review" } },
    })
    // the Demo harness quotes what it was sent
    await eventually(
      botReplies,
      (rs) =>
        rs.at(-1)!.includes('You said: "The user chose "Send choice" on your card "Choose a meeting time".') &&
        rs.at(-1)!.includes("Meeting time: 13:30 – 14:00\nMeeting title: Launch review"),
      { label: "the Bot's reply to the answer" },
    )
    await waitIdle(page)
    await card.scrollIntoViewIfNeeded()
    await app.shot("e2e-ui-02-answered")

    await page.reload()
    const reloaded = cardView(choiceId)
    await reloaded.getByText("Answered", { exact: true }).waitFor()
    await reloaded.getByText("13:30 – 14:00", { exact: true }).waitFor()
    await reloaded.getByText("Launch review", { exact: true }).waitFor()
    expect(await reloaded.getByRole("button", { name: "Send choice" }).isDisabled()).toBe(true)
    expect(await reloaded.getByRole("radio").count()).toBe(0)
    expect(await reloaded.getByRole("textbox").count()).toBe(0)

    const again = await rpc.call((c) =>
      Effect.flip(c["cards.act"]({ entryId: choiceId, actionId: "send", values: { slot: ["1000"] } })),
    )
    expect(again).toMatchObject({ _tag: "AlreadyAnswered", entryId: choiceId })
    expect((await uiCards()).find((e) => e.id === choiceId)!.state).toEqual(answered.state)
    expect(app.errors).toEqual([])
  }, 60_000)

  test("update_ui: the same card changes live; an answered card can't", async () => {
    const id = await showUi(rollout("0 of 4 done", 0))
    const card = cardView(id)
    const rollouts = app.page.locator('[data-card="ui"][aria-label="Search rollout"]')
    await card.getByText("0 of 4 done", { exact: true }).waitFor()

    await directive("update_ui", { entry_id: id, ...rollout("2 of 4 done", 2) })
    await card.getByText("2 of 4 done", { exact: true }).waitFor()
    await directive("update_ui", { entry_id: id, ...rollout("Finished", 4) })
    await card.getByText("Finished", { exact: true }).waitFor()
    expect(await rollouts.count()).toBe(1)
    const updated = (await uiCards()).find((e) => e.id === id)!
    expect(updated.card).toMatchObject({ subtitle: "Finished", fallback: "Search rollout: Finished." })
    expect(updated.state.status).toBe("info")
    await card.scrollIntoViewIfNeeded()
    await app.shot("e2e-ui-03-updated")

    await directive("update_ui", { entry_id: choiceId, ...choiceCard, title: "Changed" })
    await app.page.getByTestId("transcript").getByText("already answered this card", { exact: false }).first().waitFor()
    expect((await uiCards()).find((e) => e.id === choiceId)!.card).toMatchObject({ title: "Choose a meeting time" })
    expect(app.errors).toEqual([])
  }, 60_000)

  test("show_ui refuses a card that breaks a rule or a cap, and posts nothing", async () => {
    const before = (await uiCards()).length
    const card = (blocks: ReadonlyArray<unknown>, extra?: object) => ({ blocks, fallback: "Refused.", ...extra })
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [card([{ link: { label: "Run", url: "javascript:alert(1)" } }]), "the url must be an https:// link"],
      [card([{ link: { label: "Plain", url: "http://example.com" } }]), "the url must be an https:// link"],
      [
        card([{ table: { columns: ["n"], rows: Array.from({ length: 51 }, (_, i) => [String(i)]) } }]),
        "has 51 rows; the most is 50",
      ],
      [
        card([{ table: { columns: Array.from({ length: 9 }, (_, i) => `c${i}`), rows: [] } }]),
        "has 9 columns; the most is 8",
      ],
      [card(Array.from({ length: 21 }, () => ({ text: "x" }))), "has 21 blocks; the most is 20"],
      [card([{ text: "a", fields: [] }]), "must have exactly one of text, fields, table"],
      [card([{ map: { lat: 41.3, lng: 19.8 } }]), "(it has none)"],
      [card([{ input: { id: "note", label: "Note" } }]), "A card with a choice or an input needs an action"],
    ]
    for (const [args, message] of cases) {
      const replies = (await botReplies()).length
      await directive("show_ui", args)
      await eventually(botReplies, (rs) => rs.length > replies && rs.at(-1)!.includes(message), {
        label: `the refusal "${message}"`,
      })
    }
    await app.page.getByTestId("transcript").getByText(cases.at(-1)![1], { exact: false }).first().waitFor()
    expect((await uiCards()).length).toBe(before)
    await app.shot("e2e-ui-04-refused")
    expect(app.errors).toEqual([])
  }, 90_000)
})
