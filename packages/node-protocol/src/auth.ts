// Node <-> brain mutual authentication. WebCrypto Ed25519 only (runs in Bun and browsers).
//  - node -> brain: signed WebSocket upgrade header. The brain stores only public keys; replay cache + skew window.
//  - brain -> node: the first RPC `node.hello` carries the brain's signature over the node's upgrade nonce;
//    the node verifies it with the brain key it PINNED at pairing before serving anything else.
// Ported from vendor/scratch/hands-e2e/auth.ts (Buffer removed, Effect-returning, injectable clock/replay cache).
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import { base64UrlDecode, base64UrlEncode, randomToken, utf8Encode } from "./encoding.ts"
import { CryptoError, UpgradeAuthError } from "./errors.ts"
import { UPGRADE_SKEW_MS } from "./version.ts"

/** base64url raw public key (32 bytes) and base64url PKCS#8 private key. */
export interface KeyPair {
  readonly publicKey: string
  readonly privateKey: string
}

const ED25519 = { name: "Ed25519" } as const

const cryptoTry = <A>(op: string, f: () => Promise<A>): Effect.Effect<A, CryptoError> =>
  Effect.tryPromise({
    try: f,
    catch: (e) => new CryptoError({ op, message: e instanceof Error ? e.message : String(e) }),
  })

const decodeKey = (op: string, s: string) =>
  Effect.try({
    try: () => base64UrlDecode(s),
    catch: () => new CryptoError({ op, message: "key is not base64url" }),
  })

export const generateKeyPair: Effect.Effect<KeyPair, CryptoError> = cryptoTry("generateKey", async () => {
  const kp = (await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"])) as CryptoKeyPair
  return {
    publicKey: base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))),
    privateKey: base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey))),
  }
})

/** Recover the raw public key from a PKCS#8 private key (via JWK `x`). */
export const publicKeyFromPrivate = (privateKey: string): Effect.Effect<string, CryptoError> =>
  Effect.flatMap(decodeKey("publicKeyFromPrivate", privateKey), (der) =>
    cryptoTry("publicKeyFromPrivate", async () => {
      const key = await crypto.subtle.importKey("pkcs8", der, ED25519, true, ["sign"])
      const jwk = await crypto.subtle.exportKey("jwk", key)
      if (typeof jwk.x !== "string") throw new Error("no public component")
      return jwk.x
    }),
  )

/** True when `publicKey` is a base64url-encoded 32-byte Ed25519 public key. */
export const isValidPublicKey = (publicKey: string): boolean => {
  try {
    return base64UrlDecode(publicKey).length === 32
  } catch {
    return false
  }
}

export const sign = (privateKey: string, message: string): Effect.Effect<string, CryptoError> =>
  Effect.flatMap(decodeKey("sign", privateKey), (der) =>
    cryptoTry("sign", async () => {
      const key = await crypto.subtle.importKey("pkcs8", der, ED25519, false, ["sign"])
      return base64UrlEncode(new Uint8Array(await crypto.subtle.sign(ED25519, key, utf8Encode(message))))
    }),
  )

/** Never fails: malformed keys or signatures verify as `false`. */
export const verify = (publicKey: string, message: string, signature: string): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    try {
      const raw = base64UrlDecode(publicKey)
      if (raw.length !== 32) return false
      const key = await crypto.subtle.importKey("raw", raw, ED25519, false, ["verify"])
      return await crypto.subtle.verify(ED25519, key, base64UrlDecode(signature), utf8Encode(message))
    } catch {
      return false
    }
  })

// ---------------------------------------------------------------- signed messages
/** The origin both sides sign: `scheme://host[:port]`, with ws/wss mapped to http/https. */
export const originOf = (url: string): string => {
  const u = new URL(url)
  const protocol = u.protocol === "ws:" ? "http:" : u.protocol === "wss:" ? "https:" : u.protocol
  return `${protocol}//${u.host}`
}

