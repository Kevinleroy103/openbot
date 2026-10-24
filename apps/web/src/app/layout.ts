// Responsive layout modes and the mobile viewport plumbing.
//
//   phone   < 768 px   one pane at a time (Home list ⇄ pushed chat), sheets are full screen
//   tablet  768–1023   sidebar + chat; the details pane is an overlay sheet
//   desktop ≥ 1024     the three-pane grid (D6.2), unchanged
//
// The visual-viewport hook mirrors `visualViewport` into CSS variables on <html> so the app root
// (app.css) shrinks above the iOS keyboard instead of being pushed under it.
import { useEffect, useSyncExternalStore } from "react"

export type LayoutMode = "phone" | "tablet" | "desktop"

export const PHONE_QUERY = "(max-width: 767px)"
export const TABLET_QUERY = "(max-width: 1023px)"
/** Touch-first device: no hover, coarse pointer (phones, tablets). */
export const TOUCH_QUERY = "(hover: none) and (pointer: coarse)"

const media = (query: string): MediaQueryList | undefined =>
  typeof matchMedia === "undefined" ? undefined : matchMedia(query)

export const layoutModeNow = (): LayoutMode =>
  media(PHONE_QUERY)?.matches ? "phone" : media(TABLET_QUERY)?.matches ? "tablet" : "desktop"
export const isPhoneNow = (): boolean => layoutModeNow() === "phone"
export const isTouchNow = (): boolean => media(TOUCH_QUERY)?.matches ?? false

const subscribeTo =
  (...queries: ReadonlyArray<string>) =>
  (onChange: () => void): (() => void) => {
    const lists = queries.map(media).filter((m): m is MediaQueryList => m !== undefined)
    for (const m of lists) m.addEventListener("change", onChange)
    return () => {
      for (const m of lists) m.removeEventListener("change", onChange)
    }
  }
const subscribeLayout = subscribeTo(PHONE_QUERY, TABLET_QUERY)
const subscribeTouch = subscribeTo(TOUCH_QUERY)

export const useLayoutMode = (): LayoutMode => useSyncExternalStore(subscribeLayout, layoutModeNow, () => "desktop")
export const useIsPhone = (): boolean => useLayoutMode() === "phone"
export const useIsTouch = (): boolean => useSyncExternalStore(subscribeTouch, isTouchNow, () => false)

/**
 * iOS keyboard handling: Safari keeps the layout viewport when the keyboard opens and only shrinks
 * the visual viewport. On touch devices we publish its height / offset as `--ob-vvh` / `--ob-vv-top`
 * (the fixed app root follows them, so the composer sits right above the keyboard) and flag
 * `html[data-keyboard]` (drops the home-indicator padding under the composer). Pinch-zoom is left
 * alone. Desktop browsers are not touched.
 */
export const useVisualViewport = (): void => {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv || !isTouchNow()) return
    const root = document.documentElement
    let frame = 0
    const apply = () => {
      frame = 0
      if (vv.scale > 1.05) return
      root.style.setProperty("--ob-vvh", `${Math.round(vv.height)}px`)
      root.style.setProperty("--ob-vv-top", `${Math.max(0, Math.round(vv.offsetTop))}px`)
      const keyboard = window.innerHeight - vv.height > 120
      root.toggleAttribute("data-keyboard", keyboard)
      // Safari scrolls the (non-scrollable) document to reveal a focused field; undo it once the keyboard is gone.
      if (!keyboard && (window.scrollY !== 0 || window.scrollX !== 0)) window.scrollTo(0, 0)
    }
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(apply)
    }
    apply()
    vv.addEventListener("resize", schedule)
    vv.addEventListener("scroll", schedule)
    window.addEventListener("orientationchange", schedule)
    return () => {
      cancelAnimationFrame(frame)
      vv.removeEventListener("resize", schedule)
      vv.removeEventListener("scroll", schedule)
      window.removeEventListener("orientationchange", schedule)
      root.style.removeProperty("--ob-vvh")
      root.style.removeProperty("--ob-vv-top")
      root.removeAttribute("data-keyboard")
    }
  }, [])
}
