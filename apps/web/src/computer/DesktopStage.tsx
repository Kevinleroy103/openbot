// The frame noVNC draws a bot's desktop into: contain-fitted to the desktop's aspect ratio (1920×1200
// → 16:10) and letterboxed in its container, rounded corners; noVNC's `scaleViewport` fits the remote
// screen into it. While there is no picture, `overlay` (a notice) shows in the frame instead.
import { cn } from "@openbot/ui"
import { type ReactNode, type RefObject, useRef } from "react"
import { useContainFit } from "./useScreencast.ts"

export interface DesktopStageProps {
  /** noVNC's target: React renders no children into it. */
  readonly targetRef: RefObject<HTMLDivElement | null>
  /** Width / height of the remote screen. */
  readonly aspect: number
  readonly live: boolean
  /** Input goes to the desktop (control mode). */
  readonly interactive: boolean
  readonly overlay?: ReactNode
  readonly frameClassName?: string
  readonly label: string
  /** Clicks fall through to the parent (thumbnails, card peeks). */
  readonly passive?: boolean
}

export function DesktopStage({ targetRef, aspect, live, interactive, overlay, frameClassName, label, passive = false }: DesktopStageProps): ReactNode {
  const boxRef = useRef<HTMLDivElement>(null)
  const fit = useContainFit(boxRef, aspect)
  return (
    <div ref={boxRef} className="relative flex h-full w-full min-h-0 min-w-0 items-center justify-center">
      <div
        className={cn("relative overflow-hidden", frameClassName)}
        style={{ width: fit.width || undefined, height: fit.height || undefined, aspectRatio: fit.width ? undefined : String(aspect) }}
      >
        <div
          ref={targetRef}
          role="img"
          aria-label={label}
          data-testid="desktop-screen"
          data-live={live || undefined}
          data-interactive={interactive || undefined}
          className={cn(
            "ob-desktop absolute inset-0",
            !live && "invisible",
            passive && "pointer-events-none",
            // in control, touches are mouse input on the desktop, not page gestures
            interactive && "touch-none",
          )}
        />
        {!live && overlay && <div className="absolute inset-0 flex items-center justify-center">{overlay}</div>}
      </div>
    </div>
  )
}
