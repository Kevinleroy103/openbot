import { describe, expect, test } from "bun:test"
import * as Schema from "effect/Schema"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  base64Decode,
  base64Encode,
  base64UrlDecode,
  base64UrlEncode,
  BrowserAction,
  BrowserInputEvent,
  BrainRpcs,
  Capabilities,
  CliControl,
  decodeControlFrame,
  decodeScreencastFrame,
  describeNodeError,
  effectiveCapabilities,
  encodeScreencastFrame,
  ExecEvent,
  hasCapability,
  LeaseHeld,
  mintStreamTicket,
  negotiateProtocol,
  NodeApprovalRequest,
  NodeHello,
  NodeRpcs,
  parseCapability,
  PathDenied,
  PolicyRefused,
  PROTOCOL_VERSION,
  PtyControl,
  redialDelayMs,
  REDIAL,
  safeEqual,
  Routes,
  TransferControl,
  FsDownloadResult,
} from "../src/index.ts"

const roundTrip = <S extends Schema.Codec<any, any, never, never>>(schema: S, value: S["Type"]) => {
  const json = JSON.parse(JSON.stringify(Schema.encodeSync(schema)(value)))
  return Schema.decodeUnknownSync(schema)(json)
}

describe("contract", () => {
  test("RPC groups expose the architecture §4.2 surface", () => {
    const node = [...NodeRpcs.requests.keys()].sort()
    expect(node).toEqual(
      [
        "node.hello",
        "fs.read",
        "fs.download",
        "fs.upload",
        "fs.write",
        "fs.edit",
        "fs.stat",
        "fs.list",
        "fs.glob",
        "fs.grep",
        "fs.mkdir",
        "fs.move",
        "fs.remove",
        "shell.exec",
        "pty.open",
        "tunnel.open",
        "service.start",
        "service.stop",
        "forward.listen",
        "browser.ensure",
        "browser.action",
        "browser.screencast",
        "browser.input",
        "lease.set",
        "desktop.ensure",
        "desktop.stop",
        "computer.act",
        "computer.stream",
        "screen.ensure",
        "screen.stream",
        "screen.input",
      ].sort(),
    )
    expect([...BrainRpcs.requests.keys()].sort()).toEqual(["node.event", "node.heartbeat", "node.openStream", "node.requestApproval"])
    expect([...NodeRpcs.requests.keys()].filter((k) => /^(computer|desktop)\./.test(k)).sort()).toEqual([
      "computer.act",
      "computer.stream",
      "desktop.ensure",
      "desktop.stop",
    ])
    expect([...NodeRpcs.requests.keys()].filter((k) => k.startsWith("screen.")).sort()).toEqual(["screen.ensure", "screen.input", "screen.stream"])
    expect(PROTOCOL_VERSION).toBe(1)
  })

  test("transfer framing: done / error / ack text frames; fs.download result", () => {
    expect(decodeControlFrame(TransferControl, '{"done":true,"sha256":"ab","size":3}')).toEqual({ done: true, sha256: "ab", size: 3 })
    expect(decodeControlFrame(TransferControl, '{"error":"disk read failed"}')).toEqual({ error: "disk read failed" })
    expect(decodeControlFrame(TransferControl, '{"ack":1048576}')).toEqual({ ack: 1048576 })
    expect(decodeControlFrame(TransferControl, '{"done":false}')).toBeUndefined()
    expect(decodeControlFrame(TransferControl, "not json")).toBeUndefined()
    const result = { path: "/w/a.mp4", name: "a.mp4", size: 10, mtimeMs: 1, head: base64Encode(new Uint8Array([1, 2])) }
    expect(roundTrip(FsDownloadResult, result)).toEqual(result)
  })

  test("schemas round-trip through JSON", () => {
    const actions: Array<BrowserAction> = [
      { _tag: "navigate", url: "https://example.com" },
      { _tag: "snapshot" },
      { _tag: "click", ref: "e12" },
      { _tag: "click", x: 10, y: 20, button: "right" },
      { _tag: "type", text: "hi", ref: "e3", submit: true },
      { _tag: "key", key: "Control+a" },
      { _tag: "scroll", direction: "down", amount: 5 },
      { _tag: "screenshot", format: "jpeg", quality: 80 },
      { _tag: "tabs", op: "new", url: "about:blank" },
    ]
    for (const a of actions) expect(roundTrip(BrowserAction, a)).toEqual(a)
    const inputs: Array<BrowserInputEvent> = [
      { _tag: "mouse", type: "down", x: 1, y: 2, button: "left", clickCount: 1 },
      { _tag: "key", type: "down", key: "a", code: "KeyA", text: "a", modifiers: { shift: false } },
      { _tag: "text", text: "pasted" },
    ]
    for (const e of inputs) expect(roundTrip(BrowserInputEvent, e)).toEqual(e)
    const exec: Array<ExecEvent> = [
      { _tag: "Started", pid: 1, pgid: 1 },
      { _tag: "Output", stream: "stderr", data: "x", seq: 0 },
      { _tag: "Exit", code: null, signal: "SIGKILL", timedOut: true, durationMs: 5, outputTruncated: true, spillPath: "/w/.openbot/out/1.log" },
    ]
    for (const e of exec) expect(roundTrip(ExecEvent, e)).toEqual(e)
    expect(() => Schema.decodeUnknownSync(BrowserAction)({ _tag: "teleport" })).toThrow()
    const hello = {
      nodeId: "n",
      version: "1",
      hostname: "h",
      platform: "linux",
      arch: "x64",
      protocol: 1,
      roots: [{ id: "w", path: "/w", mode: "ro" as const }],
      capabilities: [Capabilities.fs],
      tunnels: ["codex.exec-server"],
      policy: { ceiling: "never" as const, remoteManaged: false },
      brainVerified: true,
    }
    expect(roundTrip(NodeHello, hello)).toEqual(hello)
    const approval = { invocationId: "inv_1", botId: "bot_1", runId: "bot_1:cnv_1", toolCallId: "call_1", action: "run-command", target: "ls", reason: "ask" }
    expect(roundTrip(NodeApprovalRequest, approval)).toEqual(approval)
    const legacy = { invocationId: "inv_1", botId: "bot_1", action: "run-command", target: "ls", reason: "ask" }
    expect(roundTrip(NodeApprovalRequest, legacy)).toEqual(legacy)
  })

  test("errors are model-readable", () => {
    expect(describeNodeError(new LeaseHeld({ botId: "b", holder: "user", reason: "takeover" }))).toBe("The user is controlling the browser")
    expect(describeNodeError(new PolicyRefused({ action: "run-command", reason: "ceiling is never.", retry: false }))).toContain("Do not retry.")
    expect(describeNodeError(new PathDenied({ path: "/etc", reason: "outside roots" }))).toBe("Access to /etc is denied: outside roots")
  })
})

