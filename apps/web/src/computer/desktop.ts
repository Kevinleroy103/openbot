// Pure logic of the full-desktop live view (D1.7; remote-computer-control.md §5): the connection state
// machine of one noVNC viewer, what a socket close means, reconnect backoff, phone-keyboard keysyms
// and the "what to install" hints for nodes without desktops. No DOM, no React: unit-tested.
//
// The socket is `/ws/computer/:botId?mode=view|control` (./protocol.ts `computerSocketUrl`): raw RFB in
// binary frames, relayed by the brain to the bot's x11vnc. Close codes the brain sends
// (packages/brain-nodes Computer.ts `DesktopCloseCodes`):
//   1000 "control released"  control viewers, when the owner hands control back → watch again
//   1011 + reason            the screen could not be started or reached, or its stream ended → retry
//   1012 "screen reset"      every viewer, `computer.reset` → the desktop is gone (asleep) until woken
//   4403 "take control first" `mode=control` without the lease → watch
// Pre-upgrade refusals (404 unknown bot, 409 no live view, 503 node offline) reach the browser only as
// a socket that never opened (1006).
import { type ComputerStatus, NodeCapabilities, type NodeSummary, type RuntimeRequest } from "@openbot/contracts"

export type ViewMode = "view" | "control"

export const DesktopCloseCodes = {
  released: 1000,
  failed: 1011,
  reset: 1012,
  controlRefused: 4403,
} as const

// ------------------------------------------------------------------------------- close verdicts

export interface CloseInfo {
  readonly code: number
  readonly reason: string
  readonly mode: ViewMode
  /** The WebSocket opened (the brain accepted the upgrade). */
  readonly opened: boolean
  /** The RFB handshake finished (noVNC `connect`). */
  readonly connected: boolean
}

/**
 * - `lease-lost`: this control socket ended because the owner no longer holds the lease: watch again.
 * - `asleep`: the desktop was reset (stopped); don't reconnect until it is woken.
 * - `retry`: reconnect with backoff.
 */
export type CloseVerdict = "lease-lost" | "asleep" | "retry"

export const classifyClose = (c: CloseInfo): CloseVerdict => {
  if (c.code === DesktopCloseCodes.controlRefused || c.code === 1008)
    return c.mode === "control" ? "lease-lost" : "retry"
  if (c.code === DesktopCloseCodes.released && c.mode === "control") return "lease-lost"
  if (c.code === DesktopCloseCodes.reset) return "asleep"
  return "retry"
}

/** Reconnect delay after `failures` consecutive failures: 0.5 s, 1 s, 2 s, 4 s, 8 s, then 10 s. */
export const backoffMs = (failures: number): number => Math.min(10_000, 500 * 2 ** Math.max(0, failures - 1))

// ------------------------------------------------------------------------------- state machine

export type DesktopPhase =
  /** Not connecting (disabled). */
  | "idle"
  /** First attempt (or a fresh one after a mode switch) in progress. */
  | "connecting"
  /** RFB connected: the desktop is on screen. */
  | "live"
  /** A live connection dropped; reconnecting. */
  | "reconnecting"
  /** Attempts keep failing before the screen ever showed; still retrying with backoff. */
  | "unreachable"
  /** The desktop was reset (1012): nothing to show until it is woken. */
  | "asleep"

export interface DesktopConn {
  readonly phase: DesktopPhase
  /** Consecutive failed attempts since the last successful connect. */
  readonly failures: number
  /** Why the last attempt ended (the brain's close reason), when it said. */
  readonly message: string | undefined
}

export type DesktopEvent =
  | { readonly type: "enable" }
  | { readonly type: "disable" }
  /** A new socket is being opened (`switching`: right after a view ↔ control switch). */
  | { readonly type: "attempt" }
  | { readonly type: "connected" }
  | { readonly type: "closed"; readonly close: CloseInfo }
  /** The noVNC module failed to load. */
  | { readonly type: "load-failed"; readonly message: string }

export const initialDesktopConn: DesktopConn = { phase: "idle", failures: 0, message: undefined }

/** Failures before the screen ever showed after which the view says "Can't reach". */
export const UNREACHABLE_AFTER = 2

