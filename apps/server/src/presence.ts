/**
 * Whether the owner is at a computer whose OpenBot desktop app shows the notifications: the app reports
 * `presence.active` every 30 s while they use it (no input for 2 minutes, or a locked screen, stops it).
 * Hark holds its pushes back meanwhile, so the phone (and a Mac mirroring it) does not ring twice.
 */
import { Context, Effect, Layer } from "effect"

/** How long one report counts: three missed reports and the owner is away. */
export const PRESENCE_WINDOW_MS = 90_000

export class OwnerPresence extends Context.Service<
  OwnerPresence,
  {
    readonly active: Effect.Effect<void>
    readonly atComputer: () => boolean
  }
>()("openbot/server/OwnerPresence") {
  static readonly layer: Layer.Layer<OwnerPresence> = Layer.sync(OwnerPresence, () => {
    let lastActiveAt: number | undefined
    return OwnerPresence.of({
      active: Effect.sync(() => void (lastActiveAt = Date.now())),
      atComputer: () => lastActiveAt !== undefined && Date.now() - lastActiveAt < PRESENCE_WINDOW_MS,
    })
  })
}
