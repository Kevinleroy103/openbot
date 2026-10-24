// The canvas a screencast paints into, contain-fitted to its container (16:10 until the first frame
// tells the real size), plus user input relay while the owner holds the control lease.
import { cn } from "@openbot/ui"
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef } from "react"
import { type BrowserInputEvent, modifiersOf, mouseButtonOf, toViewportPoint } from "./protocol.ts"
import { type ScreencastState, useContainFit } from "./useScreencast.ts"

export interface ScreenStageProps {
  readonly canvasRef: RefObject<HTMLCanvasElement | null>
  readonly state: ScreencastState
  /** Relay input (true only while the user holds the lease on a control socket). */
  readonly interactive: boolean
  readonly send: (event: BrowserInputEvent) => void
  /** Rendered over the frame area when there is no live frame. */
  readonly overlay?: ReactNode
  readonly frameClassName?: string
  readonly label: string
}

const DEFAULT_ASPECT = 16 / 10

export function ScreenStage({
  canvasRef,
  state,
  interactive,
  send,
  overlay,
  frameClassName,
  label,
}: ScreenStageProps): ReactNode {
  const boxRef = useRef<HTMLDivElement>(null)
  const meta = state.meta
  const aspect = meta && meta.width > 0 && meta.height > 0 ? meta.width / meta.height : DEFAULT_ASPECT
  const fit = useContainFit(boxRef, aspect)
  const live = state.phase === "live" || (meta !== undefined && state.phase !== "idle")

  // ------------------------------------------------------------------ input relay
  const metaRef = useRef(meta)
  const sendRef = useRef(send)
  useLayoutEffect(() => {
    metaRef.current = meta
    sendRef.current = send
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !interactive) return
    const point = (e: { clientX: number; clientY: number }, clamp = false) => {
      const m = metaRef.current
      if (!m) return undefined
      const r = canvas.getBoundingClientRect()
      const x = clamp ? Math.min(r.right, Math.max(r.left, e.clientX)) : e.clientX
      const y = clamp ? Math.min(r.bottom, Math.max(r.top, e.clientY)) : e.clientY
      return toViewportPoint(x, y, r, m)
    }
    // MouseEvent (not PointerEvent) so `detail` carries the click count for double / triple clicks.
    let pressed: "left" | "middle" | "right" | undefined
    let moveFrame = 0
    let lastMove: MouseEvent | undefined
    const flushMove = () => {
      moveFrame = 0
      const e = lastMove
      lastMove = undefined
      const p = e && point(e, pressed !== undefined)
      if (e && p) {
        const mods = modifiersOf(e)
        sendRef.current({
          _tag: "mouse",
          type: "move",
          x: p.x,
          y: p.y,
          button: pressed ?? "none",
          ...(mods ? { modifiers: mods } : {}),
        })
      }
    }
    const onMove = (e: MouseEvent) => {
      if (e.target !== canvas && pressed === undefined) return
      lastMove = e
      if (!moveFrame) moveFrame = requestAnimationFrame(flushMove)
    }
    const onDown = (e: MouseEvent) => {
      e.preventDefault()
      canvas.focus({ preventScroll: true })
      const p = point(e)
      if (!p) return
      pressed = mouseButtonOf(e.button)
      const mods = modifiersOf(e)
      sendRef.current({
        _tag: "mouse",
        type: "down",
        x: p.x,
        y: p.y,
        button: pressed,
        clickCount: Math.max(1, e.detail || 1),
        ...(mods ? { modifiers: mods } : {}),
      })
    }
    // released anywhere (drags may leave the frame): clamp to the frame edge
    const onUp = (e: MouseEvent) => {
      if (pressed === undefined) return
      pressed = undefined
      const p = point(e, true)
      if (!p) return
      const mods = modifiersOf(e)
      sendRef.current({
        _tag: "mouse",
        type: "up",
        x: p.x,
        y: p.y,
        button: mouseButtonOf(e.button),
        clickCount: Math.max(1, e.detail || 1),
        ...(mods ? { modifiers: mods } : {}),
      })
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const p = point(e)
      if (!p) return
      // normalize line/page deltas to pixels
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1
      const mods = modifiersOf(e)
      sendRef.current({
        _tag: "mouse",
        type: "wheel",
        x: p.x,
        y: p.y,
        deltaX: e.deltaX * scale,
        deltaY: e.deltaY * scale,
        ...(mods ? { modifiers: mods } : {}),
      })
    }
    const onKey = (type: "down" | "up") => (e: KeyboardEvent) => {
      if (e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      const mods = modifiersOf(e)
      const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey
      sendRef.current({
        _tag: "key",
        type,
        key: e.key,
        code: e.code,
        ...(printable && type === "down" ? { text: e.key } : {}),
        ...(mods ? { modifiers: mods } : {}),
      })
    }
    const onKeyDown = onKey("down")
    const onKeyUp = onKey("up")
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain")
      if (!text) return
      e.preventDefault()
      sendRef.current({ _tag: "text", text })
    }
    const onContext = (e: Event) => e.preventDefault()
    window.addEventListener("mousemove", onMove)
    canvas.addEventListener("mousedown", onDown)
    window.addEventListener("mouseup", onUp)
    canvas.addEventListener("wheel", onWheel, { passive: false })
    canvas.addEventListener("keydown", onKeyDown)
    canvas.addEventListener("keyup", onKeyUp)
    canvas.addEventListener("paste", onPaste)
    canvas.addEventListener("contextmenu", onContext)
    canvas.focus({ preventScroll: true })
    return () => {
      if (moveFrame) cancelAnimationFrame(moveFrame)
      window.removeEventListener("mousemove", onMove)
      canvas.removeEventListener("mousedown", onDown)
      window.removeEventListener("mouseup", onUp)
      canvas.removeEventListener("wheel", onWheel)
      canvas.removeEventListener("keydown", onKeyDown)
      canvas.removeEventListener("keyup", onKeyUp)
      canvas.removeEventListener("paste", onPaste)
      canvas.removeEventListener("contextmenu", onContext)
    }
  }, [canvasRef, interactive])

  return (
    <div ref={boxRef} className="relative flex h-full w-full min-h-0 min-w-0 items-center justify-center">
      <div
        className={cn("relative overflow-hidden", frameClassName)}
        style={{
          width: fit.width || undefined,
          height: fit.height || undefined,
          aspectRatio: fit.width ? undefined : String(aspect),
        }}
      >
        <canvas
          ref={canvasRef}
          aria-label={label}
          role="img"
          tabIndex={interactive ? 0 : -1}
          data-testid="screen-canvas"
          data-interactive={interactive || undefined}
          className={cn(
            "absolute inset-0 block h-full w-full outline-none",
            !live && "invisible",
            interactive ? "cursor-default" : "cursor-[inherit]",
          )}
        />
        {!live && overlay && <div className="absolute inset-0 flex items-center justify-center">{overlay}</div>}
      </div>
    </div>
  )
}
