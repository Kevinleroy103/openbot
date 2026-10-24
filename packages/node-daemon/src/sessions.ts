// Data-plane sessions that outlive their opening RPC: pty.open, tunnel.open, service.start and
// forward.listen. Each opener dials the brain's `/node/stream/:id` through StreamDialer, reports
// readiness (pid) to the RPC, and keeps running in the node's session FiberSet until either side
// ends. Closing the node (layer scope) interrupts every session, which kills its process group.
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FiberSet from "effect/FiberSet"
import * as Queue from "effect/Queue"
import * as Scope from "effect/Scope"
import * as Socket from "effect/socket/Socket"
import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import {
  decodeControlFrame,
  PathDenied,
  PtyControl,
  TunnelFailed,
  type BrainLink,
  type BrainStreamKind,
  type Invocation,
  type StreamDialer,
  type StreamTicket,
  type TunnelKind,
} from "@openbot/node-protocol"
import type { NodeConfigShape } from "./config.ts"
import type { Guard } from "./guard.ts"
import type { PathPolicyShape } from "./PathPolicy.ts"
import { baseEnv, filterEnv, killGroup, terminateGroup } from "./proc.ts"
import { frameText, openDuplex, type Duplex } from "./sockets.ts"

export interface SessionDeps {
  readonly config: NodeConfigShape
  readonly paths: PathPolicyShape
  readonly guard: Guard
  readonly dialer: StreamDialer["Service"]
  readonly brain: BrainLink["Service"]
  readonly sessions: FiberSet.FiberSet<unknown, unknown>
  readonly scope: Scope.Scope
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
const reasonOf = (e: unknown): string =>
  e && typeof e === "object" && "reason" in e && typeof (e as { reason: unknown }).reason === "string"
    ? (e as { reason: string }).reason
    : e instanceof Error
      ? e.message
      : String(e)

/** Resolve a cwd that must be an existing directory in a root. */
const resolveDir = (paths: PathPolicyShape, botId: string, cwd: string) =>
  Effect.gen(function* () {
    const r = yield* paths.resolve({ path: cwd, botId, access: "read" })
    let ok = false
    try {
      ok = statSync(r.real).isDirectory()
    } catch {
      ok = false
    }
    if (!ok) return yield* new PathDenied({ path: cwd, reason: "cwd is not an existing directory" })
    return r.real
  })

/**
 * Run `session` in the session set; it reports readiness through the Deferred. The RPC waits for
 * readiness (or the session's failure) and returns.
 */
export const startSession = <A>(
  deps: SessionDeps,
  kind: string,
  session: (ready: Deferred.Deferred<A, TunnelFailed>) => Effect.Effect<void, TunnelFailed, Scope.Scope>,
): Effect.Effect<A, TunnelFailed> =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<A, TunnelFailed>()
    yield* FiberSet.run(
      deps.sessions,
      Effect.scoped(session(ready)).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Deferred.fail(ready, new TunnelFailed({ kind, reason: "the node is shutting down" }))
            : Deferred.fail(ready, new TunnelFailed({ kind, reason: reasonOf(Cause.squash(cause)) })),
        ),
        Effect.asVoid,
      ),
    )
    return yield* Deferred.await(ready)
  })

export const dialSession = (
  deps: SessionDeps,
  ticket: StreamTicket,
  kind: string,
): Effect.Effect<Duplex, TunnelFailed, Scope.Scope> =>
  deps.dialer.dial({ ticket, kind }).pipe(
    Effect.mapError((e) => new TunnelFailed({ kind, reason: `stream refused: ${e.reason}` })),
    Effect.flatMap((socket) => openDuplex(socket)),
    Effect.mapError((e) =>
      e instanceof TunnelFailed ? e : new TunnelFailed({ kind, reason: `stream failed: ${reasonOf(e)}` }),
    ),
  )

