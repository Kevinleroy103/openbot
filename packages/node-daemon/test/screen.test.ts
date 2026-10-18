// A Mac's own screen (screen@1): key names and codes, `computer` plans replayed as helper requests,
// the helper's event logic against a fake CoreGraphics, and MacScreen's sharing rules (permissions,
// the owner at the Mac, one bot at a time, the owner's control) with a fake helper and screenshots.
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { decodeScreencastFrame } from "@openbot/node-protocol"
import {
  type CoreGraphics,
  domCodeToMac,
  type HelperClient,
  inputOps,
  MAC_FLAGS,
  macCombo,
  type MacInfo,
  type MacOp,
  macSteps,
  makeGeometry,
  makeHelperHandler,
  makeLeaseBook,
  makeMacScreen,
  makeNodeConfig,
  planAction,
  type ScreenSystem,
  spawnHelper,
  typingPieces,
  xdoKeySequence,
} from "../src/index.ts"
import { run, tempDir } from "./helpers.ts"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const g = makeGeometry(1440, 900) // a 1440×900-point Mac: the model sees 1280×800

describe("Mac keys", () => {
  test("cmd stays Command on a Mac (Ctrl on X11)", () => {
    expect(xdoKeySequence("cmd+c")).toEqual(["ctrl+c"])
    expect(xdoKeySequence("cmd+c", true)).toEqual(["super+c"])
    expect(xdoKeySequence("ctrl+a Delete", true)).toEqual(["ctrl+a", "Delete"])
  })
  test("combos → key codes with modifier flags", () => {
    expect(macCombo("super+c")).toEqual({ keyCode: 8, flags: MAC_FLAGS.super })
    expect(macCombo("ctrl+shift+t")).toEqual({ keyCode: 17, flags: MAC_FLAGS.ctrl | MAC_FLAGS.shift })
    expect(macCombo("Return")).toEqual({ keyCode: 36, flags: 0 })
    expect(macCombo("F5")).toEqual({ keyCode: 96, flags: 0 })
    expect(macCombo("exclam")).toEqual({ keyCode: 18, flags: MAC_FLAGS.shift })
    expect(macCombo("A")).toEqual({ keyCode: 0, flags: MAC_FLAGS.shift })
    expect(macCombo("super")).toEqual({ keyCode: 55, flags: 0 })
    expect(macCombo("XF86AudioPlay")).toBeUndefined()
    expect(macCombo("bogus+a")).toBeUndefined()
  })
  test("the web viewer's keys (DOM codes)", () => {
    expect(domCodeToMac("KeyA")).toBe(0)
    expect(domCodeToMac("Digit5")).toBe(23)
    expect(domCodeToMac("Enter")).toBe(36)
    expect(domCodeToMac("MetaLeft")).toBe(55)
    expect(domCodeToMac("F12")).toBe(111)
    expect(domCodeToMac("Unidentified")).toBeUndefined()
  })
})

