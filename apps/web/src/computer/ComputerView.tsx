// Full-screen live computer view (grok-bot-ui-activity.md F.8, grok-bot-ui.md §4.9): dark cover, 44 px
// top bar, the bot's screen contain-fitted with radius 6, and the "Watching | Take control" →
// "You're in control | I'm done" pill. Two surfaces (D1.7):
//   - desktop (`desktop@1`): the bot's whole Linux desktop (Xvfb 1920×1200 + dock) over noVNC;
//   - browser (`browser@1` only): the bot's browser window over the CDP screencast.
// OpenBot adds a Terminal tab (xterm.js over /ws/terminal/:botId). A pending hand-off (the bot's
// `request_takeover`, an "Action needed" card) shows its instruction over the screen; "I'm done" hands
// the screen back, and the brain answers the hand-off "done" when it gets the lease back.
// Phone: a full-screen sheet below the status bar with a 40 px close, and Back closes it; while in
// control a keyboard button types on the desktop; in portrait a hint suggests turning the phone.
import { useAtom } from "@effect/atom-react"
import { botAtom, pendingRequestsQueryAtom } from "@openbot/client"
import type { Bot } from "@openbot/contracts"
import { Avatar, Icon, PillButton, ShimmerText, Spinner, cn } from "@openbot/ui"
import { Eye, Globe, Keyboard, Minimize2, MonitorOff, Moon, MousePointer2, RotateCcw, Settings2, Smartphone, TriangleAlert, Unplug } from "lucide-react"
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useIsPhone, useIsTouch } from "../app/layout.ts"
import { useBackDismiss } from "../app/nav.ts"
import { useComputerView, useSettingsDialog } from "../app/uiState.ts"
import type { ComputerViewProps } from "../contracts.ts"
import { useQuery, useRosterValue } from "../details/kit.tsx"
import { desktopAspect, pendingHandoffOf } from "./desktop.ts"
import { DesktopStage } from "./DesktopStage.tsx"
import { type NoticeAction, type ScreenNotice, screenNotice } from "./notice.ts"
import { ScreenStage } from "./ScreenStage.tsx"
import { TerminalPane } from "./TerminalPane.tsx"
import { computerInitialTabAtom, useComputer } from "./useComputer.ts"
import { useDesktop } from "./useDesktop.ts"
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
  const surface = availability.kind === "stream" || availability.kind === "absent" ? availability.surface : (status.value?.surface ?? "browser")
  const desktop = surface === "desktop"
  // lease holder: the latest of computer.status, the socket's Lease notices and our own lease calls
  const [holder, setHolder] = useState<"user" | "bot">("bot")
  const statusController = status.value?.controller
  const [seenController, setSeenController] = useState(statusController)
  if (seenController !== statusController) {
    setSeenController(statusController)
    if (statusController) setHolder(statusController)
  }
  const controlling = holder === "user"
  const streaming = availability.kind === "stream"

  // ------------------------------------------------------------------ browser surface (CDP)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const screencast = useScreencast({
    botId,
    enabled: streaming && !desktop && tab === "screen",
    mode: controlling ? "control" : "view",
    viewPath: status.value?.viewPath,
    canvasRef,
    onTrouble: status.refresh,
  })
  const [seenNotice, setSeenNotice] = useState(screencast.state.holder)
  if (seenNotice !== screencast.state.holder) {
    setSeenNotice(screencast.state.holder)
    if (screencast.state.holder) setHolder(screencast.state.holder)
  }

  // ------------------------------------------------------------------ desktop surface (noVNC)
  const targetRef = useRef<HTMLDivElement>(null)
  const desk = useDesktop({
    botId,
    enabled: streaming && desktop && tab === "screen",
    mode: controlling ? "control" : "view",
    viewPath: status.value?.viewPath,
    targetRef,
    onTrouble: status.refresh,
    onLeaseLost: () => setHolder("bot"),
  })

  const live = desktop ? desk.state.phase === "live" : screencast.state.phase === "live"
  const pageTitle = !desktop && live ? (screencast.state.page?.title || screencast.state.page?.url) : undefined

  // ------------------------------------------------------------------ hand-off + lease
  const pending = useQuery(pendingRequestsQueryAtom("*"))
  const handoff = pendingHandoffOf(pending.value, botId)

  const takeControl = useCallback(async () => {
    const r = await lease.run({ botId, take: true })
    if (r.ok) setHolder(r.value.controller)
  }, [lease, botId])
  // "I'm done": hand the screen back (the brain answers a pending hand-off "done" when it does)
  const done = async () => {
    const r = await lease.run({ botId, take: false })
    setHolder(r.ok ? r.value.controller : "bot")
    if (handoff) pending.refresh()
  }
  const close = useCallback(async () => {
    // never leave the bot locked out of its screen, unless it asked for a hand-off: then the owner
    // keeps control until "I'm done" (the card offers it too)
    if (holder === "user" && !handoff) await lease.run({ botId, take: false })
    onClose()
  }, [holder, handoff, lease, botId, onClose])

  // a hand-off card's "Take over": take control as soon as there is a screen (waking it if asleep)
  const view = useComputerView()
  const intentHandled = useRef(false)
  useEffect(() => {
    if (!view.takeControl || intentHandled.current) return
    if (availability.kind === "stream") {
      intentHandled.current = true
      // taking the lease is the external sync here (its state lands after the RPC answers)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (holder !== "user") void takeControl()
    } else if (availability.kind === "absent") {
      intentHandled.current = true
      void ensure.run({ botId }).then((r) => {
        status.refresh()
        if (r.ok) void takeControl()
      })
    } else if (availability.kind !== "loading") intentHandled.current = true
  }, [view.takeControl, availability.kind, holder, takeControl, ensure, botId, status])

  const phone = useIsPhone()
  const touch = useIsTouch()
  const portrait = usePortrait()
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

  // ------------------------------------------------------------------ notices + actions
  const notice = screenNotice({
    name,
    availability,
    phase: desktop ? desk.state.phase : screencast.state.phase,
    message: desktop ? desk.state.message : screencast.state.message,
    starting: status.value?.state === "starting",
  })
  const settings = useSettingsDialog()
  const runAction = async (action: NoticeAction) => {
    switch (action) {
      case "wake":
      case "open-browser": {
        const r = await ensure.run({ botId })
        status.refresh()
        if (r.ok) desk.retry()
        return
      }
      case "retry":
        status.refresh()
        if (desktop) desk.retry()
        else screencast.reconnect()
        return
      case "setup":
        settings.show("computers")
        onClose()
        return
    }
  }

  const keyboardRef = useRef<HTMLTextAreaElement>(null)
  const showKeyboard = desktop && controlling && live && touch
  const aspect = desktopAspect(status.value)
  const overlay = notice ? <ScreenMessage notice={notice} pending={ensure.pending} error={ensure.error} onAction={(a) => void runAction(a)} /> : undefined

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${name}'s computer`}
      data-testid="computer-view"
      data-surface={surface}
      className="absolute inset-0 z-[2500] flex animate-fade-in flex-col bg-[rgba(20,20,20,.95)] text-white"
    >
      {/* top bar (44, black 55 %) */}
      <div className="ob-overlay-top grid h-[calc(44px+env(safe-area-inset-top))] shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 bg-black/55 ps-3 pe-2 pt-[env(safe-area-inset-top)]">
        <div className="flex min-w-0 items-center gap-2">
          {bot && <Avatar shape={bot.avatar.shape} color={bot.avatar.color} size={22} working={controlling ? false : live} />}
          <span className="truncate text-sm font-medium text-white/90">{phone ? name : `${name}'s computer`}</span>
          {pageTitle && (
            <span className="ms-1 hidden min-w-0 items-center gap-1 truncate text-xs text-white/55 md:inline-flex" title={screencast.state.page?.url}>
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

      {/* what the bot asked for (request_takeover) */}
      {handoff && tab === "screen" && (
        <div data-testid="handoff-banner" className="flex shrink-0 items-start gap-2 border-b-[0.5px] border-white/10 bg-[rgba(245,166,35,.14)] px-4 py-2 text-sm text-white/90">
          <Icon icon={TriangleAlert} size="sm" className="mt-0.5 shrink-0 text-[#f5b14c]" />
          <span className="min-w-0 flex-1 line-clamp-2 break-words">
            <span className="font-medium text-[#f5c477]">{name} needs you: </span>
            {handoff.detail ?? handoff.title}
          </span>
        </div>
      )}

      {/* stage (room at the bottom for the control pill, so it never covers the dock) */}
      <div className={cn("relative min-h-0 flex-1 p-2", tab === "screen" && streaming && "pb-[calc(64px+env(safe-area-inset-bottom))]")}>
        <div className={cn("h-full w-full", tab !== "screen" && "hidden")}>
          {desktop ? (
            <DesktopStage
              targetRef={targetRef}
              aspect={aspect}
              live={live}
              interactive={controlling && live}
              label={`${name}'s screen`}
              frameClassName="rounded-md bg-white/[.04] ring-[0.5px] ring-white/10"
              overlay={overlay}
            />
          ) : (
            <ScreenStage
              canvasRef={canvasRef}
              state={screencast.state}
              interactive={controlling && screencast.state.meta !== undefined && (screencast.state.phase === "live" || screencast.state.phase === "waiting")}
              send={screencast.send}
              label={`${name}'s screen`}
              frameClassName="rounded-md bg-white/[.04] ring-[0.5px] ring-white/10"
              overlay={overlay}
            />
          )}
        </div>
        {terminalMounted && (
          <div className={cn("absolute inset-2", tab !== "terminal" && "invisible")}>
            <TerminalPane botId={botId} botName={name} active={tab === "terminal"} />
          </div>
        )}

        {/* control pill (F.8: 36 tall, centered, 16 from the bottom) */}
        {tab === "screen" && streaming && (
          <div className="pointer-events-none absolute inset-x-0 bottom-[calc(16px+env(safe-area-inset-bottom))] flex flex-col items-center gap-2 px-3">
            {desktop && live && phone && portrait && !controlling && (
              <div data-testid="landscape-hint" className="inline-flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1 text-xs text-white/70">
                <Icon icon={Smartphone} size="xs" className="rotate-90" />
                Turn your phone sideways for a bigger screen
              </div>
            )}
            {lease.error && <div className="pointer-events-auto max-w-full rounded-full bg-black/70 px-3 py-1 text-center text-xs text-white/85">{lease.error}</div>}
            <div
              data-testid="control-pill"
              className="pointer-events-auto flex h-9 max-w-full items-center gap-2 rounded-full bg-elevated ps-3 pe-1 hairline border-line-secondary shadow-popover"
            >
              {controlling ? (
                <>
                  <Icon icon={MousePointer2} size="sm" className="shrink-0 text-icon" />
                  <span className="truncate text-sm font-medium text-fg">You're in control</span>
                  {showKeyboard && (
                    <button
                      type="button"
                      aria-label="Keyboard"
                      title="Keyboard"
                      data-testid="desktop-keyboard"
                      onClick={() => keyboardRef.current?.focus()}
                      className="inline-flex size-[26px] shrink-0 items-center justify-center rounded-full text-icon transition-colors hover:bg-[color-mix(in_srgb,var(--ob-fg)_10%,transparent)]"
                    >
                      <Icon icon={Keyboard} size="sm" />
                    </button>
                  )}
                  <PillButton variant="primary" size="sm" className="shrink-0" loading={lease.pending} onClick={() => void done()}>
                    I'm done
                  </PillButton>
                </>
              ) : (
                <>
                  <Icon icon={Eye} size="sm" className="shrink-0 text-icon-secondary" />
                  <span className="truncate text-sm font-medium text-fg-secondary">Watching</span>
                  <PillButton variant="primary" size="sm" className="shrink-0" loading={lease.pending} disabled={!live} onClick={() => void takeControl()}>
                    Take control
                  </PillButton>
                </>
              )}
            </div>
          </div>
        )}
        {showKeyboard && <PhoneKeyboard inputRef={keyboardRef} onText={desk.typeText} onKey={desk.pressKey} />}
      </div>
    </div>
  )
}

