// AppShell (architecture §4.10, grok-bot-ui.md §2.5/§3), by layout mode (layout.ts):
// - desktop (≥ 1024): CSS grid [sidebar 280 | chat 1fr | details 320]. The sidebar resizes within
//   240..400 (dragging below ~180 snaps to the 88 px compact rail), the details pane within 280..424.
//   Widths persist in localStorage.
// - tablet (768–1023): [sidebar | chat]; the details pane slides over the chat as a sheet.
// - phone (< 768): one screen at a time, Grok iOS style: Home (the full-width sidebar list) or the
//   chat pushed over it; details and the computer view are full-screen sheets.
import { type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { cn } from "@openbot/ui"
import { useLayoutMode } from "./layout.ts"

export const SIDEBAR = { default: 280, min: 240, max: 400, compact: 88 } as const
export const DETAILS = { default: 320, min: 280, max: 424 } as const
export const CHAT_MIN = 424

const read = (key: string, fallback: number, min: number, max: number): number => {
  try {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v >= min && v <= max ? v : fallback
  } catch {
    return fallback
  }
}
const write = (key: string, v: number) => {
  try {
    localStorage.setItem(key, String(Math.round(v)))
  } catch {}
}

function ResizeHandle({ side, label, onDrag, onEnd }: { readonly side: "left" | "right"; readonly label: string; readonly onDrag: (dx: number) => void; readonly onEnd: () => void }): ReactNode {
  const [dragging, setDragging] = useState(false)
  const last = useRef(0)
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    last.current = e.clientX
    setDragging(true)
  }
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    const dx = e.clientX - last.current
    last.current = e.clientX
    if (dx !== 0) onDrag(dx)
  }
  const up = () => {
    if (!dragging) return
    setDragging(false)
    onEnd()
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      className="ob-resize"
      style={side === "right" ? { right: -6 } : { left: -6 }}
      {...(dragging ? { "data-dragging": "" } : {})}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    />
  )
}

export interface AppShellProps {
  readonly sidebar: (state: { readonly compact: boolean; readonly toggleCompact: () => void }) => ReactNode
  readonly chat: ReactNode
  readonly details: ReactNode | null
  /** Full-window overlay (ComputerView). */
  readonly overlay?: ReactNode
  readonly compact: boolean
  readonly onCompactChange: (compact: boolean) => void
  /** Phone: the Home list is on screen (else the chat is pushed over it). */
  readonly home?: boolean
  /** Tablet: the scrim behind the details sheet closes it. */
  readonly onCloseDetails?: () => void
}

export function AppShell(props: AppShellProps): ReactNode {
  const mode = useLayoutMode()
  return mode === "phone" ? <PhoneShell {...props} /> : <GridShell {...props} tablet={mode === "tablet"} />
}

const noop = () => {}

function PhoneShell({ sidebar, chat, details, overlay, home = false }: AppShellProps): ReactNode {
  return (
    <div className="ob-phone relative h-full w-full overflow-hidden bg-sidebar" data-view={home ? "home" : "chat"}>
      {/* Home stays mounted under the chat so its scroll position survives a round trip. */}
      <div className="ob-home absolute inset-0" inert={!home} aria-hidden={home ? undefined : true}>
        {sidebar({ compact: false, toggleCompact: noop })}
      </div>
      {!home && <div className="absolute inset-0 z-10 animate-push-in bg-chrome shadow-modal">{chat}</div>}
      {!home && details && (
        <div className="fixed inset-0 z-[2000] animate-push-in overflow-hidden bg-chrome">
          {details}
        </div>
      )}
      {overlay && <div className="fixed inset-0 z-[2500] animate-sheet-up bg-black">{overlay}</div>}
    </div>
  )
}

function GridShell({ sidebar, chat, details, overlay, compact, onCompactChange, onCloseDetails, tablet }: AppShellProps & { readonly tablet: boolean }): ReactNode {
  const [sidebarW, setSidebarW] = useState(() => read("openbot.sidebar.width", SIDEBAR.default, SIDEBAR.min, SIDEBAR.max))
  const [detailsW, setDetailsW] = useState(() => read("openbot.details.width", DETAILS.default, DETAILS.min, DETAILS.max))
  const raw = useRef(sidebarW)
  const toggleCompact = useCallback(() => onCompactChange(!compact), [compact, onCompactChange])

  // Keep the chat column at least CHAT_MIN wide on narrow windows by closing nothing, only clamping.
  const [vw, setVw] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth))
  useEffect(() => {
    const on = () => setVw(window.innerWidth)
    window.addEventListener("resize", on)
    return () => window.removeEventListener("resize", on)
  }, [])
  const side = compact ? SIDEBAR.compact : sidebarW
  const pane = details && !tablet ? Math.max(DETAILS.min, Math.min(detailsW, vw - side - CHAT_MIN)) : 0

  return (
    <div
      className="grid h-full w-full overflow-hidden bg-chrome"
      style={{ gridTemplateColumns: `${side}px minmax(0, 1fr) ${pane}px` }}
      data-compact={compact || undefined}
    >
      <aside className="relative min-h-0 min-w-0 border-e-[0.5px] border-line-tertiary">
        {sidebar({ compact, toggleCompact })}
        {!compact && (
          <ResizeHandle
            side="right"
            label="Resize sidebar"
            onDrag={(dx) => {
              raw.current += dx
              if (raw.current < 180) {
                onCompactChange(true)
                raw.current = SIDEBAR.default
                return
              }
              setSidebarW(Math.max(SIDEBAR.min, Math.min(SIDEBAR.max, raw.current)))
            }}
            onEnd={() => {
              raw.current = sidebarW
              write("openbot.sidebar.width", sidebarW)
            }}
          />
        )}
      </aside>
      <div className="relative min-h-0 min-w-0">{chat}</div>
      {tablet && details && (
        <div className="fixed inset-0 z-[2000]">
          <div className="absolute inset-0 animate-fade-in bg-scrim" onClick={onCloseDetails} aria-hidden />
          <div className="absolute inset-y-0 end-0 w-[min(400px,100%)] animate-slide-in-end overflow-hidden bg-chrome shadow-modal">{details}</div>
        </div>
      )}
      <aside className={cn("relative min-h-0 min-w-0 overflow-hidden bg-chrome", details != null && !tablet && "border-s-[0.5px] border-line-tertiary")} aria-label="Details" hidden={!details || tablet}>
        {details && !tablet && (
          <>
            <ResizeHandle
              side="left"
              label="Resize details"
              onDrag={(dx) => setDetailsW((w) => Math.max(DETAILS.min, Math.min(DETAILS.max, w - dx)))}
              onEnd={() => write("openbot.details.width", detailsW)}
            />
            <div className="h-full overflow-hidden">{details}</div>
          </>
        )}
      </aside>
      {overlay && <div className="fixed inset-0 z-[2500] animate-fade-in">{overlay}</div>}
    </div>
  )
}
