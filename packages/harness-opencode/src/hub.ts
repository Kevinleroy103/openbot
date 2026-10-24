/**
 * The OpenCode host: one `opencode serve` per brain, started lazily and restarted on demand, with
 * ONE event subscription routed by `sessionID` (D2.3, sdk-opencode.md §7.1, §12.2).
 *
 * - **Readiness barrier.** A connection is handed out only after its subscription delivered
 *   `server.connected`, so a session always subscribes before it prompts.
 * - **Never blocks the consumer.** Events are dispatched synchronously into per-session queues; a
 *   slow consumer would otherwise overflow the server's 4096-event buffer and drop the stream.
 * - **Generations.** Each started server gets a new `generation`. A server restart silently drops
 *   runtime `mcp.add` registrations (recovery-matrix.md finding 2), so sessions compare the
 *   generation before every prompt and re-register.
 * - **Failure model.** The Promise client does not reconnect, and stdio-mode servers lose pending
 *   approvals on exit. When the server exits, the stream ends or goes silent, the connection is
 *   declared dead: routes get `onDisconnect` (sessions fail their active turn, retryable) and the
 *   server is stopped. The next `connection` call starts a fresh one.
 * - **Child sessions** (subagents) are routed to their root session (approvals reach the bot).
 */
import { HarnessError } from "@openbot/core"
import { Cause, Deferred, Effect, Exit, FiberSet, Option, Schedule, Scope, Semaphore, Stream } from "effect"
import { describeClientError, type OpenCodeApi, type OpenCodeEvent } from "./client.ts"
import { eventSessionId } from "./normalize.ts"
import type { OpenCodeTransport } from "./server.ts"

export interface HostRoute {
  /** Called synchronously on the consumer; must not block. */
  readonly onEvent: (event: OpenCodeEvent) => void
  /** The connection died (server exit, stream loss). Called at most once per generation. */
  readonly onDisconnect: (reason: string) => void
}

export interface HostConnection {
  readonly client: OpenCodeApi
  readonly version: string
  /** Increments with every started server. */
  readonly generation: number
}

/** A model as listed by `model.list` (SDK shape kept inside the package). */
export interface NativeModel {
  readonly providerID: string
  readonly id: string
  readonly name: string
  readonly variants: ReadonlyArray<string>
  readonly context: number | undefined
  readonly enabled: boolean
  readonly status: string | undefined
}

export interface OpenCodeHost {
  /** The live connection; starts (or restarts) the server and waits for `server.connected`. */
  readonly connection: Effect.Effect<HostConnection, HarnessError>
  /** The live connection, if any, without starting one. */
  readonly current: Effect.Effect<HostConnection | undefined>
  /** Routes the events of `sessionID` (and its child sessions) until the scope closes. */
  readonly register: (sessionID: string, route: HostRoute) => Effect.Effect<void, never, Scope.Scope>
  /** Declares the current connection dead and stops its server. */
  readonly invalidate: (reason: string) => Effect.Effect<void>
  /** `model.list` for a location (retried while the catalog is still loading); refreshes the window cache. */
  readonly models: (directory: string) => Effect.Effect<ReadonlyArray<NativeModel>, HarnessError>
  /** Context window of a model from the last `models` call. */
  readonly contextWindow: (model: { readonly providerID: string; readonly id: string }) => number | undefined
}

export interface HostOptions {
  /** Starts one server (spawn, or a fake in tests); stopped when the given scope closes. */
  readonly start: Effect.Effect<OpenCodeTransport, HarnessError, Scope.Scope>
  /** Time allowed for `server.connected` after the server is up. Default 15 s. */
  readonly readyTimeoutMs?: number | undefined
  /** Declare the stream dead after this long without any SSE activity (heartbeats every 10–15 s). 0 disables. Default 60 s. */
  readonly silentTimeoutMs?: number | undefined
  /** Model catalog retries while `model.list` is still empty right after start. Default 12 × 500 ms. */
  readonly modelRetries?: number | undefined
}

type Rec = Readonly<Record<string, unknown>>
const rec = (u: unknown): Rec => (typeof u === "object" && u !== null && !Array.isArray(u) ? (u as Rec) : {})
const str = (u: unknown): string | undefined => (typeof u === "string" ? u : undefined)

const harnessError = (code: HarnessError["code"], message: string, cause?: unknown) =>
  new HarnessError({ harness: "opencode", code, message, ...(cause === undefined ? {} : { cause }) })

interface Live {
  readonly connection: HostConnection
  readonly scope: Scope.Closeable
  dead: boolean
}