/** Pull frames until the socket closes; returns the close error. */
const readFrames = (io: Duplex, onFrame: (f: string | Uint8Array) => void): Effect.Effect<Socket.SocketError> =>
  Effect.forever(Effect.flatMap(io.pull, (frames) => Effect.sync(() => frames.forEach(onFrame)))).pipe(
    Effect.flip,
  ) as Effect.Effect<Socket.SocketError>

/** Drain an output queue into the socket until the queue ends. */
const writeOut = (io: Duplex, out: Queue.Queue<Uint8Array | string, Cause.Done>): Effect.Effect<void> =>
  Effect.forever(
    Effect.flatMap(Queue.takeBetween(out, 1, 256), (chunks) =>
      io.writer.writeAll(chunks as unknown as readonly [Uint8Array | string, ...Array<Uint8Array | string>]),
    ),
  ).pipe(Effect.ignore)

// ---------------------------------------------------------------- pty.open
export interface PtyPayload {
  readonly inv: Invocation
  readonly cols: number
  readonly rows: number
  readonly cwd: string
  readonly shell?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly streamId: string
  readonly streamToken: string
}

export const makePtyOpen = (deps: SessionDeps) => (p: PtyPayload) =>
  Effect.gen(function* () {
    const cwd = yield* resolveDir(deps.paths, p.inv.botId, p.cwd)
    const shell = p.shell && p.shell.length > 0 ? p.shell : deps.config.shell.interactive
    yield* deps.guard.check({ inv: p.inv, action: "pty", target: shell })
    const pid = yield* startSession<number>(deps, "pty", (ready) =>
      Effect.gen(function* () {
        const io = yield* dialSession(deps, { streamId: p.streamId, streamToken: p.streamToken }, "pty")
        const out = yield* Queue.unbounded<Uint8Array | string, Cause.Done>()
        const proc = yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              Bun.spawn([shell], {
                cwd,
                env: baseEnv({
                  ...filterEnv(p.env),
                  TERM: "xterm-256color",
                  COLORTERM: "truecolor",
                  OPENBOT_NODE_ID: deps.config.nodeId,
                  OPENBOT_BOT_ID: p.inv.botId,
                }),
                terminal: {
                  cols: Math.max(1, Math.floor(p.cols)),
                  rows: Math.max(1, Math.floor(p.rows)),
                  data: (_t, d) => void Queue.offerUnsafe(out, new Uint8Array(d)),
                },
              }),
            catch: (e) => new TunnelFailed({ kind: "pty", reason: `could not start ${shell}: ${reasonOf(e)}` }),
          }),
          (child) =>
            Effect.gen(function* () {
              if (child.exitCode === null && child.signalCode === null) {
                killGroup(child.pid, "SIGHUP")
                try {
                  child.kill("SIGHUP")
                } catch {
                  // gone
                }
              }
              yield* terminateGroup(child, 300)
              try {
                child.terminal?.close()
              } catch {
                // closed
              }
            }),
        )
        yield* Deferred.succeed(ready, proc.pid)
        const writer = yield* Effect.forkScoped(writeOut(io, out))
        const reader = yield* Effect.forkScoped(
          readFrames(io, (f) => {
            if (typeof f === "string") {
              const ctl = decodeControlFrame(PtyControl, f)
              if (ctl && "resize" in ctl)
                proc.terminal?.resize(
                  Math.max(1, Math.floor(ctl.resize.cols)),
                  Math.max(1, Math.floor(ctl.resize.rows)),
                )
              return
            }
            proc.terminal?.write(f)
          }),
        )
        const ended = yield* Effect.raceFirst(
          Effect.promise(() => proc.exited).pipe(Effect.as("exit" as const)),
          Fiber.await(reader).pipe(Effect.as("closed" as const)),
        )
        if (ended === "exit") {
          yield* Effect.sleep(50) // let the pty deliver its last bytes
          yield* Queue.offer(
            out,
            JSON.stringify({
              exit: proc.signalCode ? null : proc.exitCode,
              signal: proc.signalCode === null ? null : String(proc.signalCode),
            }),
          )
          yield* Queue.end(out)
          yield* Fiber.await(writer).pipe(Effect.timeoutOption(2000))
          yield* Effect.ignore(io.writer.write(new Socket.CloseEvent(1000, "exit")))
        }
      }),
    )
    return { pid }
  })

