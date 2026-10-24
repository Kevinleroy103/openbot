// Unit tests for the live-view wire helpers (src/computer/protocol.ts). Frames are encoded here the
// same way node-protocol's `encodeScreencastFrame` does: [u32 BE N][N bytes JSON meta][image bytes].
import { describe, expect, test } from "bun:test"
import {
  computerSocketUrl,
  decodeScreencastFrame,
  decodeScreencastNotice,
  decodeTerminalControl,
  encodeTerminalResize,
  modifiersOf,
  terminalSocketUrl,
  toViewportPoint,
} from "../src/computer/protocol.ts"

const encode = (meta: object, image: Uint8Array): ArrayBuffer => {
  const header = new TextEncoder().encode(JSON.stringify(meta))
  const out = new Uint8Array(4 + header.length + image.length)
  new DataView(out.buffer).setUint32(0, header.length, false)
  out.set(header, 4)
  out.set(image, 4 + header.length)
  return out.buffer
}

describe("screencast frames", () => {
  const meta = {
    seq: 3,
    mime: "image/jpeg",
    width: 2560,
    height: 1600,
    viewportWidth: 1280,
    viewportHeight: 800,
    timestamp: 1_700_000_000_000,
  }

  test("decodes meta and image bytes", () => {
    const image = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
    const frame = decodeScreencastFrame(encode(meta, image))
    expect(frame?.meta).toEqual(meta)
    expect([...frame!.image]).toEqual([...image])
  })

  test("rejects truncated and malformed frames", () => {
    expect(decodeScreencastFrame(new ArrayBuffer(2))).toBeUndefined()
    const bad = new Uint8Array(8)
    new DataView(bad.buffer).setUint32(0, 100, false)
    expect(decodeScreencastFrame(bad.buffer)).toBeUndefined()
    expect(decodeScreencastFrame(encode({ seq: "x" }, new Uint8Array(1)))).toBeUndefined()
  })

  test("falls back to the image size when the viewport is missing", () => {
    const frame = decodeScreencastFrame(
      encode({ seq: 1, mime: "image/png", width: 800, height: 500 }, new Uint8Array(0)),
    )
    expect(frame?.meta.viewportWidth).toBe(800)
    expect(frame?.meta.viewportHeight).toBe(500)
  })
})

describe("notices", () => {
  test("decodes the three ScreencastNotice shapes", () => {
    expect(decodeScreencastNotice('{"_tag":"Lease","holder":"user"}')).toEqual({ _tag: "Lease", holder: "user" })
    expect(decodeScreencastNotice('{"_tag":"Url","url":"https://x.dev","title":"X"}')).toEqual({
      _tag: "Url",
      url: "https://x.dev",
      title: "X",
    })
    expect(decodeScreencastNotice('{"_tag":"Ended","reason":"target closed"}')).toEqual({
      _tag: "Ended",
      reason: "target closed",
    })
    expect(decodeScreencastNotice('{"_tag":"Lease","holder":"nobody"}')).toBeUndefined()
    expect(decodeScreencastNotice("not json")).toBeUndefined()
  })
})

describe("input mapping", () => {
  test("scales a click on the fitted frame to page CSS pixels", () => {
    const rect = { left: 100, top: 50, width: 640, height: 400 }
    const vp = { viewportWidth: 1280, viewportHeight: 800 }
    expect(toViewportPoint(100, 50, rect, vp)).toEqual({ x: 0, y: 0 })
    expect(toViewportPoint(420, 250, rect, vp)).toEqual({ x: 640, y: 400 })
    expect(toViewportPoint(740, 450, rect, vp)).toEqual({ x: 1280, y: 800 })
    expect(toViewportPoint(99, 60, rect, vp)).toBeUndefined()
  })

  test("modifiers are omitted when none are held", () => {
    expect(modifiersOf({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBeUndefined()
    expect(modifiersOf({ altKey: false, ctrlKey: true, metaKey: false, shiftKey: true })).toEqual({
      ctrl: true,
      shift: true,
    })
  })
})

describe("terminal + urls", () => {
  test("control frames", () => {
    expect(encodeTerminalResize(120, 40)).toBe('{"resize":{"cols":120,"rows":40}}')
    expect(decodeTerminalControl('{"exit":0,"signal":null}')).toEqual({ exit: 0, signal: null })
    expect(decodeTerminalControl('{"error":"no pty"}')).toEqual({ error: "no pty" })
    expect(decodeTerminalControl("hello")).toBeUndefined()
  })

  test("socket urls", () => {
    expect(computerSocketUrl("bot_1", "control")).toMatch(/\/ws\/computer\/bot_1\?mode=control$/)
    expect(computerSocketUrl("bot_1", "view", "/ws/computer/bot_1")).toMatch(/\/ws\/computer\/bot_1\?mode=view$/)
    expect(terminalSocketUrl("bot_1", 80, 24)).toMatch(/\/ws\/terminal\/bot_1\?cols=80&rows=24$/)
  })
})
