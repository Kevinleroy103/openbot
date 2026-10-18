// Pure logic of the full-desktop live view (D1.7): close verdicts, the viewer's state machine,
// geometry, phone-keyboard keysyms, setup hints, availability and the screen notices.
import { describe, expect, test } from "bun:test"
import type { ComputerStatus, NodeId, RuntimeRequest } from "@openbot/contracts"
import {
  backoffMs,
  classifyClose,
  containFit,
  type DesktopConn,
  desktopAspect,
  type DesktopEvent,
  desktopInstallHints,
  desktopReducer,
  describeMissing,
  initialDesktopConn,
  keysymOf,
  keysymsOf,
  missingSentence,
  nodeDesktopState,
  nodeScreenState,
  pendingHandoffOf,
} from "../src/computer/desktop.ts"
import { screenNotice } from "../src/computer/notice.ts"
import { computerSocketUrl } from "../src/computer/protocol.ts"
import { availabilityOf } from "../src/computer/useComputer.ts"

const close = (code: number, extra: Partial<{ reason: string; mode: "view" | "control"; opened: boolean; connected: boolean }> = {}): DesktopEvent => ({
  type: "closed",
  close: { code, reason: extra.reason ?? "", mode: extra.mode ?? "view", opened: extra.opened ?? true, connected: extra.connected ?? false },
})
const run = (events: ReadonlyArray<DesktopEvent>, from: DesktopConn = initialDesktopConn): DesktopConn => events.reduce(desktopReducer, from)

describe("close verdicts (brain DesktopCloseCodes)", () => {
  test("1000 on a control socket = control released: watch again", () => {
    expect(classifyClose({ code: 1000, reason: "control released", mode: "control", opened: true, connected: true })).toBe("lease-lost")
  })
  test("4403 take control first: watch again (control), retry (view)", () => {
    expect(classifyClose({ code: 4403, reason: "", mode: "control", opened: true, connected: false })).toBe("lease-lost")
    expect(classifyClose({ code: 4403, reason: "", mode: "view", opened: true, connected: false })).toBe("retry")
  })
  test("1012 screen reset: asleep, in both modes", () => {
    expect(classifyClose({ code: 1012, reason: "screen reset", mode: "view", opened: true, connected: true })).toBe("asleep")
    expect(classifyClose({ code: 1012, reason: "screen reset", mode: "control", opened: true, connected: true })).toBe("asleep")
  })
  test("1011, 1006 (never opened: 404 / 409 / 503) and a 1000 on a view socket: retry", () => {
    expect(classifyClose({ code: 1011, reason: "The screen stream ended", mode: "view", opened: true, connected: true })).toBe("retry")
    expect(classifyClose({ code: 1006, reason: "", mode: "view", opened: false, connected: false })).toBe("retry")
    expect(classifyClose({ code: 1000, reason: "", mode: "view", opened: true, connected: true })).toBe("retry")
  })
  test("backoff doubles from 0.5 s and caps at 10 s", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(backoffMs)).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000])
  })
})

