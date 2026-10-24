/**
 * brain-nodes configuration and the brain's Ed25519 identity (D1.3, interfaces.md §8.12).
 *
 * - `BrainNodesConfig`: the public origin nodes sign into their upgrade and see in pairing commands,
 *   the brain version sent in `node.hello`, local-node settings and a few timings. Provided by the
 *   server (W2.1).
 * - `BrainIdentity`: the brain's Ed25519 key pair. Nodes pin its public key at pairing and verify
 *   the `node.hello` signature with it. Stored at `DataDir.brainIdentity` with mode 0600.
 */
import { DataDir } from "@openbot/core"
import {
  BRAIN_LIVENESS_TIMEOUT_MS,
  type KeyPair,
  generateKeyPair,
  isValidPublicKey,
  originOf,
  publicKeyFromPrivate,
  STREAM_TOKEN_TTL_MS,
} from "@openbot/node-protocol"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { chmod, rename } from "node:fs/promises"

export interface LocalNodeConfig {
  /** Run the in-process local node (`node_local`). Default true (`--no-local-node` turns it off). */
  readonly enabled: boolean
  /** Label shown in Settings › Computers. Default "This computer". */
  readonly label: string
}

export interface BrainNodesConfigShape {
  /**
   * Canonical public origin of the brain (`scheme://host[:port]`). It goes into pairing commands and
   * `PairResponse.brainOrigin`, and nodes sign it into their upgrade. An Effect so the server can
   * complete it after binding port 0.
   */
  readonly brainOrigin: Effect.Effect<string>
  /** Other origins the brain is reachable at; an upgrade signed for any of them is accepted. */
  readonly extraOrigins: ReadonlyArray<string>
  /** Sent in `node.hello`. */
  readonly brainVersion: string
  /**
   * Approve every capability a node declares in its FIRST `node.hello` after pairing (the owner just
   * paired it). Capabilities declared later need approval in Settings › Computers. Default true.
   */
  readonly autoApproveFirstHello: boolean
  /** CLI name used in the ready-to-paste pairing command. Default `openbot-node`. */
  readonly nodeCommand: string
  readonly localNode: LocalNodeConfig
  /** One-time data-stream token lifetime. Default `STREAM_TOKEN_TTL_MS` (30 s). */
  readonly streamTokenTtlMs: number
  /** How long to wait for `node.hello` after an upgrade. Default 10 s. */
  readonly helloTimeoutMs: number
  /**
   * Drop a control connection after this much silence (half-open: the node vanished without a
   * close), so the node goes offline. Default `BRAIN_LIVENESS_TIMEOUT_MS` (20 s); 0 disables.
   */
  readonly livenessTimeoutMs: number
  /**
   * A bot's desktop goes to sleep (`desktop.stop`) after this long with nothing keeping it awake
   * (`ComputerService`). Default `DESKTOP_IDLE_MS` (10 min); 0 keeps desktops up.
   */
  readonly desktopIdleMs: number
  /**
   * The brain can build the node daemon for other computers (`NodeInstall`): `entry` is apps/node's
   * `src/main.ts`. Pairing codes then come with the installer one-liner.
   */
  readonly nodeInstall: { readonly entry: string } | undefined
}

export interface BrainNodesConfigInput {
  readonly brainOrigin: string | Effect.Effect<string>
  readonly extraOrigins?: ReadonlyArray<string> | undefined
  readonly brainVersion?: string | undefined
  readonly autoApproveFirstHello?: boolean | undefined
  readonly nodeCommand?: string | undefined
  readonly localNode?: Partial<LocalNodeConfig> | undefined
  readonly streamTokenTtlMs?: number | undefined
  readonly helloTimeoutMs?: number | undefined
  readonly livenessTimeoutMs?: number | undefined
  readonly desktopIdleMs?: number | undefined
  readonly nodeInstall?: { readonly entry: string } | undefined
}

/** How long a bot's desktop stays up with nothing keeping it awake. */
export const DESKTOP_IDLE_MS = 10 * 60_000

export const makeBrainNodesConfig = (input: BrainNodesConfigInput): BrainNodesConfigShape => ({
  brainOrigin:
    typeof input.brainOrigin === "string"
      ? Effect.succeed(originOf(input.brainOrigin))
      : Effect.map(input.brainOrigin, originOf),
  extraOrigins: (input.extraOrigins ?? []).map(originOf),
  brainVersion: input.brainVersion ?? "0.0.0",
  autoApproveFirstHello: input.autoApproveFirstHello ?? true,
  nodeCommand: input.nodeCommand ?? "openbot-node",
  localNode: { enabled: input.localNode?.enabled ?? true, label: input.localNode?.label ?? "This computer" },
  streamTokenTtlMs: input.streamTokenTtlMs ?? STREAM_TOKEN_TTL_MS,
  helloTimeoutMs: input.helloTimeoutMs ?? 10_000,
  livenessTimeoutMs: input.livenessTimeoutMs ?? BRAIN_LIVENESS_TIMEOUT_MS,
  desktopIdleMs: input.desktopIdleMs ?? DESKTOP_IDLE_MS,
  nodeInstall: input.nodeInstall,
})

