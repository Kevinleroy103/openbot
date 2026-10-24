// fs.download / fs.upload: path policy, size limits, binary integrity (sha256 end to end) and
// ack-window flow control over the `transfer` data stream (in-memory socket pair, as the local node).
import { afterAll, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Socket from "effect/socket/Socket"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { base64Decode, TRANSFER_CHUNK_BYTES, TRANSFER_WINDOW_BYTES } from "@openbot/node-protocol"
import { formatBytes } from "../src/index.ts"
import { inv, makeTestNode, run, tempDir } from "./helpers.ts"

const t = tempDir("transfer-")
afterAll(t.cleanup)
const root = path.join(t.path, "work")
const outside = path.join(t.path, "elsewhere")
const dataDir = path.join(t.path, "state")
mkdirSync(path.join(root, "out"), { recursive: true })
mkdirSync(path.join(root, ".ssh"), { recursive: true })
mkdirSync(outside, { recursive: true })

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

/** Pseudo-random bytes (deterministic, every byte value present). */
const noise = (n: number, seed = 7): Uint8Array => {
  const out = new Uint8Array(n)
  let x = seed
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    out[i] = x >>> 24
  }
  return out
}

const ticket = (n: number) => ({ streamId: `st_${n}`, streamToken: "tok" })

/** Brain end of a transfer stream: collects bytes, acks when asked, records the final frame. */
const receiver = (socket: Socket.Socket, options?: { readonly autoAck?: boolean }) =>
  Effect.gen(function* () {
    const reader = yield* socket.reader
    const writer = yield* socket.writer
    const state = {
      chunks: [] as Array<Uint8Array>,
      received: 0,
      final: undefined as Record<string, unknown> | undefined,
      maxChunk: 0,
    }
    let autoAck = options?.autoAck ?? true
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.flatMap(reader.pull, (frames) =>
          Effect.forEach(
            frames,
            (f) => {
              if (typeof f === "string") {
                state.final = JSON.parse(f) as Record<string, unknown>
                return Effect.void
              }
              state.chunks.push(f.slice())
              state.received += f.byteLength
              state.maxChunk = Math.max(state.maxChunk, f.byteLength)
              return autoAck ? writer.write(JSON.stringify({ ack: state.received })) : Effect.void
            },
            { discard: true },
          ),
        ),
      ).pipe(Effect.ignore),
    )
    const waitFor = (pred: () => boolean, ms = 5000) =>
      Effect.gen(function* () {
        const end = Date.now() + ms
        while (!pred()) {
          if (Date.now() > end) return yield* Effect.die(new Error(`timed out; received ${state.received}`))
          yield* Effect.sleep(10)
        }
      })
    const bytes = () => {
      const out = new Uint8Array(state.received)
      let at = 0
      for (const c of state.chunks) {
        out.set(c, at)
        at += c.byteLength
      }
      return out
    }
    return {
      state,
      waitFor,
      bytes,
      ack: (n: number) => writer.write(JSON.stringify({ ack: n })),
      setAutoAck: (on: boolean) => {
        autoAck = on
      },
    }
  })

