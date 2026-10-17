// DEV MOCK ONLY: a tiny RFB (VNC) 3.8 server session, so the web UI's noVNC desktop view runs end to
// end against the dev mock (handshake, framebuffer updates, view-only vs control input) without Xvfb or
// x11vnc. The "desktop" is a list of flat rectangles (wallpaper bands, a dock, a terminal and a browser
// window with a sign-in page or a dashboard) sent with RRE encoding (a few KB per frame). In control
// mode, clicks leave a marker and typed keys fill the focused field with dots.
// Protocol: https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst

export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** 0xRRGGBB */
  readonly color: number
}

export type DesktopPage = "signin" | "dashboard"

export interface DesktopSceneOptions {
  readonly width: number
  readonly height: number
  /** 0xRRGGBB, the bot's color. */
  readonly accent: number
  readonly page: DesktopPage
}

const hex = (s: string): number => Number.parseInt(s.replace("#", ""), 16)
const mix = (a: number, b: number, t: number): number => {
  const ch = (shift: number) => Math.round(((a >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/** Avatar color names → 0xRRGGBB (close to the app's avatar palette). */
export const ACCENTS: Readonly<Record<string, number>> = {
  cyan: hex("#22b8cf"),
  orange: hex("#f08c00"),
  violet: hex("#845ef7"),
  blue: hex("#3b82f6"),
  red: hex("#f03e3e"),
  green: hex("#2f9e44"),
  yellow: hex("#f59f00"),
  magenta: hex("#d6336c"),
  gray: hex("#868e96"),
}

/** Where typed characters go (the focused field) on a page, in screen pixels. */
export interface Scene {
  readonly rects: Rect[]
  readonly accent: number
  readonly field: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
}

/** A plausible Linux desktop (xfwm4 + plank dock + Chromium) made of rectangles. */
export const desktopScene = ({ width: W, height: H, accent, page }: DesktopSceneOptions): Scene => {
  const r: Rect[] = []
  const add = (x: number, y: number, w: number, h: number, color: number) => r.push({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), color })
  const box = (x: number, y: number, w: number, h: number, fill: number, border: number) => {
    add(x, y, w, h, border)
    add(x + 1, y + 1, w - 2, h - 2, fill)
  }
  // wallpaper: a vertical gradient in 40 bands
  const top = hex("#1f2a48")
  const bottom = mix(hex("#2b6c74"), accent, 0.18)
  const bands = 40
  for (let i = 0; i < bands; i++) add(0, (i * H) / bands, W, Math.ceil(H / bands) + 1, mix(top, bottom, i / (bands - 1)))

  // a terminal window peeking out behind the browser
  const tx = W * 0.7
  const ty = H * 0.5
  add(tx, ty, W * 0.27, H * 0.33, hex("#1e1f22"))
  add(tx, ty, W * 0.27, 32, hex("#2b2d31"))
  for (let i = 0; i < 9; i++) add(tx + 18, ty + 52 + i * 26, [220, 120, 300, 180, 90, 260, 140, 200, 60][i]!, 10, i % 3 === 0 ? hex("#6ee7a8") : hex("#c9cdd4"))

  // the browser (Chromium) window
  const bx = W * 0.1
  const by = H * 0.06
  const bw = W * 0.78
  const bh = H * 0.8
  add(bx - 1, by - 1, bw + 2, bh + 2, hex("#0b1020"))
  add(bx, by, bw, 40, hex("#dee1e6")) // tab strip
  add(bx + 10, by + 8, 250, 32, hex("#ffffff")) // active tab
  add(bx + 26, by + 19, 14, 14, accent) // favicon
  add(bx + 50, by + 22, 150, 8, hex("#5f6368"))
  add(bx + 270, by + 14, 180, 22, hex("#d3d6db")) // inactive tab
  for (let i = 0; i < 3; i++) add(bx + bw - 26 - i * 24, by + 14, 12, 12, hex("#9aa0a6")) // window buttons
  add(bx, by + 40, bw, 46, hex("#ffffff")) // toolbar
  for (let i = 0; i < 3; i++) add(bx + 16 + i * 30, by + 56, 14, 14, hex("#9aa0a6"))
  add(bx + 120, by + 48, bw * 0.62, 30, hex("#f1f3f4")) // URL field
  add(bx + 140, by + 59, 280, 8, hex("#5f6368"))
  add(bx, by + 86, bw, 1, hex("#dadce0"))
  const cx = bx
  const cy = by + 87
  const cw = bw
  const ch = bh - 87
  add(cx, cy, cw, ch, hex("#f8f9fa")) // page

  let field = { x: 0, y: 0, w: 0, h: 0 }
  if (page === "signin") {
    const fw = 460
    const fh = 520
    const fx = cx + (cw - fw) / 2
    const fy = cy + (ch - fh) / 2
    box(fx, fy, fw, fh, hex("#ffffff"), hex("#dadce0"))
    add(fx + (fw - 56) / 2, fy + 40, 56, 56, accent) // logo
    add(fx + (fw - 240) / 2, fy + 126, 240, 16, hex("#202124")) // "Sign in"
    add(fx + (fw - 300) / 2, fy + 156, 300, 9, hex("#80868b"))
    box(fx + 50, fy + 200, fw - 100, 48, hex("#ffffff"), hex("#c4c7c5")) // email
    add(fx + 66, fy + 220, 170, 9, hex("#3c4043"))
    box(fx + 50, fy + 268, fw - 100, 48, hex("#ffffff"), accent) // password (focused)
    add(fx + 51, fy + 269, fw - 102, 1, accent)
    field = { x: fx + 66, y: fy + 268, w: fw - 132, h: 48 }
    add(fx + 50, fy + 346, fw - 100, 48, accent) // button
    add(fx + (fw - 90) / 2, fy + 366, 90, 9, hex("#ffffff"))
    add(fx + (fw - 200) / 2, fy + 430, 200, 8, mix(accent, hex("#ffffff"), 0.2))
  } else {
    add(cx, cy, cw, 56, hex("#ffffff")) // app header
    add(cx + 24, cy + 16, 24, 24, accent)
    add(cx + 60, cy + 24, 160, 10, hex("#202124"))
    add(cx, cy + 56, 220, ch - 56, hex("#ffffff")) // sidebar
    for (let i = 0; i < 7; i++) add(cx + 24, cy + 90 + i * 40, [120, 150, 100, 140, 90, 130, 110][i]!, 9, i === 1 ? accent : hex("#9aa0a6"))
    const gx = cx + 250
    const gy = cy + 80
    const card = (x: number, y: number, w: number, h: number) => box(x, y, w, h, hex("#ffffff"), hex("#e3e5e8"))
    const tile = (cw - 300) / 3
    for (let i = 0; i < 3; i++) {
      card(gx + i * (tile + 12), gy, tile, 110)
      add(gx + i * (tile + 12) + 20, gy + 24, 90, 8, hex("#80868b"))
      add(gx + i * (tile + 12) + 20, gy + 50, [140, 110, 160][i]!, 22, hex("#202124"))
      add(gx + i * (tile + 12) + 20, gy + 84, 60, 8, i === 2 ? hex("#e03131") : hex("#2f9e44"))
    }
    const chartW = tile * 2 + 12
    card(gx, gy + 130, chartW, 420)
    add(gx + 20, gy + 154, 180, 10, hex("#202124"))
    const bars = [0.45, 0.6, 0.52, 0.7, 0.66, 0.82, 0.74, 0.9, 0.78, 0.95, 0.88, 0.97]
    const slot = (chartW - 40) / bars.length
    bars.forEach((v, i) => add(gx + 20 + i * slot + 6, gy + 530 - v * 320, slot - 12, v * 320, i === bars.length - 1 ? accent : mix(accent, hex("#ffffff"), 0.55)))
    card(gx + chartW + 12, gy + 130, tile, 420)
    for (let i = 0; i < 8; i++) {
      add(gx + chartW + 32, gy + 160 + i * 46, 26, 26, mix(accent, hex("#ffffff"), 0.6))
      add(gx + chartW + 70, gy + 166 + i * 46, [150, 120, 170, 100, 140, 160, 90, 130][i]!, 8, hex("#3c4043"))
    }
    box(gx, gy + 566, chartW, 44, hex("#ffffff"), hex("#c4c7c5")) // a note field
    field = { x: gx + 16, y: gy + 566, w: chartW - 32, h: 44 }
  }

  // the dock (plank)
  const icons = [hex("#4285f4"), hex("#e8a33d"), hex("#2d2f33"), accent, hex("#6b7280")]
  const size = 56
  const gap = 14
  const dw = icons.length * size + (icons.length + 1) * gap
  const dx = (W - dw) / 2
  const dy = H - size - 2 * gap - 10
  add(dx, dy, dw, size + 2 * gap, hex("#161b26"))
  icons.forEach((c, i) => {
    const x = dx + gap + i * (size + gap)
    add(x, dy + gap, size, size, c)
    add(x + 16, dy + gap + 16, size - 32, size - 32, mix(c, hex("#ffffff"), 0.75))
  })
  add(dx + gap + size / 2 - 3, dy + gap + size + 6, 6, 4, hex("#e8eaed")) // running indicator
  return { rects: r, field, accent }
}

// ------------------------------------------------------------------------------- RFB session

const SECURITY_NONE = 1
const ENC_RAW = 0
const ENC_RRE = 2

interface PixelFormat {
  bpp: number
  bigEndian: boolean
  redShift: number
  greenShift: number
  blueShift: number
  redMax: number
  greenMax: number
  blueMax: number
}

const SERVER_FORMAT: PixelFormat = { bpp: 32, bigEndian: false, redShift: 16, greenShift: 8, blueShift: 0, redMax: 255, greenMax: 255, blueMax: 255 }

class Bytes {
  private parts: number[] = []
  u8(v: number) {
    this.parts.push(v & 255)
    return this
  }
  u16(v: number) {
    return this.u8(v >> 8).u8(v)
  }
  u32(v: number) {
    return this.u8(v >>> 24).u8(v >>> 16).u8(v >>> 8).u8(v)
  }
  s32(v: number) {
    return this.u32(v >>> 0)
  }
  bytes(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.parts.push(b[i]! & 255)
    return this
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts)
  }
}

export interface RfbSessionOptions {
  readonly width: number
  readonly height: number
  readonly name: string
  readonly scene: Scene
  /** Accepts input (a `mode=control` socket). */
  readonly control: boolean
  /** Called on every input event (dev diagnostics). */
  readonly onInput?: (event: { readonly kind: "pointer" | "key"; readonly x?: number; readonly y?: number; readonly key?: number; readonly down?: boolean }) => void
}

type Phase = "version" | "security" | "init" | "normal" | "closed"

/** One client connection: feed it the client's bytes, send what it returns. */
export class RfbSession {
  private phase: Phase = "version"
  private buf = new Uint8Array(0)
  private format: PixelFormat = SERVER_FORMAT
  private encodings: ReadonlyArray<number> = [ENC_RAW]
  private rects: Rect[]
  private dirty: Array<{ x: number; y: number; w: number; h: number }> = []
  private waiting: { x: number; y: number; w: number; h: number } | undefined
  private buttons = 0
  private typed = 0
  private readonly field: Scene["field"]
  readonly stats = { pointer: 0, keys: 0, updates: 0 }

  constructor(private readonly options: RfbSessionOptions) {
    this.rects = [...options.scene.rects]
    this.field = options.scene.field
  }

  /** The server speaks first: the protocol version. */
  greeting(): Uint8Array {
    return new TextEncoder().encode("RFB 003.008\n")
  }

  get closed(): boolean {
    return this.phase === "closed"
  }

  /** Client bytes in → server messages out. */
  receive(chunk: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = []
    const next = new Uint8Array(this.buf.length + chunk.length)
    next.set(this.buf)
    next.set(chunk, this.buf.length)
    this.buf = next
    for (;;) {
      const used = this.step(out)
      if (used === 0) break
      this.buf = this.buf.subarray(used)
    }
    return out
  }

  /** Consume one message; returns the bytes used (0 = need more). */
  private step(out: Uint8Array[]): number {
    const b = this.buf
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
    switch (this.phase) {
      case "closed":
        return 0
      case "version":
        if (b.length < 12) return 0
        this.phase = "security"
        out.push(Uint8Array.of(1, SECURITY_NONE))
        return 12
      case "security":
        if (b.length < 1) return 0
        if (b[0] !== SECURITY_NONE) {
          const reason = new TextEncoder().encode("Only None security is offered")
          out.push(new Bytes().u32(1).u32(reason.length).bytes(reason).done())
          this.phase = "closed"
          return 1
        }
        out.push(new Bytes().u32(0).done())
        this.phase = "init"
        return 1
      case "init": {
        if (b.length < 1) return 0
        const name = new TextEncoder().encode(this.options.name)
        const f = SERVER_FORMAT
        out.push(
          new Bytes()
            .u16(this.options.width)
            .u16(this.options.height)
            .u8(f.bpp)
            .u8(24)
            .u8(f.bigEndian ? 1 : 0)
            .u8(1)
            .u16(f.redMax)
            .u16(f.greenMax)
            .u16(f.blueMax)
            .u8(f.redShift)
            .u8(f.greenShift)
            .u8(f.blueShift)
            .bytes([0, 0, 0])
            .u32(name.length)
            .bytes(name)
            .done(),
        )
        this.phase = "normal"
        return 1
      }
      case "normal": {
        if (b.length < 1) return 0
        switch (b[0]) {
          case 0: {
            // SetPixelFormat
            if (b.length < 20) return 0
            this.format = {
              bpp: b[4]!,
              bigEndian: b[6] !== 0,
              redMax: view.getUint16(8),
              greenMax: view.getUint16(10),
              blueMax: view.getUint16(12),
              redShift: b[14]!,
              greenShift: b[15]!,
              blueShift: b[16]!,
            }
            return 20
          }
          case 2: {
            // SetEncodings
            if (b.length < 4) return 0
            const n = view.getUint16(2)
            if (b.length < 4 + n * 4) return 0
            const list: number[] = []
            for (let i = 0; i < n; i++) list.push(view.getInt32(4 + i * 4))
            this.encodings = list
            return 4 + n * 4
          }
          case 3: {
            // FramebufferUpdateRequest
            if (b.length < 10) return 0
            const incremental = b[1] !== 0
            const req = { x: view.getUint16(2), y: view.getUint16(4), w: view.getUint16(6), h: view.getUint16(8) }
            if (!incremental) this.dirty.push(req)
            this.waiting = req
            this.flush(out)
            return 10
          }
          case 4: {
            // KeyEvent
            if (b.length < 8) return 0
            const down = b[1] !== 0
            const key = view.getUint32(4)
            if (this.options.control) {
              this.stats.keys++
              this.options.onInput?.({ kind: "key", key, down })
              if (down) this.onKey(key)
              this.flush(out)
            }
            return 8
          }
          case 5: {
            // PointerEvent
            if (b.length < 6) return 0
            const mask = b[1]!
            const x = view.getUint16(2)
            const y = view.getUint16(4)
            if (this.options.control) {
              this.stats.pointer++
              this.options.onInput?.({ kind: "pointer", x, y })
              if (mask & 1 && !(this.buttons & 1)) this.mark(x, y)
              this.flush(out)
            }
            this.buttons = mask
            return 6
          }
          case 6: {
            // ClientCutText (a negative length is the extended format: skip its payload too)
            if (b.length < 8) return 0
            const len = Math.abs(view.getInt32(4))
            if (b.length < 8 + len) return 0
            return 8 + len
          }
          default:
            // an extension we never offered: the stream can't be parsed any further
            this.phase = "closed"
            return 0
        }
      }
    }
  }

  private mark(x: number, y: number) {
    const s = 18
    const accent = this.options.scene.accent
    this.rects.push({ x: x - s / 2, y: y - s / 2, w: s, h: s, color: 0xffffff }, { x: x - s / 2 + 3, y: y - s / 2 + 3, w: s - 6, h: s - 6, color: accent })
    this.dirty.push({ x: x - s / 2, y: y - s / 2, w: s, h: s })
  }

  private onKey(keysym: number) {
    const f = this.field
    if (f.w <= 0) return
    const dot = 10
    const step = 18
    const max = Math.floor((f.w - 4) / step)
    if (keysym === 0xff08) {
      if (this.typed === 0) return
      this.typed--
      const x = f.x + this.typed * step
      this.rects.push({ x, y: f.y + (f.h - dot) / 2, w: dot, h: dot, color: 0xffffff })
      this.dirty.push({ x, y: f.y + (f.h - dot) / 2, w: dot, h: dot })
      return
    }
    // printable keys only (Latin-1 and Unicode keysyms)
    if (!((keysym >= 0x20 && keysym <= 0xff) || keysym >= 0x01000000) || this.typed >= max) return
    const x = f.x + this.typed * step
    this.typed++
    this.rects.push({ x, y: f.y + (f.h - dot) / 2, w: dot, h: dot, color: 0x202124 })
    this.dirty.push({ x, y: f.y + (f.h - dot) / 2, w: dot, h: dot })
  }

  /** Answers the pending update request with the dirty regions (nothing to send: keep it pending). */
  private flush(out: Uint8Array[]) {
    if (!this.waiting || this.dirty.length === 0) return
    const regions = this.dirty.map((d) => this.clip(d)).filter((d) => d.w > 0 && d.h > 0)
    this.dirty = []
    this.waiting = undefined
    if (regions.length === 0) return
    const msg = new Bytes().u8(0).u8(0).u16(regions.length)
    for (const region of regions) this.encodeRegion(msg, region)
    out.push(msg.done())
    this.stats.updates++
  }

  private clip(d: { x: number; y: number; w: number; h: number }) {
    const x = Math.max(0, Math.round(d.x))
    const y = Math.max(0, Math.round(d.y))
    const w = Math.min(this.options.width, Math.round(d.x + d.w)) - x
    const h = Math.min(this.options.height, Math.round(d.y + d.h)) - y
    return { x, y, w, h }
  }

  private pixel(rgb: number): number[] {
    const f = this.format
    const r = (rgb >> 16) & 255
    const g = (rgb >> 8) & 255
    const b = rgb & 255
    const v = ((Math.round((r * f.redMax) / 255) << f.redShift) | (Math.round((g * f.greenMax) / 255) << f.greenShift) | (Math.round((b * f.blueMax) / 255) << f.blueShift)) >>> 0
    const n = f.bpp / 8
    const bytes: number[] = []
    for (let i = 0; i < n; i++) bytes.push((v >>> (8 * i)) & 255)
    return f.bigEndian ? bytes.reverse() : bytes
  }

  /** One rectangle: RRE (background + every scene rect clipped to it, in z-order) or raw pixels. */
  private encodeRegion(msg: Bytes, region: { x: number; y: number; w: number; h: number }) {
    const subs: Rect[] = []
    for (const r of this.rects) {
      const x0 = Math.max(region.x, r.x)
      const y0 = Math.max(region.y, r.y)
      const x1 = Math.min(region.x + region.w, r.x + r.w)
      const y1 = Math.min(region.y + region.h, r.y + r.h)
      if (x1 > x0 && y1 > y0) subs.push({ x: x0 - region.x, y: y0 - region.y, w: x1 - x0, h: y1 - y0, color: r.color })
    }
    msg.u16(region.x).u16(region.y).u16(region.w).u16(region.h)
    if (this.encodings.includes(ENC_RRE)) {
      msg.s32(ENC_RRE).u32(subs.length).bytes(this.pixel(0))
      for (const s of subs) msg.bytes(this.pixel(s.color)).u16(s.x).u16(s.y).u16(s.w).u16(s.h)
      return
    }
    // raw fallback: paint the rects into a pixel buffer
    msg.s32(ENC_RAW)
    const colors = new Uint32Array(region.w * region.h)
    for (const s of subs) for (let y = s.y; y < s.y + s.h; y++) colors.fill(s.color, y * region.w + s.x, y * region.w + s.x + s.w)
    for (const c of colors) msg.bytes(this.pixel(c))
  }
}