export const upgradeMessage = (nodeId: string, ts: number, nonce: string, brainOrigin: string): string =>
  `openbot-node-v1|${nodeId}|${ts}|${nonce}|${brainOrigin}`

export const helloMessage = (nodeId: string, nonce: string, brainOrigin: string): string =>
  `openbot-brain-v1|${nodeId}|${nonce}|${brainOrigin}`

// ---------------------------------------------------------------- upgrade header
export const UPGRADE_AUTH_SCHEME = "OpenBot-Node v1"

export interface UpgradeAuthFields {
  readonly nodeId: string
  readonly ts: number
  readonly nonce: string
  readonly sig: string
}

const TOKEN = /^[A-Za-z0-9_-]+$/

export const formatUpgradeAuth = (f: UpgradeAuthFields): string =>
  `${UPGRADE_AUTH_SCHEME} id=${f.nodeId},ts=${f.ts},nonce=${f.nonce},sig=${f.sig}`

/** Parse `OpenBot-Node v1 id=…,ts=…,nonce=…,sig=…`. Every value must be a base64url-safe token. */
export const parseUpgradeAuth = (header: string | null | undefined): UpgradeAuthFields | undefined => {
  if (!header || !header.startsWith(UPGRADE_AUTH_SCHEME + " ")) return undefined
  const kv = new Map<string, string>()
  for (const part of header.slice(UPGRADE_AUTH_SCHEME.length + 1).split(",")) {
    const i = part.indexOf("=")
    if (i <= 0) return undefined
    const k = part.slice(0, i).trim()
    if (kv.has(k)) return undefined
    kv.set(k, part.slice(i + 1).trim())
  }
  const nodeId = kv.get("id")
  const ts = kv.get("ts")
  const nonce = kv.get("nonce")
  const sig = kv.get("sig")
  if (!nodeId || !ts || !nonce || !sig) return undefined
  if (!TOKEN.test(nodeId) || !TOKEN.test(nonce) || !TOKEN.test(sig) || !/^[0-9]{1,16}$/.test(ts)) return undefined
  return { nodeId, ts: Number(ts), nonce, sig }
}

/** Node side: build the `Authorization` header for one control-socket dial. Keep `nonce` for `node.hello`. */
export const makeUpgradeAuth = (options: {
  readonly nodeId: string
  readonly privateKey: string
  readonly brainOrigin: string
}): Effect.Effect<{ readonly header: string; readonly nonce: string; readonly ts: number }, CryptoError> =>
  Effect.gen(function* () {
    if (!TOKEN.test(options.nodeId)) {
      return yield* new CryptoError({ op: "makeUpgradeAuth", message: "nodeId must be a base64url-safe token" })
    }
    const ts = yield* Clock.currentTimeMillis
    const nonce = randomToken(16)
    const sig = yield* sign(options.privateKey, upgradeMessage(options.nodeId, ts, nonce, options.brainOrigin))
    return { header: formatUpgradeAuth({ nodeId: options.nodeId, ts, nonce, sig }), nonce, ts }
  })

// ---------------------------------------------------------------- replay cache
/** Remembers accepted nonces until they fall out of the skew window. One instance per brain. */
export interface ReplayCache {
  /** true when the nonce was already accepted and is not yet expired */
  readonly seen: (nonce: string, now: number) => boolean
  readonly remember: (nonce: string, now: number) => void
  readonly size: () => number
}

export const makeReplayCache = (options?: { readonly ttlMs?: number; readonly maxEntries?: number }): ReplayCache => {
  const ttl = options?.ttlMs ?? UPGRADE_SKEW_MS * 2
  const max = options?.maxEntries ?? 100_000
  const entries = new Map<string, number>() // nonce -> expiry; insertion order == expiry order
  const sweep = (now: number) => {
    for (const [n, exp] of entries) {
      if (exp > now) break
      entries.delete(n)
    }
  }
  return {
    seen: (nonce, now) => {
      sweep(now)
      return entries.has(nonce)
    },
    remember: (nonce, now) => {
      sweep(now)
      entries.set(nonce, now + ttl)
      while (entries.size > max) {
        const oldest = entries.keys().next()
        if (oldest.done) break
        entries.delete(oldest.value)
      }
    },
    size: () => entries.size,
  }
}