export class BrainNodesConfig extends Context.Service<BrainNodesConfig, BrainNodesConfigShape>()(
  "openbot/brain-nodes/BrainNodesConfig",
) {
  static readonly layer = (input: BrainNodesConfigInput): Layer.Layer<BrainNodesConfig> =>
    Layer.succeed(BrainNodesConfig, makeBrainNodesConfig(input))
}

/** Every origin an upgrade may be signed for: the canonical one first. */
export const acceptedOrigins = (config: BrainNodesConfigShape): Effect.Effect<ReadonlyArray<string>> =>
  Effect.map(config.brainOrigin, (origin) => [origin, ...config.extraOrigins.filter((o) => o !== origin)])

// ============================================================================ brain identity

export class BrainIdentityError extends Schema.TaggedError<BrainIdentityError>()("BrainIdentityError", {
  path: Schema.String,
  message: Schema.String,
}) {}

const IdentityFile = Schema.Struct({
  version: Schema.Literal(1),
  publicKey: Schema.String,
  privateKey: Schema.String,
  createdAt: Schema.Number,
})
const decodeIdentityFile = Schema.decodeUnknownOption(IdentityFile)

export class BrainIdentity extends Context.Service<BrainIdentity, KeyPair>()("openbot/brain-nodes/BrainIdentity") {
  /** A fixed key pair (tests). */
  static readonly layer = (keys: KeyPair): Layer.Layer<BrainIdentity> => Layer.succeed(BrainIdentity, keys)

  /** A fresh in-memory key pair (tests, ephemeral brains). */
  static readonly layerEphemeral: Layer.Layer<BrainIdentity> = Layer.effect(
    BrainIdentity,
    Effect.orDie(generateKeyPair),
  )

  /**
   * Loads the key pair from `DataDir.brainIdentity`, or generates and stores one (mode 0600, written
   * atomically). A corrupt file fails loudly instead of being replaced: replacing it would silently
   * orphan every paired node.
   */
  static readonly layerFile: Layer.Layer<BrainIdentity, BrainIdentityError, DataDir> = Layer.effect(
    BrainIdentity,
    Effect.gen(function* () {
      const dataDir = yield* DataDir
      return yield* loadOrCreateIdentity(dataDir.brainIdentity)
    }),
  )
}

export const loadOrCreateIdentity = (path: string): Effect.Effect<KeyPair, BrainIdentityError> =>
  Effect.gen(function* () {
    const fail = (message: string) => new BrainIdentityError({ path, message })
    const file = Bun.file(path)
    const exists = yield* Effect.promise(() => file.exists())
    if (exists) {
      const raw = yield* Effect.tryPromise({
        try: () => file.json() as Promise<unknown>,
        catch: () => fail("not valid JSON"),
      })
      const parsed = decodeIdentityFile(raw)
      if (parsed._tag === "None" || !isValidPublicKey(parsed.value.publicKey)) {
        return yield* fail("unrecognized brain identity file")
      }
      const derived = yield* publicKeyFromPrivate(parsed.value.privateKey).pipe(
        Effect.mapError((e) => fail(`private key unusable: ${e.message}`)),
      )
      if (derived !== parsed.value.publicKey) return yield* fail("public key does not match the private key")
      // keep the permissions tight even if someone loosened them
      yield* Effect.promise(() => chmod(path, 0o600).catch(() => undefined))
      return { publicKey: parsed.value.publicKey, privateKey: parsed.value.privateKey }
    }
    const keys = yield* generateKeyPair.pipe(Effect.mapError((e) => fail(e.message)))
    const createdAt = yield* Clock.currentTimeMillis
    const body = JSON.stringify({ version: 1, ...keys, createdAt }, null, 2)
    const tmp = `${path}.${process.pid}.tmp`
    yield* Effect.tryPromise({
      try: async () => {
        await Bun.write(tmp, body, { mode: 0o600, createPath: true })
        await chmod(tmp, 0o600)
        await rename(tmp, path)
      },
      catch: (e) => fail(`cannot write: ${e instanceof Error ? e.message : String(e)}`),
    })
    return keys
  })
