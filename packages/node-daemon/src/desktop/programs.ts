// Which desktop programs this node has (capability `desktop@1`, D1.7). The node offers desktops
// only when every required program is found; otherwise `node.hello.desktop.missing` names what
// to install. Optional programs (dock, D-Bus, apps) improve the desktop when present.

export type WindowManagerKind = "xfwm4" | "openbox"

export interface DesktopPrograms {
  readonly xvfb?: string | undefined
  readonly x11vnc?: string | undefined
  readonly xdotool?: string | undefined
  /** window managers found, in preference order (xfwm4 first, like Grok's computer) */
  readonly windowManagers: ReadonlyArray<{ readonly kind: WindowManagerKind; readonly path: string }>
  /** ImageMagick capture argv prefix: `[import]` or `[magick, import]` */
  readonly screenshot?: ReadonlyArray<string> | undefined
  /** root-window background: `[xsetroot]` or ImageMagick `[display]` / `[magick, display]` */
  readonly background?: { readonly kind: "xsetroot" | "imagemagick"; readonly argv: ReadonlyArray<string> } | undefined
  /** the dock (plank) */
  readonly dock?: string | undefined
  /** a private session bus per desktop (dbus-daemon) */
  readonly dbus?: string | undefined
  readonly terminal?: { readonly kind: "xfce4-terminal" | "xterm"; readonly path: string } | undefined
  readonly fileManager?: string | undefined
  readonly editor?: string | undefined
}

/** Human-readable names of the required programs (what `missing` lists). */
export const REQUIRED_PROGRAMS = ["Xvfb", "x11vnc", "xdotool", "xfwm4 or openbox", "ImageMagick (import)"] as const

export interface DetectedPrograms {
  readonly programs: DesktopPrograms
  /** required programs not found (empty: desktops can be offered) */
  readonly missing: ReadonlyArray<string>
}

/** Detect with `which(name)` (a PATH lookup that already includes any extra desktop dirs). */
export const detectDesktopPrograms = (which: (name: string) => string | undefined): DetectedPrograms => {
  const magick = which("magick")
  const imp = which("import")
  const display = which("display")
  const xsetroot = which("xsetroot")
  const xfwm4 = which("xfwm4")
  const openbox = which("openbox")
  const xfceTerminal = which("xfce4-terminal")
  const xterm = which("xterm")
  const programs: DesktopPrograms = {
    xvfb: which("Xvfb"),
    x11vnc: which("x11vnc"),
    xdotool: which("xdotool"),
    windowManagers: [
      ...(xfwm4 ? [{ kind: "xfwm4" as const, path: xfwm4 }] : []),
      ...(openbox ? [{ kind: "openbox" as const, path: openbox }] : []),
    ],
    screenshot: imp ? [imp] : magick ? [magick, "import"] : undefined,
    background: xsetroot
      ? { kind: "xsetroot", argv: [xsetroot] }
      : display
        ? { kind: "imagemagick", argv: [display] }
        : magick
          ? { kind: "imagemagick", argv: [magick, "display"] }
          : undefined,
    dock: which("plank"),
    dbus: which("dbus-daemon"),
    terminal: xfceTerminal ? { kind: "xfce4-terminal", path: xfceTerminal } : xterm ? { kind: "xterm", path: xterm } : undefined,
    fileManager: which("thunar"),
    editor: which("mousepad"),
  }
  const missing: Array<string> = []
  if (!programs.xvfb) missing.push("Xvfb")
  if (!programs.x11vnc) missing.push("x11vnc")
  if (!programs.xdotool) missing.push("xdotool")
  if (programs.windowManagers.length === 0) missing.push("xfwm4 or openbox")
  if (!programs.screenshot) missing.push("ImageMagick (import)")
  return { programs, missing }
}

/**
 * The window managers to try, in order. xfwm4 + plank is Grok's stack; without a dock, openbox is
 * preferred because its desktop right-click menu still opens the apps.
 */
export const windowManagerOrder = (p: DesktopPrograms): ReadonlyArray<{ readonly kind: WindowManagerKind; readonly path: string }> => {
  if (p.dock) return p.windowManagers
  return [...p.windowManagers].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "openbox" ? -1 : 1))
}
