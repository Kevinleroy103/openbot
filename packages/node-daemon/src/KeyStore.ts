// Node identity (D1.3): the node's Ed25519 key pair plus the brain key it pinned at pairing,
// stored at `<nodeData>/identity.json` with mode 0600 (directory 0700). The private key never leaves
// the node.
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import * as path from "node:path"

export const NodeIdentity = Schema.Struct({
  version: Schema.Literal(1),
  nodeId: Schema.String,
  /** base64url raw Ed25519 public key */
  publicKey: Schema.String,
  /** base64url PKCS#8 Ed25519 private key */
  privateKey: Schema.String,
  /** pinned at pairing */
  brainPublicKey: Schema.String,
  /** origin both sides sign (`scheme://host[:port]`) */
  brainOrigin: Schema.String,
  /** http(s) base URL of the brain's public listener */
  brainUrl: Schema.String,
  pairedAt: Schema.Number,
})
export type NodeIdentity = typeof NodeIdentity.Type

export class KeyStoreError extends Schema.TaggedError<KeyStoreError>()("KeyStoreError", {
  path: Schema.String,
  message: Schema.String,
}) {}

export interface KeyStoreShape {
  readonly path: string
  readonly load: Effect.Effect<Option.Option<NodeIdentity>, KeyStoreError>
  readonly save: (identity: NodeIdentity) => Effect.Effect<void, KeyStoreError>
  readonly remove: Effect.Effect<void, KeyStoreError>
}

export class KeyStore extends Context.Service<KeyStore, KeyStoreShape>()("openbot/node-daemon/KeyStore") {}

const decode = Schema.decodeUnknownOption(NodeIdentity)

export const identityPath = (dataDir: string): string => path.join(dataDir, "identity.json")

export const makeKeyStore = (dataDir: string): KeyStoreShape => {
  const file = identityPath(dataDir)
  const fail = (e: unknown) => new KeyStoreError({ path: file, message: e instanceof Error ? e.message : String(e) })
  return {
    path: file,
    load: Effect.try({
      try: () => {
        if (!existsSync(file)) return Option.none<NodeIdentity>()
        const parsed = decode(JSON.parse(readFileSync(file, "utf8")))
        if (Option.isNone(parsed)) throw new Error("identity file is malformed")
        return parsed
      },
      catch: fail,
    }),
    save: (identity) =>
      Effect.try({
        try: () => {
          mkdirSync(dataDir, { recursive: true, mode: 0o700 })
          const tmp = `${file}.tmp-${process.pid}`
          writeFileSync(tmp, JSON.stringify(identity, null, 2) + "\n", { mode: 0o600 })
          chmodSync(tmp, 0o600)
          renameSync(tmp, file)
        },
        catch: fail,
      }),
    remove: Effect.try({ try: () => rmSync(file, { force: true }), catch: fail }),
  }
}

export const KeyStoreLive = (dataDir: string): Layer.Layer<KeyStore> => Layer.succeed(KeyStore)(makeKeyStore(dataDir))
