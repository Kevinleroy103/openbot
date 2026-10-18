/**
 * Deploys without losing work (`bun run deploy`, scripts/deploy.ts). SIGUSR2 drains the brain:
 * no new turn or task starts (messages still arrive and wait), running ones get up to the grace
 * period, what is left is handed to the next boot (`Orchestrator.drain` → `handOff`). Then the brain
 * stops the normal way (SIGTERM to itself) and the deploy script starts the new release, which
 * resumes everything (`ResumeLive`).
 *
 * The grace comes from `<data>/drain.json` (`{"graceMs": …}`, written by the deploy script and
 * removed here), else `DEFAULT_DRAIN_GRACE_MS`. The deploy script knows a brain can drain when this
 * file exists in its release.
 */
import { Orchestrator } from "@openbot/core"
import { Deferred, Effect, Exit, Layer } from "effect"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { ServerConfig } from "./config.ts"
import { setShutdownPhase } from "./shutdown.ts"

export const DEFAULT_DRAIN_GRACE_MS = 3 * 60_000

const readGrace = (dataDir: string) =>
  Effect.promise(async () => {
    const path = join(dataDir, "drain.json")
    try {
      const parsed = JSON.parse(await Bun.file(path).text()) as { graceMs?: unknown }
      await rm(path, { force: true })
      return typeof parsed.graceMs === "number" && parsed.graceMs >= 0 ? parsed.graceMs : DEFAULT_DRAIN_GRACE_MS
    } catch {
      return DEFAULT_DRAIN_GRACE_MS
    }
  })

export const DrainOnSignalLive: Layer.Layer<never, never, Orchestrator | ServerConfig> = Layer.effectDiscard(
  Effect.gen(function*() {
    const orchestrator = yield* Orchestrator
    const config = yield* ServerConfig
    const requested = yield* Deferred.make<void>()
    const onSignal = () => Deferred.doneUnsafe(requested, Exit.void)
    yield* Effect.acquireRelease(
      Effect.sync(() => process.on("SIGUSR2", onSignal)),
      () => Effect.sync(() => process.off("SIGUSR2", onSignal)),
    )
    yield* Effect.forkScoped(Effect.gen(function*() {
      yield* Deferred.await(requested)
      const graceMs = yield* readGrace(config.dataDir)
      setShutdownPhase("draining for a deploy")
      yield* orchestrator.drain({ graceMs })
      yield* Effect.logInfo("drained: stopping for the deploy")
      process.kill(process.pid, "SIGTERM")
    }))
  }),
)
