// Desktops without X (D1.7): the pure parts (coordinate mapping, key names, xdotool / import
// command lines, program detection, display allocation, session files) and DesktopManager driven
// through a fake operating system (spawns, commands, files, kills), plus the handlers: capability,
// hello, policy, lease refusal, and VNC streams bridged to a fake VNC server.
import { afterAll, describe, expect, test } from "bun:test"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Socket from "effect/socket/Socket"
import { RpcTest } from "effect/rpc"
import * as path from "node:path"
import { NodeRpcs, type ComputerAction } from "@openbot/node-protocol"
import {
  apiPoint,
  AuditLogLive,
  BrowserManagerLive,
  browserArgs,
  chunkText,
  DEBUG_PORT_RANGE,
  desktopFiles,
  DesktopManager,
  desktopNodeKey,
  desktopPrefixEnv,
  describeComputerAction,
  detectDesktopPrograms,
  displayLockPath,
  displaySocketPath,
  execArg,
  freeDebugPort,
  heldModifiers,
  holdKeys,
  importArgs,
  LeaseBook,
  LeaseBookLive,
  makeDesktopManager,
  makeGeometry,
  makeLeaseBook,
  makeNodeConfig,
  NodeConfig,
  NodeConfigLive,
  NodeHandlersFromServices,
  NodeInfo,
  NodePolicyLive,
  openboxRc,
  parseMouseLocation,
  PathPolicyLive,
  pickDisplay,
  planAction,
  sessionEnv,
  sessionLayout,
  toApi,
  toScreen,
  windowManagerOrder,
  x11vncArgs,
  xauthFile,
  xdoCombo,
  xdoKeyName,
  xdoKeySequence,
  xvfbArgs,
  zoomRect,
  type ChildHandle,
  type DesktopSystem,
  type DetectedPrograms,
  type ExecResult,
  type NodeConfigInput,
} from "../src/index.ts"
import { fakeLinks, inv, makeFakeBrain, run, tempDir } from "./helpers.ts"

const g = makeGeometry(1920, 1200)

// ================================================================ pure parts
describe("geometry", () => {
  test("1920x1200 maps to a 1280x800 API space and back", () => {
    expect(g).toEqual({ width: 1920, height: 1200, apiWidth: 1280, apiHeight: 800 })
    expect(toScreen(g, 640, 400)).toEqual({ x: 960, y: 600 })
    expect(toScreen(g, 0, 0)).toEqual({ x: 0, y: 0 })
    expect(toScreen(g, 1280, 800)).toEqual({ x: 1919, y: 1199 })
    expect(toApi(g, 960, 600)).toEqual({ x: 640, y: 400 })
    expect(toApi(g, 1919, 1199)).toEqual({ x: 1279, y: 799 })
    // round trip within one API pixel
    for (const [x, y] of [[1, 1], [333, 777], [1279, 799]] as const) {
      const s = toScreen(g, x, y)
      const back = toApi(g, s.x, s.y)
      expect(Math.abs(back.x - x)).toBeLessThanOrEqual(1)
      expect(Math.abs(back.y - y)).toBeLessThanOrEqual(1)
    }
  })

  test("screens narrower than the API width are not upscaled; odd ratios round", () => {
    expect(makeGeometry(1024, 768)).toEqual({ width: 1024, height: 768, apiWidth: 1024, apiHeight: 768 })
    expect(makeGeometry(1920, 1080).apiHeight).toBe(720)
    expect(makeGeometry(2560, 1600, 1280).apiHeight).toBe(800)
  })

  test("API points are validated", () => {
    expect(apiPoint(g, [10.4, 20.6], "coordinate")).toEqual({ x: 10, y: 21 })
    expect(apiPoint(g, [1280, 800], "coordinate")).toEqual({ x: 1279, y: 799 })
    expect(apiPoint(g, undefined, "coordinate")).toBe("coordinate [x, y] is required")
    expect(apiPoint(g, [1, 2, 3], "coordinate")).toContain("two numbers")
    expect(apiPoint(g, [1300, 10], "coordinate")).toContain("outside the 1280x800 screenshot")
    expect(apiPoint(g, [-1, 10], "start_coordinate")).toContain("start_coordinate")
  })

  test("zoom: an API region becomes a full-resolution crop fitted into the screenshot box", () => {
    expect(zoomRect(g, [0, 0, 100, 50])).toEqual({ x: 0, y: 0, width: 150, height: 75, outWidth: 1280, outHeight: 640 })
    expect(zoomRect(g, [640, 400, 0, 0])).toEqual({ x: 0, y: 0, width: 960, height: 600, outWidth: 1280, outHeight: 800 })
    // tall region: fits the height
    const tall = zoomRect(g, [100, 0, 200, 800])
    expect(typeof tall === "object" && tall.outHeight).toBe(800)
    expect(zoomRect(g, [5, 5, 5, 100])).toContain("empty")
    expect(zoomRect(g, [1, 2, 3])).toContain("four numbers")
    expect(zoomRect(g, undefined)).toContain("required")
  })
})

describe("key names", () => {
  test("Anthropic / xdotool names pass; DOM and macOS names are mapped", () => {
    expect(xdoKeyName("Return")).toBe("Return")
    expect(xdoKeyName("Enter")).toBe("Return")
    expect(xdoKeyName("ESC")).toBe("Escape")
    expect(xdoKeyName("ArrowDown")).toBe("Down")
    expect(xdoKeyName("PageUp")).toBe("Page_Up")
    expect(xdoKeyName("backspace")).toBe("BackSpace")
    expect(xdoKeyName("f5")).toBe("F5")
    expect(xdoKeyName("KP_0")).toBe("KP_0")
    expect(xdoKeyName("a")).toBe("a")
    expect(xdoKeyName("/")).toBe("slash")
    expect(xdoKeyName("super_l")).toBe("super")
    expect(xdoCombo("ctrl+l")).toBe("ctrl+l")
    expect(xdoCombo("cmd+c")).toBe("ctrl+c")
    expect(xdoCombo("Control+Shift+T")).toBe("ctrl+shift+T")
    expect(xdoCombo("ctrl++")).toBe("ctrl+plus")
    expect(xdoCombo("alt+Tab")).toBe("alt+Tab")
    expect(xdoCombo("ctrl+")).toBeUndefined()
    expect(xdoCombo("+")).toBe("plus")
    expect(xdoCombo("")).toBeUndefined()
    expect(xdoKeySequence("ctrl+a Delete")).toEqual(["ctrl+a", "Delete"])
    expect(xdoKeySequence(" ")).toEqual(["space"])
    expect(xdoKeySequence(undefined)).toBeUndefined()
    expect(heldModifiers("shift")).toEqual(["shift"])
    expect(heldModifiers("Ctrl+Shift")).toEqual(["ctrl", "shift"])
    expect(heldModifiers(undefined)).toEqual([])
    expect(heldModifiers("a")).toBeUndefined()
    expect(holdKeys("shift")).toEqual(["shift"])
    expect(holdKeys("ctrl+alt")).toEqual(["ctrl", "alt"])
  })
})

