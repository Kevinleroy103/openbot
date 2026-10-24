// W2.3 visual + behavior check: builds test/web-b-harness.html (Bun HTML bundler + Tailwind), starts the
// in-memory OpenBot mock (dev/mock-server.ts, owned by W2.2), and drives the W2.3 screens in Chromium
// at 1440×900 DPR 2, dark and light. Screenshots: test/screenshots/web-b-*.png.
// Skipped when Chromium is missing (OPENBOT_CHROMIUM, default /usr/bin/chromium) or the mock is absent.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, statSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import tailwind from "bun-plugin-tailwind"
import { type Browser, type Page, chromium } from "playwright-core"
import { type LiveStub, makeLiveStub } from "./web-b-live.ts"
import { startWebBMock, type WebBMock } from "./web-b-mock.ts"

const chromiumPath = process.env.OPENBOT_CHROMIUM ?? "/usr/bin/chromium"
const shots = new URL("./screenshots", import.meta.url).pathname
const harness = new URL("./web-b-harness.html", import.meta.url).pathname
const enabled = existsSync(chromiumPath)

let work = ""
let server: ReturnType<typeof Bun.serve> | undefined
let mock: WebBMock | undefined
let browser: Browser | undefined
let base = ""
let liveBase = ""
let live: LiveStub | undefined
const errors: string[] = []

beforeAll(async () => {
  if (!enabled) return
  mkdirSync(shots, { recursive: true })
  work = await mkdtemp(join(tmpdir(), "openbot-web-b-"))
  const built = await Bun.build({
    entrypoints: [harness],
    outdir: work,
    plugins: [tailwind],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
  })
  if (!built.success) throw new AggregateError(built.logs, "harness build failed")
  mock = await startWebBMock()
  browser = await chromium.launch({ executablePath: chromiumPath })
  // a JPEG "browser frame" for the live-view stub
  const framePage = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await framePage.setContent(
    `<body style="margin:0;background:#f3f0ea;font:28px system-ui"><div style="padding:110px 190px">Status: WAITING<br><input placeholder="type here" style="margin-top:60px;width:380px;height:40px;font-size:20px"><button style="position:absolute;left:850px;top:490px;width:190px;height:70px;background:#2a6db3;color:#fff;border:0;border-radius:6px;font-size:22px">Launch</button></div></body>`,
  )
  const jpeg = new Uint8Array(await framePage.screenshot({ type: "jpeg", quality: 70 }))
  await framePage.close()
  live = makeLiveStub({ mockRpcUrl: mock.rpcUrl, jpeg, width: 1280, height: 800 })
  const stub = live
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req, srv) => {
      const handled = await stub.fetch(req, srv as never)
      if (handled !== undefined || /^\/(rpc|ws\/)/.test(new URL(req.url).pathname)) return handled
      const path = new URL(req.url).pathname
      const file = Bun.file(join(work, path === "/" ? "web-b-harness.html" : decodeURIComponent(path)))
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 })
    },
    websocket: stub.websocket as never,
  })
  base = `http://127.0.0.1:${server.port}/web-b-harness.html?rpc=${encodeURIComponent(mock.rpcUrl)}`
  liveBase = `http://127.0.0.1:${server.port}/web-b-harness.html?rpc=${encodeURIComponent(`ws://127.0.0.1:${server.port}/rpc`)}`
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await server?.stop(true)
  await mock?.stop()
  if (work) await rm(work, { recursive: true, force: true })
})

const open = async (query: string, theme: "dark" | "light", viaLiveStub = false): Promise<Page> => {
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  page.on("pageerror", (e) => errors.push(`${query}/${theme}: ${e.message}`))
  page.on("console", (m) => {
    if (m.type() === "error" && !/WebSocket|ERR_CONNECTION|Failed to load resource/.test(m.text()))
      errors.push(`${query}/${theme}: ${m.text()}`)
  })
  await page.goto(`${viaLiveStub ? liveBase : base}&theme=${theme}&${query}`)
  await page.evaluate(() => document.fonts.ready)
  return page
}

/** Poll `read` until `ok` holds (bun:test has no expect.poll). */
const until = async <A>(read: () => Promise<A>, ok: (a: A) => boolean, timeout = 10_000): Promise<A> => {
  const end = Date.now() + timeout
  for (;;) {
    const a = await read()
    if (ok(a) || Date.now() > end) return a
    await Bun.sleep(150)
  }
}

const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(350)
  const file = join(shots, `web-b-${name}.png`)
  await page.screenshot({ path: file })
  expect(statSync(file).size).toBeGreaterThan(10_000)
}

