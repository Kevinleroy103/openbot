// Touch long-press: the touch equivalent of right-click menus and hover actions. iOS Safari fires no
// `contextmenu` on a long press, so this watches touch/pen pointers itself: hold ~450 ms without
// moving (a scroll cancels it) → `onLongPress`. The click that follows the release is swallowed so
// the row / link under the finger doesn't also activate. Mouse pointers are ignored.
import { type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, useEffect, useRef } from "react"

export interface LongPressPoint {
  readonly x: number
  readonly y: number
}

const DELAY = 450
const SLOP = 10

const createTracker = (fire: (target: Element, point: LongPressPoint) => boolean) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let origin: LongPressPoint | undefined
  let fired = false
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  return {
    down: (pointerType: string, target: Element, x: number, y: number) => {
      cancel()
      fired = false
      if (pointerType === "mouse") return
      origin = { x, y }
      timer = setTimeout(() => {
        timer = undefined
        if (fire(target, origin!)) {
          fired = true
          try {
            navigator.vibrate?.(8)
          } catch {}
        }
      }, DELAY)
    },
    move: (x: number, y: number) => {
      if (timer !== undefined && origin && Math.hypot(x - origin.x, y - origin.y) > SLOP) cancel()
    },
    cancel,
    /** True once if the current gesture fired (the caller swallows the click). */
    consumeFired: () => {
      const f = fired
      fired = false
      return f
    },
    dispose: cancel,
  }
}

/** Long-press handlers for one element (spread them on it). */
export function useLongPress(onLongPress: (point: LongPressPoint) => void) {
  const cb = useRef(onLongPress)
  cb.current = onLongPress
  const tracker = useRef<ReturnType<typeof createTracker> | null>(null)
  tracker.current ??= createTracker((_, p) => (cb.current(p), true))
  const t = tracker.current
  useEffect(() => () => t.dispose(), [t])
  return {
    onPointerDown: (e: ReactPointerEvent) => t.down(e.pointerType, e.currentTarget, e.clientX, e.clientY),
    onPointerMove: (e: ReactPointerEvent) => t.move(e.clientX, e.clientY),
    onPointerUp: () => t.cancel(),
    onPointerCancel: () => t.cancel(),
    onPointerLeave: () => t.cancel(),
    onClickCapture: (e: ReactMouseEvent) => {
      if (t.consumeFired()) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
  }
}

/**
 * Delegated long-press for a container (the transcript): `match` picks the pressed item from the
 * event target (return undefined to ignore the press), `onLongPress` gets it.
 */
export function useLongPressWithin<T>(match: (target: Element) => T | undefined, onLongPress: (item: T, point: LongPressPoint) => void) {
  const matchRef = useRef(match)
  matchRef.current = match
  const cb = useRef(onLongPress)
  cb.current = onLongPress
  const tracker = useRef<ReturnType<typeof createTracker> | null>(null)
  tracker.current ??= createTracker((target, p) => {
    const item = matchRef.current(target)
    if (item === undefined) return false
    cb.current(item, p)
    return true
  })
  const t = tracker.current
  useEffect(() => () => t.dispose(), [t])
  return {
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.target instanceof Element && matchRef.current(e.target) !== undefined) t.down(e.pointerType, e.target, e.clientX, e.clientY)
    },
    onPointerMove: (e: ReactPointerEvent) => t.move(e.clientX, e.clientY),
    onPointerUp: () => t.cancel(),
    onPointerCancel: () => t.cancel(),
    onClickCapture: (e: ReactMouseEvent) => {
      if (t.consumeFired()) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
  }
}

/**
 * For a menu / sheet that a long-press opens under the finger: lifting that finger must not "click"
 * whatever item now sits there. Clicks count only after a press that started inside the surface.
 */
export function useArmedClicks() {
  const armed = useRef(false)
  return {
    onPointerDownCapture: () => {
      armed.current = true
    },
    onClickCapture: (e: ReactMouseEvent) => {
      if (armed.current || e.detail === 0) return // (detail 0: keyboard activation)
      e.preventDefault()
      e.stopPropagation()
    },
  }
}
