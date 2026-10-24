/**
 * `CarryoverStore` at `<data>/carryover.json` (atomic writes): what a stopping brain hands to the next
 * boot. A file the next boot cannot read is dropped with a warning: boot must never fail on it.
 */
import { type Carryover, CarryoverStore, type DataDirShape, EMPTY_CARRYOVER, mergeCarryover } from "@openbot/core"
import { Effect, Semaphore } from "effect"
import { readTextFile, removePath, writeFileAtomic } from "./files.ts"

const VERSION = 1

const decode = (text: string): Carryover | undefined => {
  try {
    const parsed = JSON.parse(text) as { version?: unknown; deliveries?: unknown; cutOff?: unknown }
    if (parsed.version !== VERSION || !Array.isArray(parsed.deliveries) || !Array.isArray(parsed.cutOff)) return undefined
    return { deliveries: parsed.deliveries, cutOff: parsed.cutOff } as Carryover
  } catch {
    return undefined
  }
}

export const makeFileCarryoverStore = (dirs: Pick<DataDirShape, "carryover">) =>
  Effect.gen(function*() {
    const path = dirs.carryover
    // saves from concurrently stopping runners would otherwise overwrite each other's merge
    const lock = yield* Semaphore.make(1)
    const read = Effect.gen(function*() {
      const text = yield* readTextFile("CarryoverStore.read", path)
      if (text === undefined) return EMPTY_CARRYOVER
      const carryover = decode(text)
      if (carryover === undefined) yield* Effect.logWarning(`CarryoverStore: ignoring unreadable ${path}`)
      return carryover ?? EMPTY_CARRYOVER
    })
    return CarryoverStore.of({
      save: (carryover) =>
        lock.withPermits(1)(Effect.gen(function*() {
          const merged = mergeCarryover(yield* read, carryover)
          yield* writeFileAtomic("CarryoverStore.save", path, JSON.stringify({ version: VERSION, ...merged }))
        })),
      take: Effect.gen(function*() {
        const carryover = yield* read
        yield* removePath("CarryoverStore.take", path)
        return carryover
      }),
    })
  })
