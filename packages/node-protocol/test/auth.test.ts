import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as TestClock from "effect/testing/TestClock"
import {
  base64UrlDecode,
  base64UrlEncode,
  formatStreamAuth,
  formatUpgradeAuth,
  generateKeyPair,
  helloMessage,
  isValidPublicKey,
  makeReplayCache,
  makeUpgradeAuth,
  originOf,
  parseStreamAuth,
  parseUpgradeAuth,
  publicKeyFromPrivate,
  sign,
  signHello,
  UpgradeAuthError,
  upgradeMessage,
  verify,
  verifyHello,
  verifyUpgradeAuth,
  type ReplayCache,
} from "../src/index.ts"

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff)
const ORIGIN = "https://brain.example"

const verifyWith = (header: string | undefined, keys: Record<string, string>, replay: ReplayCache, origin = ORIGIN) =>
  verifyUpgradeAuth({
    header,
    brainOrigin: origin,
    lookupKey: (id) => Effect.succeed(keys[id]),
    replay,
  })

const failureReason = async (eff: Effect.Effect<unknown, unknown>) => {
  const exit = await Effect.runPromiseExit(eff)
  if (Exit.isSuccess(exit)) return "ok"
  const err = exit.cause.reasons.find((r) => r._tag === "Fail")
  if (!err || err._tag !== "Fail") return "defect"
  return err.error instanceof UpgradeAuthError ? err.error.reason : String(err.error)
}

describe("Ed25519 primitives (WebCrypto)", () => {
  test("generate, sign, verify; keys have the expected encodings", () =>
    run(
      Effect.gen(function* () {
        const kp = yield* generateKeyPair
        expect(isValidPublicKey(kp.publicKey)).toBe(true)
        expect(base64UrlDecode(kp.publicKey).length).toBe(32)
        expect(kp.privateKey).toMatch(/^[A-Za-z0-9_-]+$/)
        expect(yield* publicKeyFromPrivate(kp.privateKey)).toBe(kp.publicKey)
        const sig = yield* sign(kp.privateKey, "hello")
        expect(base64UrlDecode(sig).length).toBe(64)
        expect(yield* verify(kp.publicKey, "hello", sig)).toBe(true)
        expect(yield* verify(kp.publicKey, "hellO", sig)).toBe(false)
      }),
    ))

  test("wrong key and garbage inputs verify false instead of failing", () =>
    run(
      Effect.gen(function* () {
        const a = yield* generateKeyPair
        const b = yield* generateKeyPair
        const sig = yield* sign(a.privateKey, "m")
        expect(yield* verify(b.publicKey, "m", sig)).toBe(false)
        expect(yield* verify("not!base64", "m", sig)).toBe(false)
        expect(yield* verify(a.publicKey, "m", "%%%")).toBe(false)
        expect(yield* verify(base64UrlEncode(new Uint8Array(31)), "m", sig)).toBe(false)
        expect(isValidPublicKey("abc")).toBe(false)
        const bad = yield* Effect.exit(sign("garbage", "m"))
        expect(Exit.isFailure(bad)).toBe(true)
      }),
    ))
})

