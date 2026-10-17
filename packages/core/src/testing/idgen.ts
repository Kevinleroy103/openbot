/**
 * Deterministic `IdGen` for tests: `<prefix>_<n>` with a zero-padded counter shared across
 * prefixes (`bot_000001`, `cnv_000002`, …). Ids sort in creation order.
 */
import { Effect, Layer } from "effect"
import { IdGen, makeIdGenShape } from "../ports/IdGen.ts"

export const makeSequentialIdGen = (options?: { readonly start?: number; readonly width?: number }) =>
  Effect.sync(() => {
    let counter = options?.start ?? 0
    const width = options?.width ?? 6
    return IdGen.of(
      makeIdGenShape((prefix) => Effect.sync(() => `${prefix}_${String(++counter).padStart(width, "0")}`)),
    )
  })

/** Fresh counter per layer build. */
export const SequentialIdGen = (options?: { readonly start?: number; readonly width?: number }): Layer.Layer<IdGen> =>
  Layer.effect(IdGen, makeSequentialIdGen(options))
