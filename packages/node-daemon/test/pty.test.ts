import { afterAll, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Socket from "effect/socket/Socket"
import { mkdirSync } from "node:fs"
import * as path from "node:path"
import { inv, makeTestNode, run, tempDir } from "./helpers.ts"

const t = tempDir("pty-")
afterAll(t.cleanup)
const root = path.join(t.path, "work")
const dataDir = path.join(t.path, "state")
mkdirSync(root, { recursive: true })

const decoder = new TextDecoder()

/** Brain end of a data stream: collects terminal bytes and text control frames. */
const brainEnd = (socket: Socket.Socket) =>
  Effect.gen(function* () {
    const reader = yield* socket.reader
    const writer = yield* socket.writer
    const state = { output: "", controls: [] as Array<string>, closed: undefined as Socket.SocketError | undefined }
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.flatMap(reader.pull, (frames) =>
          Effect.sync(() => {
            for (const f of frames) {
              if (typeof f === "string") state.controls.push(f)
              else state.output += decoder.decode(f)
            }
          }),
        ),
      ).pipe(Effect.catch((e) => Effect.sync(() => void (state.closed = e)))),
    )
    const waitFor = (pred: () => boolean, ms = 5000) =>
      Effect.gen(function* () {
        const end = Date.now() + ms
        while (!pred()) {
          if (Date.now() > end)
            return yield* Effect.die(new Error(`timed out; output so far: ${JSON.stringify(state.output.slice(-400))}`))
          yield* Effect.sleep(20)
        }
      })
    return {
      state,
      waitFor,
      type: (s: string) => writer.write(new TextEncoder().encode(s)),
      control: (s: unknown) => writer.write(JSON.stringify(s)),
    }
  })

describe("pty.open", () => {
  test("echo, resize and exit over the data stream", () =>
    run(
      Effect.gen(function* () {
        const { client, brain } = yield* makeTestNode({ dataDir, roots: [root] })
        const { pid } = yield* client["pty.open"]({
          inv: inv(),
          cols: 80,
          rows: 24,
          cwd: root,
          shell: "/bin/sh",
          env: { PS1: "$ " },
          streamId: "s_pty1",
          streamToken: "tok",
        })
        expect(pid).toBeGreaterThan(0)
        const io = yield* brainEnd(brain.streams.get("s_pty1")!)

        yield* io.type("echo hello-$((40+2))\n")
        yield* io.waitFor(() => io.state.output.includes("hello-42"))

        yield* io.type("stty size\n")
        yield* io.waitFor(() => /24 80/.test(io.state.output))

        yield* io.control({ resize: { cols: 120, rows: 40 } })
        yield* Effect.sleep(50)
        yield* io.type("stty size; pwd\n")
        yield* io.waitFor(() => /40 120/.test(io.state.output))
        expect(io.state.output).toContain(root)

        yield* io.type("exit 5\n")
        yield* io.waitFor(() => io.state.controls.length > 0 && io.state.closed !== undefined)
        expect(JSON.parse(io.state.controls[0]!)).toEqual({ exit: 5, signal: null })
      }),
    ))

  test("closing the stream kills the shell", () =>
    run(
      Effect.gen(function* () {
        const { client, brain } = yield* makeTestNode({ dataDir, roots: [root] })
        const { pid } = yield* client["pty.open"]({
          inv: inv(),
          cols: 80,
          rows: 24,
          cwd: root,
          shell: "/bin/sh",
          streamId: "s_pty2",
          streamToken: "tok",
        })
        const socket = brain.streams.get("s_pty2")!
        const writer = yield* socket.writer
        yield* Effect.sleep(100)
        const isAlive = () => {
          try {
            process.kill(pid, 0)
            return true
          } catch {
            return false
          }
        }
        expect(isAlive()).toBe(true)
        yield* writer.write(new Socket.CloseEvent(1000, "viewer left"))
        const end = Date.now() + 3000
        while (isAlive() && Date.now() < end) yield* Effect.sleep(20)
        expect(isAlive()).toBe(false)
      }),
    ))

  test("a cwd outside the roots is refused before anything starts", () =>
    run(
      Effect.gen(function* () {
        const { client, brain } = yield* makeTestNode({ dataDir, roots: [root] })
        const e = yield* Effect.flip(
          client["pty.open"]({ inv: inv(), cols: 80, rows: 24, cwd: "/etc", streamId: "s_pty3", streamToken: "tok" }),
        )
        expect(e._tag).toBe("PathDenied")
        expect(brain.streams.has("s_pty3")).toBe(false)
      }),
    ))
})
