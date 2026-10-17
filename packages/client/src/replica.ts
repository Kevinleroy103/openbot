// Shared wiring for the live replica atoms: retry classification and the reconnect-aware wait.
import { Effect } from "effect"
import { type AtomRegistry } from "effect/reactivity"
import { RpcClientError } from "effect/rpc"
import { awaitReconnect, connectionStateAtom } from "./connection.ts"

/**
 * Transport failures and `Internal` (a brain-side defect, usually transient) are retried; typed
 * domain errors such as `NotFound` (the conversation was deleted) end the subscription.
 */
export const isRetryableSubscribeError = (error: unknown): boolean =>
  error instanceof RpcClientError.RpcClientError || (typeof error === "object" && error !== null && (error as { _tag?: unknown })._tag === "Internal")

/** Sleep for the backoff, but wake as soon as the socket reconnects (resume right away, D4.3). */
export const waitForRetry =
  (registry: AtomRegistry.AtomRegistry) =>
  (delayMs: number): Effect.Effect<void> => {
    const generation = registry.get(connectionStateAtom).generation
    return Effect.raceFirst(Effect.sleep(delayMs), awaitReconnect(registry, generation))
  }
