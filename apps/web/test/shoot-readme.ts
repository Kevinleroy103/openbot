/**
 * The README's screenshots (`docs/images/*.webp`), taken against the dev mock: made-up Bots and chats,
 * nothing from a real OpenBot. Run it again after UI changes:
 *
 *   bun apps/web/test/shoot-readme.ts [name...]
 *
 * Env: OPENBOT_CHROMIUM (default /usr/bin/chromium). Needs ImageMagick (`magick`) for the WebP files.
 */
import { chromium, type Browser, type Page } from "playwright-core"
import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromiumPath, computerTab, desktopLive, openComputers, startMock } from "./shoot.ts"
import { IPHONE, openDevice } from "./shoot-mobile.ts"

const OUT = new URL("../../../docs/images/", import.meta.url).pathname

type Theme = "dark" | "light"

interface Shot {
  readonly name: string
  readonly themes: ReadonlyArray<Theme>
  readonly route: string
  readonly phone?: boolean
  /** Window height (default 900; the width is always 1440). */
  readonly height?: number
  readonly act?: (page: Page) => Promise<void>
}

const SHOTS: ReadonlyArray<Shot> = [
  // the hero: Bots in the sidebar, a chat with a routine, a table of Bots on three harnesses and an approval
  { name: "chat", themes: ["dark", "light"], route: "#/c/cnv_chief", height: 1040 },
  { name: "group", themes: ["dark"], route: "#/c/cnv_launch" },
  {
    name: "computer",
    themes: ["dark"],
    route: "#/c/cnv_chief",
    act: async (page) => {
      await computerTab(page)
      await page.getByTestId("screen-thumbnail").click()
      await desktopLive(page)
    },
  },
  {
    name: "harnesses",
    themes: ["dark"],
    route: "#/c/cnv_chief",
    act: async (page) => {
      await openComputers(page)
      await page.getByTestId("settings-nav-harnesses").click()
      await page.waitForTimeout(600)
    },
  },
  { name: "phone", themes: ["dark"], route: "#/c/cnv_chief", phone: true },
]

const webp = (png: string, target: string) => {
  const done = Bun.spawnSync(["magick", png, "-quality", "88", "-define", "webp:method=6", target])
  if (done.exitCode !== 0) throw new Error(`magick: ${done.stderr.toString()}`)
}

const desktopPage = async (browser: Browser, url: string, theme: Theme, route: string, height = 900) => {
  const context = await browser.newContext({ viewport: { width: 1440, height }, deviceScaleFactor: 2, colorScheme: theme })
  await context.addInitScript((t) => localStorage.setItem("openbot.theme", t), theme)
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  await page.goto(`${url}/${route}`)
  await page.waitForSelector('nav[aria-label="Bots"] [data-row], nav[aria-label="Bots"] [data-bot]', { timeout: 15_000 })
  await page.evaluate(() => document.fonts.ready)
  return { page, close: () => context.close() }
}

if (import.meta.main) {
  const only = process.argv.slice(2)
  mkdirSync(OUT, { recursive: true })
  const mock = await startMock()
  const browser = await chromium.launch({ executablePath: chromiumPath })
  const scratch = join(tmpdir(), `openbot-readme-${process.pid}.png`)
  try {
    for (const shot of SHOTS.filter((s) => only.length === 0 || only.includes(s.name))) {
      for (const theme of shot.themes) {
        const opened = shot.phone ? await openDevice(browser, mock.url, IPHONE, theme, shot.route) : await desktopPage(browser, mock.url, theme, shot.route, shot.height)
        await shot.act?.(opened.page)
        // let favicons, avatars and the live desktop settle
        await opened.page.waitForTimeout(800)
        await opened.page.screenshot({ path: scratch })
        const target = join(OUT, `${shot.name}${shot.themes.length > 1 ? `-${theme}` : ""}.webp`)
        webp(scratch, target)
        console.log(`${target} (${Math.round(Bun.file(target).size / 1024)} KB)`)
        await opened.close()
      }
    }
  } finally {
    rmSync(scratch, { force: true })
    await browser.close()
    await mock.stop()
  }
}
