// Wire formats of the browser-facing live-view sockets (architecture §4.8, §5.5; D1.7).
//
// The web app cannot import `@openbot/node-protocol` (not a declared dependency, and it is not meant for
// browsers' bundle size), so this file MIRRORS the exact formats that `packages/brain-nodes/src/Computer.ts`
// relays verbatim from the node (`packages/node-protocol/src/streams.ts`, `schemas.ts`). Keep them in sync.
//
// ── /ws/computer/:botId?mode=view|control  (same origin, cookie auth) ─────────────────────────────────
//   server → client, BINARY frame (one per screencast frame), big-endian:
//       [u32 N][N bytes UTF-8 JSON ScreencastFrameMeta][image bytes (image/jpeg | image/png)]
//   server → client, TEXT frame: ScreencastNotice JSON
//       {"_tag":"Ended","reason":"…"}   the stream stopped (the socket then closes with 1011)
//       {"_tag":"Lease","holder":"user"|"bot"}   sent on join and on every lease change
//       {"_tag":"Url","url":"…","title":"…"}     the active tab's page
//   client → server, TEXT frame (only on a `mode=control` socket while the user holds the lease):
//       BrowserInputEvent JSON (below). Coordinates are CSS pixels of the page viewport
//       (`meta.viewportWidth × meta.viewportHeight`), which is what CDP `Input.dispatchMouseEvent` expects.
//   Close codes: 1000 "control released" (control sockets after Stop), 1011 "screen stream ended"
//   (reconnect for a fresh stream). Pre-upgrade refusals are plain HTTP (404 unknown bot, 409 no live
//   view, 403 "Take control first", 503 node offline), which a browser only sees as a failed socket.
//
// ── /ws/terminal/:botId?cols=&rows=  (same origin, cookie auth; `pty.open` in the bot's workspace) ────
//   BINARY frames: terminal bytes, both directions. We send keystrokes up as UTF-8 BINARY frames (the
//   brain also maps any non-control TEXT frame to bytes, but the node itself ignores text keystrokes).
//   TEXT client → server: {"resize":{"cols":120,"rows":40}}
//   TEXT server → client: {"exit":0,"signal":null} when the shell exits; {"error":"…"} then close 1011.

// ------------------------------------------------------------------------------------- screencast

export interface ScreencastFrameMeta {
  readonly seq: number
  /** image/jpeg or image/png */
  readonly mime: string
  /** Frame size in device pixels. */
  readonly width: number
  readonly height: number
  /** CSS-pixel viewport the input coordinates refer to. */
  readonly viewportWidth: number
  readonly viewportHeight: number
  /** ms since epoch. */
  readonly timestamp: number
}

export type ScreencastNotice =
  | { readonly _tag: "Ended"; readonly reason: string }
  | { readonly _tag: "Lease"; readonly holder: "user" | "bot" }
  | { readonly _tag: "Url"; readonly url: string; readonly title: string }

const MAX_META_BYTES = 64 * 1024
const utf8 = new TextDecoder()

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

/** Inverse of node-protocol `encodeScreencastFrame`; `undefined` for malformed frames. */
export const decodeScreencastFrame = (buffer: ArrayBuffer): { readonly meta: ScreencastFrameMeta; readonly image: Uint8Array } | undefined => {
  if (buffer.byteLength < 4) return undefined
  const n = new DataView(buffer).getUint32(0, false)
  if (n > MAX_META_BYTES || 4 + n > buffer.byteLength) return undefined
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(utf8.decode(new Uint8Array(buffer, 4, n))) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (typeof raw !== "object" || raw === null) return undefined
  const { seq, mime, width, height, viewportWidth, viewportHeight, timestamp } = raw
  if (!isNum(seq) || typeof mime !== "string" || !isNum(width) || !isNum(height)) return undefined
  return {
    meta: {
      seq,
      mime,
      width,
      height,
      viewportWidth: isNum(viewportWidth) && viewportWidth > 0 ? viewportWidth : width,
      viewportHeight: isNum(viewportHeight) && viewportHeight > 0 ? viewportHeight : height,
      timestamp: isNum(timestamp) ? timestamp : Date.now(),
    },
    image: new Uint8Array(buffer, 4 + n),
  }
}

