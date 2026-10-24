import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  formatPairingCode,
  generatePairingCode,
  hashPairingCode,
  isPairingCodeExpired,
  normalizePairingCode,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_TTL_MS,
  PairRequest,
  PairResponse,
} from "../src/index.ts"

describe("pairing codes", () => {
  test("8 characters from the Crockford alphabet, effectively unique", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 2000; i++) {
      const c = generatePairingCode()
      if (!/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/.test(c) || normalizePairingCode(c) !== c) throw new Error(`bad code ${c}`)
      seen.add(c)
    }
    expect(seen.size).toBe(2000)
    expect(PAIRING_CODE_ALPHABET).toHaveLength(32)
    expect(PAIRING_CODE_ALPHABET).not.toMatch(/[ILOU]/)
  })

  test("format and normalize user input", () => {
    expect(formatPairingCode("ABCD2345")).toBe("ABCD-2345")
    expect(normalizePairingCode("abcd-2345")).toBe("ABCD2345")
    expect(normalizePairingCode(" ab cd 23 45 ")).toBe("ABCD2345")
    expect(normalizePairingCode("OIL0-ABCD")).toBe("0110ABCD")
    expect(normalizePairingCode("ABCD-234")).toBeUndefined()
    expect(normalizePairingCode("ABCD-23456")).toBeUndefined()
    expect(normalizePairingCode("ABCD-UUUU")).toBeUndefined()
    expect(normalizePairingCode("ABCD-23!5")).toBeUndefined()
  })

  test("hash is stable and identical for equivalent inputs", async () => {
    const h1 = await Effect.runPromise(hashPairingCode("ABCD-2345"))
    const h2 = await Effect.runPromise(hashPairingCode("abcd2345"))
    const h3 = await Effect.runPromise(hashPairingCode("ABCD2346"))
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
    expect(h1).toBe(h2)
    expect(h1).not.toBe(h3)
  })

  test("expiry after 10 minutes", () => {
    expect(PAIRING_CODE_TTL_MS).toBe(600_000)
    expect(isPairingCodeExpired(0, 599_999)).toBe(false)
    expect(isPairingCodeExpired(0, 600_000)).toBe(true)
  })

  test("POST /node/pair schemas decode JSON bodies", () => {
    const req = Schema.decodeUnknownSync(PairRequest)({
      code: "ABCD-2345",
      publicKey: "k",
      hostname: "h",
      platform: "linux",
    })
    expect(req.code).toBe("ABCD-2345")
    expect(() => Schema.decodeUnknownSync(PairRequest)({ code: "x" })).toThrow()
    const res = Schema.decodeUnknownSync(PairResponse)({
      nodeId: "nod_1",
      brainPublicKey: "k",
      brainOrigin: "https://b",
    })
    expect(res.nodeId).toBe("nod_1")
  })
})