export const desktopReducer = (state: DesktopConn, event: DesktopEvent): DesktopConn => {
  switch (event.type) {
    case "enable":
      return state.phase === "idle" || state.phase === "asleep"
        ? { phase: "connecting", failures: 0, message: undefined }
        : state
    case "disable":
      return state.phase === "idle" ? state : { ...state, phase: "idle" }
    case "attempt":
      if (state.phase === "idle" || state.phase === "asleep")
        return { phase: "connecting", failures: 0, message: undefined }
      if (state.phase === "live") return { ...state, phase: "connecting" }
      return state
    case "connected":
      return { phase: "live", failures: 0, message: undefined }
    case "load-failed":
      return { phase: "unreachable", failures: state.failures + 1, message: event.message }
    case "closed": {
      if (state.phase === "idle") return state
      const verdict = classifyClose(event.close)
      const message = event.close.reason.trim() || undefined
      if (verdict === "lease-lost") return { phase: "connecting", failures: 0, message: undefined }
      if (verdict === "asleep") return { phase: "asleep", failures: 0, message }
      const failures = event.close.connected ? 1 : state.failures + 1
      if (event.close.connected || state.phase === "reconnecting") return { phase: "reconnecting", failures, message }
      return { phase: failures >= UNREACHABLE_AFTER ? "unreachable" : "connecting", failures, message }
    }
  }
}

// ------------------------------------------------------------------------------- geometry

export const DEFAULT_DESKTOP = { width: 1920, height: 1200 } as const

/** Aspect ratio (w/h) of a bot's screen: the desktop size from `computer.status`, else 16:10. */
export const desktopAspect = (status: Pick<ComputerStatus, "width" | "height"> | undefined): number => {
  const w = status?.width
  const h = status?.height
  return w !== undefined && h !== undefined && w > 0 && h > 0 ? w / h : DEFAULT_DESKTOP.width / DEFAULT_DESKTOP.height
}

/** Contain-fit a `w/h = aspect` box into `width × height` (letterboxing): the fitted size. */
export const containFit = (
  width: number,
  height: number,
  aspect: number,
): { readonly width: number; readonly height: number } => {
  if (width <= 0 || height <= 0 || !(aspect > 0)) return { width: 0, height: 0 }
  const w = Math.min(width, height * aspect)
  return { width: Math.floor(w), height: Math.floor(w / aspect) }
}

// ------------------------------------------------------------------------------- phone keyboard

/** X11 keysyms of the keys a phone's soft keyboard produces besides text. */
export const KEYSYM = {
  BackSpace: 0xff08,
  Tab: 0xff09,
  Return: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
} as const

/**
 * The X11 keysym of one typed character (what `RFB.sendKey` wants): Latin-1 maps to itself, any other
 * Unicode code point to `0x01000000 + cp` (X11's Unicode keysyms), newlines to Return.
 */
export const keysymOf = (char: string): number | undefined => {
  const cp = char.codePointAt(0)
  if (cp === undefined) return undefined
  if (char === "\n" || char === "\r") return KEYSYM.Return
  if (char === "\t") return KEYSYM.Tab
  if (cp < 0x20 || cp === 0x7f) return undefined
  if (cp <= 0x7e || (cp >= 0xa0 && cp <= 0xff)) return cp
  return 0x01000000 + cp
}

/** The keysyms to type `text`, one per character (unknown control characters are dropped). */
export const keysymsOf = (text: string): ReadonlyArray<number> => {
  const out: number[] = []
  for (const ch of text) {
    const k = keysymOf(ch)
    if (k !== undefined) out.push(k)
  }
  return out
}

// ------------------------------------------------------------------------------- setup hints