export const makeHost = (options: HostOptions): Effect.Effect<OpenCodeHost, never, Scope.Scope> =>
  Effect.gen(function* () {
    const hostScope = yield* Effect.scope
    const background = yield* FiberSet.make()
    const lock = yield* Semaphore.make(1)
    const routes = new Map<string, HostRoute>()
    /** child sessionID → root sessionID */
    const children = new Map<string, string>()
    const windows = new Map<string, number>()
    let generation = 0
    let current: Live | undefined
    const readyTimeoutMs = options.readyTimeoutMs ?? 15_000
    const silentTimeoutMs = options.silentTimeoutMs ?? 60_000

    const rootOf = (sessionID: string): string | undefined =>
      routes.has(sessionID) ? sessionID : children.get(sessionID)

    const dispatch = (event: OpenCodeEvent) => {
      if (event.type === "session.created") {
        const data = rec(event.data)
        const id = str(data.sessionID)
        const parent = str(data.parentID)
        const root = parent ? rootOf(parent) : undefined
        if (id && root) children.set(id, root)
      }
      const sessionID = eventSessionId(event)
      if (!sessionID) return
      const root = rootOf(sessionID)
      if (root) routes.get(root)?.onEvent(event)
    }

    const markDead = (live: Live, reason: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (live.dead) return Effect.void
        live.dead = true
        if (current === live) current = undefined
        for (const route of routes.values()) {
          try {
            route.onDisconnect(reason)
          } catch {
            // a route must never break the host
          }
        }
        // Closing from a fiber that lives in `live.scope` would interrupt itself: run it in the host set.
        return Effect.asVoid(FiberSet.run(background, Scope.close(live.scope, Exit.void)))
      })

    const start: Effect.Effect<HostConnection, HarnessError> = Effect.gen(function* () {
      const scope = yield* Scope.fork(hostScope)
      const transport = yield* Scope.provide(scope)(options.start).pipe(
        Effect.onError(() => Scope.close(scope, Exit.void)),
      )
      generation += 1
      const live: Live = {
        connection: { client: transport.client, version: transport.version, generation },
        scope,
        dead: false,
      }
      const ready = yield* Deferred.make<void, HarnessError>()
      const abort = new AbortController()
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => abort.abort()),
      )
      let lastActivity = Date.now()
      const touch = () => {
        lastActivity = Date.now()
      }

      const consume = Stream.fromAsyncIterable(
        transport.client.event.subscribe({ signal: abort.signal, onActivity: touch }),
        (cause) => cause,
      ).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            touch()
            if (event.type === "server.connected") Deferred.doneUnsafe(ready, Effect.void)
            else dispatch(event)
          }),
        ),
        Effect.matchEffect({
          onFailure: (cause) => {
            const reason = `The OpenCode event stream failed: ${describeClientError(cause)}`
            return Deferred.fail(ready, harnessError("open-failed", reason, cause)).pipe(
              Effect.andThen(markDead(live, reason)),
            )
          },
          onSuccess: () => {
            const reason = "The OpenCode event stream ended."
            return Deferred.fail(ready, harnessError("open-failed", reason)).pipe(
              Effect.andThen(markDead(live, reason)),
            )
          },
        }),
      )
      yield* Effect.forkIn(consume, scope)
      yield* Effect.forkIn(
        transport.exited.pipe(
          Effect.flatMap((reason) =>
            Deferred.fail(ready, harnessError("closed", reason)).pipe(Effect.andThen(markDead(live, reason))),
          ),
        ),
        scope,
      )
      if (silentTimeoutMs > 0) {
        yield* Effect.forkIn(
          Effect.suspend(() =>
            Date.now() - lastActivity > silentTimeoutMs
              ? markDead(live, "The OpenCode event stream went silent.").pipe(
                  Effect.andThen(Effect.fail("dead" as const)),
                )
              : Effect.void,
          ).pipe(Effect.repeat(Schedule.spaced(Math.max(250, Math.floor(silentTimeoutMs / 4)))), Effect.ignore),
          scope,
        )
      }

      yield* Deferred.await(ready).pipe(
        Effect.timeoutOrElse({
          duration: readyTimeoutMs,
          orElse: () =>
            Effect.fail(
              harnessError("open-failed", "Timed out waiting for the OpenCode event stream (server.connected)."),
            ),
        }),
        Effect.onError((cause) => {
          const error = Cause.findErrorOption(cause)
          return markDead(
            live,
            Option.isSome(error) ? error.value.message : "Starting the OpenCode server was interrupted.",
          )
        }),
      )
      current = live
      return live.connection
    })

    const connection = lock.withPermits(1)(
      Effect.suspend(() => (current !== undefined && !current.dead ? Effect.succeed(current.connection) : start)),
    )

    const models = (directory: string): Effect.Effect<ReadonlyArray<NativeModel>, HarnessError> =>
      Effect.gen(function* () {
        const { client } = yield* connection
        const list = Effect.tryPromise({
          try: (signal) => client.model.list({ location: { directory } }, { signal }),
          catch: (cause) => harnessError("protocol", `model.list failed: ${describeClientError(cause)}`, cause),
        })
        // Right after start the catalog may still be empty ("may precede initial plugin settlement").
        const output = yield* list.pipe(
          Effect.flatMap((out) => (out.data.length === 0 ? Effect.fail("empty" as const) : Effect.succeed(out))),
          Effect.retry({ times: options.modelRetries ?? 12, schedule: Schedule.spaced(500) }),
          Effect.catch((error) => (error === "empty" ? list : Effect.fail(error))),
        )
        const result = output.data.map((m): NativeModel => ({
          providerID: m.providerID,
          id: m.id,
          name: m.name,
          variants: (m.variants ?? []).map((v) => v.id),
          context: typeof m.limit?.context === "number" && m.limit.context > 0 ? m.limit.context : undefined,
          enabled: m.enabled !== false,
          status: m.status,
        }))
        for (const m of result) if (m.context !== undefined) windows.set(`${m.providerID}/${m.id}`, m.context)
        return result
      })

    return {
      connection,
      current: Effect.sync(() => (current !== undefined && !current.dead ? current.connection : undefined)),
      register: (sessionID, route) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            routes.set(sessionID, route)
          }),
          () =>
            Effect.sync(() => {
              if (routes.get(sessionID) === route) routes.delete(sessionID)
              for (const [child, root] of children) if (root === sessionID) children.delete(child)
            }),
        ),
      invalidate: (reason) => Effect.suspend(() => (current ? markDead(current, reason) : Effect.void)),
      models,
      contextWindow: (model) => windows.get(`${model.providerID}/${model.id}`),
    } satisfies OpenCodeHost
  })