describe("viewer state machine", () => {
  test("connecting → live", () => {
    expect(run([{ type: "enable" }]).phase).toBe("connecting")
    expect(run([{ type: "attempt" }, { type: "connected" }])).toEqual({ phase: "live", failures: 0, message: undefined })
  })
  test("a live connection that drops reconnects; the reason is kept", () => {
    const s = run([{ type: "attempt" }, { type: "connected" }, close(1011, { reason: "The screen stream ended", connected: true })])
    expect(s).toEqual({ phase: "reconnecting", failures: 1, message: "The screen stream ended" })
    expect(run([{ type: "attempt" }, { type: "connected" }], s).phase).toBe("live")
  })
  test("repeated failures before any picture: Can't reach (still retrying)", () => {
    const one = run([{ type: "attempt" }, close(1006, { opened: false })])
    expect(one.phase).toBe("connecting")
    const two = run([{ type: "attempt" }, close(1006, { opened: false })], one)
    expect(two).toEqual({ phase: "unreachable", failures: 2, message: undefined })
  })
  test("control released → connecting again (in view mode)", () => {
    const s = run([{ type: "attempt" }, { type: "connected" }, close(1000, { mode: "control", connected: true, reason: "control released" })])
    expect(s).toEqual({ phase: "connecting", failures: 0, message: undefined })
  })
  test("reset → asleep until enabled again", () => {
    const s = run([{ type: "attempt" }, { type: "connected" }, close(1012, { connected: true, reason: "screen reset" })])
    expect(s.phase).toBe("asleep")
    expect(run([{ type: "disable" }], s).phase).toBe("idle")
    expect(run([{ type: "enable" }], s).phase).toBe("connecting")
  })
  test("a mode switch from live starts a fresh attempt; closes while idle are ignored", () => {
    expect(run([{ type: "attempt" }, { type: "connected" }, { type: "attempt" }]).phase).toBe("connecting")
    expect(run([close(1011)]).phase).toBe("idle")
  })
  test("noVNC failing to load counts as a failure", () => {
    expect(run([{ type: "attempt" }, { type: "load-failed", message: "boom" }])).toEqual({ phase: "unreachable", failures: 1, message: "boom" })
  })
})

describe("geometry", () => {
  test("aspect from computer.status, 16:10 by default", () => {
    expect(desktopAspect({ width: 1920, height: 1200 })).toBe(1.6)
    expect(desktopAspect({ width: 1280, height: 720 })).toBeCloseTo(16 / 9)
    expect(desktopAspect(undefined)).toBe(1.6)
    expect(desktopAspect({ width: 0, height: 1200 })).toBe(1.6)
  })
  test("contain-fit letterboxes", () => {
    expect(containFit(1440, 800, 1.6)).toEqual({ width: 1280, height: 800 }) // pillarbox
    expect(containFit(377, 700, 1.6)).toEqual({ width: 377, height: 235 }) // phone portrait: letterbox
    expect(containFit(0, 700, 1.6)).toEqual({ width: 0, height: 0 })
  })
})

describe("phone keyboard keysyms", () => {
  test("Latin-1 maps to itself, other code points to Unicode keysyms", () => {
    expect(keysymOf("a")).toBe(0x61)
    expect(keysymOf("A")).toBe(0x41)
    expect(keysymOf(" ")).toBe(0x20)
    expect(keysymOf("é")).toBe(0xe9)
    expect(keysymOf("€")).toBe(0x01000000 + 0x20ac)
    expect(keysymOf("😀")).toBe(0x01000000 + 0x1f600)
  })
  test("newline and tab are keys; other control characters are dropped", () => {
    expect(keysymOf("\n")).toBe(0xff0d)
    expect(keysymOf("\t")).toBe(0xff09)
    expect(keysymOf("\u0007")).toBeUndefined()
    expect(keysymsOf("hi\u0000!\n")).toEqual([0x68, 0x69, 0x21, 0xff0d])
  })
})

