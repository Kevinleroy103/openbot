// tunnel.open (tcp, codex.exec-server NDJSON bridging), service.start/stop and forward.listen, with
// fake codex/opencode scripts (no real harness binaries are started).
import { afterAll, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Socket from "effect/socket/Socket"
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import { inv, makeTestNode, run, tempDir } from "./helpers.ts"

const t = tempDir("tunnels-")
afterAll(t.cleanup)
const root = path.join(t.path, "work")
const dataDir = path.join(t.path, "state")
const bin = path.join(t.path, "bin")
mkdirSync(root, { recursive: true })
mkdirSync(bin, { recursive: true })

const script = (name: string, body: string) => {
  const p = path.join(bin, name)
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}
// fake codex: every NDJSON line on stdin comes back wrapped; records its argv and CODEX_HOME
const fakeCodex = script(
  "codex",
  `echo "$@" > "${t.path}/codex-argv"; echo "$CODEX_HOME" > "${t.path}/codex-home"
while IFS= read -r line; do printf '{"echo":%s}\\n' "$line"; done`,
)
const fakeOpencode = script("opencode", `echo "opencode server listening on http://127.0.0.1:45999"\nexec sleep 60`)

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const waitFor = (pred: () => boolean, ms = 3000) =>
  Effect.gen(function* () {
    const end = Date.now() + ms
    while (!pred() && Date.now() < end) yield* Effect.sleep(10)
    return pred()
  })

/** Read every frame of a brain stream end into an array (forked in the test scope). */
const collect = (socket: Socket.Socket) =>
  Effect.gen(function* () {
    const reader = yield* socket.reader
    const writer = yield* socket.writer
    const frames: Array<string | Uint8Array> = []
    yield* Effect.forkScoped(Effect.ignore(Effect.forever(Effect.flatMap(reader.pull, (fs) => Effect.sync(() => void frames.push(...fs))))))
    return { frames, writer }
  })

const bytesText = (frames: ReadonlyArray<string | Uint8Array>) =>
  frames.map((f) => (typeof f === "string" ? "" : new TextDecoder().decode(f))).join("")

describe("tunnels, services and forwards", () => {
  test("tunnel.open tcp: raw bytes between the stream and a node-loopback port", () =>
    run(
      Effect.gen(function* () {
        const echo = Bun.listen({
          hostname: "127.0.0.1",
          port: 0,
          socket: { data: (s, d) => void s.write(`echo:${new TextDecoder().decode(d)}`) },
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => echo.stop(true)))
        const { client, brain } = yield* makeTestNode({ dataDir, roots: [root] })
        const res = yield* client["tunnel.open"]({ inv: inv(), kind: "tcp", args: [], env: {}, cwd: root, port: echo.port, streamId: "t_tcp", streamToken: "tok" })
        expect(res.pid).toBeNull()
        const end = yield* collect(brain.streams.get("t_tcp")!)
        yield* end.writer.write(new TextEncoder().encode("ping"))
        expect(yield* waitFor(() => bytesText(end.frames) === "echo:ping")).toBe(true)

        const closed = yield* Effect.flip(
          client["tunnel.open"]({ inv: inv(), kind: "tcp", args: [], env: {}, cwd: root, port: 1, streamId: "t_tcp2", streamToken: "tok" }),
        )
        expect(closed._tag).toBe("TunnelFailed")
        const noPort = yield* Effect.flip(client["tunnel.open"]({ inv: inv(), kind: "tcp", args: [], env: {}, cwd: root, streamId: "t3", streamToken: "tok" }))
        expect(noPort._tag).toBe("TunnelFailed")
      }),
    ))

  test("tunnel.open codex.exec-server: one JSON-RPC message per text frame <-> NDJSON stdio; closing kills it", () =>
    run(
      Effect.gen(function* () {
        const { client, brain } = yield* makeTestNode({ dataDir, roots: [root], binaries: { codex: fakeCodex } })
        const { pid } = yield* client["tunnel.open"]({
          inv: inv("bot_cx"),
          kind: "codex.exec-server",
          args: ["--ignored"],
          env: { CODEX_HOME: "/evil", RUST_LOG: "info" },
          cwd: root,
          streamId: "t_cx",
          streamToken: "tok",
        })
        expect(pid).toBeGreaterThan(0)
        const end = yield* collect(brain.streams.get("t_cx")!)
        yield* end.writer.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }))
        yield* end.writer.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "x" }))
        expect(yield* waitFor(() => end.frames.length >= 2)).toBe(true)
        expect(end.frames.every((f) => typeof f === "string")).toBe(true)
        expect(JSON.parse(end.frames[0] as string)).toEqual({ echo: { jsonrpc: "2.0", id: 1, method: "initialize" } })
        // the node's own argv and per-bot CODEX_HOME, never the brain's
        expect(yield* Effect.promise(() => Bun.file(path.join(t.path, "codex-argv")).text())).toBe("exec-server --listen stdio\n")
        expect((yield* Effect.promise(() => Bun.file(path.join(t.path, "codex-home")).text())).trim()).toBe(
          path.join(dataDir, "bots", "bot_cx", "codex-exec"),
        )
        yield* end.writer.write(new Socket.CloseEvent(1000))
        expect(yield* waitFor(() => !alive(pid!))).toBe(true)
      }),
    ))

  test("tunnel.open without codex installed, or claude.cli, is TunnelFailed", () =>
    run(
      Effect.gen(function* () {
        const { client, info } = yield* makeTestNode({ dataDir, roots: [root] })
        expect(info.capabilities).not.toContain("codex.exec-server@1")
        const e = yield* Effect.flip(
          client["tunnel.open"]({ inv: inv(), kind: "codex.exec-server", args: [], env: {}, cwd: root, streamId: "x", streamToken: "t" }),
        )
        expect(e._tag).toBe("TunnelFailed")
        const c = yield* Effect.flip(client["tunnel.open"]({ inv: inv(), kind: "claude.cli", args: [], env: {}, cwd: root, streamId: "y", streamToken: "t" }))
        expect(c._tag).toBe("TunnelFailed")
      }),
    ))

  test("service.start opencode.serve reports its loopback port; service.stop kills it", () =>
    run(
      Effect.gen(function* () {
        const { client, info } = yield* makeTestNode({ dataDir, roots: [root], binaries: { opencode: fakeOpencode } })
        expect(info.capabilities).toContain("opencode.serve@1")
        const svc = yield* client["service.start"]({ inv: inv("bot_oc"), kind: "opencode.serve", env: {}, cwd: root })
        expect(svc.port).toBe(45999)
        expect(alive(svc.pid)).toBe(true)
        // another bot cannot stop it
        yield* client["service.stop"]({ inv: inv("bot_other"), serviceId: svc.serviceId })
        expect(alive(svc.pid)).toBe(true)
        yield* client["service.stop"]({ inv: inv("bot_oc"), serviceId: svc.serviceId })
        expect(yield* waitFor(() => !alive(svc.pid))).toBe(true)
      }),
    ))

  test("forward.listen: each local connection becomes a node-initiated stream (tcp and 0600 unix socket)", () =>
    run(
      Effect.gen(function* () {
        const { client, brain } = yield* makeTestNode({ dataDir, roots: [root] })
        for (const transport of ["tcp", "unix"] as const) {
          const fwd = yield* client["forward.listen"]({ inv: inv("bot_fw"), kind: "mcp-http", transport })
          // idempotent: a retried call gets the same listener
          expect(yield* client["forward.listen"]({ inv: inv("bot_fw"), kind: "mcp-http", transport })).toEqual(fwd)
          const received: Array<string> = []
          const sock =
            transport === "tcp" ? net.connect(fwd.port!, "127.0.0.1") : net.connect(fwd.path!)
          sock.on("data", (d) => void received.push(d.toString()))
          yield* Effect.addFinalizer(() => Effect.sync(() => sock.destroy()))
          if (transport === "unix") {
            expect(fwd.path).toBe(path.join(dataDir, "run", "mcp-http-bot_fw.sock"))
            expect(statSync(fwd.path!).mode & 0o777).toBe(0o600)
          }
          const before = brain.opened.length
          expect(yield* waitFor(() => brain.opened.length > before && brain.streams.has(brain.opened[brain.opened.length - 1]!.streamId))).toBe(true)
          const opened = brain.opened[brain.opened.length - 1]!
          expect(opened).toMatchObject({ kind: "mcp-http", botId: "bot_fw" })
          const end = yield* collect(brain.streams.get(opened.streamId)!)
          sock.write("GET / HTTP/1.1\r\n\r\n")
          expect(yield* waitFor(() => bytesText(end.frames).includes("GET / HTTP/1.1"))).toBe(true)
          yield* end.writer.write(new TextEncoder().encode("HTTP/1.1 200 OK\r\n\r\n"))
          expect(yield* waitFor(() => received.join("").includes("200 OK"))).toBe(true)
        }
      }),
    ))
})