describe("capabilities and versions", () => {
  test("parse / has / effective", () => {
    expect(parseCapability("codex.exec-server@1")).toEqual({ name: "codex.exec-server", version: 1 })
    expect(parseCapability("fs")).toEqual({ name: "fs", version: 1 })
    expect(parseCapability("Bad@x")).toBeUndefined()
    expect(hasCapability(["fs@1", "browser@2"], "browser", 2)).toBe(true)
    expect(hasCapability(["fs@1", "browser@1"], "browser", 2)).toBe(false)
    expect(hasCapability(["fs@1"], "desktop")).toBe(false)
    expect(effectiveCapabilities(["fs@1", "shell@1", "browser@2"], ["fs@1", "browser@1"])).toEqual({
      effective: ["fs@1"],
      pending: ["shell@1", "browser@2"],
    })
  })

  test("protocol negotiation picks the highest overlap", () => {
    expect(negotiateProtocol({ min: 1, max: 2 }, { min: 1, max: 1 })).toBe(1)
    expect(negotiateProtocol({ min: 2, max: 3 }, { min: 1, max: 3 })).toBe(3)
    expect(negotiateProtocol({ min: 2, max: 2 }, { min: 1, max: 1 })).toBeUndefined()
  })

  test("redial backoff with jitter stays within bounds", () => {
    expect(redialDelayMs(0, 0)).toBe(125)
    expect(redialDelayMs(0, 0.999)).toBeLessThanOrEqual(250)
    expect(redialDelayMs(30, 0.999)).toBeLessThanOrEqual(REDIAL.maxMs)
    expect(redialDelayMs(30, 0)).toBe(REDIAL.maxMs / 2)
  })

  test("routes", () => {
    expect(Routes.stream("abc")).toBe("/node/stream/abc")
  })
})

