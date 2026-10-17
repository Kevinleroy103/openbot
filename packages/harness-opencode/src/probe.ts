/**
 * Status and models without a model call (D2.6): `/api/info` for the version (server readiness),
 * `model.list` for usable models (it also warms the catalog: the first turn is otherwise cold) and
 * `integration.list` connections for the auth label (names only, never credential values).
 */
import type { HarnessCapabilities, HarnessStatus, ModelInfo } from "@openbot/contracts"
import type { HarnessError } from "@openbot/core"
import { Clock, Effect } from "effect"
import { describeClientError } from "./client.ts"
import { modelId } from "./config.ts"
import type { OpenCodeHost } from "./hub.ts"

export const DISPLAY_NAME = "OpenCode"

/** OpenCode Zen (`opencode/*-free`, public key): usable without any login. */
const FREE_PROVIDER_ID = "opencode"

export interface ProbeInput {
  readonly host: OpenCodeHost
  readonly capabilities: HarnessCapabilities
  /** Location used for catalog calls (the server's working directory). */
  readonly directory: string
  /** `false` when the binary could not be found (skips starting the server). */
  readonly binaryFound: boolean
  readonly timeoutMs?: number | undefined
}

export const probeOpenCode = (input: ProbeInput): Effect.Effect<HarnessStatus> =>
  Effect.gen(function*() {
    const checkedAt = yield* Clock.currentTimeMillis
    const base = { kind: "opencode", displayName: DISPLAY_NAME, capabilities: input.capabilities, checkedAt } as const
    if (!input.binaryFound) {
      return {
        ...base,
        installed: false,
        auth: { state: "unknown" },
        problems: ["The opencode CLI was not found on PATH. Install OpenCode 2 (https://opencode.ai) and restart OpenBot."],
      } satisfies HarnessStatus
    }
    const status = Effect.gen(function*() {
      const conn = yield* input.host.connection
      const models = yield* input.host.models(input.directory).pipe(Effect.result)
      const integrations = yield* Effect.tryPromise({
        try: (signal) => conn.client.integration.list({ location: { directory: input.directory } }, { signal }),
        catch: (cause) => cause,
      }).pipe(Effect.option)
      const connected = integrations._tag === "Some"
        ? integrations.value.data.filter((i) => i.connections.length > 0).map((i) => i.name)
        : undefined
      const usable = models._tag === "Success" ? models.success.filter((m) => m.enabled && m.status !== "deprecated") : undefined
      // Providers configured outside OpenCode's credential store (API keys in the environment).
      const external = [...new Set((usable ?? []).map((m) => m.providerID).filter((p) => p !== FREE_PROVIDER_ID))]
      const problems: Array<string> = []
      if (models._tag === "Failure") problems.push(models.failure.message)
      else if (usable !== undefined && usable.length === 0) {
        problems.push("OpenCode lists no usable models. Connect a provider in OpenCode (or set a provider API key) and refresh.")
      }
      return {
        ...base,
        installed: true,
        version: conn.version,
        auth: connected !== undefined && connected.length > 0
          ? { state: "signed-in", label: connected.join(", ") }
          : external.length > 0
          ? { state: "signed-in", label: `${external.join(", ")} (from the environment)` }
          : connected !== undefined
          ? { state: "signed-out", label: "No provider connected (free OpenCode models only)" }
          : { state: "unknown" },
        problems,
      } satisfies HarnessStatus
    })
    return yield* status.pipe(
      Effect.timeoutOrElse({
        duration: input.timeoutMs ?? 40_000,
        orElse: () => Effect.fail({ message: "Timed out starting the OpenCode server." }),
      }),
      Effect.catch((error: HarnessError | { readonly message: string }) =>
        Effect.succeed({
          ...base,
          installed: !("code" in error && error.code === "not-installed"),
          auth: { state: "unknown" },
          problems: [error.message],
        } satisfies HarnessStatus)
      ),
    )
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({
        kind: "opencode",
        displayName: DISPLAY_NAME,
        installed: false,
        auth: { state: "unknown" },
        problems: [`OpenCode probe failed: ${describeClientError(cause)}`],
        capabilities: input.capabilities,
      } satisfies HarnessStatus)
    ),
  )

/** `model.list` (+ `model.default`) → OpenBot `ModelInfo` (`provider/model`, variants as efforts). */
export const listOpenCodeModels = (
  host: OpenCodeHost,
  directory: string,
): Effect.Effect<ReadonlyArray<ModelInfo>, HarnessError> =>
  Effect.gen(function*() {
    const models = yield* host.models(directory)
    const conn = yield* host.connection
    const fallback = yield* Effect.tryPromise({
      try: (signal) => conn.client.model.default({ location: { directory } }, { signal }),
      catch: (cause) => cause,
    }).pipe(Effect.option)
    const defaultId = fallback._tag === "Some" && fallback.value.data ? modelId(fallback.value.data) : undefined
    return models
      .filter((m) => m.enabled && m.status !== "deprecated")
      .map((m): ModelInfo => {
        const id = modelId(m)
        return {
          id,
          label: m.name.length > 0 ? m.name : id,
          ...(id === defaultId ? { default: true } : {}),
          ...(m.variants.length > 0 ? { efforts: m.variants } : {}),
        }
      })
  })