const PORTRAIT_QUERY = "(orientation: portrait)"
const subscribePortrait = (onChange: () => void) => {
  const m = typeof matchMedia === "undefined" ? undefined : matchMedia(PORTRAIT_QUERY)
  m?.addEventListener("change", onChange)
  return () => m?.removeEventListener("change", onChange)
}
const usePortrait = (): boolean =>
  useSyncExternalStore(subscribePortrait, () => (typeof matchMedia === "undefined" ? false : matchMedia(PORTRAIT_QUERY).matches), () => false)

/**
 * The phone's soft keyboard for the remote desktop: an off-screen textarea that, once focused (the
 * keyboard button), turns typed text into key presses on the desktop and keeps itself empty.
 */
function PhoneKeyboard({
  inputRef,
  onText,
  onKey,
}: {
  readonly inputRef: RefObject<HTMLTextAreaElement | null>
  readonly onText: (text: string) => void
  readonly onKey: (key: "BackSpace" | "Return") => void
}): ReactNode {
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const onBeforeInput = (e: InputEvent) => {
      if (e.inputType === "deleteContentBackward") {
        e.preventDefault()
        onKey("BackSpace")
      } else if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") {
        e.preventDefault()
        onKey("Return")
      }
    }
    // text arrives through `input` (composition-safe): send it and empty the field
    const onInput = () => {
      if (el.value) onText(el.value)
      el.value = ""
    }
    el.addEventListener("beforeinput", onBeforeInput)
    el.addEventListener("input", onInput)
    return () => {
      el.removeEventListener("beforeinput", onBeforeInput)
      el.removeEventListener("input", onInput)
    }
  }, [inputRef, onText, onKey])
  return (
    <textarea
      ref={inputRef}
      aria-label="Type on the computer"
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      className="pointer-events-none absolute bottom-0 left-0 size-px resize-none opacity-0"
    />
  )
}

