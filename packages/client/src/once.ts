// Execute-once guard for side-effecting `runtime.fn` atoms.
//
// An Effect atom `runtime.fn` re-runs its effect with the LAST argument whenever it recomputes, e.g.
// when `OpenBotClient.runtime` is rebuilt after a reconnect (phone waking up, coming back to a tab).
// For commands that means the last call silently runs again: a message is sent twice, a reaction
// toggles back off, a routine runs again, a Stop interrupts a newer turn. Each invocation is keyed by
// an object identity (a fresh box/draft per call); a re-run with the same key joins the first
// execution's fiber, so its result is replayed instead of the side effect being repeated. The
// execution runs detached, so a recompute that interrupts the atom's fiber never cancels it halfway.
import { Effect, Fiber } from "effect"

const runs = new WeakMap<object, Fiber.Fiber<unknown, unknown>>()

/** Runs `effect` at most once per `key`; later calls with the same key replay its result. */
export const once = <A, E, R>(key: object, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const existing = runs.get(key) as Fiber.Fiber<A, E> | undefined
    if (existing !== undefined) return Fiber.join(existing)
    return Effect.flatMap(Effect.forkDetach(effect), (fiber) => {
      runs.set(key, fiber as Fiber.Fiber<unknown, unknown>)
      return Fiber.join(fiber)
    })
  })
