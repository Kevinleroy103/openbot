/**
 * Favicons for links in chats (`GET /api/favicon?host=example.com`, signed in). The brain fetches a
 * site's icon itself, so which sites the chats link to stays between the owner and those sites (no
 * third-party favicon service).
 *
 * - The icon: the best `<link rel="…icon…">` on the site's home page (an SVG, else the size nearest a
 *   retina 16 px), else `/favicon.ico`; a subdomain without one gets its parent domain's.
 * - Only `https://<hostname>/` is asked (no IP addresses, no ports), the page is read up to 512 KB and
 *   an icon up to 256 KB, 5 s each; only an image ever comes back (checked by its bytes, so a soft
 *   404 page at `/favicon.ico` is not one).
 * - Redirects are followed by hand, at most 5; every host asked, the first and each redirect's, must
 *   resolve only to public addresses, and the connection goes to the address that was checked.
 * - Cached in `<data>/favicons`: an icon for a week, "this site has none" for a day; a stale icon is
 *   served again when the site cannot be reached.
 */
import { lookup as dnsLookup } from "node:dns/promises"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { BlockList, isIP } from "node:net"
import { join } from "node:path"

export interface Icon {
  readonly bytes: Uint8Array
  readonly type: string
}

/** The answer for a site without an icon: a 1×1 transparent PNG. A 404 would show up as an error in
 * the browser's console for every such link; the apps take a 1-pixel image as "no icon" (the globe). */
export const NO_ICON: Icon = {
  bytes: Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0)),
  type: "image/png",
}

export interface FaviconsOptions {
  readonly dir: string
  /** One request to `url`, connecting to `address` (already checked). */
  readonly fetch?: (url: string, address: string, init: RequestInit) => Promise<Response>
  readonly resolve?: (host: string) => Promise<ReadonlyArray<string>>
  readonly now?: () => number
}

const ICON_TTL_MS = 7 * 24 * 60 * 60 * 1000
const NONE_TTL_MS = 24 * 60 * 60 * 1000
const PAGE_BYTES = 512 * 1024
const ICON_BYTES = 256 * 1024
const TIMEOUT_MS = 5_000
const MAX_REDIRECTS = 5
/** Icon links tried (best first) before `/favicon.ico`. */
const MAX_CANDIDATES = 3
const HEADERS = {
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0 Safari/537.36",
  "accept-language": "en",
}

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/** A link's hostname, lowercased; undefined for anything that is not a domain name (IPs, ports, junk). */
export const faviconHost = (raw: string): string | undefined => {
  const host = raw.trim().toLowerCase().replace(/\.$/, "")
  if (!HOST.test(host)) return undefined
  // a top-level domain has a letter: no IPv4 addresses
  return /[a-z]/.test(host.slice(host.lastIndexOf(".") + 1)) ? host : undefined
}

