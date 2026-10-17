// Connection supervisor state (architecture §4.10: `connectionAtom` = connecting | online | offline + retry).
//
// Ownership (t3code "single retry owner", t3code-architecture.md §4.3, adapted):
// - The RPC socket protocol owns socket reconnects. Its retry schedule is built here
//   (`reconnectSchedule`) so the delay uses OUR attempt counter (reset on every successful connect)
//   and the next retry time is visible to the UI.
// - `RpcClient.ConnectionHooks` feed `connectionStateAtom` (online / offline transitions).
// - Replica subscriptions (resume.ts) own re-subscription. They wait for the next connect
//   (`awaitReconnect`) or their own backoff, whichever comes first, then resume from their cursor.
import { Clock, Duration, Effect, Layer, Schedule } from "effect"
import { Atom, type AtomRegistry } from "effect/reactivity"
import { RpcClient } from "effect/rpc"
import { backoffDelayMs, type Backoff } from "./config.ts"

export type ConnectionStatus = "connecting" | "online" | "offline"

export interface ConnectionState {
  /**
   * - `connecting`: never connected yet with the current runtime (first attempt in flight).
   * - `online`: the RPC socket is open.
   * - `offline`: the socket dropped or an attempt failed; the protocol is retrying.
   */
  readonly status: ConnectionStatus
  /** Increments on every successful connect. Replica streams use it to re-subscribe right after a reconnect. */
  readonly generation: number
  /** Consecutive failed attempts since the last successful connect. */
  readonly attempt: number
  /** Epoch millis of the last status change. */
  readonly since: number
  /** When the protocol will try again (epoch millis), while `offline`. */
  readonly nextRetryAt: number | undefined
  /** Which protocol instance reported the current status (internal; guards against late hooks from a replaced socket). */
  readonly owner: number
}

export const initialConnectionState: ConnectionState = {
  status: "connecting",
  generation: 0,
  attempt: 0,
  since: 0,
  nextRetryAt: undefined,
  owner: 0,
}

/** Internal, writable. Read `connectionAtom` (supervisor.ts) from UI code instead: it also keeps the socket open. */
export const connectionStateAtom: Atom.Writable<ConnectionState> = Atom.make<ConnectionState>(initialConnectionState).pipe(
  Atom.keepAlive,
  Atom.withLabel("openbot/connectionState"),
)

/** Bumped by `reconnectAtom` to rebuild the protocol layer (new socket, immediate attempt). */
export const reconnectSignalAtom: Atom.Writable<number> = Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel("openbot/reconnectSignal"))

let protocolInstances = 0
/** A fresh owner id for each protocol layer built (internal). */
export const nextProtocolOwner = (): number => ++protocolInstances

/** `RpcClient.ConnectionHooks` that publish transitions into `connectionStateAtom`. */
export const connectionHooksLayer = (registry: AtomRegistry.AtomRegistry, owner: number): Layer.Layer<RpcClient.ConnectionHooks> =>
  Layer.succeed(RpcClient.ConnectionHooks, {
    onConnect: Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.sync(() =>
        registry.update(connectionStateAtom, (s): ConnectionState => ({
          status: "online",
          generation: s.generation + 1,
          attempt: 0,
          since: now,
          nextRetryAt: undefined,
          owner,
        })),
      ),
    ),
    onDisconnect: Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.sync(() =>
        registry.update(connectionStateAtom, (s): ConnectionState => {
          // A replaced socket's late disconnect must not mark the new one offline.
          if (s.owner !== owner && s.owner !== 0 && s.status === "online") return s
          return { ...s, status: "offline", attempt: s.attempt + 1, since: s.status === "offline" ? s.since : now, owner }
        }),
      ),
    ),
  })

/**
 * The socket protocol's retry schedule: retries forever; the delay comes from `backoff` and the
 * supervisor's attempt counter (reset by every successful connect), and is published as `nextRetryAt`.
 */
export const reconnectSchedule = (registry: AtomRegistry.AtomRegistry, backoff: Backoff, owner: number): Schedule.Schedule<number, unknown> =>
  Schedule.forever.pipe(
    Schedule.modifyDelay(() =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.sync(() => {
          const state = registry.get(connectionStateAtom)
          const delay = backoffDelayMs(backoff, Math.max(1, state.attempt))
          if (state.owner === owner || state.owner === 0) {
            registry.set(connectionStateAtom, { ...state, nextRetryAt: now + delay })
          }
          return Duration.millis(delay)
        }),
      ),
    ),
  )

/**
 * Completes once the connection generation is greater than `generation` (i.e. after the next
 * successful connect). Never fails.
 */
export const awaitReconnect = (registry: AtomRegistry.AtomRegistry, generation: number): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (registry.get(connectionStateAtom).generation > generation) {
      resume(Effect.void)
      return
    }
    const unsubscribe = registry.subscribe(connectionStateAtom, (s) => {
      if (s.generation > generation) resume(Effect.void)
    })
    return Effect.sync(unsubscribe)
  })