const plan = (a: ComputerAction) => {
  const p = planAction(g, a)
  if (typeof p === "string") throw new Error(p)
  return p
}
const xdo = (...args: Array<string | number>) => ({ _tag: "xdotool" as const, args: args.map(String) })

describe("action plans (xdotool command lines)", () => {
  test("clicks move first, then click; double/triple repeat; modifiers are held", () => {
    expect(plan({ action: "left_click", coordinate: [640, 400] })).toMatchObject({
      hold: [],
      steps: [xdo("mousemove", "--sync", 960, 600), xdo("click", 1)],
      image: "after",
      text: "Clicked at (640, 400).",
    })
    expect(plan({ action: "right_click", coordinate: [10, 10] }).steps[1]).toEqual(xdo("click", 3))
    expect(plan({ action: "middle_click" }).steps).toEqual([xdo("click", 2)])
    expect(plan({ action: "double_click", coordinate: [1, 1] }).steps[1]).toEqual(xdo("click", "--repeat", 2, "--delay", 80, 1))
    expect(plan({ action: "triple_click", coordinate: [1, 1] }).steps[1]).toEqual(xdo("click", "--repeat", 3, "--delay", 80, 1))
    const shifted = plan({ action: "left_click", coordinate: [1, 1], text: "shift+ctrl" })
    expect(shifted.hold).toEqual(["shift", "ctrl"])
    expect(shifted.text).toBe("Clicked at (1, 1) holding shift+ctrl.")
    expect(planAction(g, { action: "left_click", text: "q" })).toContain("modifier keys")
    expect(plan({ action: "left_click" }).text).toBe("Clicked at the mouse position.")
  })

  test("move, drag, mouse down/up, scroll", () => {
    expect(plan({ action: "mouse_move", coordinate: [100, 200] }).steps).toEqual([xdo("mousemove", "--sync", 150, 300)])
    expect(planAction(g, { action: "mouse_move" })).toBe("coordinate [x, y] is required")
    expect(plan({ action: "left_click_drag", start_coordinate: [0, 0], coordinate: [100, 100] }).steps).toEqual([
      xdo("mousemove", "--sync", 0, 0),
      xdo("mousedown", 1),
      { _tag: "sleep", ms: 60 },
      xdo("mousemove", "--sync", 150, 150),
      { _tag: "sleep", ms: 60 },
      xdo("mouseup", 1),
    ])
    expect(planAction(g, { action: "left_click_drag", coordinate: [1, 1] })).toContain("start_coordinate")
    expect(plan({ action: "left_mouse_down" }).steps).toEqual([xdo("mousedown", 1)])
    expect(plan({ action: "left_mouse_up", coordinate: [2, 2] }).steps).toEqual([xdo("mousemove", "--sync", 3, 3), xdo("mouseup", 1)])
    expect(plan({ action: "scroll", coordinate: [640, 400], scroll_direction: "down", scroll_amount: 5 }).steps).toEqual([
      xdo("mousemove", "--sync", 960, 600),
      xdo("click", "--repeat", 5, "--delay", 30, 5),
    ])
    expect(plan({ action: "scroll", scroll_direction: "up" }).steps).toEqual([xdo("click", "--repeat", 3, "--delay", 30, 4)])
    expect(plan({ action: "scroll", scroll_direction: "left", scroll_amount: 1 }).steps[0]).toEqual(xdo("click", "--repeat", 1, "--delay", 30, 6))
    expect(plan({ action: "scroll", scroll_direction: "right", text: "shift" }).hold).toEqual(["shift"])
    expect(planAction(g, { action: "scroll" })).toContain("scroll_direction")
    expect(planAction(g, { action: "scroll", scroll_direction: "down", scroll_amount: 0 })).toContain("between 1 and")
  })

  test("type in chunks, key sequences, hold_key, wait, cursor_position, screenshot, zoom", () => {
    const long = "x".repeat(120)
    expect(plan({ action: "type", text: long }).steps).toEqual([
      xdo("type", "--delay", 12, "--", "x".repeat(50)),
      xdo("type", "--delay", 12, "--", "x".repeat(50)),
      xdo("type", "--delay", 12, "--", "x".repeat(20)),
    ])
    expect(chunkText("😀".repeat(3), 2)).toEqual(["😀😀", "😀"])
    expect(plan({ action: "type", text: "-n héllo" }).text).toBe("Typed 8 characters.")
    expect(planAction(g, { action: "type" })).toContain("text is required")
    expect(plan({ action: "key", text: "ctrl+l" }).steps).toEqual([xdo("key", "--delay", 50, "--", "ctrl+l")])
    expect(plan({ action: "key", text: "Enter" }).text).toBe("Pressed Return.")
    expect(planAction(g, { action: "key" })).toContain("key or combination")
    expect(plan({ action: "hold_key", text: "shift", duration: 2 })).toMatchObject({ hold: ["shift"], steps: [{ _tag: "sleep", ms: 2000 }] })
    expect(planAction(g, { action: "hold_key", text: "shift", duration: 600 })).toContain("at most")
    expect(plan({ action: "wait", duration: 0.5 })).toMatchObject({ steps: [{ _tag: "sleep", ms: 500 }], image: "now" })
    expect(plan({ action: "cursor_position" })).toMatchObject({ cursor: true, image: "none" })
    expect(plan({ action: "screenshot" })).toMatchObject({ steps: [], image: "now" })
    expect(plan({ action: "zoom", region: [0, 0, 100, 50] }).image).toEqual({
      zoom: { x: 0, y: 0, width: 150, height: 75, outWidth: 1280, outHeight: 640 },
    })
  })

  test("audit targets never contain typed text", () => {
    expect(describeComputerAction({ action: "type", text: "secret password" })).toBe("type 15 chars")
    expect(describeComputerAction({ action: "left_click", coordinate: [3.2, 4.7] })).toBe("left_click 3,5")
    expect(describeComputerAction({ action: "key", text: "ctrl+l" })).toBe("key ctrl+l")
    expect(describeComputerAction({ action: "scroll", scroll_direction: "down" })).toBe("scroll down 3")
  })

  test("mouse location and ImageMagick import arguments", () => {
    expect(parseMouseLocation("X=960\nY=600\nSCREEN=0\nWINDOW=935\n")).toEqual({ x: 960, y: 600 })
    expect(parseMouseLocation("nope")).toBeUndefined()
    expect(importArgs({ display: ":101", width: 1280, height: 800, exact: true, format: "jpeg", quality: 80 })).toEqual([
      "-silent", "-display", ":101", "-window", "root", "-resize", "1280x800!", "-strip", "-quality", "80", "jpeg:-",
    ])
    expect(
      importArgs({ display: ":101", width: 1280, height: 640, exact: false, crop: { x: 3, y: 4, width: 150, height: 75 }, format: "png", quality: 80 }),
    ).toEqual(["-silent", "-display", ":101", "-window", "root", "-crop", "150x75+3+4", "+repage", "-resize", "1280x640", "-strip", "png:-"])
  })
})