/** Parse a text frame from the viewer socket; unknown shapes return `undefined`. */
export const decodeScreencastNotice = (text: string): ScreencastNotice | undefined => {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    switch (raw?.["_tag"]) {
      case "Ended":
        return { _tag: "Ended", reason: String(raw["reason"] ?? "") }
      case "Lease":
        return raw["holder"] === "user" || raw["holder"] === "bot" ? { _tag: "Lease", holder: raw["holder"] } : undefined
      case "Url":
        return { _tag: "Url", url: String(raw["url"] ?? ""), title: String(raw["title"] ?? "") }
      default:
        return undefined
    }
  } catch {
    return undefined
  }
}

// ------------------------------------------------------------------------------------- user input

export interface InputModifiers {
  readonly alt?: boolean
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly shift?: boolean
}

/** Mirrors node-protocol `BrowserInputEvent` (user takeover input). */
export type BrowserInputEvent =
  | {
      readonly _tag: "mouse"
      readonly type: "move" | "down" | "up" | "wheel"
      readonly x: number
      readonly y: number
      readonly button?: "none" | "left" | "middle" | "right"
      readonly clickCount?: number
      readonly deltaX?: number
      readonly deltaY?: number
      readonly modifiers?: InputModifiers
    }
  | {
      readonly _tag: "key"
      readonly type: "down" | "up"
      /** DOM `KeyboardEvent.key` */
      readonly key: string
      /** DOM `KeyboardEvent.code` */
      readonly code?: string
      /** Text produced by the key (printable keys). */
      readonly text?: string
      readonly modifiers?: InputModifiers
    }
  | { readonly _tag: "text"; readonly text: string }

export const modifiersOf = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): InputModifiers | undefined =>
  e.altKey || e.ctrlKey || e.metaKey || e.shiftKey
    ? {
        ...(e.altKey ? { alt: true } : {}),
        ...(e.ctrlKey ? { ctrl: true } : {}),
        ...(e.metaKey ? { meta: true } : {}),
        ...(e.shiftKey ? { shift: true } : {}),
      }
    : undefined

export const mouseButtonOf = (button: number): "left" | "middle" | "right" => (button === 1 ? "middle" : button === 2 ? "right" : "left")

/**
 * Map a pointer position on the drawn frame (an element whose box exactly covers the frame, e.g. the
 * contain-fitted canvas) to page CSS pixels. Returns `undefined` outside the frame.
 */
export const toViewportPoint = (
  clientX: number,
  clientY: number,
  rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  meta: Pick<ScreencastFrameMeta, "viewportWidth" | "viewportHeight">,
): { readonly x: number; readonly y: number } | undefined => {
  if (rect.width <= 0 || rect.height <= 0) return undefined
  const fx = (clientX - rect.left) / rect.width
  const fy = (clientY - rect.top) / rect.height
  if (fx < 0 || fy < 0 || fx > 1 || fy > 1) return undefined
  return { x: Math.round(fx * meta.viewportWidth * 100) / 100, y: Math.round(fy * meta.viewportHeight * 100) / 100 }
}

// ------------------------------------------------------------------------------------- terminal

export type TerminalControl = { readonly exit: number | null; readonly signal?: string | null } | { readonly error: string }

export const decodeTerminalControl = (text: string): TerminalControl | undefined => {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    if (typeof raw?.["error"] === "string") return { error: raw["error"] }
    if ("exit" in raw) return { exit: typeof raw["exit"] === "number" ? raw["exit"] : null, signal: typeof raw["signal"] === "string" ? raw["signal"] : null }
    return undefined
  } catch {
    return undefined
  }
}

export const encodeTerminalResize = (cols: number, rows: number): string => JSON.stringify({ resize: { cols, rows } })

// ------------------------------------------------------------------------------------- URLs

const wsOrigin = (): string => {
  const loc = (globalThis as { location?: { protocol: string; host: string } }).location
  if (!loc || !loc.host) return "ws://127.0.0.1:7420"
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}`
}

/** `/ws/computer/:botId?mode=…` on the page's origin (`viewPath` from `computer.status` wins when present). */
export const computerSocketUrl = (botId: string, mode: "view" | "control", viewPath?: string): string =>
  `${wsOrigin()}${viewPath ?? `/ws/computer/${encodeURIComponent(botId)}`}?mode=${mode}`

export const terminalSocketUrl = (botId: string, cols: number, rows: number): string =>
  `${wsOrigin()}/ws/terminal/${encodeURIComponent(botId)}?cols=${cols}&rows=${rows}`
