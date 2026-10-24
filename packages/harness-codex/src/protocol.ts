/**
 * JSON-RPC peer for `codex app-server` (v2 protocol, one JSON message per line over stdio).
 *
 * Ported from t3code `packages/effect-codex-app-server/src/protocol.ts`
 * (https://github.com/pingdotgg/t3code). Copyright (c) 2026 T3 Tools Inc. MIT License:
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 *   and associated documentation files (the "Software"), to deal in the Software without
 *   restriction, including without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 *   Software is furnished to do so, subject to the following conditions: The above copyright
 *   notice and this permission notice shall be included in all copies or substantial portions of
 *   the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 *
 * Changes for OpenBot:
 * - transport-agnostic (`CodexTransport`: a byte stream in, a line sink out) so tests run over
 *   in-memory queues and production over a child process;
 * - malformed or unroutable lines are logged and skipped instead of terminating every session;
 * - a server-request handler is split into an inline routing phase (keeps the ordering with
 *   notifications) and a forked answering phase, which may decline to answer (`NoReply`, used when
 *   Codex withdraws the request with `serverRequest/resolved`);
 * - per-request timeouts, and pending requests fail with `CodexTransportClosed` on termination.
 *
 * Wire rules (sdk-codex.md §3.1): there is no `"jsonrpc"` field. Requests are `{id, method,
 * params?}`, notifications `{method, params?}`, responses `{id, result}` or `{id, error}`. The
 * server numbers its own requests independently of ours (both start low), so incoming messages are
 * routed by the presence of `method`, never by `id`.
 */
import { Cause, Deferred, Duration, Effect, Exit, Queue, Scope, type Sink, Stream } from "effect"
import {
  CodexRequestTimeout,
  CodexRpcError,
  CodexTransportClosed,
  type CodexPeerError,
  RpcErrorCodes,
} from "./errors.ts"

export type JsonRpcId = string | number

export interface IncomingNotification {
  readonly method: string
  readonly params: unknown
}

export interface IncomingRequest {
  readonly id: JsonRpcId
  readonly method: string
  readonly params: unknown
}