describe("plans on a Mac", () => {
  const steps = (action: Parameters<typeof planAction>[1]) => {
    const plan = planAction(g, action, { mac: true })
    if (typeof plan === "string") throw new Error(plan)
    return macSteps(plan)
  }
  test("clicks move first (API → screen points); double clicks count", () => {
    expect(steps({ action: "left_click", coordinate: [640, 400] })).toEqual({
      steps: [{ op: "move", x: 720, y: 450 }, { op: "click", button: "left", count: 1 }],
      needsPointer: false,
      held: [],
    })
    expect(steps({ action: "double_click", coordinate: [0, 0] })).toMatchObject({ steps: [{ op: "move" }, { op: "click", count: 2 }] })
    expect(steps({ action: "right_click" })).toMatchObject({ steps: [{ op: "click", button: "right" }], needsPointer: true })
  })
  test("scroll, drag, type, keys", () => {
    expect(steps({ action: "scroll", coordinate: [10, 10], scroll_direction: "down", scroll_amount: 3 }).valueOf()).toMatchObject({
      steps: [{ op: "move" }, { op: "scroll", dx: 0, dy: -3, unit: "line" }],
    })
    expect(steps({ action: "left_click_drag", start_coordinate: [0, 0], coordinate: [100, 100] })).toMatchObject({
      steps: [{ op: "move" }, { op: "button", down: true }, { op: "sleep" }, { op: "move" }, { op: "sleep" }, { op: "button", down: false }],
    })
    expect(steps({ action: "type", text: "hello" })).toMatchObject({ steps: [{ op: "type", text: "hello" }] })
    expect(steps({ action: "key", text: "cmd+a Delete" })).toMatchObject({
      steps: [{ op: "key", keyCode: 0, flags: MAC_FLAGS.super }, { op: "key", keyCode: 117, flags: 0 }],
    })
  })
  test("held modifiers wrap the steps and are released", () => {
    expect(steps({ action: "left_click", coordinate: [10, 10], text: "shift" })).toEqual({
      steps: [
        { op: "keyEvent", keyCode: 56, down: true },
        { op: "hold", flags: MAC_FLAGS.shift },
        { op: "move", x: 11, y: 11 },
        { op: "click", button: "left", count: 1 },
        { op: "hold", flags: 0 },
        { op: "keyEvent", keyCode: 56, down: false },
      ],
      needsPointer: false,
      held: [56],
    })
  })
  test("a key a Mac does not have is an error for the model", () => {
    const plan = planAction(g, { action: "key", text: "XF86AudioPlay" }, { mac: true })
    expect(typeof plan === "string" ? plan : macSteps(plan)).toBe("the key XF86AudioPlay does not exist on a Mac")
  })
})

describe("the helper", () => {
  const fakeCg = () => {
    const events: Array<string> = []
    let idle = 50
    const cg: CoreGraphics = {
      mouse: (type, x, y, button, clicks, flags) => void events.push(`mouse ${type} ${x},${y} b${button} c${clicks} f${flags}`),
      key: (code, down, flags) => void events.push(`key ${code} ${down ? "down" : "up"} f${flags}`),
      unicode: (text, down) => void events.push(`text ${JSON.stringify(text)} ${down ? "down" : "up"}`),
      scroll: (unit, dy, dx) => void events.push(`scroll u${unit} ${dy},${dx}`),
      secondsSinceInput: () => idle,
      displaySize: () => ({ width: 1440, height: 900 }),
      screenRecordingAllowed: () => true,
      requestScreenRecording: () => true,
      accessibilityAllowed: () => false,
    }
    return { cg, events, setIdle: (s: number) => void (idle = s) }
  }
  test("moves, clicks with click counts, drags, scrolls, releases what is held", async () => {
    const { cg, events } = fakeCg()
    const handle = makeHelperHandler(cg, { now: () => 0, sleep: async () => undefined })
    expect(await handle({ op: "info" })).toEqual({ width: 1440, height: 900, screenRecording: true, accessibility: false })
    await handle({ op: "move", x: 10, y: 20 })
    await handle({ op: "click", button: "left", count: 2 })
    await handle({ op: "button", button: "left", down: true })
    await handle({ op: "move", x: 30, y: 40 })
    await handle({ op: "scroll", dx: 0, dy: -3, unit: "line" })
    await handle({ op: "keyEvent", keyCode: 56, down: true })
    await handle({ op: "release" })
    expect(events).toEqual([
      "mouse 5 10,20 b0 c0 f0",
      "mouse 1 10,20 b0 c1 f0",
      "mouse 2 10,20 b0 c1 f0",
      "mouse 1 10,20 b0 c2 f0",
      "mouse 2 10,20 b0 c2 f0",
      "mouse 1 10,20 b0 c1 f0",
      // the left button is down: a drag
      "mouse 6 30,40 b0 c0 f0",
      "scroll u1 -3,0",
      "key 56 down f0",
      "mouse 2 30,40 b0 c1 f0",
      "key 56 up f0",
    ])
  })
  test("typing: text in 20-unit pieces, Return and Tab as keys", async () => {
    expect(typingPieces("a".repeat(25))).toEqual([{ text: "a".repeat(20) }, { text: "aaaaa" }])
    expect(typingPieces("hi\r\nthere\tok")).toEqual([{ text: "hi" }, { keyCode: 36 }, { text: "there" }, { keyCode: 48 }, { text: "ok" }])
    const { cg, events } = fakeCg()
    const handle = makeHelperHandler(cg, { now: () => 0, sleep: async () => undefined })
    await handle({ op: "type", text: "é\n" })
    expect(events).toEqual(['text "é" down', 'text "é" up', "key 36 down f0", "key 36 up f0"])
  })
  test("idle: seconds since any input and since its own last event", async () => {
    const { cg, setIdle } = fakeCg()
    let t = 10_000
    const handle = makeHelperHandler(cg, { now: () => t, sleep: async () => undefined })
    await handle({ op: "move", x: 1, y: 1 })
    t += 30_000
    setIdle(5)
    expect(await handle({ op: "idle" })).toEqual({ idle: 5, sincePost: 30 })
  })
})

