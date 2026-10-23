import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { faviconHost, iconLinks, imageType, makeFavicons, NO_ICON, recolorMonoSvg } from "../src/favicons.ts"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const ICO = new Uint8Array([0x00, 0x00, 0x01, 0x00, 1, 0, 16, 16])
const SVG = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>`)
const HTML = (head: string) => `<!doctype html><html><head><title>x</title>${head}</head><body>hi</body></html>`

/** A fake web: url → response; records every url asked. */
const fakeWeb = (pages: Record<string, { body: string | Uint8Array; type?: string; status?: number }>) => {
  const asked: Array<string> = []
  const fetch = async (url: string) => {
    asked.push(url)
    const page = pages[url]
    if (page === undefined) return new Response("not found", { status: 404 })
    const response = new Response(page.body, { status: page.status ?? 200, headers: { "content-type": page.type ?? "text/html" } })
    Object.defineProperty(response, "url", { value: url })
    return response
  }
  return { fetch, asked }
}

const setup = (pages: Parameters<typeof fakeWeb>[0], clock = { now: 1_000_000 }) => {
  const web = fakeWeb(pages)
  const favicons = makeFavicons({ dir: mkdtempSync(join(tmpdir(), "favicons-")), fetch: web.fetch, now: () => clock.now })
  return { ...web, favicons, clock }
}

describe("favicons", () => {
  test("only domain names are looked up", () => {
    expect(faviconHost("X.com")).toBe("x.com")
    expect(faviconHost("effect.website.")).toBe("effect.website")
    expect(faviconHost("docs.github.com")).toBe("docs.github.com")
    for (const bad of ["127.0.0.1", "192.168.100.12", "localhost", "example.com:8080", "[::1]", "a b.com", "-x.com", "", "x..com"]) {
      expect(faviconHost(bad)).toBeUndefined()
    }
  })

  test("the page's best icon: an SVG, then the size nearest 32 px, never a mask icon", () => {
    const html = HTML(`
      <link rel="mask-icon" href="/pin.svg" color="#000">
      <link rel="icon" href="/favicon-16.png" sizes="16x16">
      <link rel="apple-touch-icon" href="/touch.png">
      <link rel="icon" type="image/png" href="/favicon-32.png?v=1&amp;x=2" sizes="32x32">
      <link rel="shortcut icon" href="/favicon.ico">`)
    expect(iconLinks(html, "https://a.example/").map((l) => l.href)).toEqual([
      "https://a.example/favicon-32.png?v=1&x=2",
      "https://a.example/touch.png",
      "https://a.example/favicon.ico",
      "https://a.example/favicon-16.png",
    ])
    expect(iconLinks(HTML(`<link rel="icon" href="https://cdn.example/i.svg">`), "https://a.example/")[0]?.href).toBe("https://cdn.example/i.svg")
    // links in the body are not the page's icons
    expect(iconLinks(`<html><head></head><body><link rel="icon" href="/x.png"></body></html>`, "https://a.example/")).toEqual([])
  })

  test("an image is known by its bytes; an HTML page is not one", () => {
    expect(imageType(PNG)).toBe("image/png")
    expect(imageType(ICO)).toBe("image/x-icon")
    expect(imageType(SVG)).toBe("image/svg+xml")
    expect(imageType(new TextEncoder().encode("<!doctype html><html>404</html>"))).toBeUndefined()
    // "no icon" is a 1×1 PNG (the apps show the globe for it)
    const ihdr = new DataView(NO_ICON.bytes.buffer, NO_ICON.bytes.byteOffset + 16, 8)
    expect([imageType(NO_ICON.bytes), ihdr.getUint32(0), ihdr.getUint32(4)]).toEqual(["image/png", 1, 1])
  })

  test("fetches the declared icon once, then serves it from the cache", async () => {
    const { favicons, asked } = setup({
      "https://a.example/": { body: HTML(`<link rel="icon" href="/icon.png" sizes="32x32">`) },
      "https://a.example/icon.png": { body: PNG, type: "image/png" },
    })
    const icon = await favicons.get("a.example")
    expect(icon?.type).toBe("image/png")
    expect([...icon!.bytes]).toEqual([...PNG])
    const before = asked.length
    expect((await favicons.get("a.example"))?.type).toBe("image/png")
    expect(asked.length).toBe(before)
  })

  test("falls back to /favicon.ico (by its bytes, whatever the type says), and a soft 404 page is no icon", async () => {
    const { favicons } = setup({
      "https://b.example/": { body: HTML("") },
      "https://b.example/favicon.ico": { body: ICO, type: "application/octet-stream" },
      "https://c.example/": { body: HTML("") },
      "https://c.example/favicon.ico": { body: "<html>not here</html>", type: "text/html" },
    })
    expect((await favicons.get("b.example"))?.type).toBe("image/x-icon")
    expect(await favicons.get("c.example")).toBeUndefined()
  })

  test("a site without an icon is asked again only after a day; a stale icon outlives an unreachable site", async () => {
    const clock = { now: 1_000_000 }
    const pages: Parameters<typeof fakeWeb>[0] = { "https://d.example/": { body: HTML("") } }
    const { favicons, asked } = setup(pages, clock)
    expect(await favicons.get("d.example")).toBeUndefined()
    const after = asked.length
    expect(await favicons.get("d.example")).toBeUndefined()
    expect(asked.length).toBe(after)
    clock.now += 25 * 60 * 60 * 1000
    pages["https://d.example/favicon.ico"] = { body: PNG, type: "image/png" }
    expect((await favicons.get("d.example"))?.type).toBe("image/png")
    // a week later the site is down: the icon it had stays
    clock.now += 8 * 24 * 60 * 60 * 1000
    delete pages["https://d.example/"]
    delete pages["https://d.example/favicon.ico"]
    expect((await favicons.get("d.example"))?.type).toBe("image/png")
  })

  test("a subdomain without an icon of its own gets its parent domain's", async () => {
    const { favicons } = setup({
      "https://docs.e.example/": { body: HTML("") },
      "https://e.example/": { body: HTML(`<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(new TextDecoder().decode(SVG))}">`) },
    })
    expect((await favicons.get("docs.e.example"))?.type).toBe("image/svg+xml")
  })

  test("an icon over 256 KB is not taken", async () => {
    const big = new Uint8Array(300 * 1024)
    big.set(PNG)
    const { favicons } = setup({
      "https://f.example/": { body: HTML(`<link rel="icon" href="/big.png">`) },
      "https://f.example/big.png": { body: big, type: "image/png" },
    })
    expect(await favicons.get("f.example")).toBeUndefined()
  })

  test("a one-colour SVG is redrawn to show on the screen it is asked for; others are left alone", () => {
    const octocat = `<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" d="M16 0Z" fill="#24292E"/></svg>`
    const dark = recolorMonoSvg(octocat, "dark")!
    expect(dark).toContain(`fill="#e8e8e8"`)
    expect(dark).toContain(`fill="none"`)
    expect(dark).toContain(`fill-rule="evenodd"`)
    expect(recolorMonoSvg(octocat, "light")).toBeUndefined()
    // drawn in the default black: the root gets the new fill
    expect(recolorMonoSvg(`<svg viewBox="0 0 8 8"><circle r="4"/></svg>`, "dark")).toBe(`<svg viewBox="0 0 8 8" fill="#e8e8e8"><circle r="4"/></svg>`)
    expect(recolorMonoSvg(`<svg><style>path{fill:#fff}</style><path d="M0Z"/></svg>`, "light")).toContain("fill:#2a2a2a")
    // colours, gradients and colours it cannot read stay as they are
    expect(recolorMonoSvg(`<svg><path fill="#ff0000" d="M0Z"/></svg>`, "dark")).toBeUndefined()
    expect(recolorMonoSvg(`<svg><linearGradient id="g"/><path fill="url(#g)" d="M0Z"/></svg>`, "dark")).toBeUndefined()
    expect(recolorMonoSvg(`<svg><path fill="rebeccapurple" d="M0Z"/></svg>`, "dark")).toBeUndefined()
  })
})
