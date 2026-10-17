// A bot desktop's files and environment (D1.7). Everything a desktop writes lives under
// `<nodeData>/desktops/<botId>/` (XDG config/data/cache/state, logs, the bot's browser profile), so
// the desktop's apps never touch the owner's own settings; sockets and the X cookie live in a short
// runtime dir under the system temp dir. The environment is built from scratch: no WAYLAND_DISPLAY
// (x11vnc exits when it sees one), no owner session bus, no compositor variables.
import * as path from "node:path"
import type { WindowManagerKind } from "./programs.ts"
import { DESKTOP_MARKER_ENV } from "./system.ts"

export interface SessionLayout {
  /** `<nodeData>/desktops/<botId>` (kept across resets) */
  readonly root: string
  readonly config: string
  readonly data: string
  readonly cache: string
  readonly state: string
  readonly logs: string
  /** the bot's own Chromium profile (cookies survive resets and restarts) */
  readonly browserProfile: string
  /** runtime dir (0700): X cookie, session bus socket; removed when the desktop stops */
  readonly run: string
  readonly xauthority: string
  readonly bus: string
}

export const sessionLayout = (input: {
  readonly dataDir: string
  readonly botId: string
  readonly display: number
  readonly tmpdir: string
  readonly uid: number
}): SessionLayout => {
  const root = path.join(input.dataDir, "desktops", input.botId)
  const xdg = path.join(root, "home")
  const run = path.join(input.tmpdir, `openbot-desktop-${input.uid}`, String(input.display))
  return {
    root,
    config: path.join(xdg, "config"),
    data: path.join(xdg, "data"),
    cache: path.join(xdg, "cache"),
    state: path.join(xdg, "state"),
    logs: path.join(root, "logs"),
    browserProfile: path.join(root, "browser-profile"),
    run,
    xauthority: path.join(run, "Xauthority"),
    bus: path.join(run, "bus"),
  }
}

/** Variables passed through from the node's own environment (no secrets, nothing display-related). */
const PASS_THROUGH = ["HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ", "TMPDIR"]

export interface SessionEnvInput {
  readonly display: number
  readonly layout: SessionLayout
  /** extra program dirs, searched first */
  readonly path: ReadonlyArray<string>
  /** extra variables from the node config (e.g. LD_LIBRARY_PATH for a rootless install) */
  readonly extra: Readonly<Record<string, string>>
  readonly marker: string
  readonly botId: string
  readonly nodeId: string
  /** the desktop's private session bus, when dbus-daemon is installed */
  readonly busAddress?: string | undefined
  readonly windowManager?: WindowManagerKind | undefined
  readonly source?: Readonly<Record<string, string | undefined>> | undefined
}

export const sessionEnv = (input: SessionEnvInput): Record<string, string> => {
  const source = input.source ?? process.env
  const env: Record<string, string> = {}
  for (const k of PASS_THROUGH) {
    const v = source[k]
    if (v !== undefined && v !== "") env[k] = v
  }
  if (!env.LANG) env.LANG = "C.UTF-8"
  const basePath = source.PATH && source.PATH !== "" ? source.PATH : "/usr/local/bin:/usr/bin:/bin"
  env.PATH = [...input.path, basePath].join(":")
  return {
    ...env,
    ...input.extra,
    DISPLAY: `:${input.display}`,
    XAUTHORITY: input.layout.xauthority,
    XDG_SESSION_TYPE: "x11",
    XDG_CURRENT_DESKTOP: input.windowManager === "openbox" ? "OPENBOX" : "XFCE",
    XDG_CONFIG_HOME: input.layout.config,
    XDG_DATA_HOME: input.layout.data,
    XDG_CACHE_HOME: input.layout.cache,
    XDG_STATE_HOME: input.layout.state,
    XDG_RUNTIME_DIR: input.layout.run,
    // never the owner's session bus: xfce4-terminal and thunar would open their windows on the
    // owner's own screen through an already-running instance
    DBUS_SESSION_BUS_ADDRESS: input.busAddress ?? "disabled:",
    XDG_SESSION_CLASS: "user",
    GDK_BACKEND: "x11",
    QT_QPA_PLATFORM: "xcb",
    GSETTINGS_BACKEND: "keyfile",
    NO_AT_BRIDGE: "1",
    // no FUSE mount in the runtime dir, and no udisks / MTP monitors listing the owner's drives
    GVFS_DISABLE_FUSE: "1",
    GIO_USE_VOLUME_MONITOR: "unix",
    [DESKTOP_MARKER_ENV]: input.marker,
    OPENBOT_BOT_ID: input.botId,
    OPENBOT_NODE_ID: input.nodeId,
  }
}

// ---------------------------------------------------------------- apps and config files

export interface DesktopApp {
  /** file stem: `openbot-<id>.desktop`, `openbot-<id>.dockitem` */
  readonly id: string
  readonly name: string
  readonly icon: string
  readonly argv: ReadonlyArray<string>
}

export interface DesktopFile {
  readonly path: string
  readonly content: string
}