describe("streams and encoding", () => {
  test("screencast frame codec", () => {
    const meta = { seq: 3, mime: "image/jpeg", width: 1280, height: 800, viewportWidth: 1280, viewportHeight: 800, timestamp: 1 }
    const img = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01])
    const frame = encodeScreencastFrame(meta, img)
    const decoded = decodeScreencastFrame(frame)!
    expect(decoded.meta).toEqual(meta)
    expect([...decoded.image]).toEqual([...img])
    // works on a view with a non-zero byteOffset
    const padded = new Uint8Array(frame.length + 7)
    padded.set(frame, 7)
    expect(decodeScreencastFrame(padded.subarray(7))!.meta.seq).toBe(3)
    expect(decodeScreencastFrame(new Uint8Array([0, 0]))).toBeUndefined()
    expect(decodeScreencastFrame(new Uint8Array([0, 0, 0, 200, 1]))).toBeUndefined()
    expect(decodeScreencastFrame(new Uint8Array([0, 0, 0, 2, 0x7b, 0x7d]))).toBeUndefined() // {} lacks fields
  })

  test("control frames", () => {
    expect(decodeControlFrame(PtyControl, '{"resize":{"cols":80,"rows":24}}')).toEqual({ resize: { cols: 80, rows: 24 } })
    expect(decodeControlFrame(PtyControl, '{"exit":0}')).toEqual({ exit: 0 })
    expect(decodeControlFrame(PtyControl, "nope")).toBeUndefined()
    expect(decodeControlFrame(CliControl, '{"eof":true}')).toEqual({ eof: true })
    expect(decodeControlFrame(CliControl, '{"kill":"SIGTERM"}')).toEqual({ kill: "SIGTERM" })
  })

  test("stream tickets are 96/128-bit base64url", () => {
    const t = mintStreamTicket()
    expect(base64UrlDecode(t.streamId).length).toBe(12)
    expect(base64UrlDecode(t.streamToken).length).toBe(16)
    expect(mintStreamTicket().streamToken).not.toBe(t.streamToken)
  })

  test("base64 helpers match the reference encoder", () => {
    const bytes = new Uint8Array(70_000).map((_, i) => (i * 31) & 0xff)
    expect(base64Encode(bytes)).toBe(Buffer.from(bytes).toString("base64"))
    expect(base64UrlEncode(bytes)).toBe(Buffer.from(bytes).toString("base64url"))
    expect([...base64Decode(base64Encode(bytes))]).toEqual([...bytes])
    expect([...base64UrlDecode(base64UrlEncode(bytes.subarray(0, 5)))]).toEqual([...bytes.subarray(0, 5)])
    expect(() => base64UrlDecode("a+b")).toThrow()
    expect(safeEqual("abc", "abc")).toBe(true)
    expect(safeEqual("abc", "abd")).toBe(false)
    expect(safeEqual("abc", "abcd")).toBe(false)
  })
})

describe("portability", () => {
  test("src uses no Bun-only or Node-only APIs", () => {
    const dir = join(import.meta.dir, "..", "src")
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f), "utf8")
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("//"))
        .join("\n")
      expect({ f, bun: /\bBun\./.test(text) }).toEqual({ f, bun: false })
      expect({ f, buffer: /\bBuffer\b/.test(text) }).toEqual({ f, buffer: false })
      expect({ f, node: /from "node:/.test(text) }).toEqual({ f, node: false })
      expect({ f, process: /\bprocess\./.test(text) }).toEqual({ f, process: false })
      expect({ f, vendor: /vendor\//.test(text.replace(/vendor\/scratch[^\s)]*/g, "")) }).toEqual({ f, vendor: false })
    }
  })
})

describe("node-side seams (BrainLink, StreamDialer)", () => {
  test("can be provided in-process (local node) and used by handlers", async () => {
    const { Effect: E, Layer: L } = await import("effect")
    const { BrainLink, StreamDialer, StreamRefused } = await import("../src/index.ts")
    const link = L.succeed(BrainLink, BrainLink.of({
      requestApproval: (req) => E.succeed({ decision: req.action === "run-command" ? "allow-once" as const : "deny" as const, by: "rule" }),
      openStream: ({ kind }) => E.fail(new StreamRefused({ kind, reason: "not in this test" })),
      event: () => E.void,
    }))
    const dialer = L.succeed(StreamDialer, StreamDialer.of({ dial: ({ kind }) => E.fail(new StreamRefused({ kind, reason: "offline" })) }))
    const out = await E.runPromise(
      E.gen(function*() {
        const brain = yield* BrainLink
        const answer = yield* brain.requestApproval({ invocationId: "i", botId: "b", runId: "b:c", action: "run-command", target: "ls", reason: "ask" })
        const dial = yield* E.exit(E.scoped((yield* StreamDialer).dial({ ticket: { streamId: "s", streamToken: "t" }, kind: "pty" })))
        return { answer, dialFailed: dial._tag === "Failure" }
      }).pipe(E.provide(L.merge(link, dialer))),
    )
    expect(out).toEqual({ answer: { decision: "allow-once", by: "rule" }, dialFailed: true })
  })
})