// ---------------------------------------------------------------- tunnel.open
export interface TunnelPayload {
  readonly inv: Invocation
  readonly kind: TunnelKind
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly port?: number | undefined
  readonly streamId: string
  readonly streamToken: string
}

/** Tunnel kinds this node can open (`node.hello.tunnels`). */
export const availableTunnels = (config: NodeConfigShape): ReadonlyArray<TunnelKind> => [
  "tcp",
  ...(config.binaries.codex ? (["codex.exec-server", "codex.app-server"] as const) : []),
]

const botStateDir = (config: NodeConfigShape, botId: string, sub: string): string => {
  if (!SAFE_ID.test(botId)) throw new Error("invalid bot id")
  const d = path.join(config.dataDir, "bots", botId, sub)
  mkdirSync(d, { recursive: true, mode: 0o700 })
  return d
}

/** NDJSON stdio <-> one JSON-RPC message per text frame. */
const bridgeNdjson = (
  io: Duplex,
  proc: Bun.Subprocess<"pipe", "pipe", "ignore" | "pipe" | number | Bun.BunFile>,
): Effect.Effect<"exit" | "closed", never, Scope.Scope> =>
  Effect.gen(function* () {
    const out = yield* Queue.unbounded<Uint8Array | string, Cause.Done>()
    const pumpStdout = (async () => {
      const d = new TextDecoder()
      let buf = ""
      try {
        for await (const c of proc.stdout) {
          buf += d.decode(c, { stream: true })
          let i: number
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim()
            buf = buf.slice(i + 1)
            if (line) Queue.offerUnsafe(out, line)
          }
        }
        if (buf.trim()) Queue.offerUnsafe(out, buf.trim())
      } catch {
        // closed
      }
    })()
    const writer = yield* Effect.forkScoped(writeOut(io, out))
    const reader = yield* Effect.forkScoped(
      readFrames(io, (f) => {
        try {
          proc.stdin.write(frameText(f) + "\n")
          proc.stdin.flush()
        } catch {
          // stdin closed
        }
      }),
    )
    const ended = yield* Effect.raceFirst(
      Effect.promise(() => proc.exited).pipe(Effect.as("exit" as const)),
      Fiber.await(reader).pipe(Effect.as("closed" as const)),
    )
    if (ended === "exit") {
      yield* Effect.promise(() => Promise.race([pumpStdout, Bun.sleep(1000)]))
      yield* Queue.end(out)
      yield* Fiber.await(writer).pipe(Effect.timeoutOption(2000))
      yield* Effect.ignore(io.writer.write(new Socket.CloseEvent(1000, `exit:${proc.exitCode ?? proc.signalCode}`)))
    }
    return ended
  })

/** Raw bytes between a node:net socket and the stream, until either side ends. */
export const bridgeNet = (io: Duplex, sock: net.Socket): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const out = yield* Queue.unbounded<Uint8Array | string, Cause.Done>()
    const closed = yield* Deferred.make<void>()
    sock.on("data", (d: Buffer) => void Queue.offerUnsafe(out, new Uint8Array(d)))
    sock.on("close", () => {
      Queue.endUnsafe(out)
      Deferred.doneUnsafe(closed, Effect.void)
    })
    sock.on("error", () => undefined)
    yield* Effect.addFinalizer(() => Effect.sync(() => sock.destroy()))
    const writer = yield* Effect.forkScoped(writeOut(io, out))
    const reader = yield* Effect.forkScoped(
      readFrames(io, (f) => {
        if (typeof f !== "string") sock.write(f)
      }),
    )
    yield* Effect.raceFirst(Deferred.await(closed), Fiber.await(reader).pipe(Effect.asVoid))
    yield* Fiber.await(writer).pipe(Effect.timeoutOption(1000))
    yield* Effect.ignore(io.writer.write(new Socket.CloseEvent(1000)))
  })

