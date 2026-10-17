// Effect `Socket`s for the node side.
//
// `dialWebSocket` opens the WebSocket EAGERLY (so a refused upgrade or an expired stream token is a
// typed failure at dial time) and buffers frames from the first moment, so nothing the brain sends
// right after the upgrade is lost. Each frame stays one frame (text stays text, binary stays binary).
// Releasing the dial scope closes the socket with 1000.
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Scope from "effect/Scope"
import * as Socket from "effect/socket/Socket"

type Frame = string | Uint8Array
type NonEmpty<A> = readonly [A, ...Array<A>]

export const closeError = (code: number, closeReason?: string): Socket.SocketError =>
  new Socket.SocketError({ reason: new Socket.SocketCloseError({ code, closeReason }) })

export const openError = (message: string, kind: "Unknown" | "Timeout" = "Unknown"): Socket.SocketError =>
  new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind, cause: new Error(message) }) })

/** Close code of a socket error, if it was a close. */
export const closeCodeOf = (err: Socket.SocketError): number | undefined =>
  err.reason._tag === "SocketCloseError" ? err.reason.code : undefined

export interface DialOptions {
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly openTimeout?: Duration.Input | undefined
}

/** A frame-preserving inbox with one pending reader (the Socket `pull` contract). */
export const makeInbox = () => {
  let buf: Array<Frame> = []
  let err: Socket.SocketError | undefined
  let waiter: ((e: Effect.Effect<NonEmpty<Frame>, Socket.SocketError>) => void) | undefined
  const take = () => {
    const b = buf
    buf = []
    return b as unknown as NonEmpty<Frame>
  }
  return {
    get error() {
      return err
    },
    push(f: Frame) {
      if (err) return
      buf.push(f)
      if (waiter) {
        const w = waiter
        waiter = undefined
        w(Effect.succeed(take()))
      }
    },
    fail(e: Socket.SocketError) {
      if (!err) err = e
      if (waiter) {
        const w = waiter
        waiter = undefined
        w(buf.length ? Effect.succeed(take()) : Effect.fail(err))
      }
    },
    pull: Effect.callback<NonEmpty<Frame>, Socket.SocketError>((resume) => {
      if (buf.length) return resume(Effect.succeed(take()))
      if (err) return resume(Effect.fail(err))
      waiter = resume
      return Effect.sync(() => {
        if (waiter === resume) waiter = undefined
      })
    }),
  }
}

/** Dial a WebSocket and wait until it is open. Bun's WebSocket accepts handshake `headers`. */
export const dialWebSocket = (
  url: string,
  options?: DialOptions,
): Effect.Effect<Socket.Socket, Socket.SocketError, Scope.Scope> =>
  Effect.gen(function* () {
    const inbox = makeInbox()
    const ws = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const Ctor = globalThis.WebSocket as unknown as new (u: string, o?: unknown) => WebSocket
          const w = new Ctor(url, options?.headers ? { headers: options.headers } : undefined)
          w.binaryType = "arraybuffer"
          return w
        },
        catch: (e) => openError(e instanceof Error ? e.message : String(e)),
      }),
      (w) =>
        Effect.sync(() => {
          try {
            if (w.readyState === 0 || w.readyState === 1) w.close(1000)
          } catch {
            // already gone
          }
        }),
    )
    let opened = false
    let openResume: ((e: Effect.Effect<void, Socket.SocketError>) => void) | undefined
    let openResult: Effect.Effect<void, Socket.SocketError> | undefined
    const settleOpen = (e: Effect.Effect<void, Socket.SocketError>) => {
      if (openResult) return
      openResult = e
      if (openResume) openResume(e)
    }
    ws.addEventListener("open", () => {
      opened = true
      settleOpen(Effect.void)
    })
    ws.addEventListener("message", (ev: MessageEvent) => {
      const d = ev.data as unknown
      inbox.push(typeof d === "string" ? d : d instanceof ArrayBuffer ? new Uint8Array(d) : (d as Uint8Array))
    })
    ws.addEventListener("error", (ev: Event) => {
      const message = (ev as unknown as { message?: string }).message ?? "WebSocket error"
      if (!opened) settleOpen(Effect.fail(openError(message)))
      else inbox.fail(new Socket.SocketError({ reason: new Socket.SocketReadError({ cause: new Error(message) }) }))
    })
    ws.addEventListener("close", (ev: CloseEvent) => {
      const err = closeError(ev.code || 1006, ev.reason || undefined)
      if (!opened) settleOpen(Effect.fail(err))
      inbox.fail(err)
    })
    yield* Effect.callback<void, Socket.SocketError>((resume) => {
      if (openResult) return resume(openResult)
      openResume = resume
      return Effect.sync(() => {
        openResume = undefined
      })
    }).pipe(
      Effect.timeoutOrElse({
        duration: options?.openTimeout ?? Duration.seconds(10),
        orElse: () => Effect.fail(openError(`timeout opening ${url}`, "Timeout")),
      }),
    )
    return fromLiveWebSocket(ws, inbox)
  })

/** Wrap an OPEN WebSocket whose frames are fed into `inbox`. */
const fromLiveWebSocket = (ws: WebSocket, inbox: ReturnType<typeof makeInbox>): Socket.Socket => {
  const writer: Socket.Writer = {
    write: (chunk) =>
      Effect.suspend(() => {
        if (Socket.isCloseEvent(chunk)) {
          try {
            ws.close(chunk.code, chunk.reason)
          } catch {
            // ignore
          }
          return Effect.void
        }
        if (inbox.error || ws.readyState !== 1) return Effect.fail(inbox.error ?? closeError(1006))
        ws.send(chunk as string | Uint8Array<ArrayBuffer>)
        return Effect.void
      }),
    writeAll: (chunks) =>
      Effect.suspend(() => {
        if (inbox.error || ws.readyState !== 1) return Effect.fail(inbox.error ?? closeError(1006))
        for (const c of chunks) ws.send(c as string | Uint8Array<ArrayBuffer>)
        return Effect.void
      }),
  }
  return Socket.make({
    reader: Effect.gen(function* () {
      if (inbox.error) return yield* Effect.fail(inbox.error)
      const scope = yield* Effect.scope
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          try {
            if (ws.readyState === 1) ws.close(1000)
          } catch {
            // ignore
          }
        }),
      )
      return { pull: inbox.pull, upgrade: Socket.SocketUpgradeError.unsupported }
    }),
    writer: Effect.succeed(writer),
  })
}

export interface Duplex {
  readonly pull: Effect.Effect<ReadonlyArray<Frame>, Socket.SocketError>
  readonly writer: Socket.Writer
}

/** Acquire reader + writer once, in the caller's scope. */
export const openDuplex = (s: Socket.Socket): Effect.Effect<Duplex, Socket.SocketError, Scope.Scope> =>
  Effect.gen(function* () {
    const r = yield* s.reader
    const w = yield* s.writer
    return { pull: r.pull, writer: w }
  })

/** Text frames as strings, binary frames as bytes. */
export const frameText = (f: Frame): string => (typeof f === "string" ? f : new TextDecoder().decode(f))