describe("desktop setup hints", () => {
  test("Arch and Debian commands on Linux", () => {
    expect(desktopInstallHints("linux")).toEqual([
      { label: "Arch", command: "sudo pacman -S --needed xorg-server-xvfb x11vnc xdotool xfwm4 plank xfce4-terminal thunar mousepad" },
      { label: "Debian / Ubuntu", command: "sudo apt install xvfb x11vnc xdotool xfwm4 plank xfce4-terminal thunar mousepad imagemagick" },
    ])
  })
  test("ImageMagick joins the Arch line when it is what's missing; no hints off Linux", () => {
    expect(desktopInstallHints("linux", ["import"])[0]!.command.endsWith(" imagemagick")).toBe(true)
    expect(desktopInstallHints("darwin", ["Xvfb"])).toEqual([])
    expect(desktopInstallHints(undefined)).toHaveLength(2)
  })
  test("what's missing, in install order", () => {
    expect(describeMissing(["xdotool", "Xvfb", "x11vnc"])).toBe("Xvfb, x11vnc and xdotool")
    expect(describeMissing(["x11vnc"])).toBe("x11vnc")
    expect(describeMissing(["import", "magick"])).toBe("ImageMagick")
    expect(missingSentence(["x11vnc", "Xvfb"], "vps-1")).toBe("Full desktop needs Xvfb and x11vnc on vps-1.")
    expect(missingSentence([], "vps-1")).toBe("Full desktop isn't set up on vps-1.")
  })
  test("node desktop state from capabilities", () => {
    expect(nodeDesktopState({ capabilities: ["fs@1", "desktop@1"], declaredCapabilities: ["fs@1", "desktop@1"] })).toBe("on")
    expect(nodeDesktopState({ capabilities: ["fs@1"], declaredCapabilities: ["fs@1", "desktop@1"] })).toBe("unapproved")
    expect(nodeDesktopState({ capabilities: ["fs@1"], declaredCapabilities: ["fs@1"] })).toBe("off")
  })
  test("a Mac's own screen from capabilities", () => {
    expect(nodeScreenState({ capabilities: ["fs@1", "screen@1"], declaredCapabilities: ["fs@1", "screen@1"] })).toBe("on")
    expect(nodeScreenState({ capabilities: ["fs@1"], declaredCapabilities: ["fs@1", "screen@1"] })).toBe("unapproved")
    expect(nodeScreenState({ capabilities: ["fs@1", "desktop@1"], declaredCapabilities: ["fs@1", "desktop@1"] })).toBe("off")
  })
})

const status = (patch: Partial<ComputerStatus>): ComputerStatus => ({ botId: "bot_a" as ComputerStatus["botId"], nodeId: "node_local" as NodeId, state: "ready", surface: "desktop", controller: "bot", ...patch })

describe("availability", () => {
  test("desktop and browser surfaces stream when ready or starting", () => {
    expect(availabilityOf(status({}), undefined)).toEqual({ kind: "stream", surface: "desktop" })
    expect(availabilityOf(status({ state: "starting", surface: "browser" }), undefined)).toEqual({ kind: "stream", surface: "browser" })
  })
  test("asleep, failed, unsupported (with what's missing), loading", () => {
    expect(availabilityOf(status({ state: "absent" }), undefined)).toEqual({ kind: "absent", surface: "desktop" })
    expect(availabilityOf(status({ state: "error", message: "Xvfb crashed" }), undefined)).toEqual({ kind: "unreachable", message: "Xvfb crashed", surface: "desktop" })
    expect(availabilityOf(status({ state: "unsupported", surface: "none", missing: ["x11vnc"] }), undefined)).toEqual({ kind: "unsupported", message: "This computer has no screen to show", missing: ["x11vnc"] })
    expect(availabilityOf(undefined, undefined)).toEqual({ kind: "loading" })
    expect(availabilityOf(undefined, "Can't reach OpenBot.")).toEqual({ kind: "unreachable", message: "Can't reach OpenBot." })
  })
  test("a Mac's screen is always there: watching it checks it; a missing permission comes along", () => {
    expect(availabilityOf(status({ state: "absent", surface: "screen" }), undefined)).toEqual({ kind: "stream", surface: "screen" })
    expect(availabilityOf(status({ state: "error", surface: "screen", message: "Allow Accessibility…", missing: ["Accessibility"] }), undefined)).toEqual({
      kind: "unreachable",
      message: "Allow Accessibility…",
      surface: "screen",
      missing: ["Accessibility"],
    })
  })
})

