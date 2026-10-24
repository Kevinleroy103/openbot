import { describe, expect, test } from "bun:test"
import { HarnessRegistry } from "@openbot/core"
import { Effect, Exit } from "effect"
import { resolveModelFor } from "../src/toolkits/bot.ts"

const codexModels = [
  { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", default: true },
  { id: "gpt-6-astra", label: "GPT-6-Astra" },
  { id: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
  { id: "gpt-5.6-luna-mini", label: "GPT-5.6-Luna Mini" },
]

const run = <A, E>(effect: Effect.Effect<A, E, HarnessRegistry>) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const registry = yield* HarnessRegistry
      yield* registry.register({
        kind: "codex",
        displayName: "Codex",
        listModels: Effect.succeed(codexModels),
      } as never)
      return yield* effect
    }).pipe(Effect.provide(HarnessRegistry.layer), Effect.scoped),
  )

const resolved = async (requested: string) => {
  const exit = await run(resolveModelFor("codex", undefined, requested))
  return Exit.isSuccess(exit) ? exit.value : `ERR:${String(Exit.isFailure(exit) ? exit.cause : "")}`
}

describe("resolveModelFor", () => {
  test("exact id and label", async () => {
    expect(await resolved("gpt-6.1-sol")).toBe("gpt-6.1-sol")
    expect(await resolved("GPT-6-Astra")).toBe("gpt-6-astra")
  })
  test("loose human names resolve to the real id", async () => {
    expect(await resolved("sol 6.1")).toBe("gpt-6.1-sol")
    expect(await resolved("Sol")).toBe("gpt-6.1-sol")
    expect(await resolved("astra 6")).toBe("gpt-6-astra")
  })
  test("ambiguous and unknown are refused with the valid ids", async () => {
    const ambiguous = await resolved("luna")
    expect(ambiguous).toContain("ambiguous")
    expect(ambiguous).toContain("gpt-5.6-luna-mini")
    const unknown = await resolved("sol-6.1-turbo")
    expect(unknown).toContain("Unknown Codex model")
    expect(unknown).toContain("gpt-6.1-sol")
  })
})
