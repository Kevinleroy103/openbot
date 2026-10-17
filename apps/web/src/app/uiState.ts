// Shared UI state (not server state): selection, panes, dialogs. Keep-alive atoms in the app's
// registry so W2.2 and W2.3 components share one source of truth. Re-exported via ../contracts.ts.
import { useCallback, useEffect, useMemo, useState } from "react"
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Atom } from "effect/reactivity"
import type { BotId, ConversationId } from "@openbot/contracts"
import { botsAtom, settingsAtom } from "@openbot/client"
import { AsyncResult } from "effect/reactivity"
import type { DetailsTab, SettingsPage } from "../contracts.ts"
import { isPhoneNow } from "./layout.ts"

// ---------------------------------------------------------------------------------------------
// Atoms

/** `#/new` is the explicit new-chat view; no hash = "open the most recent conversation". */
export const isNewChatHash = (): boolean => typeof location !== "undefined" && /^#\/new\b/.test(location.hash)

const readHash = (): ConversationId | null => {
  if (typeof location === "undefined") return null
  const m = /^#\/c\/([^/?#]+)/.exec(location.hash)
  return m ? (decodeURIComponent(m[1]!) as ConversationId) : null
}

/** The open conversation (null = the empty / new-chat state). Mirrored to `#/c/<id>`. */
export const selectedConversationAtom: Atom.Writable<ConversationId | null> = Atom.make<ConversationId | null>(readHash()).pipe(
  Atom.keepAlive,
  Atom.withLabel("openbot/web/selectedConversation"),
)

/** `#/c/<id>` or `#/new`: a chat screen. Anything else (`#/`, no hash) is Home on a phone. */
export const isChatHash = (): boolean => typeof location !== "undefined" && /^#\/(c\/|new\b)/.test(location.hash)

/**
 * Phone navigation (layout.ts): true = Home (the full-width sidebar list), false = the pushed chat
 * screen. Tablet and desktop ignore it (the sidebar is always on screen there).
 */
export const phoneHomeAtom: Atom.Writable<boolean> = Atom.make<boolean>(!isChatHash()).pipe(
  Atom.keepAlive,
  Atom.withLabel("openbot/web/phoneHome"),
)

/**
 * History entries the app creates carry a marker in `history.state`:
 * - `{ ob: "chat" }`: pushed when a phone opens a chat from Home (Back / iOS swipe-back pops it);
 * - `{ ob: "sheet", sheet, depth }`: pushed while a phone sheet is open (Back closes it, nav.ts);
 *   `depth` counts the sheets open under it, itself included (Settings › a page › an editor = 3).
 */
export type HistoryMark = { readonly ob: "chat" } | { readonly ob: "sheet"; readonly sheet: string; readonly depth?: number }
export const historyMark = (): HistoryMark | undefined => {
  if (typeof history === "undefined") return undefined
  const s = history.state as { ob?: unknown } | null
  return s && (s.ob === "chat" || s.ob === "sheet") ? (s as HistoryMark) : undefined
}

/** The last non-null selection (Esc / × in New chat returns to it). */
export const previousConversationAtom: Atom.Writable<ConversationId | null> = Atom.make<ConversationId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("openbot/web/previousConversation"),
)

export interface DetailsPaneState {
  readonly open: boolean
  readonly tab: DetailsTab
  /**
   * A bot to show instead of the conversation's default (a group chat's member, e.g. from its
   * "Handling…" line). Ignored when that bot is not in the open conversation.
   */
  readonly botId?: BotId | undefined
}
export const detailsPaneAtom: Atom.Writable<DetailsPaneState> = Atom.make<DetailsPaneState>({ open: false, tab: "details" }).pipe(
  Atom.keepAlive,
  Atom.withLabel("openbot/web/detailsPane"),
)

export interface SettingsDialogState {
  readonly open: boolean
  readonly page: SettingsPage
}
export const settingsDialogAtom: Atom.Writable<SettingsDialogState> = Atom.make<SettingsDialogState>({ open: false, page: "general" }).pipe(
  Atom.keepAlive,
  Atom.withLabel("openbot/web/settingsDialog"),
)

export interface ComputerViewState {
  readonly botId: BotId | null
  /** Take control right away (a hand-off card's "Take over"). */
  readonly takeControl?: boolean
}
export const computerViewAtom: Atom.Writable<ComputerViewState> = Atom.make<ComputerViewState>({ botId: null }).pipe(
  Atom.keepAlive,
  Atom.withLabel("openbot/web/computerView"),
)

/** One modal surface at a time (palettes and form dialogs). */
export type ActiveDialog =
  | { readonly kind: "search"; readonly query?: string }
  | { readonly kind: "new-chat" }
  | { readonly kind: "new-bot"; readonly name?: string }
  | { readonly kind: "new-group"; readonly botIds?: ReadonlyArray<BotId> }
  | { readonly kind: "onboarding" }
  | null
