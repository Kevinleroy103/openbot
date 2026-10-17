// Browser- and Bun-safe byte helpers (no Buffer, no node:*, no Bun.*). WebCrypto for randomness/hashing.
import * as Effect from "effect/Effect"

const te = new TextEncoder()
const td = new TextDecoder()

export const utf8Encode = (s: string): Uint8Array<ArrayBuffer> => te.encode(s)
export const utf8Decode = (b: Uint8Array): string => td.decode(b)

const toBinaryString = (bytes: Uint8Array): string => {
  let s = ""
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  }
  return s
}

/** Standard base64 with padding (MCP image content, JSON payloads). */
export const base64Encode = (bytes: Uint8Array): string => btoa(toBinaryString(bytes))

export const base64Decode = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** RFC 4648 §5 base64url without padding (keys, signatures, nonces, tokens). */
export const base64UrlEncode = (bytes: Uint8Array): string =>
  base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

/** Throws on characters outside the base64url alphabet. */
export const base64UrlDecode = (s: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("invalid base64url")
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/")
  return base64Decode(b64 + "=".repeat((4 - (b64.length % 4)) % 4))
}

export const hexEncode = (bytes: Uint8Array): string => {
  let s = ""
  for (const b of bytes) s += b.toString(16).padStart(2, "0")
  return s
}

/** Cryptographically secure random bytes (WebCrypto). */
export const randomBytes = (n: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(n))

/** 128-bit random token, base64url (stream tokens, nonces). */
export const randomToken = (bytes = 16): string => base64UrlEncode(randomBytes(bytes))

/** SHA-256 of a string (UTF-8) or bytes, lowercase hex. */
export const sha256Hex = (input: string | Uint8Array<ArrayBuffer>): Effect.Effect<string> =>
  Effect.promise(async () =>
    hexEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", typeof input === "string" ? utf8Encode(input) : input))),
  )

/** Constant-time string comparison (length is not hidden). */
export const safeEqual = (a: string, b: string): boolean => {
  const x = utf8Encode(a)
  const y = utf8Encode(b)
  if (x.length !== y.length) return false
  let d = 0
  for (let i = 0; i < x.length; i++) d |= x[i]! ^ y[i]!
  return d === 0
}