export interface RpcErrorShape {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

/** Returned by a server-request handler that must not answer (the request was withdrawn). */
export const NoReply: unique symbol = Symbol.for("openbot/harness-codex/NoReply")
export type RequestReply = { readonly result: unknown } | { readonly error: RpcErrorShape } | typeof NoReply

/** A bidirectional line transport (the app-server's stdout and stdin). */
export interface CodexTransport {
  /** Raw bytes from the app-server. Ends when the server closes its output. */
  readonly incoming: Stream.Stream<Uint8Array, unknown>
  /** Receives whole lines, each terminated with `"\n"`. */
  readonly outgoing: Sink.Sink<void, string, never, unknown>
  /** Why the connection ended, evaluated once `incoming` completed (e.g. the exit code). */
  readonly terminationReason?: Effect.Effect<string> | undefined
}

export interface ProtocolLogEvent {
  readonly direction: "in" | "out"
  readonly message: unknown
}

export interface CodexPeerOptions {
  readonly transport: CodexTransport
  readonly onNotification: (notification: IncomingNotification) => Effect.Effect<void>
  /**
   * Called inline by the reader (so routing keeps the order of the wire). Returns the effect that
   * produces the reply; it is forked so a long approval never blocks the connection.
   */
  readonly onRequest: (request: IncomingRequest) => Effect.Effect<Effect.Effect<RequestReply>>
  readonly onTermination?: ((reason: string) => Effect.Effect<void>) | undefined
  /** Concurrent server requests beyond this are answered with `overloaded` (t3code: 32). */
  readonly maxConcurrentRequests?: number | undefined
  /** Protocol tracing hook. Messages may contain secrets (MCP headers); redact before logging. */
  readonly log?: ((event: ProtocolLogEvent) => Effect.Effect<void>) | undefined
}

export interface CodexPeer {
  readonly request: (
    method: string,
    params?: unknown,
    options?: { readonly timeout?: Duration.Input | undefined },
  ) => Effect.Effect<unknown, CodexPeerError>
  readonly notify: (method: string, params?: unknown) => Effect.Effect<void, CodexTransportClosed>
  /** Completes with the termination reason once the connection is gone. */
  readonly terminated: Effect.Effect<string>
  readonly isTerminated: Effect.Effect<boolean>
  /** Ends the connection: pending requests fail with `CodexTransportClosed`. */
  readonly terminate: (reason: string) => Effect.Effect<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isId = (value: unknown): value is JsonRpcId =>
  (typeof value === "number" && Number.isFinite(value)) || typeof value === "string"

interface PendingRequest {
  readonly method: string
  readonly deferred: Deferred.Deferred<unknown, CodexPeerError>
}

/**
 * Starts the peer's reader and writer fibers in the current scope. Closing the scope stops them;
 * the transport (e.g. the child process) is owned by the caller.
 */
export const makeCodexPeer = Effect.fnUntraced(function* (options: CodexPeerOptions) {
  const scope = yield* Effect.scope
  const handlerScope = yield* Scope.fork(scope, "parallel")
  const outgoing = yield* Queue.unbounded<string, Cause.Done>()
  const terminatedSignal = yield* Deferred.make<string>()
  const pending = new Map<string, PendingRequest>()
  const maxHandlers = options.maxConcurrentRequests ?? 32
  const log = options.log
  let nextId = 1
  let activeHandlers = 0
  let terminatedReason: string | undefined

  const closedError = () => new CodexTransportClosed({ reason: terminatedReason ?? "connection closed" })

  const terminate = (reason: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (terminatedReason !== undefined) return Effect.void
      terminatedReason = reason
      const failing = [...pending.values()]
      pending.clear()
      const error = new CodexTransportClosed({ reason })
      // Uninterruptible and in this order: whoever waits on `terminated` may close the scope this
      // fiber runs in, so the owners (`onTermination`) and the waiters hear about it first.
      return Effect.uninterruptible(
        Effect.gen(function* () {
          if (options.onTermination) yield* options.onTermination(reason)
          for (const entry of failing) yield* Deferred.fail(entry.deferred, error)
          yield* Queue.end(outgoing)
          yield* Deferred.succeed(terminatedSignal, reason)
          // Forked: terminate may run on a handler fiber that lives in handlerScope.
          yield* Effect.forkIn(Scope.close(handlerScope, Exit.void), scope, { startImmediately: true })
        }),
      )
    })

  const send = (message: Record<string, unknown>): Effect.Effect<void, CodexTransportClosed> =>
    Effect.suspend(() => {
      if (terminatedReason !== undefined) return Effect.fail(closedError())
      const line = `${JSON.stringify(message)}\n`
      const traced = log ? log({ direction: "out", message }) : Effect.void
      return traced.pipe(
        Effect.andThen(Queue.offer(outgoing, line)),
        Effect.flatMap((accepted) => (accepted ? Effect.void : Effect.fail(closedError()))),
      )
    })

  const sendReply = (id: JsonRpcId, reply: Exclude<RequestReply, typeof NoReply>) =>
    send("result" in reply ? { id, result: reply.result ?? null } : { id, error: reply.error })

  const handleResponse = (id: JsonRpcId, message: Record<string, unknown>): Effect.Effect<void> =>
    Effect.suspend(() => {
      const key = String(id)
      const entry = pending.get(key)
      if (!entry)
        return Effect.logDebug("Codex app-server: response for an unknown request").pipe(
          Effect.annotateLogs({ id: key }),
        )
      pending.delete(key)
      const error = message.error
      if (error !== undefined && error !== null) {
        const shape = isRecord(error) ? error : {}
        return Deferred.fail(
          entry.deferred,
          new CodexRpcError({
            method: entry.method,
            code: typeof shape.code === "number" ? shape.code : RpcErrorCodes.internal,
            message: typeof shape.message === "string" ? shape.message : JSON.stringify(error),
            ...(shape.data === undefined ? {} : { data: shape.data }),
          }),
        ).pipe(Effect.asVoid)
      }
      return Deferred.succeed(entry.deferred, message.result).pipe(Effect.asVoid)
    })

  const handleRequest = (request: IncomingRequest): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (activeHandlers >= maxHandlers) {
        yield* sendReply(request.id, {
          error: { code: RpcErrorCodes.overloaded, message: "Too many Codex requests are already pending." },
        }).pipe(Effect.ignore)
        return
      }
      activeHandlers++
      const answer = yield* options.onRequest(request).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Codex app-server: routing a server request failed", cause).pipe(
            Effect.as(
              Effect.succeed<RequestReply>({
                error: { code: RpcErrorCodes.internal, message: "OpenBot failed to route the request." },
              }),
            ),
          ),
        ),
      )
      yield* answer.pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Codex app-server: answering a server request failed", cause).pipe(
            Effect.as<RequestReply>({
              error: { code: RpcErrorCodes.internal, message: "OpenBot failed to handle the request." },
            }),
          ),
        ),
        Effect.flatMap((reply) => (reply === NoReply ? Effect.void : sendReply(request.id, reply))),
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => {
            activeHandlers--
          }),
        ),
        Effect.forkIn(handlerScope, { startImmediately: true }),
      )
    })

  const handleLine = (raw: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const line = raw.trim()
      if (line === "" || terminatedReason !== undefined) return Effect.void
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        return Effect.logWarning("Codex app-server: skipped a non-JSON line").pipe(
          Effect.annotateLogs({ preview: line.slice(0, 160) }),
        )
      }
      if (!isRecord(message)) return Effect.logWarning("Codex app-server: skipped a non-object message")
      const traced = log ? log({ direction: "in", message }) : Effect.void
      const method = message.method
      const id = message.id
      if (typeof method === "string") {
        return traced.pipe(
          Effect.andThen(
            isId(id)
              ? handleRequest({ id, method, params: message.params })
              : options.onNotification({ method, params: message.params }),
          ),
        )
      }
      if (isId(id) && ("result" in message || "error" in message)) {
        return traced.pipe(Effect.andThen(handleResponse(id, message)))
      }
      return Effect.logWarning("Codex app-server: skipped an unroutable message").pipe(
        Effect.annotateLogs({ keys: Object.keys(message).join(",") }),
      )
    })

  // Reader: stdout → lines → route. The end of the stream terminates the peer.
  yield* options.transport.incoming.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach(handleLine),
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.void : terminate(`reading from Codex failed: ${Cause.pretty(cause)}`),
      onSuccess: () =>
        Effect.flatMap(options.transport.terminationReason ?? Effect.succeed("Codex closed its output"), terminate),
    }),
    Effect.forkIn(scope),
  )

  // Writer: queued lines → stdin.
  yield* Stream.fromQueue(outgoing).pipe(
    Stream.run(options.transport.outgoing),
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.void : terminate(`writing to Codex failed: ${Cause.pretty(cause)}`),
      onSuccess: () => Effect.void,
    }),
    Effect.forkIn(scope),
  )

  // Closing the owning scope ends the connection for every waiter.
  yield* Effect.addFinalizer(() => terminate("connection scope closed"))

  const request = (
    method: string,
    params?: unknown,
    requestOptions?: { readonly timeout?: Duration.Input | undefined },
  ): Effect.Effect<unknown, CodexPeerError> =>
    Effect.suspend(() => {
      if (terminatedReason !== undefined) return Effect.fail(closedError())
      const id = nextId++
      const key = String(id)
      const deferred = Deferred.makeUnsafe<unknown, CodexPeerError>()
      pending.set(key, { method, deferred })
      const timeout = requestOptions?.timeout
      const wait: Effect.Effect<unknown, CodexPeerError> =
        timeout === undefined
          ? Deferred.await(deferred)
          : Deferred.await(deferred).pipe(
              Effect.timeoutOrElse({
                duration: timeout,
                orElse: () => Effect.fail(new CodexRequestTimeout({ method, timeoutMs: Duration.toMillis(timeout) })),
              }),
            )
      return send({ id, method, ...(params === undefined ? {} : { params }) }).pipe(
        Effect.andThen(wait),
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(key)
          }),
        ),
      )
    })

  return {
    request,
    notify: (method: string, params?: unknown) => send({ method, ...(params === undefined ? {} : { params }) }),
    terminated: Deferred.await(terminatedSignal),
    isTerminated: Effect.sync(() => terminatedReason !== undefined),
    terminate,
  } satisfies CodexPeer
})
