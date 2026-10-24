// Pairing (D1.3; docs/node-protocol.md §2): generate an Ed25519 key, `POST /node/pair` with the
// one-time code, pin the brain's key, store the identity.
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { arch, hostname } from "node:os"
import {
  generateKeyPair,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  normalizePairingCode,
  originOf,
  PairResponse,
  PROTOCOL_VERSION,
  Routes,
  type PairRequest,
} from "@openbot/node-protocol"
import { NODE_DAEMON_VERSION } from "./config.ts"
import type { KeyStoreShape, NodeIdentity } from "./KeyStore.ts"

export class PairingError extends Schema.TaggedError<PairingError>()("PairingError", {
  message: Schema.String,
}) {}

/** `https://brain.example/x/` → `https://brain.example/x` (ws/wss accepted and mapped to http/https). */
export const normalizeBrainUrl = (input: string): string => {
  const u = new URL(input.includes("://") ? input : `http://${input}`)
  if (u.protocol === "ws:") u.protocol = "http:"
  if (u.protocol === "wss:") u.protocol = "https:"
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`unsupported brain URL scheme ${u.protocol}`)
  u.search = ""
  u.hash = ""
  return u.toString().replace(/\/+$/, "")
}

/** http(s) base → ws(s) URL of a route on the brain. */
export const brainWsUrl = (brainUrl: string, route: string): string => {
  const u = new URL(normalizeBrainUrl(brainUrl))
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:"
  return `${u.toString().replace(/\/+$/, "")}${route}`
}

export const pairNode = (input: {
  readonly brainUrl: string
  readonly code: string
  readonly keyStore: KeyStoreShape
  readonly hostname?: string | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
}): Effect.Effect<NodeIdentity, PairingError> =>
  Effect.gen(function* () {
    const code = normalizePairingCode(input.code)
    if (!code)
      return yield* new PairingError({ message: "that is not a valid pairing code (8 characters, e.g. ABCD-EFGH)" })
    const brainUrl = yield* Effect.try({
      try: () => normalizeBrainUrl(input.brainUrl),
      catch: (e) => new PairingError({ message: e instanceof Error ? e.message : String(e) }),
    })
    const keys = yield* generateKeyPair.pipe(
      Effect.mapError((e) => new PairingError({ message: `key generation failed: ${e.message}` })),
    )
    const body: PairRequest = {
      code,
      publicKey: keys.publicKey,
      hostname: input.hostname ?? hostname(),
      platform: process.platform,
      arch: arch(),
      nodeVersion: NODE_DAEMON_VERSION,
      protocol: { min: MIN_SUPPORTED_PROTOCOL_VERSION, max: PROTOCOL_VERSION },
    }
    const doFetch = input.fetch ?? globalThis.fetch
    const res = yield* Effect.tryPromise({
      try: async () => {
        const r = await doFetch(`${brainUrl}${Routes.pair}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
        const text = await r.text()
        if (!r.ok) throw new Error(`the brain refused pairing (HTTP ${r.status}): ${text.slice(0, 300)}`)
        return JSON.parse(text) as unknown
      },
      catch: (e) => new PairingError({ message: e instanceof Error ? e.message : String(e) }),
    })
    const pr = yield* Schema.decodeUnknownEffect(PairResponse)(res).pipe(
      Effect.mapError(() => new PairingError({ message: "the brain sent a malformed pairing response" })),
    )
    const now = yield* Clock.currentTimeMillis
    const identity: NodeIdentity = {
      version: 1,
      nodeId: pr.nodeId,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      brainPublicKey: pr.brainPublicKey,
      brainOrigin: pr.brainOrigin || originOf(brainUrl),
      brainUrl,
      pairedAt: now,
    }
    yield* input.keyStore
      .save(identity)
      .pipe(Effect.mapError((e) => new PairingError({ message: `could not store the identity: ${e.message}` })))
    return identity
  })
