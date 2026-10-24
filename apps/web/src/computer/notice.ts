// What the screen area says when there is no picture (Grok: "Connecting to ‹Bot›'s computer…",
// "Can't reach ‹Bot›'s screen", Wake "It wakes up when a Bot needs it"). One pure function for the
// full view and the Details thumbnail, so both always agree. Unit-tested.
import type { DesktopPhase } from "./desktop.ts"
import type { ScreenPhase } from "./useScreencast.ts"
import type { ScreenAvailability } from "./useComputer.ts"

export type NoticeAction =
  /** `computer.ensure` (wakes a sleeping desktop / opens the browser window). */
  | "wake"
  | "open-browser"
  /** Reconnect now (and refetch the status). */
  | "retry"
  /** Settings › Computers (what to install). */
  | "setup"

export type NoticeIcon = "spinner" | "unplug" | "off" | "asleep"

export interface ScreenNotice {
  readonly icon: NoticeIcon
  readonly title: string
  readonly body?: string | undefined
  readonly action?: NoticeAction | undefined
  /** The title shimmers (work in progress). */
  readonly busy?: boolean
}

export interface NoticeInput {
  readonly name: string
  readonly availability: ScreenAvailability
  /** The live connection's phase: noVNC's (desktop) or the screencast's (browser). */
  readonly phase: DesktopPhase | ScreenPhase
  /** The brain's reason for the last close / end, if any. */
  readonly message?: string | undefined
  /** `computer.status` says the screen is starting. */
  readonly starting?: boolean
}

/** The brain's reasons start with "Can't reach the screen: …"; the title already says that. */
const reasonOf = (message: string | undefined): string | undefined => {
  const m = message?.replace(/^can't reach the screen:?\s*/i, "").trim()
  return m ? m.charAt(0).toUpperCase() + m.slice(1) : undefined
}

/** `undefined` = the picture is live: nothing to say. */
export const screenNotice = ({
  name,
  availability,
  phase,
  message: raw,
  starting,
}: NoticeInput): ScreenNotice | undefined => {
  const message = reasonOf(raw)
  switch (availability.kind) {
    case "loading":
      return { icon: "spinner", title: `Connecting to ${name}'s computer…`, busy: true }
    case "unsupported":
      return {
        icon: "off",
        title: "No screen to show",
        body: availability.message,
        ...(availability.missing && availability.missing.length > 0 ? { action: "setup" as const } : {}),
      }
    case "unreachable":
      // a Mac that still needs permissions: its own words say what to allow
      if (availability.surface === "screen" && availability.missing && availability.missing.length > 0) {
        return {
          icon: "off",
          title: `${name} can't use the Mac's screen yet`,
          body: availability.message,
          action: "retry",
        }
      }
      return {
        icon: "unplug",
        title: `Can't reach ${name}'s screen`,
        body: reasonOf(availability.message),
        action: availability.surface === "desktop" ? "wake" : "retry",
      }
    case "absent":
      return availability.surface === "desktop"
        ? {
            icon: "asleep",
            title: `${name}'s computer is asleep`,
            body: `It wakes up when ${name} needs it.`,
            action: "wake",
          }
        : {
            icon: "off",
            title: "No screen to show",
            body: `${name}'s browser isn't open. It opens when ${name} browses, or you can open it now.`,
            action: "open-browser",
          }
    case "stream":
      break
  }
  switch (phase) {
    case "live":
      return undefined
    case "asleep":
      return {
        icon: "asleep",
        title: `${name}'s computer is asleep`,
        body: message ?? `It wakes up when ${name} needs it.`,
        action: "wake",
      }
    case "unreachable":
      return { icon: "unplug", title: `Can't reach ${name}'s screen`, body: message ?? "Retrying…", action: "retry" }
    case "ended":
      return { icon: "off", title: "The screen stream ended", body: message, action: "retry" }
    case "reconnecting":
      return { icon: "spinner", title: "Reconnecting…", body: message, busy: true }
    case "waiting":
      return { icon: "spinner", title: "Waking up…", body: "Just a moment", busy: true }
    case "idle":
    case "connecting":
      return starting
        ? { icon: "spinner", title: "Waking up…", body: "Just a moment", busy: true }
        : { icon: "spinner", title: `Connecting to ${name}'s computer…`, body: "Just a moment", busy: true }
  }
}
