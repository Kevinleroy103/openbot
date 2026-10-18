// `computer.act` → a plan of xdotool invocations (pure, so the command lines are unit-tested).
// Mirrors Anthropic's reference computer tool (anthropic-quickstarts computer_use_demo): clicks
// move first (`mousemove --sync`), double/triple clicks are `click --repeat`, scroll is buttons
// 4/5/6/7, text goes through `type --delay` in chunks, `key` is xdotool's key syntax, modifiers
// for clicks and scroll and `hold_key` are pressed with keydown and always released with keyup.
// Every action except `cursor_position` ends with a screenshot (after a short settle delay).
import type { ComputerAction } from "@openbot/node-protocol"
import { apiPoint, toScreen, zoomRect, type Point, type ScreenGeometry, type ZoomRect } from "./geometry.ts"
import { heldModifiers, holdKeys, xdoKeySequence } from "./keys.ts"

export type PlanStep =
  /** run `xdotool <args>` */
  | { readonly _tag: "xdotool"; readonly args: ReadonlyArray<string> }
  | { readonly _tag: "sleep"; readonly ms: number }

export interface ActionPlan {
  /** keysyms pressed (`keydown`) before the steps and released (`keyup`, reverse order) after them, even on failure */
  readonly hold: ReadonlyArray<string>
  readonly steps: ReadonlyArray<PlanStep>
  /** "after": settle, then a full screenshot; "now": a screenshot right away; zoom: a crop; "none": no image */
  readonly image: "after" | "now" | "none" | { readonly zoom: ZoomRect }
  /** read the pointer position (cursor_position) */
  readonly cursor: boolean
  /** model-facing text (short and factual) */
  readonly text: string
}

/** Characters per `xdotool type` invocation (Anthropic's reference uses 50). */
export const TYPE_CHUNK = 50
/** Delay between typed characters, ms. */
export const TYPE_DELAY_MS = 12
export const MAX_SCROLL = 50
export const MAX_DURATION_S = 60
const CLICK_DELAY_MS = 80

const xdo = (...args: ReadonlyArray<string | number>): PlanStep => ({ _tag: "xdotool", args: args.map(String) })
const sleep = (ms: number): PlanStep => ({ _tag: "sleep", ms: Math.max(0, Math.round(ms)) })
const moveTo = (g: ScreenGeometry, p: Point): PlanStep => {
  const s = toScreen(g, p.x, p.y)
  return xdo("mousemove", "--sync", s.x, s.y)
}
const at = (p: Point | undefined) => (p ? ` at (${p.x}, ${p.y})` : " at the mouse position")
const withMods = (mods: ReadonlyArray<string>) => (mods.length > 0 ? ` holding ${mods.join("+")}` : "")

/** Splits text into chunks of at most `size` characters (code points, never splitting a surrogate pair). */
export const chunkText = (text: string, size = TYPE_CHUNK): ReadonlyArray<string> => {
  const chars = Array.from(text)
  const out: Array<string> = []
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""))
  return out
}

const seconds = (duration: number | undefined, fallback: number): number | string => {
  const d = duration ?? fallback
  if (!Number.isFinite(d) || d < 0) return "duration must be a number of seconds ≥ 0"
  if (d > MAX_DURATION_S) return `duration must be at most ${MAX_DURATION_S} seconds`
  return d
}

const CLICKS = {
  left_click: { button: 1, count: 1, verb: "Clicked" },
  right_click: { button: 3, count: 1, verb: "Right-clicked" },
  middle_click: { button: 2, count: 1, verb: "Middle-clicked" },
  double_click: { button: 1, count: 2, verb: "Double-clicked" },
  triple_click: { button: 1, count: 3, verb: "Triple-clicked" },
} as const

const SCROLL_BUTTONS = { up: 4, down: 5, left: 6, right: 7 } as const

/**
 * Builds the plan for one action, or returns an error message for the model. `mac`: key names for a
 * Mac (Command stays Command; the steps are then replayed by `macSteps`).
 */