export interface VerifiedUpgrade {
  readonly nodeId: string
  readonly nonce: string
  readonly ts: number
}

/**
 * Brain side: verify the signed upgrade. Checks, in order: header shape, known (non-revoked) node,
 * |now - ts| ≤ skew, nonce not replayed, Ed25519 signature. The nonce is remembered only after the
 * signature verifies, so unauthenticated callers cannot fill the cache.
 */
export const verifyUpgradeAuth = <E, R>(options: {
  readonly header: string | null | undefined
  readonly brainOrigin: string
  /** base64url public key of a paired, non-revoked node, or undefined */
  readonly lookupKey: (nodeId: string) => Effect.Effect<string | undefined, E, R>
  readonly replay: ReplayCache
  readonly skewMs?: number
}): Effect.Effect<VerifiedUpgrade, UpgradeAuthError | E, R> =>
  Effect.gen(function* () {
    const p = parseUpgradeAuth(options.header)
    if (!p) {
      return yield* new UpgradeAuthError({
        reason: "malformed",
        message: "missing or malformed OpenBot-Node authorization",
      })
    }
    const publicKey = yield* options.lookupKey(p.nodeId)
    if (!publicKey) {
      return yield* new UpgradeAuthError({ reason: "unknown-node", message: `unknown or revoked node ${p.nodeId}` })
    }
    const now = yield* Clock.currentTimeMillis
    if (Math.abs(now - p.ts) > (options.skewMs ?? UPGRADE_SKEW_MS)) {
      return yield* new UpgradeAuthError({ reason: "skew", message: "clock skew or stale signature" })
    }
    if (options.replay.seen(p.nonce, now)) {
      return yield* new UpgradeAuthError({ reason: "replay", message: "replayed nonce" })
    }
    const ok = yield* verify(publicKey, upgradeMessage(p.nodeId, p.ts, p.nonce, options.brainOrigin), p.sig)
    if (!ok) return yield* new UpgradeAuthError({ reason: "bad-signature", message: "bad signature" })
    options.replay.remember(p.nonce, now)
    return { nodeId: p.nodeId, nonce: p.nonce, ts: p.ts }
  })

// ---------------------------------------------------------------- node.hello brain signature
/** Brain side: `brainSig` for `node.hello`, over the nonce the node used in its upgrade. */
export const signHello = (options: {
  readonly brainPrivateKey: string
  readonly nodeId: string
  readonly nonce: string
  readonly brainOrigin: string
}): Effect.Effect<string, CryptoError> =>
  sign(options.brainPrivateKey, helloMessage(options.nodeId, options.nonce, options.brainOrigin))

/** Node side: verify `brainSig` with the PINNED brain public key. */
export const verifyHello = (options: {
  readonly brainPublicKey: string
  readonly nodeId: string
  readonly nonce: string
  readonly brainOrigin: string
  readonly brainSig: string
}): Effect.Effect<boolean> =>
  verify(options.brainPublicKey, helloMessage(options.nodeId, options.nonce, options.brainOrigin), options.brainSig)

// ---------------------------------------------------------------- data-stream bearer
export const STREAM_AUTH_SCHEME = "Bearer"

export const formatStreamAuth = (streamToken: string): string => `${STREAM_AUTH_SCHEME} ${streamToken}`

export const parseStreamAuth = (header: string | null | undefined): string | undefined => {
  const m = /^Bearer ([A-Za-z0-9_-]{16,})$/.exec(header ?? "")
  return m ? m[1] : undefined
}
