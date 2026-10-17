// Full-screen live computer view (grok-bot-ui-activity.md F.8, grok-bot-ui.md §4.9): dark cover, 44 px
// top bar, the bot's browser contain-fitted with radius 6, and the "Watching | Take control" →
// "You're in control | Stop" pill. OpenBot adds a Terminal tab (xterm.js over /ws/terminal/:botId).
// Phone: a full-screen sheet below the status bar with a 40 px close, and Back closes it.
import { useAtom } from "@effect/atom-react"
import { botAtom } from "@openbot/client"
import type { Bot } from "@openbot/contracts"
import { Avatar, Icon, PillButton, ShimmerText, Spinner, cn } from "@openbot/ui"
import { Eye, Globe, Minimize2, MonitorOff, MousePointer2, RotateCcw, Unplug } from "lucide-react"
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { useIsPhone } from "../app/layout.ts"
import { useBackDismiss } from "../app/nav.ts"
import type { ComputerViewProps } from "../contracts.ts"
import { useRosterValue } from "../details/kit.tsx"
import { ScreenStage } from "./ScreenStage.tsx"
import { TerminalPane } from "./TerminalPane.tsx"
import { computerInitialTabAtom, useComputer } from "./useComputer.ts"
import { useScreencast } from "./useScreencast.ts"

type ViewTab = "screen" | "terminal"

