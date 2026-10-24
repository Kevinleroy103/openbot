// The Mac screen helper: a child process of the node that posts mouse and keyboard events through
// CoreGraphics (bun:ffi, ./coregraphics.ts) and reports the display and permissions. It runs apart
// from the node so a native crash cannot take the node (or a brain running a local node) down.
//
// Protocol: one JSON request per line on stdin (`{"id":1,"op":"move","x":10,"y":20}`), one JSON
// response per line on stdout (`{"id":1,"ok":true,"value":…}` or `{"id":1,"ok":false,"error":"…"}`).
// When stdin closes, every held button and key is released and the helper exits.
//
// Coordinates are global display points (origin at the top left of the main display).

export type MacButton = "left" | "right" | "middle"

export type MacOp =
  | { readonly op: "info" }
  | { readonly op: "idle" }
  | { readonly op: "requestScreenRecording" }
  | { readonly op: "move"; readonly x: number; readonly y: number; readonly flags?: number | undefined }
  /** press or release one button (`clicks`: the click count it belongs to, for double clicks) */
  | {
      readonly op: "button"
      readonly button: MacButton
      readonly down: boolean
      readonly clicks?: number | undefined
      readonly flags?: number | undefined
    }
  /** `count` full clicks at the current position */
  | { readonly op: "click"; readonly button: MacButton; readonly count: number; readonly flags?: number | undefined }
  /** wheel ticks: lines (bot) or pixels (the owner's trackpad); positive dy scrolls up, positive dx left */
  | {
      readonly op: "scroll"
      readonly dx: number
      readonly dy: number
      readonly unit: "line" | "pixel"
      readonly flags?: number | undefined
    }
  | { readonly op: "type"; readonly text: string }
  /** press and release a key with modifier flags */
  | { readonly op: "key"; readonly keyCode: number; readonly flags: number }
  /** one key edge (held keys, the owner's keyboard) */
  | { readonly op: "keyEvent"; readonly keyCode: number; readonly down: boolean; readonly flags?: number | undefined }
  /** modifier flags applied to every following event until changed */
  | { readonly op: "hold"; readonly flags: number }
  /** let go of every held button, key and modifier */
  | { readonly op: "release" }

export interface MacInfo {
  /** main display size in points */
  readonly width: number
  readonly height: number
  readonly screenRecording: boolean
  readonly accessibility: boolean
}

export interface MacIdle {
  /** seconds since the last input event of any kind (hardware or posted) */
  readonly idle: number
  /** seconds since this helper last posted an event */
  readonly sincePost: number
}

/** What the helper needs from CoreGraphics (the real one in ./coregraphics.ts; a fake in tests). */
export interface CoreGraphics {
  /** post a mouse event: CGEventType, position, CGMouseButton, click state, flags */
  readonly mouse: (type: number, x: number, y: number, button: number, clickState: number, flags: number) => void
  readonly key: (keyCode: number, down: boolean, flags: number) => void
  /** post a key event carrying `text` (at most 20 UTF-16 units) */
  readonly unicode: (text: string, down: boolean, flags: number) => void
  /** unit 0 = pixel, 1 = line */
  readonly scroll: (unit: 0 | 1, dy: number, dx: number, flags: number) => void
  readonly secondsSinceInput: () => number
  readonly displaySize: () => { readonly width: number; readonly height: number }
  readonly screenRecordingAllowed: () => boolean
  readonly requestScreenRecording: () => boolean
  readonly accessibilityAllowed: () => boolean
}

// CGEventType values
const MOUSE = {
  left: { down: 1, up: 2, drag: 6, button: 0 },
  right: { down: 3, up: 4, drag: 7, button: 1 },
  middle: { down: 25, up: 26, drag: 27, button: 2 },
} as const
const MOUSE_MOVED = 5

/** UTF-16 units per posted unicode event (CoreGraphics' limit). */
export const UNICODE_CHUNK = 20
/** Key codes typed for these characters instead of posting them as text (Return, Tab). */
const TYPED_KEYS: Readonly<Record<string, number>> = { "\n": 36, "\t": 48 }
/** Pause between posted text chunks, ms: apps drop events that arrive faster. */
const TYPE_PAUSE_MS = 8
const CLICK_PAUSE_MS = 40

/** Splits text into posted pieces: runs of at most `UNICODE_CHUNK` UTF-16 units, and Return / Tab keys. */
export const typingPieces = (text: string): ReadonlyArray<{ readonly text: string } | { readonly keyCode: number }> => {
  const out: Array<{ readonly text: string } | { readonly keyCode: number }> = []
  let run = ""
  const flush = () => {
    if (run !== "") out.push({ text: run })
    run = ""
  }
  for (const ch of text.replace(/\r\n?/g, "\n")) {
    const key = TYPED_KEYS[ch]
    if (key !== undefined) {
      flush()
      out.push({ keyCode: key })
      continue
    }
    if (run.length + ch.length > UNICODE_CHUNK) flush()
    run += ch
  }
  flush()
  return out
}