describe("screen notices", () => {
  const name = "Scout"
  const stream = { kind: "stream", surface: "desktop" } as const
  test("live: nothing to say", () => {
    expect(screenNotice({ name, availability: stream, phase: "live" })).toBeUndefined()
  })
  test("connecting, waking, reconnecting", () => {
    expect(screenNotice({ name, availability: stream, phase: "connecting" })).toMatchObject({ icon: "spinner", title: "Connecting to Scout's computer…", busy: true })
    expect(screenNotice({ name, availability: stream, phase: "connecting", starting: true })?.title).toBe("Waking up…")
    expect(screenNotice({ name, availability: stream, phase: "reconnecting", message: "The screen stream ended" })).toMatchObject({ title: "Reconnecting…", body: "The screen stream ended" })
  })
  test("the brain's \"Can't reach the screen:\" prefix is not repeated under the title", () => {
    expect(screenNotice({ name, availability: stream, phase: "unreachable", message: "Can't reach the screen: node offline" })?.body).toBe("Node offline")
  })
  test("can't reach: retry", () => {
    expect(screenNotice({ name, availability: stream, phase: "unreachable" })).toMatchObject({ icon: "unplug", title: "Can't reach Scout's screen", body: "Retrying…", action: "retry" })
    expect(screenNotice({ name, availability: { kind: "unreachable", message: "node offline", surface: "desktop" }, phase: "idle" })).toMatchObject({ title: "Can't reach Scout's screen", body: "Node offline", action: "wake" })
  })
  test("asleep desktops wake; absent browsers open", () => {
    expect(screenNotice({ name, availability: { kind: "absent", surface: "desktop" }, phase: "idle" })).toMatchObject({ icon: "asleep", title: "Scout's computer is asleep", body: "It wakes up when Scout needs it.", action: "wake" })
    expect(screenNotice({ name, availability: stream, phase: "asleep" })).toMatchObject({ icon: "asleep", action: "wake" })
    expect(screenNotice({ name, availability: { kind: "absent", surface: "browser" }, phase: "idle" })).toMatchObject({ action: "open-browser" })
  })
  test("a Mac that still needs permissions says what to allow", () => {
    const message = "Allow Screen Recording for openbot-node on the Mac (System Settings › Privacy & Security), then try again."
    expect(screenNotice({ name, availability: { kind: "unreachable", message, surface: "screen", missing: ["Screen Recording"] }, phase: "idle" })).toEqual({
      icon: "off",
      title: "Scout can't use the Mac's screen yet",
      body: message,
      action: "retry",
    })
  })
  test("unsupported: how to set it up only when the node said what it lacks", () => {
    expect(screenNotice({ name, availability: { kind: "unsupported", message: "No screen", missing: ["x11vnc"] }, phase: "idle" })).toMatchObject({ title: "No screen to show", action: "setup" })
    expect(screenNotice({ name, availability: { kind: "unsupported", message: "No screen" }, phase: "idle" })?.action).toBeUndefined()
  })
})

describe("socket URL and hand-offs", () => {
  test("view / control sockets on the page origin (viewPath from computer.status wins)", () => {
    expect(computerSocketUrl("bot_a", "view")).toBe("ws://127.0.0.1:7420/ws/computer/bot_a?mode=view")
    expect(computerSocketUrl("bot a", "control")).toBe("ws://127.0.0.1:7420/ws/computer/bot%20a?mode=control")
    expect(computerSocketUrl("bot_a", "control", "/ws/computer/bot_a")).toBe("ws://127.0.0.1:7420/ws/computer/bot_a?mode=control")
    // the side preview: it does not keep the screen awake
    expect(computerSocketUrl("bot_a", "view", undefined, true)).toBe("ws://127.0.0.1:7420/ws/computer/bot_a?mode=view&passive=1")
  })
  test("the bot's pending hand-off", () => {
    const req = (patch: Partial<RuntimeRequest>) => ({ id: "req_1", botId: "bot_a", kind: "handoff", status: "pending", ...patch }) as RuntimeRequest
    expect(pendingHandoffOf([req({ kind: "question" }), req({ id: "req_2" as RuntimeRequest["id"] })], "bot_a")?.id).toBe("req_2" as RuntimeRequest["id"])
    expect(pendingHandoffOf([req({ status: "resolved" })], "bot_a")).toBeUndefined()
    expect(pendingHandoffOf([req({ botId: "bot_b" as RuntimeRequest["botId"] })], "bot_a")).toBeUndefined()
    expect(pendingHandoffOf(undefined, "bot_a")).toBeUndefined()
  })
})