const BLOCKED = new BlockList()
for (const [net, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4")
}
// ::/96 holds :: and ::1 and the IPv4-compatible forms; IPv4-mapped ones are checked against the IPv4 rules
for (const [net, prefix] of [["::", 96], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv6")
}

/** Whether the brain must not connect to `address`: loopback, private, link-local, CGNAT, multicast, reserved, or not an IP. */
export const blockedAddress = (address: string): boolean => {
  const ip = address.replace(/%.*$/, "")
  const family = isIP(ip)
  return family === 0 || BLOCKED.check(ip, family === 4 ? "ipv4" : "ipv6")
}

const resolveHost = async (host: string): Promise<ReadonlyArray<string>> => (await dnsLookup(host, { all: true })).map((a) => a.address)

const pinnedFetch = (url: string, address: string, init: RequestInit): Promise<Response> => {
  const target = new URL(url)
  const serverName = target.hostname
  target.hostname = isIP(address) === 6 ? `[${address}]` : address
  return fetch(target, { ...init, tls: { serverName } })
}

// ---------------------------------------------------------------------------- picking the icon

export interface IconLink {
  readonly href: string
  readonly score: number
}

const attrsOf = (tag: string): Map<string, string> => {
  const attrs = new Map<string, string>()
  for (const m of tag.matchAll(/([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attrs.set(m[1]!.toLowerCase(), (m[2] ?? m[3] ?? m[4] ?? "").replaceAll("&amp;", "&").trim())
  }
  return attrs
}

/** How well an icon suits a 16 px spot on a retina screen (32 px): an SVG best, then the nearest size. */
const scoreOf = (rel: string, sizes: string, type: string, href: string): number => {
  if (type.includes("svg") || /\.svg(?:[?#]|$)/i.test(href) || sizes === "any") return 100
  const px = Math.max(0, ...[...sizes.matchAll(/(\d+)x(\d+)/gi)].map((m) => Number(m[1])))
  const size = px > 0 ? px : rel.includes("apple-touch-icon") ? 180 : 0
  if (size === 0) return 60 // usually an .ico with several sizes
  return size >= 32 ? 90 - Math.log2(size / 32) * 8 : 40 + size
}

/** The icons a page declares, best first (`mask-icon` aside: it is a one-colour Safari pin). */
export const iconLinks = (html: string, base: string): ReadonlyArray<IconLink> => {
  const end = html.search(/<\/head>/i)
  const head = end < 0 ? html : html.slice(0, end)
  const links: Array<IconLink> = []
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attrsOf(m[0])
    const rel = (attrs.get("rel") ?? "").toLowerCase()
    const href = attrs.get("href") ?? ""
    if (!/\bicon\b|apple-touch-icon/.test(rel) || rel.includes("mask-icon") || href === "") continue
    try {
      const url = new URL(href, base)
      if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "data:") continue
      links.push({ href: url.href, score: scoreOf(rel, attrs.get("sizes") ?? "", (attrs.get("type") ?? "").toLowerCase(), url.href) })
    } catch {}
  }
  return links.sort((a, b) => b.score - a.score)
}

/** The image type of `bytes` by its first bytes (an SVG by its text); undefined when it is not an image. */
export const imageType = (bytes: Uint8Array): string | undefined => {
  const b = bytes
  if (b.length < 4) return undefined
  if (b[0] === 0x00 && b[1] === 0x00 && (b[2] === 0x01 || b[2] === 0x02) && b[3] === 0x00) return "image/x-icon"
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif"
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg"
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return "image/webp"
  const text = new TextDecoder().decode(b.subarray(0, 1024)).trimStart().toLowerCase()
  if (text.startsWith("<svg") || ((text.startsWith("<?xml") || text.startsWith("<!--")) && text.includes("<svg"))) return "image/svg+xml"
  return undefined
}

// ---------------------------------------------------------------------------- one-colour SVGs

const NAMED: Record<string, readonly [number, number, number]> = { black: [0, 0, 0], white: [255, 255, 255] }

const rgbOf = (value: string): readonly [number, number, number] | undefined => {
  const v = value.trim().toLowerCase()
  if (v in NAMED) return NAMED[v]
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1]
  if (hex !== undefined && (hex.length === 3 || hex.length === 4)) return [0, 1, 2].map((i) => parseInt(hex[i]! + hex[i]!, 16)) as unknown as [number, number, number]
  if (hex !== undefined && (hex.length === 6 || hex.length === 8)) return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as unknown as [number, number, number]
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v)
  return rgb === null ? undefined : [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
}

const COLOUR = /((?:fill|stroke|stop-color|color)\s*(?:=\s*["']|:\s*))([^"';}]+)/gi

/**
 * An SVG icon drawn in one dark colour (GitHub's octocat), redrawn light for a dark screen; or one in
 * one light colour, redrawn dark for a light one. Undefined when it has other colours, gradients or
 * images, or already suits the screen. For clients that cannot look at the icon's pixels (the
 * iPhone app); the web app picks its tile from them instead.
 */
export const recolorMonoSvg = (svg: string, screen: "dark" | "light"): string | undefined => {
  if (/<(?:linear|radial)Gradient|<image|<pattern/i.test(svg)) return undefined
  const colours: Array<readonly [number, number, number]> = []
  for (const m of svg.matchAll(COLOUR)) {
    const value = m[2]!.trim().toLowerCase()
    if (value === "none" || value === "transparent" || value === "currentcolor" || value === "inherit") continue
    const rgb = rgbOf(value)
    if (rgb === undefined) return undefined
    colours.push(rgb)
  }
  const lum = ([r, g, b]: readonly [number, number, number]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  if (colours.some(([r, g, b]) => (Math.max(r, g, b) - Math.min(r, g, b)) / 255 > 0.2)) return undefined
  // no colour given at all: drawn in the default black
  const tones = colours.length === 0 ? [0] : colours.map(lum)
  const to = screen === "dark" && tones.every((t) => t < 0.3) ? "#e8e8e8" : screen === "light" && tones.every((t) => t > 0.75) ? "#2a2a2a" : undefined
  if (to === undefined) return undefined
  const redrawn = svg.replace(COLOUR, (all, lead: string, value: string) => (rgbOf(value) === undefined ? all : `${lead}${to}`))
  // shapes without a fill of their own take the root's
  return redrawn.replace(/<svg\b([^>]*)>/i, (tag, attrs: string) => (/\bfill\s*=/.test(attrs) ? tag : `<svg${attrs} fill="${to}">`))
}

// ---------------------------------------------------------------------------- fetching

/** The body up to `max` bytes: the rest is cut (`truncate`) or the whole read refused. */
const readCapped = async (response: Response, max: number, truncate: boolean): Promise<Uint8Array | undefined> => {
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
    if (total > max) {
      await reader.cancel().catch(() => {})
      if (!truncate) return undefined
      break
    }
  }
  const out = new Uint8Array(Math.min(total, max))
  let at = 0
  for (const chunk of chunks) {
    const part = chunk.subarray(0, out.length - at)
    out.set(part, at)
    at += part.length
    if (at >= out.length) break
  }
  return out
}

const dataIcon = (href: string): Icon | undefined => {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(href)
  if (m === null) return undefined
  const bytes = m[2] ? Uint8Array.from(atob(m[3]!), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]!))
  const type = imageType(bytes)
  return type === undefined || bytes.length > ICON_BYTES ? undefined : { bytes, type }
}

export const makeFavicons = (options: FaviconsOptions) => {
  const fetchFn = options.fetch ?? pinnedFetch
  const resolve = options.resolve ?? resolveHost
  const now = options.now ?? Date.now
  const inFlight = new Map<string, Promise<Icon | undefined>>()

  /** The response at `url` after its redirects, and the url it came from; throws for a host it must not ask. */
  const request = async (url: string, accept: string): Promise<{ readonly response: Response; readonly url: string }> => {
    const signal = AbortSignal.timeout(TIMEOUT_MS)
    for (let hop = 0; ; hop++) {
      const target = new URL(url)
      if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error(`not fetched: ${url}`)
      const host = target.hostname.replace(/^\[(.*)\]$/, "$1")
      const addresses = isIP(host) === 0 ? await resolve(host) : [host]
      if (addresses.some(blockedAddress)) throw new Error(`not fetched: ${url}`)
      const response = await fetchFn(url, addresses[0]!, { redirect: "manual", signal, headers: { ...HEADERS, accept, host: target.host } })
      const location = response.headers.get("location")
      if (response.status < 300 || response.status > 399 || location === null) return { response, url }
      await response.body?.cancel().catch(() => {})
      if (hop === MAX_REDIRECTS) throw new Error(`too many redirects: ${url}`)
      url = new URL(location, url).href
    }
  }

  const fetchIcon = async (href: string): Promise<Icon | undefined> => {
    try {
      if (href.startsWith("data:")) return dataIcon(href)
      const { response } = await request(href, "image/avif,image/webp,image/svg+xml,image/*;q=0.8,*/*;q=0.5")
      if (!response.ok) return undefined
      const bytes = await readCapped(response, ICON_BYTES, false)
      const type = bytes === undefined ? undefined : imageType(bytes)
      return bytes === undefined || type === undefined ? undefined : { bytes, type }
    } catch {
      return undefined
    }
  }

  /** The site's own icon, fetched now. */
  const fetchSite = async (host: string): Promise<Icon | undefined> => {
    let candidates: ReadonlyArray<IconLink> = []
    try {
      const { response, url } = await request(`https://${host}/`, "text/html,application/xhtml+xml")
      if (response.ok && (response.headers.get("content-type") ?? "text/html").includes("html")) {
        const page = await readCapped(response, PAGE_BYTES, true)
        if (page !== undefined) candidates = iconLinks(new TextDecoder().decode(page), url)
      } else await response.body?.cancel().catch(() => {})
    } catch {}
    for (const link of candidates.slice(0, MAX_CANDIDATES)) {
      const icon = await fetchIcon(link.href)
      if (icon !== undefined) return icon
    }
    return fetchIcon(`https://${host}/favicon.ico`)
  }

  const cachePaths = (host: string) => ({ meta: join(options.dir, `${host}.json`), bytes: join(options.dir, `${host}.icon`) })

  const readCache = async (host: string): Promise<{ readonly at: number; readonly icon: Icon | undefined } | undefined> => {
    try {
      const paths = cachePaths(host)
      const meta = JSON.parse(await readFile(paths.meta, "utf8")) as { at: number; type?: string }
      if (meta.type === undefined) return { at: meta.at, icon: undefined }
      return { at: meta.at, icon: { bytes: new Uint8Array(await readFile(paths.bytes)), type: meta.type } }
    } catch {
      return undefined
    }
  }

  const writeCache = async (host: string, icon: Icon | undefined) => {
    try {
      await mkdir(options.dir, { recursive: true })
      const paths = cachePaths(host)
      if (icon !== undefined) await writeFile(paths.bytes, icon.bytes)
      await writeFile(paths.meta, JSON.stringify(icon === undefined ? { at: now() } : { at: now(), type: icon.type }))
    } catch {}
  }

  const lookup = async (host: string, parentOk: boolean): Promise<Icon | undefined> => {
    const cached = await readCache(host)
    if (cached !== undefined && now() - cached.at < (cached.icon === undefined ? NONE_TTL_MS : ICON_TTL_MS)) {
      if (cached.icon !== undefined || !parentOk) return cached.icon
    } else {
      const icon = (await fetchSite(host)) ?? cached?.icon
      await writeCache(host, icon)
      if (icon !== undefined) return icon
    }
    // docs.example.com without an icon of its own: example.com's
    const labels = host.split(".")
    return parentOk && labels.length > 2 ? get(labels.slice(1).join("."), false) : undefined
  }

  const get = (host: string, parentOk = true): Promise<Icon | undefined> => {
    const key = `${host}|${parentOk}`
    const running = inFlight.get(key)
    if (running !== undefined) return running
    const next = lookup(host, parentOk).finally(() => inFlight.delete(key))
    inFlight.set(key, next)
    return next
  }

  return { get: (host: string) => get(host) }
}
