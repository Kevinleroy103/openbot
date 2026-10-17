/**
 * Build the gallery and screenshot it in Chromium (dark + light) via playwright-core.
 *   bun run packages/ui/scripts/screenshot.ts            → packages/ui/test/screenshots/*.png
 * Env: OPENBOT_CHROMIUM (default /usr/bin/chromium).
 */
import { chromium } from "playwright-core"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildGallery } from "./build-gallery.ts"

export const chromiumPath = process.env.OPENBOT_CHROMIUM ?? "/usr/bin/chromium"
export const screenshotDir = new URL("../test/screenshots", import.meta.url).pathname

export interface ShotResult {
  readonly files: ReadonlyArray<string>
  readonly errors: ReadonlyArray<string>
}

/** Scenes rendered by the gallery (`?scene=`); "all" is the full story page. */
export const scenes = ["all", "chat", "details", "editor", "overlays", "settings", "avatars"] as const

export const takeScreenshots = async (options?: { readonly only?: ReadonlyArray<string>; readonly outDir?: string }): Promise<ShotResult> => {
  const work = await mkdtemp(join(tmpdir(), "openbot-ui-gallery-"))
  const outDir = options?.outDir ?? screenshotDir
  const files: string[] = []
  const errors: string[] = []
  try {
    await buildGallery(work)
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const path = new URL(req.url).pathname
        const file = Bun.file(join(work, path === "/" ? "gallery.html" : decodeURIComponent(path)))
        return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 })
      },
    })
    const base = `http://127.0.0.1:${server.port}/gallery.html`
    const browser = await chromium.launch({ executablePath: chromiumPath })
    try {
      for (const scene of scenes) {
        if (options?.only && !options.only.includes(scene)) continue
        for (const theme of ["dark", "light"] as const) {
          const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: scene === "avatars" ? 2 : 1 })
          page.on("pageerror", (e) => errors.push(`${scene}/${theme}: ${e.message}`))
          page.on("console", (m) => {
            if (m.type() === "error") errors.push(`${scene}/${theme}: ${m.text()}`)
          })
          await page.goto(`${base}?theme=${theme}&scene=${scene}&static=1`)
          await page.waitForSelector("[data-gallery-ready]", { timeout: 10_000 })
          await page.evaluate(() => document.fonts.ready)
          await page.waitForTimeout(450)
          const file = join(outDir, `${scene}-${theme}.png`)
          await page.screenshot({ path: file, fullPage: scene === "all" || scene === "avatars" })
          files.push(file)
          await page.close()
        }
      }
    } finally {
      await browser.close()
      await server.stop(true)
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
  return { files, errors }
}

if (import.meta.main) {
  const only = process.argv.slice(2)
  const res = await takeScreenshots(only.length ? { only } : undefined)
  for (const f of res.files) console.log(f)
  for (const e of res.errors) console.error("ERROR", e)
}