/** Packages per program a node needs for desktops (D1.7: Xvfb + window manager + dock + VNC + tools). */
const PACKAGES: ReadonlyArray<{
  readonly names: ReadonlyArray<string>
  readonly arch: string
  readonly debian: string
}> = [
  { names: ["xvfb"], arch: "xorg-server-xvfb", debian: "xvfb" },
  { names: ["x11vnc"], arch: "x11vnc", debian: "x11vnc" },
  { names: ["xdotool"], arch: "xdotool", debian: "xdotool" },
  { names: ["xfwm4"], arch: "xfwm4", debian: "xfwm4" },
  { names: ["plank"], arch: "plank", debian: "plank" },
  { names: ["xfce4-terminal"], arch: "xfce4-terminal", debian: "xfce4-terminal" },
  { names: ["thunar"], arch: "thunar", debian: "thunar" },
  { names: ["mousepad"], arch: "mousepad", debian: "mousepad" },
  { names: ["import", "imagemagick", "magick", "convert"], arch: "imagemagick", debian: "imagemagick" },
]

/** The full install commands (every package; `--needed` / apt skip what is already there). */
export const DESKTOP_INSTALL = {
  arch: "sudo pacman -S --needed xorg-server-xvfb x11vnc xdotool xfwm4 plank xfce4-terminal thunar mousepad",
  debian: "sudo apt install xvfb x11vnc xdotool xfwm4 plank xfce4-terminal thunar mousepad imagemagick",
} as const

export interface InstallHint {
  readonly label: string
  readonly command: string
}

/**
 * Copyable install commands for a node's platform (Linux only: desktops are X11). ImageMagick (for
 * screenshots) is added to the Arch line only when it is what's missing; it is usually installed.
 */
export const desktopInstallHints = (
  platform: string | undefined,
  missing?: ReadonlyArray<string>,
): ReadonlyArray<InstallHint> => {
  if (platform !== undefined && platform !== "linux") return []
  const needsMagick = (missing ?? []).some((m) =>
    ["import", "imagemagick", "magick", "convert"].includes(m.toLowerCase()),
  )
  return [
    { label: "Arch", command: needsMagick ? `${DESKTOP_INSTALL.arch} imagemagick` : DESKTOP_INSTALL.arch },
    { label: "Debian / Ubuntu", command: DESKTOP_INSTALL.debian },
  ]
}

/** Display names of what a node lacks, in install order, deduplicated ("Xvfb, x11vnc and xdotool"). */
export const describeMissing = (missing: ReadonlyArray<string>): string => {
  const seen = new Set<string>()
  const names: string[] = []
  const known = (m: string) => PACKAGES.findIndex((p) => p.names.includes(m.toLowerCase()))
  const sorted = [...missing].sort((a, b) => {
    const ia = known(a)
    const ib = known(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
  for (const m of sorted) {
    const name = m.toLowerCase() === "xvfb" ? "Xvfb" : known(m) === PACKAGES.length - 1 ? "ImageMagick" : m
    if (seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  if (names.length <= 1) return names.join("")
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

/** "Full desktop needs Xvfb, x11vnc and xdotool on vps-1." */
export const missingSentence = (missing: ReadonlyArray<string>, nodeName: string): string =>
  missing.length === 0
    ? `Full desktop isn't set up on ${nodeName}.`
    : `Full desktop needs ${describeMissing(missing)} on ${nodeName}.`

// ------------------------------------------------------------------------------- nodes + hand-offs

/** Full desktops on a node: on (effective `desktop@1`), declared but not approved, or not offered. */
export const nodeDesktopState = (
  node: Pick<NodeSummary, "capabilities" | "declaredCapabilities">,
): "on" | "unapproved" | "off" =>
  node.capabilities.includes(NodeCapabilities.desktop)
    ? "on"
    : node.declaredCapabilities.includes(NodeCapabilities.desktop)
      ? "unapproved"
      : "off"

/** A Mac's own screen on a node: on (effective `screen@1`), declared but not approved, or not offered. */
export const nodeScreenState = (
  node: Pick<NodeSummary, "capabilities" | "declaredCapabilities">,
): "on" | "unapproved" | "off" =>
  node.capabilities.includes(NodeCapabilities.screen)
    ? "on"
    : node.declaredCapabilities.includes(NodeCapabilities.screen)
      ? "unapproved"
      : "off"

/** The bot's pending hand-off (`request_takeover`), if any. */
export const pendingHandoffOf = (
  requests: ReadonlyArray<RuntimeRequest> | undefined,
  botId: string,
): RuntimeRequest | undefined =>
  requests?.find((r) => r.kind === "handoff" && r.botId === botId && r.status === "pending")