for (const theme of ["dark", "light"] as const) {
  test.skipIf(!enabled)(
    `details pane tabs, avatar editor, instructions (${theme})`,
    async () => {
      const page = await open("scene=details", theme)
      await page.getByTestId("details-pane").waitFor()
      await page.getByTestId("bot-name").waitFor({ timeout: 15_000 })
      await page.getByText("Brain", { exact: true }).waitFor()
      await shot(page, `details-${theme}`)

      // edit instructions → saved through bots.update
      await page.getByTestId("edit-instructions").click()
      const text = `Keep replies short. (${theme})`
      await page.getByTestId("instructions-input").fill(text)
      await page.getByTestId("save-instructions").click()
      await page.getByTestId("instructions-text").getByText(text).waitFor({ timeout: 10_000 })

      // scroll to the lower sections
      await page.locator("#details-session").scrollIntoViewIfNeeded()
      await shot(page, `details-lower-${theme}`)

      // avatar editor
      await page.locator("#details-brain").scrollIntoViewIfNeeded()
      await page.getByTestId("avatar-button").click()
      await page.getByTestId("avatar-editor").waitFor()
      await shot(page, `avatar-editor-${theme}`)
      await page.keyboard.press("Escape")

      await page.getByRole("tab", { name: "Library" }).click()
      await page.getByTestId("details-tab-library").waitFor()
      await shot(page, `details-library-${theme}`)

      await page.getByRole("tab", { name: "Computer" }).click()
      await page.getByTestId("screen-thumbnail").waitFor()
      await shot(page, `details-computer-${theme}`)

      // open the full computer view from the thumbnail (the mock streams no frames: empty state)
      await page.getByTestId("screen-thumbnail").click()
      await page.getByTestId("computer-view").waitFor()
      await shot(page, `computer-view-${theme}`)
      await page.close()
    },
    60_000,
  )

  test.skipIf(!enabled)(
    `live computer view: frames, take control, input relay, terminal (${theme})`,
    async () => {
      live!.holder = "bot"
      live!.inputs.length = 0
      live!.terminalInput.length = 0
      const page = await open("scene=computer", theme, true)
      await page.getByTestId("computer-view").waitFor({ timeout: 15_000 })
      const canvas = page.getByTestId("computer-view").getByTestId("screen-canvas")
      const visible = await until(
        () => canvas.evaluate((c) => getComputedStyle(c).visibility),
        (v) => v === "visible",
        15_000,
      )
      expect(visible).toBe("visible")
      await page.getByRole("button", { name: "Take control" }).waitFor()
      await shot(page, `computer-live-watching-${theme}`)

      await page.getByRole("button", { name: "Take control" }).click()
      await page.getByText("You're in control").waitFor()
      // input flows once the control socket is up (the canvas is wired for input then)
      await page
        .locator('[data-testid="computer-view"] [data-testid="screen-canvas"][data-interactive]')
        .waitFor({ timeout: 10_000 })
      await page.waitForTimeout(300)
      const box = (await canvas.boundingBox())!
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await page.keyboard.type("hi")
      const inputs = await until(
        async () => [...live!.inputs],
        (l) => l.some((e) => e["_tag"] === "key" && e["key"] === "i"),
        5000,
      )
      const down = inputs.find((e) => e["_tag"] === "mouse" && e["type"] === "down")
      expect(down).toBeDefined()
      // the click at the frame center lands at the center of the 1280×800 page viewport
      expect(Math.abs(Number(down!["x"]) - 640)).toBeLessThan(4)
      expect(Math.abs(Number(down!["y"]) - 400)).toBeLessThan(4)
      expect(inputs.some((e) => e["_tag"] === "key" && e["type"] === "down" && e["text"] === "h")).toBe(true)
      await shot(page, `computer-live-control-${theme}`)

      await page.getByTestId("control-pill").getByRole("button", { name: "I'm done" }).click()
      await page.getByRole("button", { name: "Take control" }).waitFor()

      await page.getByTestId("computer-tab-terminal").click()
      await page.getByTestId("terminal-host").getByText("openbot@node").first().waitFor({ timeout: 10_000 })
      await page.keyboard.type("ls")
      const typed = await until(
        async () => live!.terminalInput.join(""),
        (t) => t.includes("ls"),
        5000,
      )
      expect(typed).toContain("ls")
      await shot(page, `computer-terminal-${theme}`)
      await page.close()
    },
    60_000,
  )

  test.skipIf(!enabled)(
    `live thumbnail, routine editor, group details (${theme})`,
    async () => {
      live!.holder = "bot"
      const page = await open("scene=details&tab=computer", theme, true)
      await page.getByTestId("screen-thumbnail").waitFor({ timeout: 15_000 })
      await until(
        () => page.getByTestId("screen-canvas").evaluate((c) => getComputedStyle(c).visibility),
        (v) => v === "visible",
        15_000,
      )
      await shot(page, `details-computer-live-${theme}`)
      await page.getByRole("tab", { name: "Details" }).click()
      await page.getByTestId("routine-row").first().getByRole("button").first().click()
      await page.getByTestId("routine-name").waitFor()
      await shot(page, `routine-editor-${theme}`)
      await page.close()

      const group = await open("scene=group", theme)
      await group.getByTestId("group-member").first().waitFor({ timeout: 15_000 })
      await shot(group, `group-details-${theme}`)
      await group.close()
    },
    60_000,
  )

  test.skipIf(!enabled)(
    `computer view full screen (${theme})`,
    async () => {
      const page = await open("scene=computer", theme)
      await page.getByTestId("computer-view").waitFor({ timeout: 15_000 })
      await page.waitForTimeout(600)
      await shot(page, `computer-${theme}`)
      await page.close()
    },
    30_000,
  )

  test.skipIf(!enabled)(
    `settings pages + pairing code (${theme})`,
    async () => {
      const page = await open("scene=settings&page=general", theme)
      await page.getByTestId("settings-dialog").waitFor({ timeout: 15_000 })
      await shot(page, `settings-general-${theme}`)
      for (const p of ["harnesses", "computers", "permissions", "usage", "updates"] as const) {
        await page.getByTestId(`settings-nav-${p}`).click()
        await page.getByTestId(`settings-page-${p}`).waitFor()
        await page.waitForTimeout(400)
        await shot(page, `settings-${p}-${theme}`)
      }
      // Settings › Computers → Pair a computer → a pairing code appears
      await page.getByTestId("settings-nav-computers").click()
      await page.getByTestId("pair-computer").click()
      const code = page.getByTestId("pairing-code")
      await code.waitFor()
      const shown = await until(
        async () => (await code.innerText()).replace(/[^A-Za-z0-9]/g, ""),
        (t) => t.length >= 8,
      )
      expect(shown.length).toBeGreaterThanOrEqual(8)
      await shot(page, `settings-pairing-${theme}`)
      await page.close()
    },
    60_000,
  )

  test.skipIf(!enabled)(
    `new bot + new group forms (${theme})`,
    async () => {
      const page = await open("scene=newbot", theme)
      await page.getByTestId("new-bot-form").waitFor({ timeout: 15_000 })
      await page.getByTestId("harness-chip-fake").waitFor()
      await page.getByTestId("new-bot-name").fill("Scout")
      await shot(page, `newbot-${theme}`)
      await page.close()

      const group = await open("scene=newgroup", theme)
      await group.getByTestId("new-group-form").waitFor({ timeout: 15_000 })
      await shot(group, `newgroup-${theme}`)
      await group.close()
    },
    30_000,
  )

  test.skipIf(!enabled)(
    `onboarding (${theme})`,
    async () => {
      const page = await open("scene=onboarding", theme)
      await page.getByTestId("onboarding").waitFor({ timeout: 15_000 })
      await shot(page, `onboarding-welcome-${theme}`)
      await page.getByTestId("onboarding-start").click()
      await page.getByTestId("onboarding-harnesses").waitFor()
      await page.waitForTimeout(500)
      await shot(page, `onboarding-brains-${theme}`)
      await page.getByTestId("onboarding-next").click()
      await page.getByTestId("new-bot-form").waitFor()
      await shot(page, `onboarding-create-${theme}`)
      await page.close()
    },
    30_000,
  )
}

test.skipIf(!enabled)(
  "creating a bot from the form calls bots.create",
  async () => {
    const page = await open("scene=newbot", "dark")
    await page.getByTestId("harness-chip-fake").waitFor({ timeout: 15_000 })
    await page.getByTestId("harness-chip-fake").click()
    await page.getByTestId("new-bot-name").fill("Web B Bot")
    await page.getByTestId("create-bot").click()
    const created = await until(
      () => page.evaluate(() => document.body.dataset.created ?? ""),
      (id) => id.length > 0,
    )
    expect(created).toMatch(/.+/)
    await page.close()
  },
  30_000,
)

test.skipIf(!enabled)("no page errors", () => {
  expect(errors).toEqual([])
})
