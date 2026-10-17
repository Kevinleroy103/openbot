// Details › Computer screen card (grok-bot-ui-activity.md F.8 "Thumbnail"): 288×180, radius 12,
// 6 % placeholder fill, live frames scaled inside, caption "‹Bot›'s screen". Click → ComputerView.
import type { BotId } from "@openbot/contracts"
import { Avatar, Icon, PillButton, ShimmerText, Spinner, cn } from "@openbot/ui"
import { Maximize2, Unplug } from "lucide-react"
import { type ReactNode, useRef } from "react"
import { useComputerView } from "../contracts.ts"
import { ScreenStage } from "./ScreenStage.tsx"
import { useComputer } from "./useComputer.ts"
import { useScreencast } from "./useScreencast.ts"

export interface ScreenThumbnailProps {
  readonly botId: BotId
  readonly botName: string
  /** Host node label ("Runs on ‹node›" in the empty state). */
  readonly nodeLabel?: string | undefined
  readonly onOpen: () => void
  readonly className?: string
}

export function ScreenThumbnail({ botId, botName, nodeLabel, onOpen, className }: ScreenThumbnailProps): ReactNode {
  const { status, availability, ensure } = useComputer(botId)
  // pause the thumbnail while the full-screen view of the same bot is open (one viewer is enough)
  const fullView = useComputerView()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { state, send } = useScreencast({
    botId,
    enabled: availability.kind === "stream" && fullView.botId !== botId,
    mode: "view",
    viewPath: status.value?.viewPath,
    canvasRef,
    onTrouble: status.refresh,
  })
  const live = state.phase === "live"

  const placeholder = (icon: ReactNode, title: ReactNode, sub?: ReactNode, action?: ReactNode) => (
    <div className="flex flex-col items-center gap-1 px-4 text-center" data-testid="screen-empty">
      {icon}
      <div className="mt-1.5 text-base text-fg">{title}</div>
      {sub && <div className="text-sm text-fg-secondary">{sub}</div>}
      {action}
    </div>
  )
  const ghost = <Avatar shape="blob" color="gray" size={28} />

  let overlay: ReactNode
  switch (availability.kind) {
    case "loading":
      overlay = placeholder(<Spinner size={16} className="text-icon-tertiary" />, <ShimmerText>Checking the screen…</ShimmerText>)
      break
    case "unsupported":
      overlay = placeholder(ghost, nodeLabel ? `Works on ${nodeLabel}` : "Works on this device", "No screen to show")
      break
    case "unreachable":
      overlay = placeholder(<Icon icon={Unplug} size="lg" className="text-icon-tertiary" />, `Can't reach ${botName}'s screen`, availability.message)
      break
    case "absent":
      overlay = placeholder(
        ghost,
        "No screen to show",
        ensure.error ?? "The browser opens when it's needed",
        <PillButton
          size="sm"
          variant="secondary"
          className="mt-2"
          loading={ensure.pending}
          onClick={(e) => {
            e.stopPropagation()
            void ensure.run({ botId }).then((r) => r.ok && status.refresh())
          }}
        >
          Open browser
        </PillButton>,
      )
      break
    case "stream":
      overlay =
        state.phase === "unreachable" || state.phase === "ended"
          ? placeholder(<Icon icon={Unplug} size="lg" className="text-icon-tertiary" />, `Can't reach ${botName}'s screen`, state.message ?? "Retrying…")
          : placeholder(<Spinner size={16} className="text-icon-tertiary" />, <ShimmerText>Waking up…</ShimmerText>, "Just a moment")
      break
  }

  return (
    <div className={cn("flex flex-col items-center gap-2", className)}>
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open ${botName}'s screen`}
        data-testid="screen-thumbnail"
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onOpen()
          }
        }}
        className="group relative flex h-[180px] w-[288px] cursor-pointer items-center justify-center overflow-hidden rounded-2xl bg-secondary transition-[filter] duration-150 hover:brightness-[.98] focus-visible:outline-2"
      >
        <ScreenStage canvasRef={canvasRef} state={state} interactive={false} send={send} overlay={overlay} label={`${botName}'s screen`} />
        {live && (
          <span className="absolute top-2 right-2 inline-flex size-6 items-center justify-center rounded-md bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100">
            <Icon icon={Maximize2} size="xs" />
          </span>
        )}
      </div>
      <span className="text-sm text-fg-secondary">{botName}'s screen</span>
    </div>
  )
}
