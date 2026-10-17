// E2E: a bot sends files with `send_file` (fake harness `tool: send_file {...}` through the REAL
// gateway, local node transfer and attachment store) and the chat renders them Grok-like: an image
// thumbnail that opens a lightbox, an inline video (metadata over HTTP ranges, first frame as
// poster), audio, a PDF card with Open, and a file card with Download. Desktop and phone layouts.
// Real brain, fake harness only. Screenshots: e2e/screenshots/e2e-attachments-*.png.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Browser } from "playwright-core"
import type { Bot } from "@openbot/contracts"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import { type AppPage, type Brain, connectRpc, hasChromium, launchBrowser, openApp, type Rpc, send, shotsDir, startBrain, waitIdle } from "./brain.ts"

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** A real RGB PNG with a diagonal gradient (so the thumbnail and lightbox show something). */
const makePng = (width: number, height: number): Uint8Array => {
  const raw = new Uint8Array((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = Math.round((x / width) * 255)
      raw[row + 2 + x * 3] = Math.round((y / height) * 255)
      raw[row + 3 + x * 3] = 160
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, data.length)
    out.set(new TextEncoder().encode(type), 4)
    out.set(data, 8)
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
    return out
  }
  const ihdr = new Uint8Array(13)
  new DataView(ihdr.buffer).setUint32(0, width)
  new DataView(ihdr.buffer).setUint32(4, height)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    png.set(p, at)
    at += p.length
  }
  return png
}

const ffmpeg = Bun.which("ffmpeg")