const EXEC_RESERVED = /[\s"'\\><~|&;$*?#()`]/

/** One argument of a desktop entry's `Exec` key (quoting rules of the Desktop Entry spec). */
export const execArg = (arg: string): string => {
  const escaped = arg.replaceAll("%", "%%")
  if (escaped !== "" && !EXEC_RESERVED.test(escaped)) return escaped
  // inside quotes, `"`, `` ` ``, `$` and `\` are escaped with a backslash; the value's own string
  // escaping then doubles every backslash
  return `"${escaped.replace(/(["`$\\])/g, "\\$1")}"`.replaceAll("\\", "\\\\")
}

export const execLine = (argv: ReadonlyArray<string>): string => argv.map(execArg).join(" ")

const desktopEntry = (app: DesktopApp): string =>
  [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${app.name}`,
    `Exec=${execLine(app.argv)}`,
    `Icon=${app.icon}`,
    "Terminal=false",
    "StartupNotify=false",
    "",
  ].join("\n")

const xmlEscape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

/** POSIX shell quoting (openbox menu `<command>` lines are parsed shell-style). */
export const shellQuote = (s: string): string => (/^[A-Za-z0-9_./=:,@%+-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`)

export const openboxMenu = (apps: ReadonlyArray<DesktopApp>): string =>
  [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<openbox_menu xmlns="http://openbox.org/3.4/menu">`,
    `  <menu id="root-menu" label="Apps">`,
    ...apps.map(
      (a) =>
        `    <item label="${xmlEscape(a.name)}"><action name="Execute"><command>${xmlEscape(a.argv.map(shellQuote).join(" "))}</command></action></item>`,
    ),
    `  </menu>`,
    `</openbox_menu>`,
    "",
  ].join("\n")

const APP_RULE = `<application class="*" type="normal"><maximized>yes</maximized></application>`

/** A minimal openbox config (used when no system rc.xml is found): window moves, the desktop menu, one desktop. */
export const MINIMAL_OPENBOX_RC = `<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <focus><focusNew>yes</focusNew><followMouse>no</followMouse></focus>
  <placement><policy>Smart</policy></placement>
  <theme><name>Clearlooks</name><titleLayout>NLIMC</titleLayout></theme>
  <desktops><number>1</number></desktops>
  <mouse>
    <dragThreshold>1</dragThreshold>
    <doubleClickTime>500</doubleClickTime>
    <context name="Frame"><mousebind button="A-Left" action="Drag"><action name="Move"/></mousebind></context>
    <context name="Titlebar">
      <mousebind button="Left" action="Press"><action name="Focus"/><action name="Raise"/></mousebind>
      <mousebind button="Left" action="Drag"><action name="Move"/></mousebind>
      <mousebind button="Left" action="DoubleClick"><action name="ToggleMaximize"/></mousebind>
    </context>
    <context name="Client"><mousebind button="Left" action="Press"><action name="Focus"/><action name="Raise"/></mousebind></context>
    <context name="Close"><mousebind button="Left" action="Click"><action name="Close"/></mousebind></context>
    <context name="Maximize"><mousebind button="Left" action="Click"><action name="ToggleMaximize"/></mousebind></context>
    <context name="Iconify"><mousebind button="Left" action="Click"><action name="Iconify"/></mousebind></context>
    <context name="Root">
      <mousebind button="Right" action="Press"><action name="ShowMenu"><menu>root-menu</menu></action></mousebind>
      <mousebind button="Left" action="Press"><action name="ShowMenu"><menu>root-menu</menu></action></mousebind>
    </context>
  </mouse>
  <menu><file>menu.xml</file></menu>
  <applications></applications>
</openbox_config>
`

/**
 * The bot's openbox rc.xml: the system default (when found) with one desktop, every normal window
 * maximized, and our app menu as the desktop's right-click menu.
 */
export const openboxRc = (template: string | undefined, menuPath: string): string => {
  let rc = template ?? MINIMAL_OPENBOX_RC
  rc = rc.replace(/(<desktops>[\s\S]*?<number>)\s*\d+\s*(<\/number>)/, (_m, open: string, close: string) => `${open}1${close}`)
  rc = /<file>[^<]*<\/file>/.test(rc)
    ? rc.replace(/<file>[^<]*<\/file>/, `<file>${xmlEscape(menuPath)}</file>`)
    : rc.replace(/<\/openbox_config>/, `<menu><file>${xmlEscape(menuPath)}</file></menu></openbox_config>`)
  rc = /<applications\s*\/>/.test(rc)
    ? rc.replace(/<applications\s*\/>/, `<applications>${APP_RULE}</applications>`)
    : /<\/applications>/.test(rc)
      ? rc.replace(/<\/applications>/, `${APP_RULE}</applications>`)
      : rc.replace(/<\/openbox_config>/, `<applications>${APP_RULE}</applications></openbox_config>`)
  return rc
}

const XFWM4_XML = `<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfwm4" version="1.0">
  <property name="general" type="empty">
    <property name="workspace_count" type="int" value="1"/>
    <property name="use_compositing" type="bool" value="false"/>
    <property name="placement_mode" type="string" value="center"/>
    <property name="placement_ratio" type="int" value="100"/>
    <property name="wrap_windows" type="bool" value="false"/>
    <property name="theme" type="string" value="Default"/>
  </property>
</channel>
`

const THUNAR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<channel name="thunar" version="1.0">
  <property name="last-window-maximized" type="bool" value="true"/>
  <property name="misc-single-click" type="bool" value="false"/>
</channel>
`

/** GSettings (keyfile backend): plank's dock and mousepad's window. */
const gsettingsKeyfile = (dockItems: ReadonlyArray<string>): string =>
  [
    "[net/launchpad/plank/docks/dock1]",
    `dock-items=[${dockItems.map((d) => `'${d}'`).join(", ")}]`,
    "position='bottom'",
    "hide-mode='none'",
    "icon-size=48",
    "lock-items=true",
    "",
    "[org/xfce/mousepad/state/window]",
    "maximized=true",
    "",
  ].join("\n")

/**
 * Config files of a desktop: app launchers (`.desktop`), plank dock items, the openbox menu and
 * rc.xml, xfwm4 / thunar settings (xfconf XML) and GSettings. Written before the programs start.
 */
export const desktopFiles = (input: {
  readonly layout: SessionLayout
  readonly apps: ReadonlyArray<DesktopApp>
  readonly openboxTemplate?: string | undefined
}): { readonly files: ReadonlyArray<DesktopFile>; readonly openboxRcPath: string } => {
  const { layout, apps } = input
  const appsDir = path.join(layout.data, "applications")
  const launchers = path.join(layout.config, "plank", "dock1", "launchers")
  const xfconf = path.join(layout.config, "xfce4", "xfconf", "xfce-perchannel-xml")
  const menuPath = path.join(layout.config, "openbox", "menu.xml")
  const openboxRcPath = path.join(layout.config, "openbox", "rc.xml")
  const files: Array<DesktopFile> = []
  for (const app of apps) {
    const desktopPath = path.join(appsDir, `openbot-${app.id}.desktop`)
    files.push({ path: desktopPath, content: desktopEntry(app) })
    files.push({
      path: path.join(launchers, `openbot-${app.id}.dockitem`),
      content: `[PlankDockItemPreferences]\nLauncher=file://${desktopPath}\n`,
    })
  }
  files.push({ path: menuPath, content: openboxMenu(apps) })
  files.push({ path: openboxRcPath, content: openboxRc(input.openboxTemplate, menuPath) })
  files.push({ path: path.join(xfconf, "xfwm4.xml"), content: XFWM4_XML })
  files.push({ path: path.join(xfconf, "thunar.xml"), content: THUNAR_XML })
  files.push({
    path: path.join(layout.config, "glib-2.0", "settings", "keyfile"),
    content: gsettingsKeyfile(apps.map((a) => `openbot-${a.id}.dockitem`)),
  })
  return { files, openboxRcPath }
}

/** Desktop background: a dark blue-grey gradient (ImageMagick) or a solid color (xsetroot). */
export const BACKGROUND = { top: "#33475b", bottom: "#141c26", solid: "#1f2a36" } as const

export const backgroundArgs = (
  bg: { readonly kind: "xsetroot" | "imagemagick"; readonly argv: ReadonlyArray<string> },
  display: number,
  width: number,
  height: number,
): ReadonlyArray<string> =>
  bg.kind === "xsetroot"
    ? [...bg.argv, "-display", `:${display}`, "-solid", BACKGROUND.solid]
    : [...bg.argv, "-display", `:${display}`, "-window", "root", "-size", `${width}x${height}`, `gradient:${BACKGROUND.top}-${BACKGROUND.bottom}`]

export interface X11vncOptions {
  readonly x11vnc: string
  readonly display: number
  readonly xauthority: string
  readonly port: number
  readonly viewOnly: boolean
}

/** Loopback-only x11vnc for one display (research P1/P8; `-viewonly` for watchers). */
export const x11vncArgs = (o: X11vncOptions): ReadonlyArray<string> => [
  o.x11vnc,
  "-display",
  `:${o.display}`,
  "-auth",
  o.xauthority,
  "-rfbport",
  String(o.port),
  "-localhost",
  "-noipv6",
  "-shared",
  "-forever",
  "-nopw",
  "-norc",
  "-noxdamage",
  "-nolookup",
  "-xkb",
  "-quiet",
  // watchers have no pointer of their own: the bot's is drawn into the picture so they see it move
  ...(o.viewOnly ? ["-viewonly", "-nocursorshape", "-nocursorpos"] : []),
]

export const xvfbArgs = (o: { readonly xvfb: string; readonly display: number; readonly width: number; readonly height: number; readonly xauthority: string }) => [
  o.xvfb,
  `:${o.display}`,
  "-screen",
  "0",
  `${o.width}x${o.height}x24`,
  "-nolisten",
  "tcp",
  "-auth",
  o.xauthority,
  // without -noreset the server resets (pointer back to the center) whenever its last client leaves
  "-noreset",
  "-dpi",
  "96",
  "+extension",
  "XTEST",
  "+extension",
  "RANDR",
]
