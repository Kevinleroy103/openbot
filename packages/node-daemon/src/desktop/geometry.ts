// Coordinate spaces of the `computer` tool (remote-computer-control.md §7.2, Grok's exec-daemon
// scaler). The model sees screenshots scaled to a fixed API width (1280 px; 1280×800 for a 1920×1200
// screen) and acts in that space; the node maps API coordinates back to screen pixels.

export interface ScreenGeometry {
  /** screen size in pixels */
  readonly width: number
  readonly height: number
  /** model-facing (screenshot) size */
  readonly apiWidth: number
  readonly apiHeight: number
}

/** `apiW = min(apiWidth, W)`, `apiH = round(apiW · H / W)`. Screens narrower than the API width are not upscaled. */
export const makeGeometry = (width: number, height: number, apiWidth = 1280): ScreenGeometry => {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const apiW = Math.max(1, Math.min(Math.round(apiWidth), w))
  return { width: w, height: h, apiWidth: apiW, apiHeight: Math.max(1, Math.round((apiW * h) / w)) }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** API point → screen pixel (rounded, clamped to the screen). */
export const toScreen = (g: ScreenGeometry, x: number, y: number): { readonly x: number; readonly y: number } => ({
  x: clamp(Math.round((x * g.width) / g.apiWidth), 0, g.width - 1),
  y: clamp(Math.round((y * g.height) / g.apiHeight), 0, g.height - 1),
})

/** Screen pixel → API point (rounded, clamped to the screenshot). */
export const toApi = (g: ScreenGeometry, x: number, y: number): { readonly x: number; readonly y: number } => ({
  x: clamp(Math.round((x * g.apiWidth) / g.width), 0, g.apiWidth - 1),
  y: clamp(Math.round((y * g.apiHeight) / g.height), 0, g.apiHeight - 1),
})

export interface Point {
  readonly x: number
  readonly y: number
}

/**
 * Validates an API `[x, y]` (two finite numbers inside the screenshot). Returns the point or an
 * error message for the model.
 */
export const apiPoint = (g: ScreenGeometry, value: ReadonlyArray<number> | undefined, name: string): Point | string => {
  if (value === undefined) return `${name} [x, y] is required`
  if (value.length !== 2 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return `${name} must be two numbers [x, y]`
  }
  const [x, y] = value as [number, number]
  if (x < 0 || y < 0 || x > g.apiWidth || y > g.apiHeight) {
    return `${name} [${x}, ${y}] is outside the ${g.apiWidth}x${g.apiHeight} screenshot`
  }
  return { x: Math.round(Math.min(x, g.apiWidth - 1)), y: Math.round(Math.min(y, g.apiHeight - 1)) }
}

export interface ZoomRect {
  /** crop on the screen, in screen pixels */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** size the crop is resized to: it fits the screenshot box, keeping its aspect ratio */
  readonly outWidth: number
  readonly outHeight: number
}

/**
 * `zoom`: an API region `[x0, y0, x1, y1]` → the screen crop (full resolution) and the size it is
 * shown at (fitted into the API screenshot box). Returns an error message for a bad region.
 */
export const zoomRect = (g: ScreenGeometry, region: ReadonlyArray<number> | undefined): ZoomRect | string => {
  if (region === undefined) return "region [x0, y0, x1, y1] is required"
  if (region.length !== 4 || !region.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return "region must be four numbers [x0, y0, x1, y1]"
  }
  const [a, b, c, d] = region as [number, number, number, number]
  const x0 = clamp(Math.min(a, c), 0, g.apiWidth)
  const x1 = clamp(Math.max(a, c), 0, g.apiWidth)
  const y0 = clamp(Math.min(b, d), 0, g.apiHeight)
  const y1 = clamp(Math.max(b, d), 0, g.apiHeight)
  if (x1 - x0 < 1 || y1 - y0 < 1)
    return `region [${region.join(", ")}] is empty or outside the ${g.apiWidth}x${g.apiHeight} screenshot`
  const sx = clamp(Math.floor((x0 * g.width) / g.apiWidth), 0, g.width - 1)
  const sy = clamp(Math.floor((y0 * g.height) / g.apiHeight), 0, g.height - 1)
  const ex = clamp(Math.ceil((x1 * g.width) / g.apiWidth), sx + 1, g.width)
  const ey = clamp(Math.ceil((y1 * g.height) / g.apiHeight), sy + 1, g.height)
  const width = ex - sx
  const height = ey - sy
  const scale = Math.min(g.apiWidth / width, g.apiHeight / height)
  return {
    x: sx,
    y: sy,
    width,
    height,
    outWidth: Math.max(1, Math.round(width * scale)),
    outHeight: Math.max(1, Math.round(height * scale)),
  }
}
