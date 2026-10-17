// Pairing codes: 8 Crockford base32 characters (40 bits), single use, 10-minute TTL, stored hashed.
// Displayed as `ABCD-EFGH`; input is normalized (case, dashes/spaces, I/L→1, O→0).
import type * as Effect from "effect/Effect"
import { randomBytes, sha256Hex } from "./encoding.ts"
import { PAIRING_CODE_TTL_MS } from "./version.ts"

export const PAIRING_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ" // Crockford: no I L O U
export const PAIRING_CODE_LENGTH = 8

/** A fresh random code (canonical form, no dash). 32 divides 256, so `byte & 31` is unbiased. */
export const generatePairingCode = (): string => {
  let s = ""
  for (const b of randomBytes(PAIRING_CODE_LENGTH)) s += PAIRING_CODE_ALPHABET[b & 31]
  return s
}

/** `ABCDEFGH` → `ABCD-EFGH`. */
export const formatPairingCode = (code: string): string => {
  const c = normalizePairingCode(code) ?? code
  return `${c.slice(0, 4)}-${c.slice(4)}`
}

/** Canonical form of user input, or `undefined` when it cannot be a pairing code. */
export const normalizePairingCode = (input: string): string | undefined => {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
  if (s.length !== PAIRING_CODE_LENGTH) return undefined
  for (const ch of s) if (!PAIRING_CODE_ALPHABET.includes(ch)) return undefined
  return s
}

/** SHA-256 hex of the canonical code; the brain stores only this. Invalid input hashes its raw form. */
export const hashPairingCode = (code: string): Effect.Effect<string> =>
  sha256Hex(`openbot-pairing-v1|${normalizePairingCode(code) ?? code}`)

export const pairingCodeExpiresAt = (createdAt: number): number => createdAt + PAIRING_CODE_TTL_MS

export const isPairingCodeExpired = (createdAt: number, now: number): boolean => now >= pairingCodeExpiresAt(createdAt)