describe("programs", () => {
  const all: Record<string, string> = {
    Xvfb: "/usr/bin/Xvfb",
    x11vnc: "/usr/bin/x11vnc",
    xdotool: "/usr/bin/xdotool",
    xfwm4: "/usr/bin/xfwm4",
    openbox: "/usr/bin/openbox",
    import: "/usr/bin/import",
    plank: "/usr/bin/plank",
    "xfce4-terminal": "/usr/bin/xfce4-terminal",
  }
  test("all required programs: nothing missing; xfwm4 first with a dock, openbox first without", () => {
    const d = detectDesktopPrograms((n) => all[n])
    expect(d.missing).toEqual([])
    expect(windowManagerOrder(d.programs).map((w) => w.kind)).toEqual(["xfwm4", "openbox"])
    expect(windowManagerOrder({ ...d.programs, dock: undefined }).map((w) => w.kind)).toEqual(["openbox", "xfwm4"])
    expect(d.programs.screenshot).toEqual(["/usr/bin/import"])
    expect(d.programs.terminal).toEqual({ kind: "xfce4-terminal", path: "/usr/bin/xfce4-terminal" })
  })
  test("missing programs are named; ImageMagick 7 without `import` works through `magick import`", () => {
    expect(detectDesktopPrograms(() => undefined).missing).toEqual(["Xvfb", "x11vnc", "xdotool", "xfwm4 or openbox", "ImageMagick (import)"])
    const d = detectDesktopPrograms((n) => ({ Xvfb: "/x/Xvfb", openbox: "/x/openbox", magick: "/x/magick" })[n])
    expect(d.missing).toEqual(["x11vnc", "xdotool"])
    expect(d.programs.screenshot).toEqual(["/x/magick", "import"])
    expect(d.programs.background).toEqual({ kind: "imagemagick", argv: ["/x/magick", "display"] })
  })
  test("rootless prefixes add their lib and share dirs", () => {
    const env = desktopPrefixEnv(["/opt/xroot/usr/bin", "/usr/bin"], (p) => p.startsWith("/opt/xroot/usr/"))
    expect(env).toEqual({ LD_LIBRARY_PATH: "/opt/xroot/usr/lib", XDG_DATA_DIRS: "/opt/xroot/usr/share:/usr/local/share:/usr/share" })
  })
})

describe("display allocation and session files", () => {
  const fs = (files: Record<string, string>, alive: ReadonlyArray<number> = []) => ({
    files: new Map(Object.entries(files)),
    exists(p: string) {
      return this.files.has(p)
    },
    readText(p: string) {
      return this.files.get(p)
    },
    remove(p: string) {
      this.files.delete(p)
    },
    pidAlive: (pid: number) => alive.includes(pid),
  })

  test("skips live and unknown servers, reclaims stale locks, honors reserved numbers", () => {
    expect(pickDisplay(fs({}), 100, new Set())).toBe(100)
    expect(pickDisplay(fs({}), 100, new Set([100, 101]))).toBe(102)
    // a live server on :100
    expect(pickDisplay(fs({ [displayLockPath(100)]: "      4242\n" }, [4242]), 100, new Set())).toBe(101)
    // a socket without a lock (someone else's server): left alone
    expect(pickDisplay(fs({ [displaySocketPath(100)]: "" }), 100, new Set())).toBe(101)
    // a SIGKILLed Xvfb: its lock and socket are removed and the number reused
    const stale = fs({ [displayLockPath(100)]: "      4243\n", [displaySocketPath(100)]: "" })
    expect(pickDisplay(stale, 100, new Set())).toBe(100)
    expect(stale.files.size).toBe(0)
  })

  test("Xauthority: one MIT-MAGIC-COOKIE-1 entry for any display", () => {
    const cookie = new Uint8Array(16).fill(7)
    const f = xauthFile(cookie)
    expect([...f.slice(0, 2)]).toEqual([0xff, 0xff])
    expect([...f.slice(2, 6)]).toEqual([0, 0, 0, 0])
    expect(new TextDecoder().decode(f.slice(8, 26))).toBe("MIT-MAGIC-COOKIE-1")
    expect([...f.slice(26, 28)]).toEqual([0, 16])
    expect(f.length).toBe(28 + 16)
  })

  test("the session environment is clean: no Wayland, no owner bus, its own X cookie and XDG dirs", () => {
    const layout = sessionLayout({ dataDir: "/data", botId: "bot_1", display: 101, tmpdir: "/tmp", uid: 1000 })
    const env = sessionEnv({
      display: 101,
      layout,
      path: ["/opt/x/bin"],
      extra: { LD_LIBRARY_PATH: "/opt/x/lib" },
      marker: "abc/bot_1/",
      botId: "bot_1",
      nodeId: "nod_1",
      source: {
        PATH: "/usr/bin",
        HOME: "/home/o",
        WAYLAND_DISPLAY: "wayland-1",
        DISPLAY: ":0",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        HYPRLAND_INSTANCE_SIGNATURE: "x",
        ANTHROPIC_API_KEY: "secret",
      },
    })
    expect(env.WAYLAND_DISPLAY).toBeUndefined()
    expect(env.HYPRLAND_INSTANCE_SIGNATURE).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.DISPLAY).toBe(":101")
    expect(env.XAUTHORITY).toBe("/tmp/openbot-desktop-1000/101/Xauthority")
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("disabled:")
    expect(env.XDG_SESSION_TYPE).toBe("x11")
    expect(env.XDG_CONFIG_HOME).toBe("/data/desktops/bot_1/home/config")
    expect(env.PATH).toBe("/opt/x/bin:/usr/bin")
    expect(env.HOME).toBe("/home/o")
    expect(env.LD_LIBRARY_PATH).toBe("/opt/x/lib")
    expect(env.OPENBOT_DESKTOP).toBe("abc/bot_1/")
  })

  test("command lines: Xvfb without TCP and with -noreset, loopback x11vnc, view-only flag", () => {
    expect(xvfbArgs({ xvfb: "Xvfb", display: 100, width: 1920, height: 1200, xauthority: "/r/Xa" })).toEqual([
      "Xvfb", ":100", "-screen", "0", "1920x1200x24", "-nolisten", "tcp", "-auth", "/r/Xa", "-noreset", "-dpi", "96", "+extension", "XTEST", "+extension", "RANDR",
    ])
    const vnc = x11vncArgs({ x11vnc: "x11vnc", display: 100, xauthority: "/r/Xa", port: 5999, viewOnly: true })
    expect(vnc).toContain("-localhost")
    expect(vnc).toContain("-viewonly")
    // watchers see the bot's pointer drawn into the picture
    expect(vnc).toEqual(expect.arrayContaining(["-nocursorshape", "-nocursorpos"]))
    expect(vnc.slice(vnc.indexOf("-rfbport"), vnc.indexOf("-rfbport") + 2)).toEqual(["-rfbport", "5999"])
    expect(x11vncArgs({ x11vnc: "x11vnc", display: 100, xauthority: "/r/Xa", port: 5998, viewOnly: false })).not.toContain("-viewonly")
  })

  test("openbox rc.xml: one desktop, maximized windows, our menu", () => {
    const template = `<openbox_config><desktops><!-- c --><number>4</number></desktops><menu><file>menu.xml</file></menu><applications>
    <!-- <application class="x"/> --></applications></openbox_config>`
    const rc = openboxRc(template, "/c/openbox/menu.xml")
    expect(rc).toContain("<number>1</number>")
    expect(rc).toContain("<file>/c/openbox/menu.xml</file>")
    expect(rc).toContain(`<application class="*" type="normal"><maximized>yes</maximized></application></applications>`)
    const minimal = openboxRc(undefined, "/m.xml")
    expect(minimal).toContain("<file>/m.xml</file>")
    expect(minimal).toContain("<maximized>yes</maximized>")
  })

  test("desktop files: launchers, dock items, menu, xfwm4 / thunar settings", () => {
    const layout = sessionLayout({ dataDir: "/data", botId: "bot_1", display: 101, tmpdir: "/tmp", uid: 1000 })
    const { files } = desktopFiles({
      layout,
      apps: [{ id: "terminal", name: "Terminal", icon: "utilities-terminal", argv: ["xfce4-terminal", "--working-directory=/w s"] }],
    })
    const byName = new Map(files.map((f) => [path.basename(f.path), f.content]))
    expect(byName.get("openbot-terminal.desktop")).toContain(`Exec=xfce4-terminal "--working-directory=/w s"`)
    expect(byName.get("openbot-terminal.dockitem")).toBe(
      "[PlankDockItemPreferences]\nLauncher=file:///data/desktops/bot_1/home/data/applications/openbot-terminal.desktop\n",
    )
    expect(byName.get("menu.xml")).toContain(`<command>xfce4-terminal '--working-directory=/w s'</command>`)
    expect(byName.get("xfwm4.xml")).toContain(`name="use_compositing" type="bool" value="false"`)
    expect(byName.get("keyfile")).toContain("dock-items=['openbot-terminal.dockitem']")
    expect(execArg("100%")).toBe("100%%")
    expect(execArg(`a"b`)).toBe(`"a\\\\"b"`)
  })
})

