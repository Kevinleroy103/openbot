// Details › Computer screen card (grok-bot-ui-activity.md F.8 "Thumbnail"): 288×180, radius 12,
// 6 % placeholder fill, the live screen scaled inside (the bot's whole desktop over noVNC, view-only,
// or its browser window over the screencast), caption "‹Bot›'s screen". Click → ComputerView.
// `ScreenPeek` is the same live picture at any width (the hand-off card).
import type { BotId } from "@openbot/contracts"
import { Avatar, Icon, PillButton, ShimmerText, Spinner, cn } from "@openbot/ui"
import { Maximize2, Moon, Unplug } from "lucide-react"
import { type ReactNode, useRef } from "react"
import { useComputerView } from "../contracts.ts"
import { desktopAspect } from "./desktop.ts"
import { DesktopStage } from "./DesktopStage.tsx"
import { type ScreenNotice, screenNotice } from "./notice.ts"
import { ScreenStage } from "./ScreenStage.tsx"
import { useComputer } from "./useComputer.ts"
import { useDesktop } from "./useDesktop.ts"
import { useScreencast } from "./useScreencast.ts"

export interface ScreenThumbnailProps {
  readonly botId: BotId
  readonly botName: string
  /** Host node label ("Works on ‹node›" in the empty state). */
  readonly nodeLabel?: string | undefined
  readonly onOpen: () => void
  readonly className?: string
}

/** The live picture (or a notice) of a bot's screen, view-only. Paused while the full view of the same bot is open. */
function useLivePicture(botId: BotId, botName: string, quality: number) {
  const { status, availability, ensure } = useComputer(botId)
  const fullView = useComputerView()
  const streaming = availability.kind === "stream" && fullView.botId !== botId
  const desktop = (availability.kind === "stream" || availability.kind === "absent" ? availability.surface : status.value?.surface) === "desktop"
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const targetRef = useRef<HTMLDivElement>(null)
  const screencast = useScreencast({ botId, enabled: streaming && !desktop, mode: "view", viewPath: status.value?.viewPath, canvasRef, onTrouble: status.refresh })
  const desk = useDesktop({ botId, enabled: streaming && desktop, mode: "view", viewPath: status.value?.viewPath, targetRef, quality, onTrouble: status.refresh })
  const phase = desktop ? desk.state.phase : screencast.state.phase
  const live = phase === "live"
  const notice = screenNotice({
    name: botName,
    availability,
    phase,
    message: desktop ? desk.state.message : screencast.state.message,
    starting: status.value?.state === "starting",
  })
  const wake = () => void ensure.run({ botId }).then((r) => (status.refresh(), r.ok && desk.retry()))
  const picture = (overlay: ReactNode, frameClassName?: string) =>
    desktop ? (
      <DesktopStage targetRef={targetRef} aspect={desktopAspect(status.value)} live={live} interactive={false} passive overlay={overlay} label={`${botName}'s screen`} frameClassName={frameClassName} />
    ) : (
      <ScreenStage canvasRef={canvasRef} state={screencast.state} interactive={false} send={screencast.send} overlay={overlay} label={`${botName}'s screen`} frameClassName={frameClassName} />
    )
  return { availability, notice, live, wake, waking: ensure.pending, wakeError: ensure.error, picture }
}

export function ScreenThumbnail({ botId, botName, nodeLabel, onOpen, className }: ScreenThumbnailProps): ReactNode {
  const { availability, notice, live, wake, waking, wakeError, picture } = useLivePicture(botId, botName, 5)
  const overlay = notice ? (
    <ThumbNotice notice={notice} nodeLabel={availability.kind === "unsupported" ? nodeLabel : undefined} waking={waking} error={wakeError} onWake={wake} />
  ) : undefined

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
        className="group relative flex h-[180px] w-[288px] max-w-full cursor-pointer items-center justify-center overflow-hidden rounded-2xl bg-secondary transition-[filter] duration-150 hover:brightness-[.98] focus-visible:outline-2"
      >
        {picture(overlay)}
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

/** The bot's screen at the container's width (16:10), view-only; click opens the full view. */
export function ScreenPeek({ botId, botName, onOpen, className }: { readonly botId: BotId; readonly botName: string; readonly onOpen: () => void; readonly className?: string }): ReactNode {
  const { notice, wake, waking, wakeError, picture } = useLivePicture(botId, botName, 5)
  const overlay = notice ? <ThumbNotice notice={notice} compact waking={waking} error={wakeError} onWake={wake} /> : undefined
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${botName}'s screen`}
      data-testid="screen-peek"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen()
        }
      }}
      className={cn("relative aspect-[16/10] w-full cursor-pointer overflow-hidden rounded-xl bg-secondary hairline border-line-tertiary", className)}
    >
      <div className="absolute inset-0">{picture(overlay)}</div>
    </div>
  )
}

function ThumbNotice({
  notice,
  nodeLabel,
  compact = false,
  waking,
  error,
  onWake,
}: {
  readonly notice: ScreenNotice
  readonly nodeLabel?: string | undefined
  readonly compact?: boolean
  readonly waking: boolean
  readonly error: string | undefined
  readonly onWake: () => void
}): ReactNode {
  const ghost = <Avatar shape="blob" color="gray" size={compact ? 22 : 28} />
  const icon =
    notice.icon === "spinner" ? (
      <Spinner size={16} className="text-icon-tertiary" />
    ) : notice.icon === "unplug" ? (
      <Icon icon={Unplug} size="lg" className="text-icon-tertiary" />
    ) : notice.icon === "asleep" ? (
      <Icon icon={Moon} size="lg" className="text-icon-tertiary" />
    ) : (
      ghost
    )
  // Grok's empty thumbnail: "Works on this device" / "No screen to show"
  const worksOn = notice.icon === "off" && notice.title === "No screen to show" && nodeLabel !== undefined
  const title = worksOn ? `Works on ${nodeLabel}` : notice.title
  const sub = error ?? (worksOn ? "No screen to show" : notice.icon === "spinner" ? "Just a moment" : notice.body)
  const canWake = notice.action === "wake" || notice.action === "open-browser"
  return (
    <div className="flex flex-col items-center gap-1 px-4 text-center" data-testid="screen-empty" data-notice={notice.icon}>
      {icon}
      <div className={cn("mt-1.5 text-fg", compact ? "text-sm" : "text-base")}>{notice.busy ? <ShimmerText>{title}</ShimmerText> : title}</div>
      {!compact && sub && <div className="line-clamp-2 text-sm text-fg-secondary">{sub}</div>}
      {canWake && (
        <PillButton
          size="sm"
          variant="secondary"
          className="mt-2"
          loading={waking}
          onClick={(e) => {
            e.stopPropagation()
            onWake()
          }}
        >
          {notice.action === "open-browser" ? "Open browser" : notice.icon === "asleep" ? "Wake" : "Try again"}
        </PillButton>
      )}
    </div>
  )
}