describe("fs.download", () => {
  test("streams a binary file intact (sha256 + size), chunked ≤ 1 MiB, with the head for sniffing", () =>
    run(
      Effect.gen(function* () {
        const data = noise(3 * TRANSFER_CHUNK_BYTES + 12_345)
        data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0) // PNG signature
        writeFileSync(path.join(root, "out", "render.png"), data)
        const { client, brain } = yield* makeTestNode({ dataDir, roots: [root] })
        const meta = yield* client["fs.download"]({ inv: inv(), path: "out/render.png", cwd: root, ...ticket(1) })
        expect(meta).toMatchObject({
          path: path.join(root, "out", "render.png"),
          name: "render.png",
          size: data.byteLength,
        })
        const head = base64Decode(meta.head)
        expect(head.byteLength).toBe(4096)
        expect([...head.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
        const rx = yield* receiver(brain.streams.get("st_1")!)
        yield* rx.waitFor(() => rx.state.final !== undefined)
        expect(rx.state.final).toEqual({ done: true, sha256: sha256(data), size: data.byteLength })
        expect(rx.state.maxChunk).toBeLessThanOrEqual(TRANSFER_CHUNK_BYTES)
        expect(sha256(rx.bytes())).toBe(sha256(data))
      }),
    ))

  test("flow control: at most the ack window is in flight until the brain acknowledges", () =>
    run(
      Effect.gen(function* () {
        const data = noise(TRANSFER_WINDOW_BYTES + 3 * TRANSFER_CHUNK_BYTES, 11)
        writeFileSync(path.join(root, "big.bin"), data)
        const { client, brain } = yield* makeTestNode({ dataDir, roots: [root] })
        yield* client["fs.download"]({ inv: inv(), path: path.join(root, "big.bin"), ...ticket(2) })
        const rx = yield* receiver(brain.streams.get("st_2")!, { autoAck: false })
        yield* rx.waitFor(() => rx.state.received >= TRANSFER_WINDOW_BYTES)
        yield* Effect.sleep(200)
        expect(rx.state.received).toBe(TRANSFER_WINDOW_BYTES)
        expect(rx.state.final).toBeUndefined()
        rx.setAutoAck(true)
        yield* rx.ack(rx.state.received)
        yield* rx.waitFor(() => rx.state.final !== undefined)
        expect(rx.state.final).toMatchObject({ done: true, size: data.byteLength, sha256: sha256(data) })
      }),
    ))

  test("path policy: outside the roots, the deny-list and directories are refused before any stream", () =>
    run(
      Effect.gen(function* () {
        writeFileSync(path.join(outside, "secret.txt"), "nope")
        writeFileSync(path.join(root, ".ssh", "id_ed25519"), "key")
        const { client, brain } = yield* makeTestNode({ dataDir, roots: [root] })
        const out = yield* Effect.flip(
          client["fs.download"]({ inv: inv(), path: path.join(outside, "secret.txt"), ...ticket(3) }),
        )
        expect(out._tag).toBe("PathDenied")
        const escape = yield* Effect.flip(
          client["fs.download"]({ inv: inv(), path: "../elsewhere/secret.txt", cwd: root, ...ticket(4) }),
        )
        expect(escape._tag).toBe("PathDenied")
        const denied = yield* Effect.flip(
          client["fs.download"]({ inv: inv(), path: ".ssh/id_ed25519", cwd: root, ...ticket(5) }),
        )
        expect(denied._tag).toBe("PathDenied")
        const dir = yield* Effect.flip(client["fs.download"]({ inv: inv(), path: "out", cwd: root, ...ticket(6) }))
        expect(dir).toMatchObject({ _tag: "FsError", code: "EISDIR" })
        const missing = yield* Effect.flip(
          client["fs.download"]({ inv: inv(), path: "nope.mp4", cwd: root, ...ticket(7) }),
        )
        expect(missing).toMatchObject({ _tag: "FsError", code: "ENOENT" })
        expect(brain.streams.size).toBe(0)
      }),
    ))

  test("size limits: the caller's maxBytes and the node's own transfer cap", () =>
    run(
      Effect.gen(function* () {
        writeFileSync(path.join(root, "clip.mp4"), noise(5000))
        const { client } = yield* makeTestNode({ dataDir, roots: [root], limits: { transferBytes: 4000 } })
        const capped = yield* Effect.flip(
          client["fs.download"]({ inv: inv(), path: "clip.mp4", cwd: root, ...ticket(8) }),
        )
        expect(capped).toMatchObject({ _tag: "FsError", code: "EFBIG" })
        expect((capped as { reason: string }).reason).toBe("the file is 5 KB; files up to 4 KB can be sent")
        const node2 = yield* makeTestNode({ dataDir, roots: [root] })
        const asked = yield* Effect.flip(
          node2.client["fs.download"]({ inv: inv(), path: "clip.mp4", cwd: root, maxBytes: 1000, ...ticket(9) }),
        )
        expect(asked).toMatchObject({ _tag: "FsError", code: "EFBIG" })
        const ok = yield* node2.client["fs.download"]({
          inv: inv(),
          path: "clip.mp4",
          cwd: root,
          maxBytes: 5000,
          ...ticket(10),
        })
        expect(ok.size).toBe(5000)
      }),
    ))

  test("the node's read-file ceiling applies (never → refused, ask → the brain decides)", () =>
    run(
      Effect.gen(function* () {
        writeFileSync(path.join(root, "a.txt"), "hello")
        const never = yield* makeTestNode({ dataDir, roots: [root], policy: { actions: { "read-file": "never" } } })
        const refused = yield* Effect.flip(
          never.client["fs.download"]({ inv: inv(), path: "a.txt", cwd: root, ...ticket(11) }),
        )
        expect(refused._tag).toBe("PolicyRefused")
        const ask = yield* makeTestNode({ dataDir, roots: [root], policy: { actions: { "read-file": "ask" } } })
        const meta = yield* ask.client["fs.download"]({
          inv: inv("bot_1", "call_9"),
          path: "a.txt",
          cwd: root,
          ...ticket(12),
        })
        expect(meta.size).toBe(5)
        expect(ask.brain.approvals).toHaveLength(1)
        expect(ask.brain.approvals[0]).toMatchObject({
          action: "read-file",
          target: path.join(root, "a.txt"),
          toolCallId: "call_9",
        })
      }),
    ))

  test("fs.upload receives a file (acks, sha256 check) and renames it into place; damaged or cut transfers leave nothing", () =>
    run(
      Effect.gen(function* () {
        const data = noise(3 * TRANSFER_CHUNK_BYTES + 777, 5)
        const { client, brain } = yield* makeTestNode({ dataDir, roots: [root] })
        const target = path.join(root, "inbox", "att_1", "diagram.png")
        const sendAll = (streamId: string, bytes: Uint8Array, final: Record<string, unknown> | "close") =>
          Effect.gen(function* () {
            while (!brain.streams.has(streamId)) yield* Effect.sleep(5)
            const socket = brain.streams.get(streamId)!
            const reader = yield* socket.reader
            const writer = yield* socket.writer
            const acks: Array<number> = []
            yield* Effect.forkScoped(
              Effect.forever(
                Effect.flatMap(reader.pull, (frames) =>
                  Effect.sync(() => {
                    for (const f of frames) if (typeof f === "string") acks.push((JSON.parse(f) as { ack: number }).ack)
                  }),
                ),
              ).pipe(Effect.ignore),
            )
            for (let at = 0; at < bytes.length; at += TRANSFER_CHUNK_BYTES)
              yield* writer.write(bytes.slice(at, at + TRANSFER_CHUNK_BYTES))
            if (final === "close") yield* writer.write(new Socket.CloseEvent(1000))
            else yield* writer.write(JSON.stringify(final))
            return acks
          })

        const upload = yield* client["fs.upload"]({
          inv: inv(),
          path: target,
          size: data.byteLength,
          ...ticket(20),
        }).pipe(Effect.forkScoped)
        const acks = yield* sendAll("st_20", data, { done: true, sha256: sha256(data), size: data.byteLength })
        const result = yield* Fiber.join(upload)
        expect(result).toEqual({ path: target, size: data.byteLength, sha256: sha256(data) })
        expect(sha256(new Uint8Array(readFileSync(target)))).toBe(sha256(data))
        expect(acks.length).toBeGreaterThanOrEqual(3)

        const damagedTarget = path.join(root, "inbox", "att_2", "x.bin")
        const damaged = yield* client["fs.upload"]({ inv: inv(), path: damagedTarget, size: 10, ...ticket(21) }).pipe(
          Effect.forkScoped,
        )
        yield* sendAll("st_21", noise(10), { done: true, sha256: "00", size: 10 })
        expect((yield* Effect.flip(Fiber.join(damaged)))._tag).toBe("TunnelFailed")
        const cutTarget = path.join(root, "inbox", "att_3", "y.bin")
        const cut = yield* client["fs.upload"]({
          inv: inv(),
          path: cutTarget,
          size: 2 * TRANSFER_CHUNK_BYTES,
          ...ticket(22),
        }).pipe(Effect.forkScoped)
        yield* sendAll("st_22", noise(TRANSFER_CHUNK_BYTES), "close")
        expect((yield* Effect.flip(Fiber.join(cut)))._tag).toBe("TunnelFailed")
        expect(existsSync(damagedTarget)).toBe(false)
        expect(existsSync(cutTarget)).toBe(false)
        expect(readdirSync(path.join(root, "inbox", "att_2"))).toEqual([])
        expect(readdirSync(path.join(root, "inbox", "att_3"))).toEqual([])

        const outsideRoot = yield* Effect.flip(
          client["fs.upload"]({ inv: inv(), path: path.join(outside, "z.bin"), size: 1, ...ticket(23) }),
        )
        expect(outsideRoot._tag).toBe("PathDenied")
        const capped = yield* makeTestNode({ dataDir, roots: [root], limits: { transferBytes: 100 } })
        const tooBig = yield* Effect.flip(
          capped.client["fs.upload"]({ inv: inv(), path: path.join(root, "big.bin"), size: 101, ...ticket(24) }),
        )
        expect(tooBig).toMatchObject({ _tag: "FsError", code: "EFBIG" })
      }),
    ))

  test("formatBytes", () => {
    expect(formatBytes(1)).toBe("1 byte")
    expect(formatBytes(999)).toBe("999 bytes")
    expect(formatBytes(24_123_456)).toBe("24.1 MB")
    expect(formatBytes(200_000_000)).toBe("200 MB")
  })
})