// ================================================================ DesktopManager with a fake OS
interface FakeChild {
  readonly argv: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly handle: ChildHandle
  readonly exit: (code: number) => void
  setOutput: (text: string) => void
}

interface FakeOs {
  readonly system: DesktopSystem
  readonly files: Map<string, string | Uint8Array>
  readonly spawned: Array<FakeChild>
  readonly execs: Array<ReadonlyArray<string>>
  readonly kills: Array<{ readonly pid: number; readonly signal: string }>
  readonly marked: Array<{ readonly prefix: string; readonly signal: string }>
  readonly alive: Set<number>
  /** program name → behaviour at spawn (default: Xvfb creates its socket and lock, x11vnc prints PORT=) */
  readonly onSpawn: Map<string, (c: FakeChild) => void>
  readonly onExec: Map<string, (argv: ReadonlyArray<string>) => ExecResult | undefined>
  readonly ports: Array<number>
  readonly running: (name: string) => ReadonlyArray<FakeChild>
}

/** A PNG header (enough for `imageSize`). */
const pngHeader = (w: number, h: number) => {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(b.buffer).setUint32(16, w)
  new DataView(b.buffer).setUint32(20, h)
  return b
}

const ok = (stdout: Uint8Array | string = ""): ExecResult => ({
  code: 0,
  stdout: typeof stdout === "string" ? new TextEncoder().encode(stdout) : stdout,
  stderr: "",
  timedOut: false,
})

const makeFakeOs = (): FakeOs => {
  const files = new Map<string, string | Uint8Array>()
  const spawned: Array<FakeChild> = []
  const execs: Array<ReadonlyArray<string>> = []
  const kills: Array<{ pid: number; signal: string }> = []
  const marked: Array<{ prefix: string; signal: string }> = []
  const alive = new Set<number>()
  const onSpawn = new Map<string, (c: FakeChild) => void>()
  const onExec = new Map<string, (argv: ReadonlyArray<string>) => ExecResult | undefined>()
  const ports: Array<number> = []
  let nextPid = 70_000
  let nextPort = 59_000
  const name = (argv: ReadonlyArray<string>) => path.basename(argv[0] ?? "")
  const byPid = new Map<number, FakeChild>()
  onSpawn.set("Xvfb", (c) => {
    const n = Number(c.argv[1]!.slice(1))
    files.set(displaySocketPath(n), "")
    files.set(displayLockPath(n), `      ${c.handle.pid}\n`)
  })
  onSpawn.set("x11vnc", (c) => c.setOutput(`PORT=${c.argv[c.argv.indexOf("-rfbport") + 1]}\n`))
  onExec.set("import", () => ok(pngHeader(1280, 800)))
  const os: FakeOs = {
    files,
    spawned,
    execs,
    kills,
    marked,
    alive,
    onSpawn,
    onExec,
    ports,
    running: (n) => spawned.filter((c) => name(c.argv) === n && c.handle.exitCode === null),
    system: {
      spawn: (argv, options) => {
        const pid = nextPid++
        let exitCode: number | null = null
        let output = ""
        let resolve!: (code: number) => void
        const exited = new Promise<number>((r) => (resolve = r))
        const handle: ChildHandle = {
          pid,
          exited,
          get exitCode() {
            return exitCode
          },
          signalCode: null,
          output: () => output,
        }
        const child: FakeChild = {
          argv,
          env: options.env,
          handle,
          exit: (code) => {
            if (exitCode !== null) return
            exitCode = code
            alive.delete(pid)
            if (name(argv) === "Xvfb") {
              const n = Number(argv[1]!.slice(1))
              files.delete(displaySocketPath(n))
              files.delete(displayLockPath(n))
            }
            resolve(code)
          },
          setOutput: (t) => void (output = t),
        }
        alive.add(pid)
        byPid.set(pid, child)
        spawned.push(child)
        onSpawn.get(name(argv))?.(child)
        return handle
      },
      exec: async (argv) => {
        execs.push(argv)
        const prog = name(argv) === "magick" ? argv[1]! : name(argv)
        return onExec.get(prog)?.(argv) ?? ok()
      },
      exists: (p) => files.has(p),
      readText: (p) => {
        const v = files.get(p)
        return typeof v === "string" ? v : v === undefined ? undefined : new TextDecoder().decode(v)
      },
      writeFile: (p, d) => void files.set(p, d),
      mkdir: () => undefined,
      remove: (p) => {
        for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k)
      },
      pidAlive: (pid) => alive.has(pid),
      kill: (pid, signal) => {
        kills.push({ pid, signal })
        const c = byPid.get(pid)
        if (!c || c.handle.exitCode !== null) return false
        c.exit(143)
        return true
      },
      killMarked: (prefix, signal) => {
        marked.push({ prefix, signal })
        return []
      },
      freePort: async () => ports.shift() ?? nextPort++,
      sleep: (ms) => Bun.sleep(ms),
      tmpdir: "/fake-tmp",
      uid: 1000,
    },
  }
  return os
}