export const planAction = (g: ScreenGeometry, a: ComputerAction, options?: { readonly mac?: boolean }): ActionPlan | string => {
  const mac = options?.mac ?? false
  const optionalPoint = (name: "coordinate"): Point | undefined | string =>
    a[name] === undefined ? undefined : apiPoint(g, a[name], name)
  switch (a.action) {
    case "screenshot":
      return { hold: [], steps: [], image: "now", cursor: false, text: `Screenshot of the screen (${g.apiWidth}x${g.apiHeight}).` }
    case "zoom": {
      const z = zoomRect(g, a.region)
      if (typeof z === "string") return z
      const r = a.region!.map((n) => Math.round(n)).join(", ")
      return {
        hold: [],
        steps: [],
        image: { zoom: z },
        cursor: false,
        text: `Zoomed into [${r}], shown at ${z.outWidth}x${z.outHeight}. Coordinates for actions stay in the ${g.apiWidth}x${g.apiHeight} screenshot space.`,
      }
    }
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click": {
      const c = CLICKS[a.action]
      const p = optionalPoint("coordinate")
      if (typeof p === "string") return p
      const mods = heldModifiers(a.text, mac)
      if (mods === undefined) return `text must name modifier keys to hold (e.g. "shift" or "ctrl+shift"), got ${JSON.stringify(a.text)}`
      const click = c.count === 1 ? xdo("click", c.button) : xdo("click", "--repeat", c.count, "--delay", CLICK_DELAY_MS, c.button)
      return {
        hold: mods,
        steps: p ? [moveTo(g, p), click] : [click],
        image: "after",
        cursor: false,
        text: `${c.verb}${at(p)}${withMods(mods)}.`,
      }
    }
    case "mouse_move": {
      const p = apiPoint(g, a.coordinate, "coordinate")
      if (typeof p === "string") return p
      return { hold: [], steps: [moveTo(g, p)], image: "after", cursor: false, text: `Moved the mouse to (${p.x}, ${p.y}).` }
    }
    case "left_click_drag": {
      const from = apiPoint(g, a.start_coordinate, "start_coordinate")
      if (typeof from === "string") return from
      const to = apiPoint(g, a.coordinate, "coordinate")
      if (typeof to === "string") return to
      return {
        hold: [],
        steps: [moveTo(g, from), xdo("mousedown", 1), sleep(60), moveTo(g, to), sleep(60), xdo("mouseup", 1)],
        image: "after",
        cursor: false,
        text: `Dragged from (${from.x}, ${from.y}) to (${to.x}, ${to.y}).`,
      }
    }
    case "left_mouse_down":
    case "left_mouse_up": {
      const p = optionalPoint("coordinate")
      if (typeof p === "string") return p
      const down = a.action === "left_mouse_down"
      return {
        hold: [],
        steps: [...(p ? [moveTo(g, p)] : []), xdo(down ? "mousedown" : "mouseup", 1)],
        image: "after",
        cursor: false,
        text: `${down ? "Pressed" : "Released"} the left mouse button${at(p)}.`,
      }
    }
    case "scroll": {
      const p = optionalPoint("coordinate")
      if (typeof p === "string") return p
      const direction = a.scroll_direction
      if (direction === undefined) return "scroll_direction (up, down, left or right) is required"
      const amount = Math.round(a.scroll_amount ?? 3)
      if (!Number.isFinite(amount) || amount < 1 || amount > MAX_SCROLL) return `scroll_amount must be between 1 and ${MAX_SCROLL}`
      const mods = heldModifiers(a.text, mac)
      if (mods === undefined) return `text must name modifier keys to hold (e.g. "shift"), got ${JSON.stringify(a.text)}`
      return {
        hold: mods,
        steps: [...(p ? [moveTo(g, p)] : []), xdo("click", "--repeat", amount, "--delay", 30, SCROLL_BUTTONS[direction])],
        image: "after",
        cursor: false,
        text: `Scrolled ${direction} ${amount}${at(p)}${withMods(mods)}.`,
      }
    }
    case "type": {
      if (a.text === undefined || a.text === "") return "text is required for type"
      return {
        hold: [],
        steps: chunkText(a.text).map((chunk) => xdo("type", "--delay", TYPE_DELAY_MS, "--", chunk)),
        image: "after",
        cursor: false,
        text: `Typed ${Array.from(a.text).length} characters.`,
      }
    }
    case "key": {
      const keys = xdoKeySequence(a.text, mac)
      if (keys === undefined) return `text must name a key or combination for key (e.g. "Return" or "ctrl+l"), got ${JSON.stringify(a.text)}`
      return { hold: [], steps: [xdo("key", "--delay", 50, "--", ...keys)], image: "after", cursor: false, text: `Pressed ${keys.join(" ")}.` }
    }
    case "hold_key": {
      const keys = holdKeys(a.text, mac)
      if (keys === undefined) return `text must name the key to hold (e.g. "shift"), got ${JSON.stringify(a.text)}`
      const d = seconds(a.duration, 1)
      if (typeof d === "string") return d
      return { hold: keys, steps: [sleep(d * 1000)], image: "after", cursor: false, text: `Held ${keys.join("+")} for ${d} s.` }
    }
    case "wait": {
      const d = seconds(a.duration, 1)
      if (typeof d === "string") return d
      return { hold: [], steps: [sleep(d * 1000)], image: "now", cursor: false, text: `Waited ${d} s.` }
    }
    case "cursor_position":
      return { hold: [], steps: [], image: "none", cursor: true, text: "" }
  }
}