/** Connect to a node-loopback TCP port (`kind` labels the error). */
export const connectTcp = (port: number, kind = "tcp"): Effect.Effect<net.Socket, TunnelFailed, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<net.Socket, TunnelFailed>((resume) => {
      const sock = net.connect(port, "127.0.0.1")
      const onError = (e: Error) =>
        resume(Effect.fail(new TunnelFailed({ kind, reason: `connect 127.0.0.1:${port}: ${e.message}` })))
      sock.once("error", onError)
      sock.once("connect", () => {
        sock.off("error", onError)
        resume(Effect.succeed(sock))
      })
    }),
    (sock) => Effect.sync(() => sock.destroy()),
  )

export const makeTunnelOpen = (deps: SessionDeps) => (p: TunnelPayload) =>
  Effect.gen(function* () {
    const { config } = deps
    if (p.kind === "claude.cli") {
      return yield* new TunnelFailed({
        kind: p.kind,
        reason: "claude.cli tunnels are not supported by this node yet (v1 uses brain-side Claude)",
      })
    }
    if (p.kind === "tcp") {
      const port = p.port
      if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
        return yield* new TunnelFailed({ kind: "tcp", reason: "a valid node-loopback port is required" })
      }
      yield* deps.guard.check({ inv: p.inv, action: "tunnel", target: `tcp:127.0.0.1:${port}` })
      yield* startSession<null>(deps, "tcp", (ready) =>
        Effect.gen(function* () {
          const sock = yield* connectTcp(port)
          const io = yield* dialSession(deps, { streamId: p.streamId, streamToken: p.streamToken }, "tcp")
          yield* Deferred.succeed(ready, null)
          yield* bridgeNet(io, sock)
        }),
      )
      return { pid: null }
    }
    const codex = config.binaries.codex
    if (!codex) return yield* new TunnelFailed({ kind: p.kind, reason: "codex is not installed on this node" })
    const cwd = yield* resolveDir(deps.paths, p.inv.botId, p.cwd).pipe(
      Effect.mapError((e) => new TunnelFailed({ kind: p.kind, reason: e.reason })),
    )
    const argv = p.kind === "codex.exec-server" ? [codex, "exec-server", "--listen", "stdio"] : [codex, "app-server"]
    yield* deps.guard.check({ inv: p.inv, action: "tunnel", target: `${p.kind} ${argv.slice(1).join(" ")}` })
    const pid = yield* startSession<number>(deps, p.kind, (ready) =>
      Effect.gen(function* () {
        const io = yield* dialSession(deps, { streamId: p.streamId, streamToken: p.streamToken }, p.kind)
        const home = yield* Effect.try({
          try: () => botStateDir(config, p.inv.botId, p.kind === "codex.exec-server" ? "codex-exec" : "codex-home"),
          catch: (e) => new TunnelFailed({ kind: p.kind, reason: reasonOf(e) }),
        })
        const proc = yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              Bun.spawn(argv, {
                cwd,
                detached: true,
                stdin: "pipe",
                stdout: "pipe",
                stderr: Bun.file(path.join(home, "stderr.log")),
                env: baseEnv({
                  ...filterEnv(p.env),
                  CODEX_HOME: home,
                  OPENBOT_NODE_ID: config.nodeId,
                  OPENBOT_BOT_ID: p.inv.botId,
                }),
              }),
            catch: (e) => new TunnelFailed({ kind: p.kind, reason: `could not start codex: ${reasonOf(e)}` }),
          }),
          (child) => terminateGroup(child, 500),
        )
        yield* Deferred.succeed(ready, proc.pid)
        yield* bridgeNdjson(io, proc)
      }),
    )
    return { pid }
  })

