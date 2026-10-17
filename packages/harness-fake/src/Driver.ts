/**
 * The fake `HarnessDriver` (architecture §4.5 Fake, D2.4): deterministic, credential-free, used by
 * tests and the offline demo. Capabilities are all true except remote placements, which are
 * `["brain-mcp-hands"]` (the fake has no built-in tools; every tool goes through the gateway).
 */
import type { HarnessCapabilities, HarnessDriver, OpenSessionInput } from "@openbot/core"
import { HarnessRegistry } from "@openbot/core"
import type { HarnessStatus, ModelInfo } from "@openbot/contracts"
import { Clock, Duration, Effect, Layer } from "effect"
import { FAKE_HARNESS_KIND, openFakeSession } from "./Session.ts"

export const FAKE_HARNESS_VERSION = "1.0.0"

export const FAKE_CAPABILITIES: HarnessCapabilities = {
  resume: true,
  steer: true,
  interrupt: true,
  approvals: "interactive",
  questions: true,
  compact: true,
  contextUsage: true,
  images: true,
  remotePlacements: ["brain-mcp-hands"],
}

export const FAKE_MODELS: ReadonlyArray<ModelInfo> = [
  { id: "fake", label: "Fake", default: true },
  { id: "fake-reasoning", label: "Fake (reasoning)", efforts: ["low", "medium", "high"] },
]

export interface FakeDriverOptions {
  /** Delay between streamed chunks of normal replies. Default 15 ms (looks like streaming in the demo). */
  readonly chunkDelay?: Duration.Input
  /** Delay between streamed chunks of `slow:` replies. Default 250 ms. */
  readonly slowChunkDelay?: Duration.Input
  /** Context window reported by `ContextUsage`. Default 200 000. */
  readonly windowTokens?: number
  /** Per-call timeout of `tool:` MCP calls (progress notifications reset it). Default 5 minutes. */
  readonly toolTimeout?: Duration.Input
  /** Overrides the display name ("Fake"). */
  readonly displayName?: string
}

/** Fresh native session ids: deterministic per driver instance, never containing ':'. */
const nativeIdFor = (sessionKey: string, n: number): string => `fake-${sessionKey.replaceAll(":", "-")}-${n}`

export const makeFakeDriver = (options?: FakeDriverOptions): HarnessDriver => {
  let sessions = 0
  const displayName = options?.displayName ?? "Fake"
  const chunkDelay = options?.chunkDelay ?? Duration.millis(15)
  const slowChunkDelay = options?.slowChunkDelay ?? Duration.millis(250)
  const windowTokens = options?.windowTokens ?? 200_000
  const toolTimeout = options?.toolTimeout ?? Duration.minutes(5)

  const openSession = Effect.fn("FakeHarness.openSession")(function*(input: OpenSessionInput) {
    const nativeSessionId = input.nativeSessionId ?? nativeIdFor(input.sessionKey, ++sessions)
    return yield* openFakeSession(input, {
      nativeSessionId,
      chunkDelay,
      slowChunkDelay,
      windowTokens,
      toolTimeout,
      reasoning: (input.model ?? input.bot.harness.model) === "fake-reasoning",
    })
  })

  return {
    kind: FAKE_HARNESS_KIND,
    displayName,
    capabilities: FAKE_CAPABILITIES,
    probe: Effect.map(Clock.currentTimeMillis, (now): HarnessStatus => ({
      kind: FAKE_HARNESS_KIND,
      displayName,
      installed: true,
      version: FAKE_HARNESS_VERSION,
      auth: { state: "signed-in", label: "Offline demo (no credentials)" },
      problems: [],
      capabilities: FAKE_CAPABILITIES,
      checkedAt: now,
    })),
    listModels: Effect.succeed(FAKE_MODELS),
    openSession,
  }
}

/** Registers a fake driver with custom options into the `HarnessRegistry` for the layer's lifetime. */
export const FakeHarnessLayer = (options?: FakeDriverOptions): Layer.Layer<never, never, HarnessRegistry> =>
  HarnessRegistry.registerLayer(Effect.sync(() => makeFakeDriver(options)))

/** The fake harness with default options (always available in the brain, D2.4). */
export const FakeHarnessLive: Layer.Layer<never, never, HarnessRegistry> = FakeHarnessLayer()