const allPrograms: DetectedPrograms = detectDesktopPrograms(
  (n) =>
    ({
      Xvfb: "/usr/bin/Xvfb",
      x11vnc: "/usr/bin/x11vnc",
      xdotool: "/usr/bin/xdotool",
      xfwm4: "/usr/bin/xfwm4",
      openbox: "/usr/bin/openbox",
      import: "/usr/bin/import",
      display: "/usr/bin/display",
      plank: "/usr/bin/plank",
      "dbus-daemon": "/usr/bin/dbus-daemon",
      "xfce4-terminal": "/usr/bin/xfce4-terminal",
      thunar: "/usr/bin/thunar",
      mousepad: "/usr/bin/mousepad",
    })[n],
)

const t = tempDir("desktop-")
afterAll(t.cleanup)

const nodeConfig = (extra?: Partial<NodeConfigInput>) =>
  makeNodeConfig({
    nodeId: "nod_fake",
    dataDir: path.join(t.path, "state"),
    roots: [path.join(t.path, "work")],
    detectBinaries: false,
    browser: { enabled: false },
    desktop: { enabled: true, settleMs: 0 },
    ...extra,
  })

const fastTimeouts = { display: 500, vnc: 500, windowManager: 20, bus: 200, exec: 1000 }

const withManager = <A, E>(
  f: (dm: Effect.Success<ReturnType<typeof makeDesktopManager>>, os: FakeOs, leases: ReturnType<typeof makeLeaseBook>) => Effect.Effect<A, E, Scope.Scope>,
  options?: { readonly os?: FakeOs; readonly detected?: DetectedPrograms; readonly config?: Partial<NodeConfigInput> },
) =>
  run(
    Effect.gen(function* () {
      const os = options?.os ?? makeFakeOs()
      const leases = makeLeaseBook()
      const dm = yield* makeDesktopManager(nodeConfig(options?.config), {
        system: os.system,
        detected: options?.detected ?? allPrograms,
        leases,
        timeouts: fastTimeouts,
      })
      return yield* f(dm, os, leases)
    }),
  )

/** xdotool runs of actions (not the start-up probes: display geometry, waiting for the dock). */
const xdoCalls = (os: FakeOs) =>
  os.execs.filter((a) => path.basename(a[0]!) === "xdotool" && a[1] !== "getdisplaygeometry" && a[1] !== "search").map((a) => a.slice(1).join(" "))