// ---------------------------------------------------------------- service.start / service.stop
export interface ServiceRegistry {
  readonly services: Map<string, { readonly fiber: Fiber.Fiber<unknown, unknown>; readonly botId: string }>
  next: number
}

export const makeServiceStart =
  (deps: SessionDeps, registry: ServiceRegistry) =>
  (p: {
    readonly inv: Invocation
    readonly kind: "opencode.serve"
    readonly env: Readonly<Record<string, string>>
    readonly cwd: string
  }) =>
    Effect.gen(function* () {
      const bin = deps.config.binaries.opencode
      if (!bin) return yield* new TunnelFailed({ kind: p.kind, reason: "opencode is not installed on this node" })
      const cwd = yield* resolveDir(deps.paths, p.inv.botId, p.cwd)
      yield* deps.guard.check({ inv: p.inv, action: "service", target: `${p.kind} ${cwd}` })
      const serviceId = `svc_${++registry.next}`
      const ready = yield* Deferred.make<{ port: number; pid: number }, TunnelFailed>()
      const fiber = yield* FiberSet.run(
        deps.sessions,
        Effect.scoped(
          Effect.gen(function* () {
            const st = yield* Effect.try({
              try: () => botStateDir(deps.config, p.inv.botId, "opencode"),
              catch: (e) => new TunnelFailed({ kind: p.kind, reason: reasonOf(e) }),
            })
            const proc = yield* Effect.acquireRelease(
              Effect.try({
                try: () =>
                  Bun.spawn([bin, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
                    cwd,
                    detached: true,
                    stdin: "ignore",
                    stdout: "pipe",
                    stderr: Bun.file(path.join(st, "stderr.log")),
                    env: baseEnv({ ...filterEnv(p.env), OPENCODE_CLIENT: "openbot-node", OPENBOT_BOT_ID: p.inv.botId }),
                  }),
                catch: (e) => new TunnelFailed({ kind: p.kind, reason: `could not start opencode: ${reasonOf(e)}` }),
              }),
              (child) => terminateGroup(child, 1000),
            )
            // opencode prints its listen URL; accept JSON {"url"} or a plain "http://127.0.0.1:<port>" line
            const port = yield* Effect.tryPromise({
              try: async () => {
                const d = new TextDecoder()
                let buf = ""
                const reader = proc.stdout.getReader()
                while (true) {
                  const { value, done } = await reader.read()
                  if (done) throw new Error(`opencode exited before listening: ${buf.slice(0, 300)}`)
                  buf += d.decode(value, { stream: true })
                  const m = /https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(buf)
                  if (m) {
                    // keep draining stdout so the server never blocks on a full pipe
                    void (async () => {
                      try {
                        while (!(await reader.read()).done) {
                          // discard
                        }
                      } catch {
                        // closed
                      }
                    })()
                    return Number(m[1])
                  }
                }
              },
              catch: (e) => new TunnelFailed({ kind: p.kind, reason: reasonOf(e) }),
            }).pipe(
              Effect.timeoutOrElse({
                duration: 30_000,
                orElse: () =>
                  Effect.fail(new TunnelFailed({ kind: p.kind, reason: "opencode did not report a port within 30 s" })),
              }),
            )
            yield* Deferred.succeed(ready, { port, pid: proc.pid })
            yield* Effect.promise(() => proc.exited)
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Deferred.fail(ready, new TunnelFailed({ kind: p.kind, reason: reasonOf(Cause.squash(cause)) })),
          ),
          Effect.ensuring(Effect.sync(() => void registry.services.delete(serviceId))),
        ),
      )
      registry.services.set(serviceId, { fiber, botId: p.inv.botId })
      const { port, pid } = yield* Deferred.await(ready)
      return { serviceId, port, pid }
    })

export const makeServiceStop =
  (registry: ServiceRegistry) => (p: { readonly inv: Invocation; readonly serviceId: string }) =>
    Effect.gen(function* () {
      const s = registry.services.get(p.serviceId)
      if (!s || s.botId !== p.inv.botId) return
      registry.services.delete(p.serviceId)
      yield* Fiber.interrupt(s.fiber)
    })

// ---------------------------------------------------------------- forward.listen
type ForwardAddress = { readonly port: number | null; readonly path: string | null }

/**
 * Idempotent per (bot, kind, transport): a repeated call (e.g. a retried tool call) returns the
 * listener that is already open instead of opening another one.
 */
export const makeForwardListen = (
  deps: SessionDeps,
  runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>,
) => {
  const listeners = new Map<string, Deferred.Deferred<ForwardAddress, TunnelFailed>>()
  return (p: { readonly inv: Invocation; readonly kind: BrainStreamKind; readonly transport: "tcp" | "unix" }) =>
    Effect.gen(function* () {
      const botId = p.inv.botId
      if (!SAFE_ID.test(botId)) return yield* new TunnelFailed({ kind: p.kind, reason: "invalid bot id" })
      yield* deps.guard
        .check({ inv: p.inv, action: "forward", target: `${p.kind}/${p.transport}` })
        .pipe(Effect.mapError((e) => new TunnelFailed({ kind: p.kind, reason: e.reason })))
      const key = `${botId}\u0000${p.kind}\u0000${p.transport}`
      const existing = listeners.get(key)
      if (existing) return yield* Deferred.await(existing)
      const done = yield* Deferred.make<ForwardAddress, TunnelFailed>()
      listeners.set(key, done)
      return yield* openForward(deps, runFork, p).pipe(
        Effect.onExit((exit) =>
          Effect.andThen(
            Effect.sync(() => {
              if (exit._tag === "Failure") listeners.delete(key)
            }),
            Deferred.done(done, exit),
          ),
        ),
      )
    })
}

const openForward = (
  deps: SessionDeps,
  runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>,
  p: { readonly inv: Invocation; readonly kind: BrainStreamKind; readonly transport: "tcp" | "unix" },
): Effect.Effect<ForwardAddress, TunnelFailed> =>
  Effect.gen(function* () {
    const botId = p.inv.botId
    const onConnection = (sock: net.Socket) => {
      sock.pause()
      runFork(
        Effect.scoped(
          Effect.gen(function* () {
            const ticket = yield* deps.brain.openStream({ kind: p.kind, botId })
            const io = yield* dialSession(deps, ticket, p.kind)
            sock.resume()
            yield* bridgeNet(io, sock)
          }),
        ).pipe(Effect.catchCause(() => Effect.sync(() => sock.destroy()))),
      )
    }
    const server = net.createServer(onConnection)
    const listen = (target: { port: number; host: string } | { path: string }) =>
      Effect.callback<void, TunnelFailed>((resume) => {
        server.once("error", (e) => resume(Effect.fail(new TunnelFailed({ kind: p.kind, reason: e.message }))))
        if ("path" in target) server.listen(target.path, () => resume(Effect.void))
        else server.listen(target.port, target.host, () => resume(Effect.void))
      })
    yield* Scope.addFinalizer(
      deps.scope,
      Effect.sync(() => server.close()),
    )
    if (p.transport === "unix") {
      const dir = path.join(deps.config.dataDir, "run")
      const sockPath = path.join(dir, `${p.kind}-${botId}.sock`)
      yield* Effect.try({
        try: () => {
          mkdirSync(dir, { recursive: true, mode: 0o700 })
          rmSync(sockPath, { force: true })
        },
        catch: (e) => new TunnelFailed({ kind: p.kind, reason: reasonOf(e) }),
      })
      yield* listen({ path: sockPath })
      try {
        chmodSync(sockPath, 0o600)
      } catch {
        // best effort
      }
      return { port: null, path: sockPath }
    }
    yield* listen({ port: 0, host: "127.0.0.1" })
    const addr = server.address()
    return { port: typeof addr === "object" && addr ? addr.port : null, path: null }
  })
