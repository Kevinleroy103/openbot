// E2E: pinned tiles' names use the room their row has and truncate only in a full row (desktop
// sidebar and phone Home, 1 to 7 pins). Real brain, fake harness only. Screenshots: e2e-pins-*.png.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Bot } from "@openbot/contracts"
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
  shotsDir,
  startBrain,
} from "./brain.ts"

const NAMES = [
  "Chief of Staff",
  "Engineering Lead",
  "Technical Video Creator",
  "Ada",
  "Competitor Research",
  "Bo",
  "News digest",
] as const

const PHONE = {
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
} as const

interface Tile {
  readonly name: string
  readonly truncated: boolean
  /** Whether the tiles of this tile's row (and the gaps between them) fill the row. */
  readonly rowFull: boolean
}

describe.skipIf(!hasChromium)("e2e: pinned tiles", () => {
  let brain: Brain
  let browser: Browser
  let rpc: Rpc
  const bots: Array<Bot> = []

  beforeAll(async () => {
    brain = await startBrain()
    browser = await launchBrowser()
    rpc = await connectRpc(brain)
    for (const name of NAMES) {
      bots.push(
        await rpc.call((c) =>
          c["bots.create"]({ name, harness: { kind: "fake" }, clientNonce: `pins-${name}`, introduce: false }),
        ),
      )
    }
  }, 60_000)

  afterAll(async () => {
    await rpc?.close()
    await browser?.close()
    await brain?.stop()
  })

  const pinFirst = async (count: number) => {
    for (const [index, bot] of bots.entries()) {
      const patch = index < count ? { pinned: true, sidebarOrder: index } : { pinned: false, sidebarOrder: null }
      await rpc.call((c) => c["bots.update"]({ botId: bot.id, patch }))
    }
  }

  const tiles = (app: AppPage): Promise<ReadonlyArray<Tile>> =>
    app.page.locator('[aria-label="Pinned Bots"]').evaluate((el) => {
      const style = getComputedStyle(el)
      const room = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const gap = parseFloat(style.columnGap)
      const cells = [...el.children] as Array<HTMLElement>
      const rowWidth = (top: number) => {
        const row = cells.filter((c) => c.offsetTop === top)
        return row.reduce((sum, c) => sum + c.getBoundingClientRect().width, 0) + gap * (row.length - 1)
      }
      return cells.map((cell) => {
        const tile = cell.querySelector<HTMLElement>("[data-bot]")!
        const label = [...tile.children].find((c) => c.textContent === tile.title)!
        return {
          name: tile.title,
          truncated: label.scrollWidth > label.clientWidth,
          rowFull: rowWidth(cell.offsetTop) >= room - 1,
        }
      })
    })

  const shoot = async (app: AppPage, name: string) => {
    const box = (await app.page.locator('[aria-label="Pinned Bots"]').boundingBox())!
    const nav = (await app.page.getByRole("navigation", { name: "Bots" }).boundingBox())!
    await app.page.screenshot({
      path: `${shotsDir}/${name}.png`,
      clip: { x: nav.x, y: nav.y, width: nav.width, height: box.y + box.height - nav.y + 8 },
    })
  }

  for (const [layout, context] of [
    ["desktop", undefined],
    ["phone", PHONE],
  ] as const) {
    test(`${layout}: names fill their row and truncate only in a full one`, async () => {
      const app = await openApp(browser, brain, { theme: "dark", ...(context && { context }) })
      for (const count of [1, 2, 3, NAMES.length]) {
        await pinFirst(count)
        const names = NAMES.slice(0, count).join()
        const shown = await eventually(
          () => tiles(app),
          (ts) => ts.map((t) => t.name).join() === names,
          { label: `${count} pins` },
        )
        await shoot(app, `e2e-pins-${layout}-${count}`)
        const truncated = shown.filter((t) => t.truncated)
        if (count <= 2) expect(truncated).toEqual([])
        expect(truncated.filter((t) => !t.rowFull)).toEqual([])
        // three long names don't fit in the default 280 px sidebar
        if (layout === "desktop" && count === 3)
          expect(truncated.map((t) => t.name)).toContain("Technical Video Creator")
      }
      expect(app.errors).toEqual([])
      await app.context.close()
    }, 60_000)
  }
})