describe("DesktopManager (fake OS)", () => {
  test("ensure starts Xvfb, a session bus, xfwm4, plank and two loopback VNC servers; concurrent calls share it", () =>
    withManager((dm, os) =>
      Effect.gen(function* () {
        expect(dm.offered).toBe(true)
        expect(dm.support).toEqual({ missing: [], width: 1920, height: 1200 })
        const [a, b] = yield* Effect.all([dm.ensure("bot_1"), dm.ensure("bot_1")], { concurrency: 2 })
        expect(a).toEqual({ botId: "bot_1", display: ":100", width: 1920, height: 1200 })
        expect(b).toEqual(a)
        expect(os.running("Xvfb").length).toBe(1)
        const names = os.spawned.map((c) => path.basename(c.argv[0]!))
        expect(names).toEqual(["Xvfb", "dbus-daemon", "xfwm4", "plank", "x11vnc", "x11vnc"])
        // the desktop is handed out once the dock is on screen
        expect(os.execs.some((a) => path.basename(a[0]!) === "xdotool" && a.slice(1).join(" ") === "search --onlyvisible --classname plank")).toBe(true)
        const xvfb = os.spawned[0]!
        expect(xvfb.argv.slice(0, 5)).toEqual(["/usr/bin/Xvfb", ":100", "-screen", "0", "1920x1200x24"])
        // every child: the bot's display, no Wayland, the marker
        for (const c of os.spawned) {
          expect(c.env.WAYLAND_DISPLAY).toBeUndefined()
          expect(c.env.DISPLAY).toBe(":100")
          expect(c.env.OPENBOT_DESKTOP).toBe(`${desktopNodeKey(path.join(t.path, "state"))}/bot_1/`)
        }
        const vnc = os.running("x11vnc")
        expect(vnc.filter((c) => c.argv.includes("-viewonly")).length).toBe(1)
        expect(vnc.every((c) => c.argv.includes("-localhost"))).toBe(true)
        expect(os.spawned[2]!.argv).toEqual(["/usr/bin/xfwm4", "--compositor=off", "--sm-client-disable"])
        // the X cookie was written before Xvfb started
        expect(os.files.get("/fake-tmp/openbot-desktop-1000/100/Xauthority")).toBeInstanceOf(Uint8Array)
        // the background was set
        expect(os.execs.some((a) => path.basename(a[0]!) === "display" && a.includes("root"))).toBe(true)
        expect(dm.running()).toEqual([a])
        // a second bot gets the next display
        expect((yield* dm.ensure("bot_2")).display).toBe(":101")
      }),
    ))

  test("display allocation: a stale lock is reclaimed, a live one skipped, a lost race moves on", () =>
    withManager(
      (dm, os) =>
        Effect.gen(function* () {
          os.files.set(displayLockPath(100), "      123\n") // live (see below)
          os.alive.add(123)
          os.files.set(displayLockPath(101), "      124\n") // dead
          os.files.set(displaySocketPath(101), "")
          // the first Xvfb on :101 loses a race to another server
          let first = true
          os.onSpawn.set("Xvfb", (c) => {
            const n = Number(c.argv[1]!.slice(1))
            if (first) {
              first = false
              os.files.set(path.join(t.path, "state", "desktops", "bot_1", "logs", "xvfb.log"), "Fatal server error:\nServer is already active for display 101\n")
              return c.exit(1)
            }
            os.files.set(displaySocketPath(n), "")
            os.files.set(displayLockPath(n), `      ${c.handle.pid}\n`)
          })
          const origRead = os.system.readText
          ;(os.system as { readText: DesktopSystem["readText"] }).readText = (p) =>
            p.endsWith("xvfb.log") ? os.files.get(path.join(t.path, "state", "desktops", "bot_1", "logs", "xvfb.log")) as string : origRead(p)
          const d = yield* dm.ensure("bot_1")
          expect(d.display).toBe(":102")
          expect(os.spawned.filter((c) => path.basename(c.argv[0]!) === "Xvfb").map((c) => c.argv[1])).toEqual([":101", ":102"])
        }),
    ))

  test("missing programs: not offered, ensure and act fail with the list", () =>
    withManager(
      (dm, os) =>
        Effect.gen(function* () {
          expect(dm.offered).toBe(false)
          expect(dm.support.missing).toEqual(["x11vnc", "xdotool"])
          const e = yield* Effect.flip(dm.ensure("bot_1"))
          expect(e._tag).toBe("DesktopUnavailable")
          expect(e.missing).toEqual(["x11vnc", "xdotool"])
          expect(e.message).toContain("x11vnc, xdotool not installed")
          expect((yield* Effect.flip(dm.act("bot_1", { action: "screenshot" })))._tag).toBe("DesktopUnavailable")
          expect(os.spawned.length).toBe(0)
        }),
      { detected: detectDesktopPrograms((n) => ({ Xvfb: "/x/Xvfb", xfwm4: "/x/xfwm4", import: "/x/import" })[n]) },
    ))

  test("window manager fallback: xfwm4 dies at start, openbox takes over", () =>
    withManager((dm, os) =>
      Effect.gen(function* () {
        os.onSpawn.set("xfwm4", (c) => c.exit(1))
        yield* dm.ensure("bot_1")
        expect(os.running("openbox").length).toBe(1)
        const ob = os.running("openbox")[0]!
        expect(ob.argv[1]).toBe("--config-file")
        expect(String(os.files.get(ob.argv[2]!))).toContain("<maximized>yes</maximized>")
        expect(ob.env.XDG_CURRENT_DESKTOP).toBe("OPENBOX")
      }),
    ))

  test("a failed start kills what it started", () =>
    withManager((dm, os) =>
      Effect.gen(function* () {
        os.onSpawn.set("xfwm4", (c) => c.exit(1))
        os.onSpawn.set("openbox", (c) => c.exit(1))
        const e = yield* Effect.flip(dm.ensure("bot_1"))
        expect(e.message).toContain("no window manager could start")
        expect(os.running("Xvfb").length).toBe(0)
        expect(os.running("dbus-daemon").length).toBe(0)
        expect(os.marked.some((m) => m.prefix.endsWith("/bot_1/"))).toBe(true)
        expect(os.files.has(displayLockPath(100))).toBe(false)
        expect(dm.running()).toEqual([])
      }),
    ))

  test("act: xdotool in screen pixels, then a screenshot; modifiers released even on failure", () =>
    withManager((dm, os) =>
      Effect.gen(function* () {
        const r = yield* dm.act("bot_1", { action: "double_click", coordinate: [640, 400] })
        expect(r.text).toBe("Double-clicked at (640, 400).")
        expect(r.image).toEqual({ mimeType: "image/png", data: Buffer.from(pngHeader(1280, 800)).toString("base64"), width: 1280, height: 800 })
        expect(xdoCalls(os)).toEqual(["mousemove --sync 960 600", "click --repeat 2 --delay 80 1"])
        const shot = os.execs.find((a) => path.basename(a[0]!) === "import")!
        expect(shot).toContain("1280x800!")
        expect(shot).toContain(":100")

        os.execs.length = 0
        os.onExec.set("xdotool", (argv) => (argv[1] === "click" ? { code: 1, stdout: new Uint8Array(), stderr: "boom", timedOut: false } : undefined))
        const failed = yield* Effect.flip(dm.act("bot_1", { action: "left_click", text: "shift" }))
        expect(failed._tag).toBe("DesktopUnavailable")
        expect(xdoCalls(os)).toEqual(["keydown shift", "click 1", "keyup shift"])
        os.onExec.delete("xdotool")

        os.execs.length = 0
        os.onExec.set("xdotool", (argv) => (argv[1] === "getmouselocation" ? ok("X=960\nY=600\nSCREEN=0\nWINDOW=1\n") : undefined))
        const pos = yield* dm.act("bot_1", { action: "cursor_position" })
        expect(pos).toEqual({ text: "X=640, Y=400" })

        const zoom = yield* dm.act("bot_1", { action: "zoom", region: [0, 0, 100, 50] })
        expect(zoom.text).toContain("Zoomed into [0, 0, 100, 50]")
        expect(os.execs.at(-1)).toContain("150x75+0+0")

        const bad = yield* dm.act("bot_1", { action: "mouse_move" })
        expect(bad).toEqual({ text: "ERROR: coordinate [x, y] is required" })
      }),
    ))

  test("the lease: no input while the user holds it", () =>
    withManager((dm, os, leases) =>
      Effect.gen(function* () {
        yield* dm.ensure("bot_1")
        os.execs.length = 0
        leases.set("bot_1", "user")
        const e = yield* Effect.flip(dm.act("bot_1", { action: "left_click", coordinate: [1, 1] }))
        expect(e._tag).toBe("LeaseHeld")
        // no input, only the hand-over releasing every held modifier (a lost key-up never sticks)
        yield* Effect.sleep(20)
        expect(os.execs.map((a) => a[1])).toEqual(["keyup"])
        expect(os.execs[0]).toEqual(expect.arrayContaining(["Alt_L", "Control_L", "Shift_L", "Super_L"]))
        // taken mid-action: the remaining steps do not run
        leases.set("bot_1", "bot")
        os.onExec.set("xdotool", (argv) => {
          if (argv[1] === "type") leases.set("bot_1", "user")
          return undefined
        })
        const mid = yield* Effect.flip(dm.act("bot_1", { action: "type", text: "x".repeat(120) }))
        expect(mid._tag).toBe("LeaseHeld")
        expect(xdoCalls(os).filter((c) => c.startsWith("type")).length).toBe(1)
      }),
    ))

  test("stop: hooks first, then every child and everything marked; the next ensure starts fresh", () =>
    withManager((dm, os) =>
      Effect.gen(function* () {
        const order: Array<string> = []
        dm.onStop((botId) => Effect.sync(() => void order.push(`hook:${botId}:${os.running("Xvfb").length}`)))
        yield* dm.ensure("bot_1")
        const pids = os.spawned.map((c) => c.handle.pid)
        yield* dm.stop("bot_1")
        expect(order).toEqual(["hook:bot_1:1"])
        expect(os.spawned.every((c) => c.handle.exitCode !== null)).toBe(true)
        for (const pid of pids) expect(os.kills.some((k) => k.pid === pid && k.signal === "SIGTERM")).toBe(true)
        const marker = `${desktopNodeKey(path.join(t.path, "state"))}/bot_1/`
        expect(os.marked).toContainEqual({ prefix: marker, signal: "SIGTERM" })
        expect(os.files.has(displayLockPath(100))).toBe(false)
        expect([...os.files.keys()].some((k) => k.startsWith("/fake-tmp/openbot-desktop-1000/100"))).toBe(false)
        expect(dm.running()).toEqual([])
        yield* dm.stop("bot_1") // no-op
        expect((yield* dm.ensure("bot_1")).display).toBe(":100")
        expect(os.running("Xvfb").length).toBe(1)
      }),
    ))

  test("start hooks run once per fresh desktop, not when an existing one is returned", () =>
    withManager((dm) =>
      Effect.gen(function* () {
        const started: Array<string> = []
        dm.onStart((info) => Effect.sync(() => void started.push(`${info.botId}@${info.display} ${info.width}x${info.height}`)))
        yield* Effect.all([dm.ensure("bot_1"), dm.ensure("bot_1")], { concurrency: "unbounded" })
        yield* dm.ensure("bot_1")
        expect(started).toEqual(["bot_1@:100 1920x1200"])
        yield* dm.stop("bot_1")
        yield* dm.ensure("bot_1")
        expect(started).toEqual(["bot_1@:100 1920x1200", "bot_1@:100 1920x1200"])
      }),
    ))

  test("repairs: dead VNC servers and window manager are restarted; a dead X server means a fresh desktop", () =>
    withManager((dm, os) =>
      Effect.gen(function* () {
        yield* dm.ensure("bot_1")
        const view = os.running("x11vnc").find((c) => c.argv.includes("-viewonly"))!
        view.exit(1)
        os.running("xfwm4")[0]!.exit(1)
        const port = yield* dm.vncPort("bot_1", "view")
        expect(port).toBeGreaterThan(0)
        expect(os.running("x11vnc").length).toBe(2)
        expect(os.running("xfwm4").length).toBe(1)
        // the X server dies: everything goes, a new desktop starts
        os.running("Xvfb")[0]!.exit(1)
        yield* dm.ensure("bot_1")
        expect(os.running("Xvfb").length).toBe(1)
        expect(os.running("x11vnc").length).toBe(2)
        expect(os.spawned.filter((c) => path.basename(c.argv[0]!) === "Xvfb").length).toBe(2)
      }),
    ))

  test("closing the scope stops every desktop; nothing starts afterwards", () =>
    run(
      Effect.gen(function* () {
        const os = makeFakeOs()
        const scope = yield* Scope.make()
        const dm = yield* makeDesktopManager(nodeConfig(), { system: os.system, detected: allPrograms, timeouts: fastTimeouts }).pipe(Scope.provide(scope))
        yield* dm.ensure("bot_1")
        yield* dm.ensure("bot_2")
        yield* Scope.close(scope, Exit.void)
        expect(os.spawned.every((c) => c.handle.exitCode !== null)).toBe(true)
        expect((yield* Effect.flip(dm.ensure("bot_3"))).message).toContain("shutting down")
      }),
    ))

  test("startup sweeps orphans of a previous run of this node", () =>
    withManager((_dm, os) =>
      Effect.sync(() => {
        expect(os.marked[0]).toEqual({ prefix: `${desktopNodeKey(path.join(t.path, "state"))}/`, signal: "SIGTERM" })
      }),
    ))

  test("invalid bot ids are refused", () =>
    withManager((dm) => Effect.map(Effect.flip(dm.ensure("../etc")), (e) => expect(e.message).toBe("invalid bot id"))))
})

