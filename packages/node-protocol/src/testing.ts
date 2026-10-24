// Test helpers (subpath `@openbot/node-protocol/testing`): an in-memory, frame-preserving socket pair with
// WebSocket-like semantics, so brain and node peers can be wired without a network.
import * as Effect from "effect/Effect"
import * as Scope from "effect/Scope"
import * as Socket from "effect/socket/Socket"

type Frame = string | Uint8Array
type NonEmpty<A> = readonly [A, ...Array<A>]

const closeError = (code: number, closeReason?: string) =>
  new Socket.SocketError({ reason: new Socket.SocketCloseError({ code, closeReason }) })

interface Endpoint {
  buf: Array<Frame>
  err: Socket.SocketError | undefined
  waiter: ((e: Effect.Effect<NonEmpty<Frame>, Socket.SocketError>) => void) | undefined
  /** every frame this endpoint wrote (for wire assertions) */
  sent: Array<Frame>
}

const makeEndpoint = (): Endpoint => ({ buf: [], err: undefined, waiter: undefined, sent: [] })

const deliver = (e: Endpoint, f: Frame) => {
  if (e.err) return
  e.buf.push(f)
  if (e.waiter) {
    const w = e.waiter
    e.waiter = undefined
    const b = e.buf
    e.buf = []
    w(Effect.succeed(b as unknown as NonEmpty<Frame>))
  }
}

const fail = (e: Endpoint, err: Socket.SocketError) => {
  if (!e.err) e.err = err
  if (e.waiter) {
    const w = e.waiter
    e.waiter = undefined
    if (e.buf.length) {
      const b = e.buf
      e.buf = []
      w(Effect.succeed(b as unknown as NonEmpty<Frame>))
    } else w(Effect.fail(e.err))
  }
}

export interface MemorySocketPair {
  readonly a: Socket.Socket
  readonly b: Socket.Socket
  /** frames written by side a / side b */
  readonly sentByA: ReadonlyArray<Frame>
  readonly sentByB: ReadonlyArray<Frame>
  /** Simulate a connection drop (both sides see a close with `code`). */
  readonly drop: (code?: number, reason?: string) => void
}

/**
 * Two connected sockets. Each frame written on one side arrives as one frame on the other (text stays text).
 * Writing a `CloseEvent` or releasing a reader's scope closes the connection for both sides (like a
 * WebSocket close handshake). Readers may be acquired more than once (re-acquisition after close fails).
 */
export const makeMemorySocketPair = (options?: {
  /** Keep every written frame in `sentByA` / `sentByB` (default true; off for bulk data such as transfers). */
  readonly record?: boolean
}): MemorySocketPair => {
  const record = options?.record ?? true
  const ea = makeEndpoint()
  const eb = makeEndpoint()
  const drop = (code = 1006, reason?: string) => {
    fail(ea, closeError(code, reason))
    fail(eb, closeError(code, reason))
  }
  const side = (self: Endpoint, peer: Endpoint): Socket.Socket => {
    const pull = Effect.callback<NonEmpty<Frame>, Socket.SocketError>((resume) => {
      if (self.buf.length) {
        const b = self.buf
        self.buf = []
        return resume(Effect.succeed(b as unknown as NonEmpty<Frame>))
      }
      if (self.err) return resume(Effect.fail(self.err))
      self.waiter = resume
      return Effect.sync(() => {
        if (self.waiter === resume) self.waiter = undefined
      })
    })
    const writer: Socket.Writer = {
      write: (chunk) =>
        Effect.suspend(() => {
          if (Socket.isCloseEvent(chunk)) {
            drop(chunk.code, chunk.reason)
            return Effect.void
          }
          if (self.err) return Effect.fail(self.err)
          if (record) self.sent.push(chunk)
          deliver(peer, chunk)
          return Effect.void
        }),
      writeAll: (chunks) =>
        Effect.suspend(() => {
          if (self.err) return Effect.fail(self.err)
          for (const c of chunks) {
            if (record) self.sent.push(c)
            deliver(peer, c)
          }
          return Effect.void
        }),
    }
    return Socket.make({
      reader: Effect.gen(function* () {
        if (self.err) return yield* Effect.fail(self.err)
        const scope = yield* Effect.scope
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => drop(1000, "closed")),
        )
        return { pull, upgrade: Socket.SocketUpgradeError.unsupported }
      }),
      writer: Effect.succeed(writer),
    })
  }
  return { a: side(ea, eb), b: side(eb, ea), sentByA: ea.sent, sentByB: eb.sent, drop }
}

/** A raw (non-Effect-RPC) endpoint over a socket: send JSON frames and await incoming ones. */
export const rawJsonPeer = (socket: Socket.Socket) =>
  Effect.gen(function* () {
    const { pull } = yield* socket.reader
    const writer = yield* socket.writer
    const pending: Array<unknown> = []
    const decoder = new TextDecoder()
    const next: Effect.Effect<unknown, Socket.SocketError> = Effect.suspend(() => {
      if (pending.length) return Effect.succeed(pending.shift())
      return Effect.map(pull, (frames) => {
        for (const f of frames) {
          const v = JSON.parse(typeof f === "string" ? f : decoder.decode(f)) as unknown
          if (Array.isArray(v)) pending.push(...v)
          else pending.push(v)
        }
        return pending.shift()
      })
    })
    /** next message not matching `skip` (e.g. pings) */
    const nextWhere = (pred: (m: any) => boolean, skip?: (m: any) => Effect.Effect<void, Socket.SocketError>) =>
      Effect.gen(function* () {
        while (true) {
          const m = yield* next
          if (pred(m)) return m as any
          if (skip) yield* skip(m)
        }
      })
    return {
      send: (m: unknown) => writer.write(JSON.stringify(m)),
      next,
      nextWhere,
      /** take whatever is already buffered without waiting */
      buffered: () => pending.splice(0),
    }
  })
