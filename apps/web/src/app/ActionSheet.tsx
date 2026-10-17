// Bottom action sheet (phone): the touch counterpart of context menus and small popovers. A scrim,
// a panel that rises from the bottom edge (grabber, optional header, safe-area padding), Esc /
// scrim tap / browser Back close it. Menu rows inside get 44 px touch targets (app.css .ob-sheet).
import { type ReactNode, useEffect, useRef } from "react"
import { Portal, cn } from "@openbot/ui"
import { isTouchNow } from "./layout.ts"
import { useArmedClicks } from "./longPress.ts"
import { useBackDismiss } from "./nav.ts"

export interface ActionSheetProps {
  readonly onClose: () => void
  readonly label: string
  /** Shown above the actions (avatar + name, a message preview…). */
  readonly header?: ReactNode
  readonly children: ReactNode
  readonly className?: string
  readonly testId?: string
}

export function ActionSheet({ onClose, label, header, children, className, testId }: ActionSheetProps): ReactNode {
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const armed = useArmedClicks()
  const scrimArmed = useRef(false)
  useBackDismiss(true, onClose, `action:${label}`)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.focus({ preventScroll: true })
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        close.current()
      }
    }
    document.addEventListener("keydown", key)
    return () => {
      document.removeEventListener("keydown", key)
      // (touch: refocusing a text field would pop the keyboard back up)
      if (!isTouchNow()) previous?.focus?.({ preventScroll: true })
    }
  }, [])
  return (
    <Portal>
      <div className="fixed inset-0 z-[4500]">
        {/* Closes on click (not pointerdown, which would let the click land on what is underneath), and
            only for a press that started on the scrim (not the long-press that opened the sheet). */}
        <div
          className="absolute inset-0 animate-fade-in bg-scrim"
          onPointerDown={() => (scrimArmed.current = true)}
          onClick={() => scrimArmed.current && onClose()}
          aria-hidden
          data-testid="action-sheet-scrim"
        />
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          tabIndex={-1}
          data-testid={testId}
          {...armed}
          className={cn(
            "ob-sheet absolute inset-x-0 bottom-0 flex max-h-[85%] flex-col overflow-hidden rounded-t-[22px] bg-elevated shadow-modal outline-none",
            "animate-sheet-up pb-[max(10px,env(safe-area-inset-bottom))]",
            className,
          )}
        >
          <div className="flex shrink-0 justify-center pt-2 pb-1" aria-hidden>
            <span className="h-[5px] w-9 rounded-full bg-line" />
          </div>
          {header && <div className="shrink-0 px-4 pt-1 pb-2">{header}</div>}
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-1 scrollbar-thin">{children}</div>
        </div>
      </div>
    </Portal>
  )
}