// ================================================================ handlers
const handlerNode = (os: FakeOs, input?: Partial<NodeConfigInput>, detected: DetectedPrograms = allPrograms) =>
  Effect.gen(function* () {
    const brain = makeFakeBrain()
    const config = nodeConfig(input)
    const fakeDesktop = Layer.effect(
      DesktopManager,
      Effect.gen(function* () {
        const leases = yield* LeaseBook
        return DesktopManager.of(yield* makeDesktopManager(yield* NodeConfig, { system: os.system, detected, leases, timeouts: fastTimeouts }))
      }),
    )
    const layer = NodeHandlersFromServices.pipe(
      Layer.provide(BrowserManagerLive),
      Layer.provideMerge(Layer.mergeAll(PathPolicyLive, NodePolicyLive, AuditLogLive, fakeDesktop)),
      Layer.provideMerge(LeaseBookLive),
      Layer.provide(NodeConfigLive(config)),
      Layer.provide(fakeLinks(brain)),
    )
    const ctx = yield* Layer.build(layer)
    const client = yield* RpcTest.makeClient(NodeRpcs).pipe(Effect.provide(ctx))
    return { client, brain, info: Context.get(ctx, NodeInfo) }
  })

/** A fake VNC server: sends the RFB banner, echoes what it gets. */
const fakeVnc = () =>
  Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open: (s) => void s.write("RFB 003.008\n"),
      data: (s, d) => void s.write(d),
    },
  })

const collect = (socket: Socket.Socket) =>
  Effect.gen(function* () {
    const reader = yield* socket.reader
    const writer = yield* socket.writer
    const end = { frames: [] as Array<string | Uint8Array>, closed: false, writer }
    yield* Effect.forkScoped(
      Effect.forever(Effect.flatMap(reader.pull, (fs) => Effect.sync(() => void end.frames.push(...fs)))).pipe(
        Effect.ignore,
        Effect.andThen(Effect.sync(() => void (end.closed = true))),
      ),
    )
    return end
  })

const text = (frames: ReadonlyArray<string | Uint8Array>) => frames.map((f) => (typeof f === "string" ? f : new TextDecoder().decode(f))).join("")

