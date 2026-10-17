import { describe, expect, test } from "bun:test"
import type { HarnessCapabilities } from "@openbot/contracts"
import { Effect, Exit, Layer, Scope, Stream } from "effect"
import { driverForBot, driverKeyOf, type HarnessDriver, HarnessError, HarnessRegistry } from "../../src/ports/index.ts"

const capabilities: HarnessCapabilities = {
  resume: true,
  steer: false,
  interrupt: true,
  approvals: "interactive",
  questions: true,
  compact: false,
  contextUsage: false,
  images: false,
  remotePlacements: ["brain-mcp-hands"],
}

const driver = (kind: HarnessDriver["kind"], displayName: string = kind, profileId?: string): HarnessDriver => ({
  kind,
  ...(profileId !== undefined ? { profileId } : {}),
  displayName,
  capabilities,
  probe: Effect.succeed({ kind, installed: true, auth: { state: "unknown" }, problems: [] }),
  listModels: Effect.succeed([]),
  openSession: () =>
    Effect.succeed({
      events: Stream.empty,
      nativeSessionId: Effect.succeed(undefined),
      startTurn: () => Effect.void,
      steer: () => Effect.fail(new HarnessError({ harness: kind, code: "unsupported", message: "no steer" })),
      interrupt: Effect.void,
      compact: Effect.fail(new HarnessError({ harness: kind, code: "unsupported", message: "no compact" })),
      contextUsage: Effect.succeed(undefined),
    }),
})

describe("HarnessRegistry", () => {
  test("unknown kinds fail with HarnessUnavailable", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(HarnessRegistry, (r) => r.get("claude")).pipe(Effect.provide(HarnessRegistry.layer)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("HarnessUnavailable")
  })

  test("registerLayer adds drivers for the layer's lifetime", async () => {
    const layer = Layer.mergeAll(
      HarnessRegistry.registerLayer(Effect.succeed(driver("fake", "Fake"))),
      HarnessRegistry.registerLayer(Effect.succeed(driver("codex", "Codex"))),
    ).pipe(Layer.provideMerge(HarnessRegistry.layer))
    const names = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* HarnessRegistry
        const fake = yield* registry.get("fake")
        const all = yield* registry.list
        return [fake.displayName, all.map((d) => d.kind).sort()] as const
      }).pipe(Effect.provide(layer)),
    )
    expect(names).toEqual(["Fake", ["codex", "fake"]])
  })

  test("a registration is removed when its scope closes", async () => {
    const kinds = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* HarnessRegistry
        const scope = yield* Scope.make()
        yield* registry.register(driver("opencode")).pipe(Scope.provide(scope))
        const before = (yield* registry.list).map((d) => d.kind)
        yield* Scope.close(scope, Exit.void)
        const after = (yield* registry.list).map((d) => d.kind)
        return { before, after }
      }).pipe(Effect.provide(HarnessRegistry.layer)),
    )
    expect(kinds).toEqual({ before: ["opencode"], after: [] })
  })

  test("drivers are keyed by (kind, profile); the default profile is absent or \"default\"", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* HarnessRegistry
        const scope = yield* Scope.make()
        yield* registry.register(driver("claude", "Claude")).pipe(Scope.provide(scope))
        yield* registry.register(driver("claude", "Claude", "hpf_work")).pipe(Scope.provide(scope))
        const byDefault = yield* registry.get("claude")
        const byDefaultName = yield* registry.get("claude", "default")
        const work = yield* registry.get("claude", "hpf_work")
        const viaBot = yield* driverForBot(registry, { harness: { kind: "claude", profileId: "hpf_work" } })
        const missing = yield* Effect.flip(registry.get("claude", "hpf_gone"))
        const all = (yield* registry.list).map((d) => driverKeyOf(d.kind, d.profileId)).sort()
        yield* Scope.close(scope, Exit.void)
        return {
          defaultProfile: byDefault.profileId,
          sameDefault: byDefault === byDefaultName,
          work: work.profileId,
          viaBot: viaBot === work,
          missing: missing.message,
          all,
        }
      }).pipe(Effect.provide(HarnessRegistry.layer)),
    )
    expect(out).toEqual({
      defaultProfile: undefined,
      sameDefault: true,
      work: "hpf_work",
      viaBot: true,
      missing: 'The Claude account "hpf_gone" is not available.',
      all: ["claude", "claude/hpf_work"],
    })
  })

  test("removing one profile's driver keeps the others", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* HarnessRegistry
        const keep = yield* Scope.make()
        const drop = yield* Scope.make()
        yield* registry.register(driver("codex", "Codex")).pipe(Scope.provide(keep))
        yield* registry.register(driver("codex", "Codex", "hpf_b")).pipe(Scope.provide(drop))
        yield* Scope.close(drop, Exit.void)
        return (yield* registry.list).map((d) => driverKeyOf(d.kind, d.profileId))
      }).pipe(Effect.provide(HarnessRegistry.layer)),
    )
    expect(out).toEqual(["codex"])
  })
})