describe("MacScreen", () => {
  const darwin = (enabled = true) => ({
    ...makeNodeConfig({ nodeId: "mac", dataDir: "/tmp/ob-mac", detectBinaries: false }),
    platform: "darwin",
    screen: { enabled },
  })
  const fakeHelper = (info: MacInfo, idle = { idle: 600, sincePost: 600 }) => {
    const ops: Array<MacOp> = []
    const client: HelperClient & { info: MacInfo; idle: { idle: number; sincePost: number } } = {
      info,
      idle,
      call: async (op) => {
        ops.push(op)
        if (op.op === "info") return client.info
        if (op.op === "idle") return client.idle
        return null
      },
      close: () => undefined,
    }
    return { client, ops, acted: () => ops.filter((o) => o.op !== "info" && o.op !== "idle" && o.op !== "release") }
  }
  const fakeSystem = () => {
    const runs: Array<ReadonlyArray<string>> = []
    const system: ScreenSystem = {
      exec: async (argv) => {
        runs.push(argv)
        if (argv[0] === "/usr/bin/osascript" && argv.some((a) => a.includes("mouseLocation"))) return { code: 0, stdout: '{"x":720,"y":450}', stderr: "" }
        return { code: 0, stdout: "", stderr: "" }
      },
      readFile: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      exists: () => true,
      remove: () => undefined,
      tmpdir: "/tmp",
    }
    return { system, runs }
  }
  const allowed: MacInfo = { width: 1440, height: 900, screenRecording: true, accessibility: true }

  test("only on macOS (and when enabled)", () =>
    run(
      Effect.gen(function* () {
        const linux = yield* makeMacScreen({ config: makeNodeConfig({ nodeId: "x", dataDir: "/tmp/ob-x", detectBinaries: false }), helper: fakeHelper(allowed).client })
        expect(linux.offered).toBe(false)
        const off = yield* makeMacScreen({ config: darwin(false), helper: fakeHelper(allowed).client })
        expect(off.offered).toBe(false)
        const on = yield* makeMacScreen({ config: darwin(), helper: fakeHelper(allowed).client, system: fakeSystem().system })
        expect(on.offered).toBe(true)
        expect(on.support).toEqual({ missing: [], width: 1440, height: 900 })
      }),
    ))

  test("an action: posted through the helper, then a screenshot in the model's space", () =>
    run(
      Effect.gen(function* () {
        const helper = fakeHelper(allowed)
        const sys = fakeSystem()
        const screen = yield* makeMacScreen({ config: darwin(), helper: helper.client, system: sys.system })
        const result = yield* screen.act("bot_a", { action: "left_click", coordinate: [640, 400] })
        expect(result.text).toBe("Clicked at (640, 400).")
        expect(result.image).toMatchObject({ mimeType: "image/jpeg", width: 1280, height: 800 })
        expect(helper.acted()).toEqual([{ op: "move", x: 720, y: 450 }, { op: "click", button: "left", count: 1 }])
        expect(sys.runs[0]!.slice(0, 5)).toEqual(["/usr/sbin/screencapture", "-x", "-t", "jpg", "-m"])
        expect(sys.runs[1]).toContain("-z")
        expect(sys.runs[1]!.slice(sys.runs[1]!.indexOf("-z") + 1, sys.runs[1]!.indexOf("-z") + 3)).toEqual(["800", "1280"])
        // a click at the mouse position starts from the real pointer
        yield* screen.act("bot_a", { action: "right_click" })
        expect(helper.acted().slice(-2)).toEqual([{ op: "move", x: 720, y: 450 }, { op: "click", button: "right", count: 1 }])
        expect((yield* screen.act("bot_a", { action: "cursor_position" })).text).toBe("X=640, Y=400")
        expect((yield* screen.act("bot_a", { action: "key", text: "XF86AudioPlay" })).text).toBe("ERROR: the key XF86AudioPlay does not exist on a Mac")
      }),
    ))

  test("missing permissions: macOS is asked at once and again every 30 s; uses are refused with what to allow", () =>
    run(
      Effect.gen(function* () {
        const helper = fakeHelper({ ...allowed, screenRecording: false, accessibility: false })
        const sys = fakeSystem()
        let now = 1_000_000
        const screen = yield* makeMacScreen({ config: darwin(), helper: helper.client, system: sys.system, now: () => now })
        expect(screen.support?.missing).toEqual(["Screen Recording", "Accessibility"])
        const asks = () => ({
          screenRecording: helper.ops.filter((o) => o.op === "requestScreenRecording").length,
          accessibility: sys.runs.filter((r) => r.some((a) => a.includes("AXIsProcessTrustedWithOptions"))).length,
        })
        // the node's start asked already (the owner is at the Mac)
        yield* Effect.sleep("20 millis")
        expect(asks()).toEqual({ screenRecording: 1, accessibility: 1 })
        const first = yield* Effect.flip(screen.ensure("bot_a"))
        expect(first).toMatchObject({ _tag: "DesktopUnavailable", missing: ["Screen Recording", "Accessibility"] })
        expect(first.message).toContain("System Settings › Privacy & Security")
        yield* Effect.flip(screen.act("bot_a", { action: "screenshot" }))
        expect(asks()).toEqual({ screenRecording: 1, accessibility: 1 })
        now += 31_000
        yield* Effect.flip(screen.ensure("bot_a"))
        expect(asks()).toEqual({ screenRecording: 2, accessibility: 2 })
        // allowed meanwhile: it works
        helper.client.info = allowed
        expect(yield* screen.ensure("bot_a")).toEqual({ width: 1440, height: 900 })
      }),
    ))

  test("shared: not while the owner uses the Mac or controls it, and one bot at a time", () =>
    run(
      Effect.gen(function* () {
        const helper = fakeHelper(allowed)
        const leases = makeLeaseBook()
        let now = 1_000_000
        const screen = yield* makeMacScreen({ config: darwin(), helper: helper.client, system: fakeSystem().system, leases, now: () => now })
        // someone typed 3 s ago, after the helper's last event (100 s ago)
        helper.client.idle = { idle: 3, sincePost: 100 }
        const owner = yield* Effect.flip(screen.act("bot_a", { action: "screenshot" }))
        expect(owner).toMatchObject({ _tag: "LeaseHeld" })
        expect((owner as { reason: string }).reason).toContain("The owner is using this computer")
        // input that was the helper's own does not count
        helper.client.idle = { idle: 3, sincePost: 3 }
        yield* screen.act("bot_a", { action: "screenshot" })
        // another bot waits while bot_a used it in the last minute
        const other = yield* Effect.flip(screen.act("bot_b", { action: "screenshot" }))
        expect((other as { reason: string }).reason).toContain("Another Bot")
        now += 61_000
        yield* screen.act("bot_b", { action: "screenshot" })
        // the owner took control (of any bot's view): every bot waits
        leases.set("bot_b", "user")
        expect(((yield* Effect.flip(screen.act("bot_a", { action: "screenshot" }))) as { reason: string }).reason).toContain("controlling this screen")
        leases.set("bot_b", "bot")
        expect(helper.ops.filter((o) => o.op === "release").length).toBeGreaterThanOrEqual(2)
      }),
    ))

  test("the owner's input needs the lease; mouse and keys become helper requests", () =>
    run(
      Effect.gen(function* () {
        const helper = fakeHelper(allowed)
        const leases = makeLeaseBook()
        const screen = yield* makeMacScreen({ config: darwin(), helper: helper.client, system: fakeSystem().system, leases })
        const click = { _tag: "mouse", type: "down", x: 640, y: 400, button: "left", clickCount: 1 } as const
        expect(yield* Effect.flip(screen.input("bot_a", click))).toMatchObject({ _tag: "LeaseHeld" })
        leases.set("bot_a", "user")
        yield* screen.input("bot_a", click)
        yield* screen.input("bot_a", { _tag: "key", type: "down", key: "c", code: "KeyC", modifiers: { meta: true } })
        expect(helper.acted()).toEqual([
          { op: "move", x: 720, y: 450, flags: 0 },
          { op: "button", button: "left", down: true, clicks: 1, flags: 0 },
          { op: "keyEvent", keyCode: 8, down: true, flags: MAC_FLAGS.super },
        ])
        expect(inputOps(g, { _tag: "mouse", type: "wheel", x: 0, y: 0, deltaY: 120 })).toEqual([
          { op: "move", x: 0, y: 0, flags: 0 },
          { op: "scroll", dx: -0, dy: -120, unit: "pixel", flags: 0 },
        ])
      }),
    ))

  test("the live view: screenshot frames until the viewer goes", () =>
    run(
      Effect.gen(function* () {
        const screen = yield* makeMacScreen({ config: darwin(), helper: fakeHelper(allowed).client, system: fakeSystem().system })
        const written: Array<Uint8Array | string> = []
        let open = true
        const io = {
          pull: Effect.suspend(() => (open ? Effect.sleep("20 millis").pipe(Effect.as([] as Array<Uint8Array>)) : Effect.fail(new Error("closed") as never))),
          writer: { write: (chunk: unknown) => Effect.sync(() => void written.push(chunk as Uint8Array)) },
        }
        const fiber = yield* Effect.forkChild(screen.stream({ botId: "bot_a", io: io as never }) as Effect.Effect<void>)
        yield* Effect.sleep("150 millis")
        open = false
        const exit = yield* Effect.exit(Fiber.join(fiber).pipe(Effect.timeout("3 seconds")))
        expect(Exit.isSuccess(exit)).toBe(true)
        const frame = decodeScreencastFrame(written[0] as Uint8Array)
        expect(frame?.meta).toMatchObject({ mime: "image/jpeg", width: 1280, height: 800, viewportWidth: 1280, viewportHeight: 800 })
      }),
    ))
})

describe("the helper process", () => {
  test("a closed helper exiting never fails the requests sent to its successor", async () => {
    const dir = tempDir()
    try {
      // answers every request (with its pid), exits when stdin closes, like the real helper
      const fake = join(dir.path, "fake-helper.ts")
      writeFileSync(
        fake,
        `let buf = ""
for await (const c of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(c)
  let nl
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const req = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1)
    if (req.op === "idle") await Bun.sleep(300)
    process.stdout.write(JSON.stringify({ id: req.id, ok: true, value: { pid: process.pid, op: req.op } }) + "\\n")
  }
}
`,
      )
      const helper = spawnHelper([process.execPath, fake], 5_000)
      const first = (await helper.call({ op: "info" })) as { pid: number }
      helper.close()
      // the next request starts a new helper; the old one exits meanwhile
      const second = (await helper.call({ op: "idle" })) as { pid: number; op: string }
      expect(second.op).toBe("idle")
      expect(second.pid).not.toBe(first.pid)
      helper.close()
    } finally {
      dir.cleanup()
    }
  }, 20_000)
})