export function ComputerView({ botId, onClose }: ComputerViewProps): ReactNode {
  const bot = useRosterValue<Bot | undefined>(botAtom(botId), undefined)
  const name = bot?.name ?? "Bot"
  const [initialTab, setInitialTab] = useAtom(computerInitialTabAtom)
  const [tab, setTabState] = useState<ViewTab>(initialTab)
  // the terminal stays mounted once opened so switching tabs keeps the shell session
  const [terminalMounted, setTerminalMounted] = useState(initialTab === "terminal")
  const setTab = (next: ViewTab) => {
    setTabState(next)
    if (next === "terminal") setTerminalMounted(true)
  }
  // the initial tab is one-shot: reset it for the next opener
  useEffect(() => () => setInitialTab("screen"), [setInitialTab])

  const { status, availability, ensure, lease } = useComputer(botId)
  // lease holder: the latest of computer.status, the socket's Lease notices and our own lease calls
  const [holder, setHolder] = useState<"user" | "bot">("bot")
  const statusController = status.value?.controller
  const [seenController, setSeenController] = useState(statusController)
  if (seenController !== statusController) {
    setSeenController(statusController)
    if (statusController) setHolder(statusController)
  }
  const controlling = holder === "user"

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streaming = availability.kind === "stream"
  const { state, send, reconnect } = useScreencast({
    botId,
    enabled: streaming && tab === "screen",
    mode: controlling ? "control" : "view",
    viewPath: status.value?.viewPath,
    canvasRef,
    onTrouble: status.refresh,
  })
  const [seenNotice, setSeenNotice] = useState(state.holder)
  if (seenNotice !== state.holder) {
    setSeenNotice(state.holder)
    if (state.holder) setHolder(state.holder)
  }

  const takeControl = async () => {
    const r = await lease.run({ botId, take: true })
    if (r.ok) setHolder(r.value.controller)
  }
  const stop = async () => {
    const r = await lease.run({ botId, take: false })
    setHolder(r.ok ? r.value.controller : "bot")
  }
  const close = useCallback(async () => {
    // never leave the bot locked out of its browser
    if (holder === "user") await lease.run({ botId, take: false })
    onClose()
  }, [holder, lease, botId, onClose])

  const phone = useIsPhone()
  useBackDismiss(true, () => void close(), "computer")

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !controlling && tab === "screen") {
        e.stopPropagation()
        void close()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [controlling, tab, close])

  const live = state.phase === "live"
  const pageTitle = live ? (state.page?.title || state.page?.url) : undefined

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${name}'s computer`}
      data-testid="computer-view"
      className="absolute inset-0 z-[2500] flex animate-fade-in flex-col bg-[rgba(20,20,20,.95)] text-white"
    >
      {/* top bar (44, black 55 %) */}
      <div className="grid h-[calc(44px+env(safe-area-inset-top))] shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 bg-black/55 ps-3 pe-2 pt-[env(safe-area-inset-top)]">
        <div className="flex min-w-0 items-center gap-2">
          {bot && <Avatar shape={bot.avatar.shape} color={bot.avatar.color} size={22} working={controlling ? false : live} />}
          <span className="truncate text-sm font-medium text-white/90">{name}'s computer</span>
          {pageTitle && (
            <span className="ms-1 hidden min-w-0 items-center gap-1 truncate text-xs text-white/55 md:inline-flex" title={state.page?.url}>
              <Icon icon={Globe} size="xs" className="text-white/45" />
              <span className="truncate">{pageTitle}</span>
            </span>
          )}
        </div>
        {/* always-dark segmented control (the cover is dark in both themes) */}
        <div role="tablist" aria-label="Computer view" className="inline-flex items-center gap-0.5 rounded-full bg-white/[.06] p-0.5">
          {(["screen", "terminal"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              data-testid={`computer-tab-${t}`}
              onClick={() => setTab(t)}
              className={cn(
                "inline-flex h-6 items-center rounded-full px-2.5 text-xs transition-colors duration-[120ms]",
                tab === t ? "bg-white/[.14] text-white" : "text-white/60 hover:text-white/90",
              )}
            >
              {t === "screen" ? "Screen" : "Terminal"}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-end">
          <button
            type="button"
            aria-label="Exit fullscreen"
            title="Exit fullscreen"
            onClick={() => void close()}
            className={cn("inline-flex items-center justify-center text-white/85 transition-colors hover:bg-white/10", phone ? "size-10 rounded-full" : "size-6 rounded-md")}
          >
            <Icon icon={Minimize2} size={phone ? "md" : "xs"} />
          </button>
        </div>
      </div>

      {/* stage */}
      <div className="relative min-h-0 flex-1 p-2">
        <div className={cn("h-full w-full", tab !== "screen" && "hidden")}>
          <ScreenStage
            canvasRef={canvasRef}
            state={state}
            interactive={controlling && state.meta !== undefined && (state.phase === "live" || state.phase === "waiting")}
            send={send}
            label={`${name}'s screen`}
            frameClassName="rounded-md bg-white/[.04] ring-[0.5px] ring-white/10"
            overlay={
              <ScreenMessage
                name={name}
                availability={availability.kind}
                message={availability.kind === "unsupported" || availability.kind === "unreachable" ? availability.message : state.message}
                phase={state.phase}
                ensuring={ensure.pending}
                error={ensure.error}
                onEnsure={async () => {
                  const r = await ensure.run({ botId })
                  if (r.ok) status.refresh()
                }}
                onRetry={() => {
                  status.refresh()
                  reconnect()
                }}
              />
            }
          />
        </div>
        {terminalMounted && (
          <div className={cn("absolute inset-2", tab !== "terminal" && "invisible")}>
            <TerminalPane botId={botId} botName={name} active={tab === "terminal"} />
          </div>
        )}

        {/* control pill (F.8: 36 tall, centered, 16 from the bottom) */}
        {tab === "screen" && streaming && (
          <div className="pointer-events-none absolute inset-x-0 bottom-[calc(16px+env(safe-area-inset-bottom))] flex flex-col items-center gap-2">
            {lease.error && <div className="pointer-events-auto rounded-full bg-black/70 px-3 py-1 text-xs text-white/85">{lease.error}</div>}
            <div
              data-testid="control-pill"
              className="pointer-events-auto flex h-9 items-center gap-2 rounded-full bg-elevated ps-3 pe-1 hairline border-line-secondary shadow-popover"
            >
              {controlling ? (
                <>
                  <Icon icon={MousePointer2} size="sm" className="text-icon" />
                  <span className="text-sm font-medium text-fg">You're in control</span>
                  <button
                    type="button"
                    onClick={() => void stop()}
                    disabled={lease.pending}
                    className="inline-flex h-[26px] items-center rounded-full bg-[color-mix(in_srgb,var(--ob-fg)_10%,transparent)] px-2.5 text-sm text-fg transition-colors hover:bg-[color-mix(in_srgb,var(--ob-fg)_16%,transparent)] disabled:opacity-60"
                  >
                    Stop
                  </button>
                </>
              ) : (
                <>
                  <Icon icon={Eye} size="sm" className="text-icon-secondary" />
                  <span className="text-sm font-medium text-fg-secondary">Watching</span>
                  <PillButton variant="primary" size="sm" loading={lease.pending} disabled={!live} onClick={() => void takeControl()}>
                    Take control
                  </PillButton>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ScreenMessage({
  name,
  availability,
  message,
  phase,
  ensuring,
  error,
  onEnsure,
  onRetry,
}: {
  readonly name: string
  readonly availability: "loading" | "unsupported" | "unreachable" | "absent" | "stream"
  readonly message: string | undefined
  readonly phase: string
  readonly ensuring: boolean
  readonly error: string | undefined
  readonly onEnsure: () => void
  readonly onRetry: () => void
}): ReactNode {
  const box = (icon: ReactNode, title: ReactNode, body?: ReactNode, action?: ReactNode) => (
    <div className="flex max-w-[360px] flex-col items-center gap-2 px-6 text-center" data-testid="screen-message">
      {icon}
      <div className="text-base text-white/90">{title}</div>
      {body && <div className="text-sm text-white/55">{body}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
  if (availability === "loading") return box(<Spinner size={18} className="text-white/60" />, `Connecting to ${name}'s computer…`)
  if (availability === "unsupported") return box(<Icon icon={MonitorOff} size="xl" className="text-white/45" />, "No screen to show", message)
  if (availability === "unreachable")
    return box(
      <Icon icon={Unplug} size="xl" className="text-white/45" />,
      `Can't reach ${name}'s screen`,
      message,
      <DarkPill icon={RotateCcw} onClick={onRetry}>
        Retry
      </DarkPill>,
    )
  if (availability === "absent")
    return box(
      <Icon icon={MonitorOff} size="xl" className="text-white/45" />,
      "No screen to show",
      error ?? `${name}'s browser isn't open. It opens when ${name} browses, or you can open it now.`,
      <DarkPill primary loading={ensuring} onClick={onEnsure}>
        Open browser
      </DarkPill>,
    )
  if (phase === "ended")
    return box(
      <Icon icon={MonitorOff} size="xl" className="text-white/45" />,
      "The screen stream ended",
      message,
      <DarkPill icon={RotateCcw} onClick={onRetry}>
        Reconnect
      </DarkPill>,
    )
  if (phase === "unreachable")
    return box(
      <Icon icon={Unplug} size="xl" className="text-white/45" />,
      `Can't reach ${name}'s screen`,
      "Retrying…",
      <DarkPill icon={RotateCcw} onClick={onRetry}>
        Retry now
      </DarkPill>,
    )
  return box(
    <Spinner size={18} className="text-white/60" />,
    <ShimmerText className="[--ob-shimmer-ink:#fff]">{phase === "waiting" ? "Waking up…" : `Connecting to ${name}'s computer…`}</ShimmerText>,
    "Just a moment",
  )
}

/** Pill on the always-dark cover (theme tokens follow the app theme, the cover does not). */
export function DarkPill({
  children,
  primary = false,
  loading = false,
  icon,
  onClick,
}: {
  readonly children: ReactNode
  readonly primary?: boolean
  readonly loading?: boolean
  readonly icon?: typeof RotateCcw
  readonly onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-full px-3 text-sm font-medium transition-colors duration-[120ms] disabled:opacity-70",
        primary ? "bg-white text-[#121212] hover:bg-white/90" : "bg-white/10 text-white hover:bg-white/15",
      )}
    >
      {loading ? <Spinner size={14} /> : icon ? <Icon icon={icon} size="sm" className="-ms-0.5" /> : null}
      {children}
    </button>
  )
}