/** Short audit / approval target for an action (no typed text). */
export const describeComputerAction = (a: ComputerAction): string => {
  const c = a.coordinate && a.coordinate.length === 2 ? ` ${Math.round(a.coordinate[0]!)},${Math.round(a.coordinate[1]!)}` : ""
  switch (a.action) {
    case "type":
      return `type ${Array.from(a.text ?? "").length} chars`
    case "key":
    case "hold_key":
      return `${a.action} ${a.text ?? ""}`.trim()
    case "scroll":
      return `scroll ${a.scroll_direction ?? ""} ${a.scroll_amount ?? 3}${c}`.replace(/\s+/g, " ").trim()
    case "left_click_drag": {
      const s = a.start_coordinate && a.start_coordinate.length === 2 ? `${Math.round(a.start_coordinate[0]!)},${Math.round(a.start_coordinate[1]!)}` : "?"
      return `left_click_drag ${s} →${c || " ?"}`
    }
    case "zoom":
      return `zoom ${(a.region ?? []).map((n) => Math.round(n)).join(",")}`
    default:
      return `${a.action}${c}`
  }
}

/** Parses `xdotool getmouselocation --shell` output (`X=…\nY=…`). */
export const parseMouseLocation = (out: string): Point | undefined => {
  const x = /(?:^|\n)X=(-?\d+)/.exec(out)
  const y = /(?:^|\n)Y=(-?\d+)/.exec(out)
  if (!x || !y) return undefined
  return { x: Number(x[1]), y: Number(y[1]) }
}

export interface ScreenshotSpec {
  readonly display: string
  readonly width: number
  readonly height: number
  /** exact size (`WxH!`) for full screenshots; fit (`WxH`) for zoom crops */
  readonly exact: boolean
  readonly crop?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined
  readonly format: "jpeg" | "webp" | "png"
  readonly quality: number
}

/** ImageMagick `import` argv (after the program, e.g. `["import"]` or `["magick", "import"]`); the image goes to stdout. */
export const importArgs = (s: ScreenshotSpec): ReadonlyArray<string> => [
  "-silent",
  "-display",
  s.display,
  "-window",
  "root",
  ...(s.crop ? ["-crop", `${s.crop.width}x${s.crop.height}+${s.crop.x}+${s.crop.y}`, "+repage"] : []),
  "-resize",
  `${s.width}x${s.height}${s.exact ? "!" : ""}`,
  "-strip",
  ...(s.format === "png" ? [] : ["-quality", String(Math.max(1, Math.min(100, Math.round(s.quality))))]),
  `${s.format}:-`,
]
