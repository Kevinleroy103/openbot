// Minimal Chrome DevTools Protocol client over the browser-level WebSocket, flattened sessions
// (`Target.attachToTarget {flatten: true}` → `sessionId` on every message). No Playwright
// (docs/architecture.md §4.7). Ported from vendor/scratch/browser/cdp-*.ts.
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"

export class CdpError extends Schema.TaggedError<CdpError>()("CdpError", {
  method: Schema.String,
  message: Schema.String,
}) {}

export interface CdpEvent {
  readonly method: string
  readonly params: any
  readonly sessionId?: string | undefined
}

export interface CdpClient {
  readonly send: <T = any>(
    method: string,
    params?: Record<string, unknown> | undefined,
    sessionId?: string | undefined,
    timeoutMs?: number | undefined,
  ) => Effect.Effect<T, CdpError>
  /** Fire-and-forget (acks, best-effort calls). */
  readonly sendUnsafe: (method: string, params?: Record<string, unknown>, sessionId?: string) => void
  /** Subscribe to events; returns the unsubscribe function. */
  readonly on: (listener: (event: CdpEvent) => void) => () => void
  /** Wait for the first event matching `pred` (registered before `trigger` runs). */
  readonly waitFor: <A>(
    pred: (event: CdpEvent) => boolean,
    trigger: Effect.Effect<A, CdpError>,
    timeoutMs: number,
  ) => Effect.Effect<{ readonly result: A; readonly event: CdpEvent | undefined }, CdpError>
  readonly isOpen: () => boolean
  readonly closed: Promise<void>
  readonly close: () => void
}

const DEFAULT_TIMEOUT_MS = 30_000

export const connectCdp = (wsUrl: string): Effect.Effect<CdpClient, CdpError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<CdpClient>((resolve, reject) => {
          const ws = new WebSocket(wsUrl)
          let nextId = 1
          let open = false
          const pending = new Map<
            number,
            { resolve: (v: any) => void; reject: (e: CdpError) => void; method: string }
          >()
          const listeners = new Set<(e: CdpEvent) => void>()
          let markClosed: () => void = () => undefined
          const closed = new Promise<void>((r) => (markClosed = r))
          ws.addEventListener("message", (ev) => {
            let msg: any
            try {
              msg = JSON.parse(String(ev.data))
            } catch {
              return
            }
            if (typeof msg.id === "number") {
              const p = pending.get(msg.id)
              if (!p) return
              pending.delete(msg.id)
              if (msg.error)
                p.reject(new CdpError({ method: p.method, message: String(msg.error.message ?? "CDP error") }))
              else p.resolve(msg.result ?? {})
              return
            }
            if (typeof msg.method === "string") {
              const e: CdpEvent = { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId }
              for (const l of [...listeners]) {
                try {
                  l(e)
                } catch {
                  // listener errors never break the client
                }
              }
            }
          })
          ws.addEventListener("close", () => {
            open = false
            for (const p of pending.values())
              p.reject(new CdpError({ method: p.method, message: "browser connection closed" }))
            pending.clear()
            markClosed()
          })
          ws.addEventListener("error", () => {
            if (!open) reject(new Error(`cannot connect to ${wsUrl}`))
          })
          ws.addEventListener("open", () => {
            open = true
            const rawSend = (
              id: number,
              method: string,
              params: Record<string, unknown> | undefined,
              sessionId: string | undefined,
            ) => ws.send(JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) }))
            const client: CdpClient = {
              send: <T>(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number) =>
                Effect.callback<T, CdpError>((resume) => {
                  if (!open) return resume(Effect.fail(new CdpError({ method, message: "browser connection closed" })))
                  const id = nextId++
                  pending.set(id, {
                    method,
                    resolve: (v) => resume(Effect.succeed(v as T)),
                    reject: (e) => resume(Effect.fail(e)),
                  })
                  try {
                    rawSend(id, method, params, sessionId)
                  } catch (e) {
                    pending.delete(id)
                    resume(Effect.fail(new CdpError({ method, message: String(e) })))
                  }
                  return Effect.sync(() => void pending.delete(id))
                }).pipe(
                  Effect.timeoutOrElse({
                    duration: timeoutMs ?? DEFAULT_TIMEOUT_MS,
                    orElse: () =>
                      Effect.fail(
                        new CdpError({ method, message: `timed out after ${timeoutMs ?? DEFAULT_TIMEOUT_MS} ms` }),
                      ),
                  }),
                ),
              sendUnsafe: (method, params, sessionId) => {
                if (!open) return
                try {
                  rawSend(nextId++, method, params, sessionId)
                } catch {
                  // ignore
                }
              },
              on: (l) => {
                listeners.add(l)
                return () => void listeners.delete(l)
              },
              waitFor: (pred, trigger, timeoutMs) =>
                Effect.gen(function* () {
                  let hit: CdpEvent | undefined
                  let wake: (() => void) | undefined
                  const off = client.on((e) => {
                    if (hit === undefined && pred(e)) {
                      hit = e
                      wake?.()
                    }
                  })
                  return yield* Effect.gen(function* () {
                    const result = yield* trigger
                    if (hit === undefined) {
                      yield* Effect.callback<void>((resume) => {
                        if (hit !== undefined) return resume(Effect.void)
                        wake = () => resume(Effect.void)
                        return Effect.sync(() => {
                          wake = undefined
                        })
                      }).pipe(Effect.timeoutOption(timeoutMs))
                    }
                    return { result, event: hit }
                  }).pipe(Effect.ensuring(Effect.sync(off)))
                }),
              isOpen: () => open,
              closed,
              close: () => {
                try {
                  ws.close()
                } catch {
                  // ignore
                }
              },
            }
            resolve(client)
          })
        }),
      catch: (e) => new CdpError({ method: "connect", message: e instanceof Error ? e.message : String(e) }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: 10_000,
        orElse: () => Effect.fail(new CdpError({ method: "connect", message: `timed out connecting to ${wsUrl}` })),
      }),
    ),
    (c) => Effect.sync(() => c.close()),
  )
