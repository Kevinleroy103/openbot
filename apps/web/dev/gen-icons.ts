#!/usr/bin/env bun
// Generates the PWA / home-screen icons in apps/web/public/ from the original OpenBot avatar art
// (@openbot/ui Avatar, D6.3): a luminous blob with two capsule eyes on the dark chrome color.
//
//   bun apps/web/dev/gen-icons.ts
//
// Writes icon.svg (rounded, favicon), apple-touch-icon.png (180, full bleed: iOS rounds it) and
// manifest.webmanifest (192 / 512 / maskable PNGs). The manifest is linked from index.html and
// Bun hashes it like any other asset, so its icons are inlined as data: URLs (relative paths would
// point at unhashed files nobody serves). Needs Chromium (OPENBOT_CHROMIUM, default /usr/bin/chromium).
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { chromium } from "playwright-core"
import { Avatar } from "@openbot/ui"

const out = new URL("../public/", import.meta.url).pathname
const BG = "#121212"
const BODY = "#f5f5f5"
const EYES = "#121212"

// The avatar's inner SVG (body path + eyes) with concrete colors instead of theme variables.
const markup = renderToStaticMarkup(createElement(Avatar, { shape: "blob", color: "gray", size: 100 }))
const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(markup)?.[1]
if (!inner) throw new Error("could not extract the avatar SVG")
const art = inner
  .replace(/ class="[^"]*"/g, "")
  .replace(/fill="var\(--ob-avatar-[a-z]+\)"/g, `fill="${BODY}"`)
  .replace(/fill="#ffffff"/g, `fill="${EYES}"`)

/** 512 canvas; the body spans ~60 % (inside the maskable safe zone). `radius` 0 = full bleed. */
const iconSvg = (radius: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="${radius}" fill="${BG}"/><g transform="translate(96 92) scale(3.2)">${art}</g></svg>`

const fullBleed = iconSvg(0)
await Bun.write(`${out}icon.svg`, iconSvg(112))

const browser = await chromium.launch({ executablePath: process.env.OPENBOT_CHROMIUM ?? "/usr/bin/chromium" })
const png = async (size: number): Promise<Buffer> => {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
  await page.setContent(`<html><body style="margin:0"><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(fullBleed).toString("base64")}"></body></html>`)
  await page.waitForFunction(() => document.images[0]?.complete)
  const shot = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: size, height: size } })
  await page.close()
  return shot
}
const [p180, p192, p512] = [await png(180), await png(192), await png(512)]
await browser.close()
await Bun.write(`${out}apple-touch-icon.png`, p180)

const dataUrl = (mime: string, bytes: Uint8Array) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`
const manifest = {
  name: "OpenBot",
  short_name: "OpenBot",
  description: "Your team of always-on Bots",
  id: "/",
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "any",
  background_color: BG,
  theme_color: BG,
  icons: [
    { src: dataUrl("image/png", p192), sizes: "192x192", type: "image/png", purpose: "any" },
    { src: dataUrl("image/png", p512), sizes: "512x512", type: "image/png", purpose: "any" },
    { src: dataUrl("image/png", p512), sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
}
await Bun.write(`${out}manifest.webmanifest`, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`wrote icons and manifest to ${out}`)