describe("signed upgrade", () => {
  test("header format round-trips and rejects malformed input", () => {
    const h = formatUpgradeAuth({ nodeId: "nod_1", ts: 1700000000000, nonce: "abc_-", sig: "SIG" })
    expect(h).toBe("OpenBot-Node v1 id=nod_1,ts=1700000000000,nonce=abc_-,sig=SIG")
    expect(parseUpgradeAuth(h)).toEqual({ nodeId: "nod_1", ts: 1700000000000, nonce: "abc_-", sig: "SIG" })
    expect(parseUpgradeAuth(undefined)).toBeUndefined()
    expect(parseUpgradeAuth("Bearer xyz")).toBeUndefined()
    expect(parseUpgradeAuth("OpenBot-Node v1 id=a,ts=1,nonce=n")).toBeUndefined()
    expect(parseUpgradeAuth("OpenBot-Node v1 id=a|b,ts=1,nonce=n,sig=s")).toBeUndefined()
    expect(parseUpgradeAuth("OpenBot-Node v1 id=a,ts=x1,nonce=n,sig=s")).toBeUndefined()
    expect(parseUpgradeAuth("OpenBot-Node v1 id=a,id=b,ts=1,nonce=n,sig=s")).toBeUndefined()
    expect(upgradeMessage("n", 1, "x", ORIGIN)).toBe("openbot-node-v1|n|1|x|https://brain.example")
    expect(helloMessage("n", "x", ORIGIN)).toBe("openbot-brain-v1|n|x|https://brain.example")
  })

  test("originOf normalizes ws/wss and drops paths", () => {
    expect(originOf("wss://brain.example/node")).toBe("https://brain.example")
    expect(originOf("ws://127.0.0.1:4310/node?x=1")).toBe("http://127.0.0.1:4310")
    expect(originOf("https://Brain.Example:443/")).toBe("https://brain.example")
  })

  test("valid signature verifies once; a replay is refused", async () => {
    const kp = await run(generateKeyPair)
    const replay = makeReplayCache()
    const auth = await run(makeUpgradeAuth({ nodeId: "nod_1", privateKey: kp.privateKey, brainOrigin: ORIGIN }))
    expect(auth.nonce.length).toBeGreaterThanOrEqual(22)
    const ok = await run(verifyWith(auth.header, { nod_1: kp.publicKey }, replay))
    expect(ok).toEqual({ nodeId: "nod_1", nonce: auth.nonce, ts: auth.ts })
    expect(await failureReason(verifyWith(auth.header, { nod_1: kp.publicKey }, replay))).toBe("replay")
  })

  test("negatives: wrong key, unknown node, wrong origin, tampered, malformed", async () => {
    const kp = await run(generateKeyPair)
    const other = await run(generateKeyPair)
    const auth = await run(makeUpgradeAuth({ nodeId: "nod_1", privateKey: kp.privateKey, brainOrigin: ORIGIN }))
    expect(await failureReason(verifyWith(auth.header, { nod_1: other.publicKey }, makeReplayCache()))).toBe("bad-signature")
    expect(await failureReason(verifyWith(auth.header, {}, makeReplayCache()))).toBe("unknown-node")
    expect(await failureReason(verifyWith(auth.header, { nod_1: kp.publicKey }, makeReplayCache(), "https://evil.example"))).toBe(
      "bad-signature",
    )
    const p = parseUpgradeAuth(auth.header)!
    const tampered = formatUpgradeAuth({ ...p, nodeId: "nod_2" })
    expect(await failureReason(verifyWith(tampered, { nod_2: kp.publicKey }, makeReplayCache()))).toBe("bad-signature")
    const tsTampered = formatUpgradeAuth({ ...p, ts: p.ts + 1 })
    expect(await failureReason(verifyWith(tsTampered, { nod_1: kp.publicKey }, makeReplayCache()))).toBe("bad-signature")
    expect(await failureReason(verifyWith("OpenBot-Node v1 nope", { nod_1: kp.publicKey }, makeReplayCache()))).toBe("malformed")
    expect(await failureReason(verifyWith(undefined, { nod_1: kp.publicKey }, makeReplayCache()))).toBe("malformed")
  })

  test("a failed signature does not poison the replay cache", async () => {
    const kp = await run(generateKeyPair)
    const other = await run(generateKeyPair)
    const replay = makeReplayCache()
    const auth = await run(makeUpgradeAuth({ nodeId: "nod_1", privateKey: kp.privateKey, brainOrigin: ORIGIN }))
    expect(await failureReason(verifyWith(auth.header, { nod_1: other.publicKey }, replay))).toBe("bad-signature")
    expect(replay.size()).toBe(0)
    expect(await failureReason(verifyWith(auth.header, { nod_1: kp.publicKey }, replay))).toBe("ok")
  })

  test("clock skew: stale and future signatures are refused (±60 s)", async () => {
    const kp = await run(generateKeyPair)
    const keys = { nod_1: kp.publicKey }
    const signAt = (ts: number) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(ts)
        return yield* makeUpgradeAuth({ nodeId: "nod_1", privateKey: kp.privateKey, brainOrigin: ORIGIN })
      })
    const T = 1_800_000_000_000
    const scenario = (signTs: number, verifyTs: number) =>
      Effect.gen(function* () {
        const auth = yield* signAt(signTs)
        yield* TestClock.setTime(verifyTs)
        return yield* verifyWith(auth.header, keys, makeReplayCache())
      }).pipe(Effect.provide(TestClock.layer()))
    expect(await failureReason(scenario(T, T + 59_000))).toBe("ok")
    expect(await failureReason(scenario(T, T + 61_000))).toBe("skew")
    expect(await failureReason(scenario(T + 61_000, T))).toBe("skew")
    expect(await failureReason(scenario(T + 59_000, T))).toBe("ok")
  })

  test("replay cache entries expire after the TTL and the cache is bounded", () => {
    const c = makeReplayCache({ ttlMs: 1000, maxEntries: 3 })
    c.remember("a", 0)
    expect(c.seen("a", 999)).toBe(true)
    expect(c.seen("a", 1000)).toBe(false)
    for (const n of ["b", "c", "d", "e"]) c.remember(n, 2000)
    expect(c.size()).toBe(3)
    expect(c.seen("b", 2000)).toBe(false)
    expect(c.seen("e", 2000)).toBe(true)
  })
})

describe("node.hello brain signature", () => {
  test("verifies with the pinned key; wrong key, nonce, node or origin fail", () =>
    run(
      Effect.gen(function* () {
        const brain = yield* generateKeyPair
        const impostor = yield* generateKeyPair
        const brainSig = yield* signHello({ brainPrivateKey: brain.privateKey, nodeId: "nod_1", nonce: "N1", brainOrigin: ORIGIN })
        const base = { brainPublicKey: brain.publicKey, nodeId: "nod_1", nonce: "N1", brainOrigin: ORIGIN, brainSig }
        expect(yield* verifyHello(base)).toBe(true)
        expect(yield* verifyHello({ ...base, brainPublicKey: impostor.publicKey })).toBe(false)
        expect(yield* verifyHello({ ...base, nonce: "N2" })).toBe(false)
        expect(yield* verifyHello({ ...base, nodeId: "nod_2" })).toBe(false)
        expect(yield* verifyHello({ ...base, brainOrigin: "https://evil.example" })).toBe(false)
        const impostorSig = yield* signHello({ brainPrivateKey: impostor.privateKey, nodeId: "nod_1", nonce: "N1", brainOrigin: ORIGIN })
        expect(yield* verifyHello({ ...base, brainSig: impostorSig })).toBe(false)
      }),
    ))
})

describe("data-stream bearer", () => {
  test("format/parse", () => {
    const t = "AAAAAAAAAAAAAAAAAAAAAA"
    expect(parseStreamAuth(formatStreamAuth(t))).toBe(t)
    expect(parseStreamAuth("Bearer short")).toBeUndefined()
    expect(parseStreamAuth("Basic " + t)).toBeUndefined()
    expect(parseStreamAuth(null)).toBeUndefined()
  })
})