const waitFor = (pred: () => boolean, ms = 3000) =>
  Effect.gen(function* () {
    const end = Date.now() + ms
    while (!pred() && Date.now() < end) yield* Effect.sleep(10)
    return pred()
  })

describe("handlers (fake OS)", () => {
  test("hello: desktop@1 and no missing programs when offered", () =>
    run(
      Effect.gen(function* () {
        const { info, client } = yield* handlerNode(makeFakeOs())
        expect(info.capabilities).toContain("desktop@1")
        const hello = yield* client["node.hello"]({ protocol: { min: 1, max: 1 }, brainVersion: "t", brainSig: "" })
        expect(hello.desktop).toEqual({ missing: [], width: 1920, height: 1200 })
      }),
    ))

  test("hello: no desktop@1 and the missing programs when not offered", () =>
    run(
      Effect.gen(function* () {
        const { info, client } = yield* handlerNode(makeFakeOs(), undefined, detectDesktopPrograms(() => undefined))
        expect(info.capabilities).not.toContain("desktop@1")
        const hello = yield* client["node.hello"]({ protocol: { min: 1, max: 1 }, brainVersion: "t", brainSig: "" })
        expect(hello.desktop?.missing).toEqual(["Xvfb", "x11vnc", "xdotool", "xfwm4 or openbox", "ImageMagick (import)"])
        const e = yield* Effect.flip(client["desktop.ensure"]({ botId: "bot_1" }))
        expect(e._tag).toBe("DesktopUnavailable")
      }),
    ))

  test("policy: computer never → no capability, ensure refused, act PolicyRefused; ask → the brain is asked", () =>
    run(
      Effect.gen(function* () {
        const never = yield* handlerNode(makeFakeOs(), { policy: { actions: { computer: "never" } } })
        expect(never.info.capabilities).not.toContain("desktop@1")
        expect((yield* Effect.flip(never.client["desktop.ensure"]({ botId: "bot_1" }))).message).toContain("policy")
        expect((yield* Effect.flip(never.client["computer.act"]({ inv: inv("bot_1"), action: { action: "screenshot" } })))._tag).toBe("PolicyRefused")

        const ask = yield* handlerNode(makeFakeOs(), { policy: { actions: { computer: "ask" } } })
        const r = yield* ask.client["computer.act"]({ inv: inv("bot_1"), action: { action: "type", text: "hunter2" } })
        expect(r.text).toBe("Typed 7 characters.")
        expect(ask.brain.approvals.map((a) => [a.action, a.target])).toEqual([["computer", "type 7 chars"]])
      }),
    ))

  test("computer.act is refused while the user holds the lease (shared with the browser)", () =>
    run(
      Effect.gen(function* () {
        const os = makeFakeOs()
        const { client } = yield* handlerNode(os)
        const lease = yield* client["lease.set"]({ botId: "bot_1", holder: "user" })
        expect(lease.holder).toBe("user")
        const e = yield* Effect.flip(client["computer.act"]({ inv: inv("bot_1"), action: { action: "screenshot" } }))
        expect(e._tag).toBe("LeaseHeld")
        expect(os.spawned.length).toBe(0)
        yield* client["lease.set"]({ botId: "bot_1", holder: "bot" })
        const r = yield* client["computer.act"]({ inv: inv("bot_1"), action: { action: "screenshot" } })
        expect(r.image?.width).toBe(1280)
        yield* client["desktop.stop"]({ botId: "bot_1" })
        expect(os.running("Xvfb").length).toBe(0)
      }),
    ))

  test("computer.stream: view is bridged to the view-only server; control needs the lease and closes when it is handed back", () =>
    run(
      Effect.gen(function* () {
        const control = fakeVnc()
        const view = fakeVnc()
        yield* Effect.addFinalizer(() => Effect.sync(() => (control.stop(true), view.stop(true))))
        const os = makeFakeOs()
        // x11vnc for control starts first, then the view-only one
        os.ports.push(control.port, view.port)
        const { client, brain } = yield* handlerNode(os)

        yield* client["computer.stream"]({ botId: "bot_1", mode: "view", streamId: "v1", streamToken: "tok" })
        const v = yield* collect(brain.streams.get("v1")!)
        expect(yield* waitFor(() => text(v.frames) === "RFB 003.008\n")).toBe(true)
        yield* v.writer.write(new TextEncoder().encode("hi"))
        expect(yield* waitFor(() => text(v.frames).endsWith("hi"))).toBe(true)
        const viewOnly = os.running("x11vnc").find((c) => c.argv.includes("-viewonly"))!
        expect(viewOnly.argv[viewOnly.argv.indexOf("-rfbport") + 1]).toBe(String(view.port))

        const refused = yield* Effect.flip(client["computer.stream"]({ botId: "bot_1", mode: "control", streamId: "c0", streamToken: "tok" }))
        expect(refused._tag).toBe("LeaseHeld")

        yield* client["lease.set"]({ botId: "bot_1", holder: "user" })
        yield* client["computer.stream"]({ botId: "bot_1", mode: "control", streamId: "c1", streamToken: "tok" })
        const c = yield* collect(brain.streams.get("c1")!)
        expect(yield* waitFor(() => text(c.frames) === "RFB 003.008\n")).toBe(true)
        yield* client["lease.set"]({ botId: "bot_1", holder: "bot" })
        expect(yield* waitFor(() => c.closed)).toBe(true)
        expect(v.closed).toBe(false)

        // the viewer leaves: its stream ends cleanly
        yield* v.writer.write(new Socket.CloseEvent(1000, "bye"))
        expect(yield* waitFor(() => v.closed)).toBe(true)
      }),
    ))
})

describe("DevTools ports", () => {
  test("browsers get a fixed port from the range, never 0 (Google sign-in rejects a random DevTools port)", () => {
    const taken = new Set<number>()
    for (let i = 0; i < 20; i++) {
      const port = freeDebugPort(taken)
      expect(port).toBeGreaterThanOrEqual(DEBUG_PORT_RANGE.from)
      expect(port).toBeLessThanOrEqual(DEBUG_PORT_RANGE.to)
      expect(taken.has(port)).toBe(false)
      taken.add(port)
    }
    const browser = makeNodeConfig({ nodeId: "n", dataDir: "/tmp/ob-ports", detectBinaries: false }).browser
    const args = browserArgs(browser, false)
    const port = Number(args.find((a) => a.startsWith("--remote-debugging-port="))!.split("=")[1])
    expect(port).toBeGreaterThanOrEqual(DEBUG_PORT_RANGE.from)
    expect(browserArgs({ ...browser, debugPort: 9555 }, false))
      .toContain("--remote-debugging-port=9555")
  })
})
