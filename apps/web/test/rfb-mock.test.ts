// The dev mock's fake RFB server (dev/mock/rfb.ts) speaks enough RFB 3.8 for noVNC: handshake,
// RRE framebuffer updates, view-only vs control input.
import { describe, expect, test } from "bun:test"
import { desktopScene, RfbSession } from "../dev/mock/rfb.ts"

const W = 1920
const H = 1200
const session = (control: boolean, inputs: string[] = []) =>
  new RfbSession({
    width: W,
    height: H,
    name: "Scout's computer",
    scene: desktopScene({ width: W, height: H, accent: 0x3b82f6, page: "signin" }),
    control,
    onInput: (e) => inputs.push(e.kind),
  })

const u16 = (v: number) => [v >> 8, v & 255]
const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
const handshake = (s: RfbSession) => {
  const version = s.receive(new TextEncoder().encode("RFB 003.008\n"))
  const security = s.receive(Uint8Array.of(1))
  const init = s.receive(Uint8Array.of(1))
  return { version, security, init }
}
// noVNC's pixel format: 32 bpp, depth 24, little endian, true colour, red shift 0, green 8, blue 16
const setPixelFormat = Uint8Array.of(0, 0, 0, 0, 32, 24, 0, 1, ...u16(255), ...u16(255), ...u16(255), 0, 8, 16, 0, 0, 0)
const setEncodings = (encs: number[]) => Uint8Array.of(2, 0, ...u16(encs.length), ...encs.flatMap(u32))
const updateRequest = (incremental: boolean, x = 0, y = 0, w = W, h = H) => Uint8Array.of(3, incremental ? 1 : 0, ...u16(x), ...u16(y), ...u16(w), ...u16(h))

describe("fake RFB desktop", () => {
  test("handshake: version, None security, ServerInit with the desktop size and name", () => {
    const s = session(false)
    expect(new TextDecoder().decode(s.greeting())).toBe("RFB 003.008\n")
    const { version, security, init } = handshake(s)
    expect([...version[0]!]).toEqual([1, 1])
    expect([...security[0]!]).toEqual([0, 0, 0, 0])
    const si = new DataView(init[0]!.buffer)
    expect(si.getUint16(0)).toBe(W)
    expect(si.getUint16(2)).toBe(H)
    expect(init[0]![4]).toBe(32) // bpp
    const nameLen = si.getUint32(20)
    expect(new TextDecoder().decode(init[0]!.subarray(24, 24 + nameLen))).toBe("Scout's computer")
  })

  test("a full update request gets one RRE rectangle covering the screen; incremental ones wait for changes", () => {
    const s = session(false)
    handshake(s)
    s.receive(setPixelFormat)
    s.receive(setEncodings([7, 16, 5, 2, 0, -223]))
    const [update] = s.receive(updateRequest(false))
    const v = new DataView(update!.buffer)
    expect(update![0]).toBe(0) // FramebufferUpdate
    expect(v.getUint16(2)).toBe(1) // one rectangle
    expect([v.getUint16(4), v.getUint16(6), v.getUint16(8), v.getUint16(10)]).toEqual([0, 0, W, H])
    expect(v.getInt32(12)).toBe(2) // RRE
    expect(v.getUint32(16)).toBeGreaterThan(50) // subrectangles
    expect(update!.byteLength).toBeLessThan(64 * 1024)
    expect(s.receive(updateRequest(true))).toEqual([])
  })

  test("messages split across frames are reassembled", () => {
    const s = session(false)
    handshake(s)
    s.receive(setEncodings([2]))
    const req = updateRequest(false)
    expect(s.receive(req.subarray(0, 4))).toEqual([])
    expect(s.receive(req.subarray(4))).toHaveLength(1)
  })

  test("view-only sessions ignore input; control sessions draw it", () => {
    const watched: string[] = []
    const view = session(false, watched)
    handshake(view)
    view.receive(setEncodings([2]))
    view.receive(updateRequest(false))
    expect(view.receive(Uint8Array.of(5, 1, ...u16(960), ...u16(600)))).toEqual([])
    expect(watched).toEqual([])

    const inputs: string[] = []
    const control = session(true, inputs)
    handshake(control)
    control.receive(setEncodings([2]))
    control.receive(updateRequest(false))
    control.receive(updateRequest(true))
    // a click leaves a marker: the pending incremental request is answered with that region
    const [click] = control.receive(Uint8Array.of(5, 1, ...u16(960), ...u16(600)))
    expect(click).toBeDefined()
    expect(new DataView(click!.buffer).getUint16(2)).toBe(1)
    control.receive(Uint8Array.of(5, 0, ...u16(960), ...u16(600)))
    // typing fills the focused field
    control.receive(updateRequest(true))
    const [typed] = control.receive(Uint8Array.of(4, 1, 0, 0, ...u32(0x61)))
    expect(typed).toBeDefined()
    expect(inputs).toEqual(["pointer", "pointer", "key"])
    expect(control.stats).toMatchObject({ pointer: 2, keys: 1 })
  })

  test("an unknown message closes the session", () => {
    const s = session(false)
    handshake(s)
    s.receive(Uint8Array.of(200, 0, 0, 0))
    expect(s.closed).toBe(true)
  })
})