function ScreenMessage({
  notice,
  pending,
  error,
  onAction,
}: {
  readonly notice: ScreenNotice
  readonly pending: boolean
  readonly error: string | undefined
  readonly onAction: (action: NoticeAction) => void
}): ReactNode {
  const icon =
    notice.icon === "spinner" ? (
      <Spinner size={18} className="text-white/60" />
    ) : (
      <Icon icon={notice.icon === "unplug" ? Unplug : notice.icon === "asleep" ? Moon : MonitorOff} size="xl" className="text-white/45" />
    )
  const action = notice.action
  return (
    <div className="flex max-w-[360px] flex-col items-center gap-2 px-6 text-center" data-testid="screen-message" data-notice={notice.icon}>
      {icon}
      <div className="text-base text-white/90">{notice.busy ? <ShimmerText className="[--ob-shimmer-ink:#fff]">{notice.title}</ShimmerText> : notice.title}</div>
      {(error ?? notice.body) && <div className="text-sm text-white/55">{error ?? notice.body}</div>}
      {action && (
        <div className="mt-2">
          {action === "wake" ? (
            <DarkPill primary loading={pending} onClick={() => onAction("wake")}>
              {notice.icon === "asleep" ? "Wake" : "Try again"}
            </DarkPill>
          ) : action === "open-browser" ? (
            <DarkPill primary loading={pending} onClick={() => onAction("open-browser")}>
              Open browser
            </DarkPill>
          ) : action === "setup" ? (
            <DarkPill icon={Settings2} onClick={() => onAction("setup")}>
              How to set it up
            </DarkPill>
          ) : (
            <DarkPill icon={RotateCcw} onClick={() => onAction("retry")}>
              {notice.icon === "unplug" ? "Retry now" : "Reconnect"}
            </DarkPill>
          )}
        </div>
      )}
    </div>
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
