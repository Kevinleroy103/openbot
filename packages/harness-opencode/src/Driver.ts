/**
 * OpenCode `HarnessDriver` and its layer (architecture §4.5, D2.3).
 *
 * `OpenCodeHarnessLive(config?)` registers the driver into `HarnessRegistry`. It needs `DataDir`
 * (OpenBot `OPENCODE_CONFIG_DIR`, server cwd, empty test home, skills library) and records the
 * spawned server in `ProcessLedger` when that port is provided. The server starts lazily on the
 * first probe / model list / session and is stopped with the layer.
 */
import type { HarnessCapabilities } from "@openbot/contracts"
import { DataDir, HarnessError, HarnessRegistry, joinPath, ProcessLedger, type HarnessDriver } from "@openbot/core"
import { Clock, Effect, Layer, Option, Scope } from "effect"
import { mkdir } from "node:fs/promises"
import { describeClientError } from "./client.ts"
import { serverConfigContent, serverEnv } from "./config.ts"
import { type HostOptions, makeHost, type OpenCodeHost } from "./hub.ts"
import { DISPLAY_NAME, listOpenCodeModels, probeOpenCode } from "./probe.ts"
import { resolveOpenCodeBinary, spawnServer, type OpenCodeTransport } from "./server.ts"
import { openOpenCodeSession, type SessionOptions } from "./Session.ts"

/** Declared, never faked (D2). Remote hosts run B1 (built-ins denied, gateway node tools). */
export const OPENCODE_CAPABILITIES: HarnessCapabilities = {
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

export interface OpenCodeHarnessConfig {
  /** `opencode` binary (name on PATH or absolute path). Default: PATH, then the usual install dirs. */
  readonly binary?: string | undefined
  /**
   * Replaces spawning `opencode serve` (tests: a scripted fake server; or an external server).
   * Started lazily, stopped when the given scope closes.
   */
  readonly startTransport?: Effect.Effect<OpenCodeTransport, HarnessError, Scope.Scope> | undefined
  /** Use an empty `OPENCODE_TEST_HOME` so the user's `~/.claude` / `~/.agents` skills stay out. Default true. */
  readonly isolateHome?: boolean | undefined
  /** Extra environment for the server process. */
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly startTimeoutMs?: number | undefined
  readonly host?: Omit<HostOptions, "start"> | undefined
  readonly session?: SessionOptions | undefined
}

/** Paths the adapter owns under the data root. */
export const openCodePaths = (dataDir: {
  readonly root: string
  readonly opencodeConfig: string
  readonly skillsLib: string
}) => ({
  /** Server cwd and catalog location. */
  serverDir: joinPath(dataDir.root, "opencode"),
  /** Empty `OPENCODE_TEST_HOME`. */
  testHome: joinPath(dataDir.root, "opencode", "home"),
  configDir: dataDir.opencodeConfig,
  skillsDir: joinPath(dataDir.skillsLib, "skills"),
})

/** Builds the driver over a host (exported for tests and alternative compositions). */
export const makeOpenCodeDriver = (
  host: OpenCodeHost,
  options: { readonly directory: string; readonly binaryFound: boolean; readonly session?: SessionOptions | undefined },
): HarnessDriver => ({
  kind: "opencode",
  displayName: DISPLAY_NAME,
  capabilities: OPENCODE_CAPABILITIES,
  probe: probeOpenCode({
    host,
    capabilities: OPENCODE_CAPABILITIES,
    directory: options.directory,
    binaryFound: options.binaryFound,
  }),
  listModels: listOpenCodeModels(host, options.directory),
  openSession: (input) => openOpenCodeSession(host, input, options.session),
})

const randomPassword = (): string => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString("base64url")
}

const makeDir = (path: string) =>
  Effect.tryPromise({
    try: () => mkdir(path, { recursive: true }),
    catch: (cause) =>
      new HarnessError({
        harness: "opencode",
        code: "open-failed",
        message: `Cannot create ${path}: ${describeClientError(cause)}`,
        cause,
      }),
  })

/** The OpenCode driver bound to the current `DataDir` (and `ProcessLedger`, when provided). */
export const makeOpenCodeDriverLive = (
  config: OpenCodeHarnessConfig = {},
): Effect.Effect<HarnessDriver, never, DataDir | Scope.Scope> =>
  Effect.gen(function* () {
    const dataDir = yield* DataDir
    const ledger = yield* Effect.serviceOption(ProcessLedger)
    const paths = openCodePaths(dataDir)
    const binary = config.startTransport ? undefined : resolveOpenCodeBinary(config.binary)

    const spawn: Effect.Effect<OpenCodeTransport, HarnessError, Scope.Scope> = Effect.gen(function* () {
      if (binary === undefined) {
        return yield* Effect.fail(
          new HarnessError({
            harness: "opencode",
            code: "not-installed",
            message: "The opencode CLI was not found on PATH.",
          }),
        )
      }
      yield* makeDir(paths.serverDir)
      yield* makeDir(paths.configDir)
      if (config.isolateHome !== false) yield* makeDir(paths.testHome)
      const password = randomPassword()
      return yield* spawnServer({
        binary,
        cwd: paths.serverDir,
        password,
        startTimeoutMs: config.startTimeoutMs,
        env: serverEnv({
          baseEnv: process.env,
          password,
          configDir: paths.configDir,
          testHome: config.isolateHome === false ? undefined : paths.testHome,
          configContent: serverConfigContent({ skillsDirs: [paths.skillsDir] }),
          extra: config.env,
        }),
        onSpawned: (pid) =>
          Option.match(ledger, {
            onNone: () => Effect.void,
            onSome: (l) =>
              Effect.flatMap(Clock.currentTimeMillis, (startedAt) =>
                l.record({ pid, pgid: pid, kind: "opencode-serve", label: paths.serverDir, startedAt }),
              ).pipe(Effect.catch((error) => Effect.logWarning(`ProcessLedger.record failed: ${error.message}`))),
          }),
        onReaped: (pid) =>
          Option.match(ledger, {
            onNone: () => Effect.void,
            onSome: (l) =>
              l
                .remove(pid)
                .pipe(Effect.catch((error) => Effect.logWarning(`ProcessLedger.remove failed: ${error.message}`))),
          }),
      })
    })

    const host = yield* makeHost({ ...config.host, start: config.startTransport ?? spawn })
    if (config.startTransport) yield* makeDir(paths.serverDir).pipe(Effect.ignore)
    return makeOpenCodeDriver(host, {
      directory: paths.serverDir,
      binaryFound: config.startTransport !== undefined || binary !== undefined,
      session: config.session,
    })
  })

/** Registers the OpenCode driver into `HarnessRegistry` for the lifetime of the layer. */
export const OpenCodeHarnessLive = (
  config: OpenCodeHarnessConfig = {},
): Layer.Layer<never, never, HarnessRegistry | DataDir> => HarnessRegistry.registerLayer(makeOpenCodeDriverLive(config))