/** A short real video (ffmpeg test pattern) when ffmpeg is installed, else MP4-looking bytes. */
const makeMedia = (dir: string): { readonly video: boolean; readonly audio: boolean } => {
  let video = false
  let audio = false
  if (ffmpeg !== null) {
    const v = Bun.spawnSync([ffmpeg, "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(dir, "cache-demo.mp4")])
    video = v.exitCode === 0
    const a = Bun.spawnSync([ffmpeg, "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", join(dir, "beep.wav")])
    audio = a.exitCode === 0
  }
  if (!video) {
    const bytes = new Uint8Array(4096)
    bytes.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
    writeFileSync(join(dir, "cache-demo.mp4"), bytes)
  }
  if (!audio) writeFileSync(join(dir, "beep.wav"), new TextEncoder().encode("RIFF$\u0000\u0000\u0000WAVEfmt "))
  return { video, audio }
}

describe.skipIf(!hasChromium)("e2e: files a bot sends", () => {
  let brain: Brain
  let browser: Browser
  let rpc: Rpc
  let app: AppPage
  let bot: Bot
  let media: { readonly video: boolean; readonly audio: boolean }

  beforeAll(async () => {
    brain = await startBrain()
    browser = await launchBrowser()
    rpc = await connectRpc(brain)
    bot = await rpc.call((c) => c["bots.create"]({ name: "Reel", harness: { kind: "fake" }, clientNonce: "e2e-attachments" }))
    // what the bot "rendered" in its workspace on the local node
    const out = join(brain.dataDir, "bots", bot.id, "workspace", "output")
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, "cover.png"), makePng(960, 540))
    media = makeMedia(out)
    writeFileSync(join(out, "report.pdf"), "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n")
    writeFileSync(join(out, "site.zip"), new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]))
  }, 60_000)

  afterAll(async () => {
    await app?.context.close()
    await rpc?.close()
    await browser?.close()
    await brain?.stop()
  })

  test("image, video, audio, PDF and file cards render in the bot's message; the image opens a lightbox", async () => {
    app = await openApp(browser, brain, { theme: "dark", route: `#/c/${bot.directConversationId}` })
    const { page } = app
    await send(
      page,
      "Reel",
      `tool: send_file {"paths":["output/cover.png","output/cache-demo.mp4","output/beep.wav","output/report.pdf","output/site.zip"],"caption":"Rendered: cover, demo and sources"}`,
    )
    const transcript = page.getByTestId("transcript")
    const files = transcript.getByTestId("attachments").last()
    await files.locator('[data-attachment="image"] img').waitFor({ timeout: 20_000 })
    await waitIdle(page, 20_000)
    await transcript.getByText("Rendered: cover, demo and sources", { exact: true }).waitFor()

    // the image loaded through the cookie-authenticated route
    const image = files.locator('[data-attachment="image"] img')
    await page.waitForFunction((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0, await image.elementHandle())
    expect(await image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(960)
    const imageBox = (await files.locator('[data-attachment="image"]').boundingBox())!
    expect(imageBox.width).toBeLessThanOrEqual(361)
    expect(Math.round(imageBox.height)).toBe(Math.round((imageBox.width * 540) / 960))

    // inline video: controls, metadata only, plays inline (iOS), first frame as poster
    const video = files.locator('[data-attachment="video"] video')
    expect(await video.getAttribute("preload")).toBe("metadata")
    expect(await video.getAttribute("playsinline")).not.toBeNull()
    expect(await video.getAttribute("controls")).not.toBeNull()
    expect(await video.getAttribute("src")).toMatch(/^\/api\/attachments\/[\w-]+#t=0\.1$/)
    if (media.video) {
      await page.waitForFunction((el) => (el as HTMLVideoElement).readyState >= 1, await video.elementHandle(), { timeout: 15_000 })
      expect(await video.evaluate((el) => Math.round((el as HTMLVideoElement).duration))).toBe(2)
    }
    expect(await files.locator('[data-attachment="audio"] audio').getAttribute("controls")).not.toBeNull()

    // PDF: Open in a new tab + Download; other files: a card with Download
    const pdf = files.locator('[data-attachment="pdf"]')
    await pdf.getByText("report.pdf").waitFor()
    expect(await pdf.getByRole("link", { name: "Open" }).getAttribute("target")).toBe("_blank")
    const zip = files.locator('[data-attachment="file"]')
    await zip.getByText("site.zip").waitFor()
    await zip.getByText("ZIP · 22 bytes").waitFor()
    const download = zip.getByRole("link", { name: "Download site.zip" })
    expect(await download.getAttribute("href")).toMatch(/^\/api\/attachments\/[\w-]+\?download=1$/)
    expect(await download.getAttribute("download")).toBe("site.zip")
    await app.shot("e2e-attachments-01-desktop")

    // lightbox
    await files.locator('[data-attachment="image"]').click()
    const lightbox = page.getByTestId("lightbox")
    await lightbox.waitFor()
    await lightbox.getByText("cover.png").waitFor()
    expect(await lightbox.getByRole("link", { name: "Download cover.png" }).getAttribute("href")).toContain("?download=1")
    await app.shot("e2e-attachments-02-lightbox")
    await page.keyboard.press("Escape")
    await lightbox.waitFor({ state: "detached" })
    expect(app.errors).toEqual([])
  }, 90_000)

  test("phone: media fits the message column (≤ 85 % of the screen) and the video plays inline", async () => {
    const context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      colorScheme: "dark",
    })
    try {
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      await page.goto(brain.loginUrl)
      await page.goto(`${brain.base}/#/c/${bot.directConversationId}`)
      const files = page.getByTestId("attachments").last()
      await files.locator('[data-attachment="video"] video').waitFor()
      await files.locator('[data-attachment="video"]').scrollIntoViewIfNeeded()
      for (const kind of ["image", "video", "audio", "pdf", "file"]) {
        const box = (await files.locator(`[data-attachment="${kind}"]`).boundingBox())!
        expect(box.width).toBeLessThanOrEqual(393 * 0.85 + 1)
        expect(box.x).toBeGreaterThanOrEqual(0)
      }
      expect(await files.locator("video").getAttribute("playsinline")).not.toBeNull()
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(shotsDir, "e2e-attachments-03-phone.png") })
    } finally {
      await context.close()
    }
  }, 60_000)
})