export const makeHelperHandler = (
  cg: CoreGraphics,
  clock: { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> },
) => {
  let pos = { x: 0, y: 0 }
  let held = 0
  let lastPost = Number.NEGATIVE_INFINITY
  const buttons = new Set<MacButton>()
  const keys = new Set<number>()
  const posted = () => {
    lastPost = clock.now()
  }
  const moveType = () => {
    for (const b of ["left", "right", "middle"] as const)
      if (buttons.has(b)) return { type: MOUSE[b].drag, button: MOUSE[b].button }
    return { type: MOUSE_MOVED, button: 0 }
  }
  const press = (button: MacButton, down: boolean, clicks: number, flags: number) => {
    const m = MOUSE[button]
    cg.mouse(down ? m.down : m.up, pos.x, pos.y, m.button, clicks, flags)
    if (down) buttons.add(button)
    else buttons.delete(button)
    posted()
  }

  return async (req: MacOp): Promise<unknown> => {
    switch (req.op) {
      case "info": {
        const size = cg.displaySize()
        return {
          width: size.width,
          height: size.height,
          screenRecording: cg.screenRecordingAllowed(),
          accessibility: cg.accessibilityAllowed(),
        } satisfies MacInfo
      }
      case "idle":
        return { idle: cg.secondsSinceInput(), sincePost: (clock.now() - lastPost) / 1000 } satisfies MacIdle
      case "requestScreenRecording":
        return cg.requestScreenRecording()
      case "move": {
        pos = { x: req.x, y: req.y }
        const m = moveType()
        cg.mouse(m.type, pos.x, pos.y, m.button, 0, req.flags ?? held)
        posted()
        return null
      }
      case "button":
        press(req.button, req.down, Math.max(1, req.clicks ?? 1), req.flags ?? held)
        return null
      case "click":
        for (let i = 1; i <= Math.max(1, req.count); i++) {
          press(req.button, true, i, req.flags ?? held)
          press(req.button, false, i, req.flags ?? held)
          if (i < req.count) await clock.sleep(CLICK_PAUSE_MS)
        }
        return null
      case "scroll":
        cg.scroll(req.unit === "pixel" ? 0 : 1, Math.round(req.dy), Math.round(req.dx), req.flags ?? held)
        posted()
        return null
      case "type":
        for (const piece of typingPieces(req.text)) {
          if ("keyCode" in piece) {
            cg.key(piece.keyCode, true, held)
            cg.key(piece.keyCode, false, held)
          } else {
            cg.unicode(piece.text, true, held)
            cg.unicode(piece.text, false, held)
          }
          posted()
          await clock.sleep(TYPE_PAUSE_MS)
        }
        return null
      case "key":
        cg.key(req.keyCode, true, req.flags)
        cg.key(req.keyCode, false, req.flags)
        posted()
        return null
      case "keyEvent":
        cg.key(req.keyCode, req.down, req.flags ?? held)
        if (req.down) keys.add(req.keyCode)
        else keys.delete(req.keyCode)
        posted()
        return null
      case "hold":
        held = req.flags
        return null
      case "release": {
        for (const b of [...buttons]) press(b, false, 1, 0)
        for (const k of [...keys]) cg.key(k, false, 0)
        keys.clear()
        held = 0
        return null
      }
    }
  }
}

const write = (o: unknown) => {
  process.stdout.write(`${JSON.stringify(o)}\n`)
}

/** The helper process: `openbot-node screen-helper` (or this module's entry under Bun). */
export const runScreenHelper = async (): Promise<void> => {
  const { loadCoreGraphics } = await import("./coregraphics.ts")
  const cg = loadCoreGraphics()
  const handle = makeHelperHandler(cg, { now: () => performance.now(), sleep: (ms) => Bun.sleep(ms) })
  const decoder = new TextDecoder()
  let buffered = ""
  // one request at a time, in order (events must not interleave)
  for await (const chunk of Bun.stdin.stream()) {
    buffered += decoder.decode(chunk, { stream: true })
    let nl: number
    while ((nl = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, nl).trim()
      buffered = buffered.slice(nl + 1)
      if (line === "") continue
      let id: unknown = null
      try {
        const req = JSON.parse(line) as MacOp & { readonly id?: unknown }
        id = req.id ?? null
        write({ id, ok: true, value: await handle(req) })
      } catch (e) {
        write({ id, ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  await handle({ op: "release" })
}

if (import.meta.main) await runScreenHelper()
