import { describe, expect, test } from "bun:test"
import { Effect, Random } from "effect"
import { TestClock } from "effect/testing"
import { IdGen } from "../../src/ports/index.ts"
import { SequentialIdGen } from "../../src/testing/index.ts"

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/

const run = <A, E>(effect: Effect.Effect<A, E, IdGen | TestClock.TestClock>) =>
  Effect.runPromise(effect.pipe(Effect.provide(IdGen.layer), Effect.provide(TestClock.layer())))

describe("IdGen.layer (ULID)", () => {
  test("ids are `<prefix>_<ULID>` with typed helpers", async () => {
    const ids = await run(Effect.gen(function*() {
      const gen = yield* IdGen
      return [yield* gen.botId, yield* gen.conversationId, yield* gen.entryId, yield* gen.next("custom")]
    }))
    expect(ids.map((id) => id.split("_")[0])).toEqual(["bot", "cnv", "ent", "custom"])
    for (const id of ids) expect(id.slice(id.indexOf("_") + 1)).toMatch(ULID)
  })

  test("monotonic and unique within the same millisecond", async () => {
    const ids = await run(Effect.gen(function*() {
      const gen = yield* IdGen
      return yield* Effect.forEach(Array.from({ length: 500 }), () => gen.next("x"), { concurrency: 8 })
    }))
    expect(new Set(ids).size).toBe(ids.length)
    const sorted = [...ids].sort()
    expect(sorted).toEqual(ids)
  })

  test("time prefix follows the Clock; later ids sort after earlier ones", async () => {
    const [a, b] = await run(Effect.gen(function*() {
      const gen = yield* IdGen
      yield* TestClock.setTime(1_700_000_000_000)
      const first = yield* gen.next("t")
      yield* TestClock.adjust("1 second")
      const second = yield* gen.next("t")
      return [first, second] as const
    }))
    expect(a < b).toBe(true)
    expect(a.slice(2, 12)).not.toBe(b.slice(2, 12))
  })

  test("deterministic with a seeded Random and a fixed clock", async () => {
    const once = () =>
      run(Effect.gen(function*() {
        const gen = yield* IdGen
        return [yield* gen.next("s"), yield* gen.next("s")]
      }).pipe(Random.withSeed("openbot")))
    expect(await once()).toEqual(await once())
  })
})

describe("SequentialIdGen", () => {
  test("zero-padded counter shared across prefixes", async () => {
    const ids = await Effect.runPromise(
      Effect.gen(function*() {
        const gen = yield* IdGen
        const generated: ReadonlyArray<string> = [yield* gen.botId, yield* gen.turnId, yield* gen.ruleId]
        return generated
      }).pipe(Effect.provide(SequentialIdGen())),
    )
    expect(ids).toEqual(["bot_000001", "trn_000002", "rul_000003"])
  })
})