export const dialogAtom: Atom.Writable<ActiveDialog> = Atom.make<ActiveDialog>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("openbot/web/dialog"),
)

// ---------------------------------------------------------------------------------------------
// Hooks

export const useSelection = () => {
  const [conversationId, set] = useAtom(selectedConversationAtom)
  const setPrevious = useAtomSet(previousConversationAtom)
  const [home, setHome] = useAtom(phoneHomeAtom)
  const bots = useAtomValue(botsAtom)
  const select = useCallback(
    (id: ConversationId | null) => {
      if (conversationId && conversationId !== id) setPrevious(conversationId)
      set(id)
      const phone = isPhoneNow()
      if (home) setHome(false)
      if (typeof history !== "undefined") {
        const hash = id ? `#/c/${encodeURIComponent(id)}` : "#/new"
        if (!phone) {
          if (location.hash !== hash) history.replaceState(null, "", hash)
          return
        }
        // Phone: Home → chat pushes an entry (Back and iOS swipe-back return Home). A sheet's entry
        // (search, details…) becomes the chat entry; chat → chat replaces in place.
        // Already on this entry (Back / Forward, a deep link): leave the history alone.
        const mark = historyMark()
        if (mark?.ob !== "sheet" && location.hash === hash) return
        if (home && mark?.ob !== "sheet") history.pushState({ ob: "chat" }, "", hash)
        else history.replaceState({ ob: "chat" }, "", hash)
      }
    },
    [conversationId, set, setPrevious, home, setHome],
  )
  const selectBot = useCallback(
    (botId: BotId) => {
      if (!AsyncResult.isSuccess(bots)) return
      const bot = bots.value.find((b) => b.id === botId)
      if (bot) select(bot.directConversationId)
    },
    [bots, select],
  )
  return { conversationId, select, selectBot }
}

/**
 * Phone navigation: `home` (the Home list is on screen) and `back()`, which pops the chat entry the
 * app pushed (so the in-app back button and iOS swipe-back agree), else replaces it with Home.
 */
export const usePhoneNav = () => {
  const [home, setHome] = useAtom(phoneHomeAtom)
  const back = useCallback(() => {
    if (typeof history !== "undefined" && historyMark()?.ob === "chat") {
      // The hashchange that follows settles where we land (Home, or the chat this one was opened from).
      history.back()
      return
    }
    setHome(true)
    if (typeof history !== "undefined") history.replaceState(null, "", "#/")
  }, [setHome])
  return useMemo(() => ({ home, back, setHome }), [home, back, setHome])
}

export const useDetailsPane = () => {
  const [state, set] = useAtom(detailsPaneAtom)
  return useMemo(
    () => ({
      open: state.open,
      tab: state.tab,
      botId: state.botId,
      show: (tab?: DetailsTab, botId?: BotId) => set({ open: true, tab: tab ?? state.tab, botId }),
      hide: () => set({ open: false, tab: state.tab }),
      toggle: () => set(state.open ? { open: false, tab: state.tab } : { ...state, open: true }),
      setTab: (tab: DetailsTab) => set({ ...state, tab }),
    }),
    [state, set],
  )
}

export const useSettingsDialog = () => {
  const [state, set] = useAtom(settingsDialogAtom)
  return useMemo(
    () => ({
      open: state.open,
      page: state.page,
      show: (page?: SettingsPage) => set({ open: true, page: page ?? "general" }),
      hide: () => set({ ...state, open: false }),
    }),
    [state, set],
  )
}

export const useComputerView = () => {
  const [state, set] = useAtom(computerViewAtom)
  return useMemo(
    () => ({
      botId: state.botId,
      takeControl: state.takeControl === true,
      /** `takeControl`: open in control (the view takes the lease) instead of Watching. */
      open: (botId: BotId, options?: { readonly takeControl?: boolean }) => set({ botId, ...(options?.takeControl ? { takeControl: true } : {}) }),
      close: () => set({ botId: null }),
    }),
    [state, set],
  )
}

export const useDialogs = () => {
  const [dialog, set] = useAtom(dialogAtom)
  return useMemo(() => ({ dialog, show: (d: Exclude<ActiveDialog, null>) => set(d), hide: () => set(null) }), [dialog, set])
}

const prefersDark = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches

/** `settings.theme` resolved against the OS preference ("system"). */
export const useResolvedTheme = (): "dark" | "light" => {
  const settings = useAtomValue(settingsAtom)
  const [systemDark, setSystemDark] = useState(prefersDark)
  useEffect(() => {
    if (typeof matchMedia === "undefined") return
    const mq = matchMedia("(prefers-color-scheme: dark)")
    const on = () => setSystemDark(mq.matches)
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])
  const theme = settings.theme as string
  if (theme === "dark" || theme === "light") return theme
  return systemDark ? "dark" : "light"
}
