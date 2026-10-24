import { afterAll, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { mkdirSync, readFileSync, statSync } from "node:fs"
import * as path from "node:path"
import { generateKeyPair, isValidPublicKey, PairRequest, publicKeyFromPrivate } from "@openbot/node-protocol"
import * as Schema from "effect/Schema"
import { brainWsUrl, makeAuditLog, makeKeyStore, normalizeBrainUrl, pairNode, verifyAuditChain } from "../src/index.ts"
import { run, tempDir } from "./helpers.ts"

const t = tempDir("pair-")
afterAll(t.cleanup)

const requests: Array<unknown> = []
const brainKeys = await Effect.runPromise(generateKeyPair)
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method !== "POST" || url.pathname !== "/base/node/pair") return new Response("nope", { status: 404 })
    const body = (await req.json()) as { code: string }
    requests.push(body)
    if (body.code !== "ABCDEFGH") return Response.json({ error: "invalid or expired pairing code" }, { status: 403 })
    return Response.json({ nodeId: "nod_paired", brainPublicKey: brainKeys.publicKey, brainOrigin: "https://brain.example" })
  },
})
afterAll(() => server.stop(true))

describe("pairing and identity", () => {
  test("pair: POST /node/pair with a fresh key, pin the brain key, store identity.json (0600)", () =>
    run(
      Effect.gen(function* () {
        const dataDir = path.join(t.path, "node")
        const keyStore = makeKeyStore(dataDir)
        // code normalization: lower case, dash, I/L → 1, O → 0 are tolerated
        const identity = yield* pairNode({ brainUrl: `http://127.0.0.1:${server.port}/base/`, code: "abcd-efgh", keyStore, hostname: "box" })
        expect(identity.nodeId).toBe("nod_paired")
        expect(identity.brainPublicKey).toBe(brainKeys.publicKey)
        expect(identity.brainOrigin).toBe("https://brain.example")
        expect(identity.brainUrl).toBe(`http://127.0.0.1:${server.port}/base`)
        expect(isValidPublicKey(identity.publicKey)).toBe(true)
        expect(yield* Effect.orDie(publicKeyFromPrivate(identity.privateKey))).toBe(identity.publicKey)

        const sent = Schema.decodeUnknownSync(PairRequest)(requests[requests.length - 1])
        expect(sent).toMatchObject({ code: "ABCDEFGH", publicKey: identity.publicKey, hostname: "box", protocol: { min: 1, max: 1 } })
        // the private key never leaves the node
        expect(JSON.stringify(requests)).not.toContain(identity.privateKey)

        const file = path.join(dataDir, "identity.json")
        expect(statSync(file).mode & 0o777).toBe(0o600)
        expect(statSync(dataDir).mode & 0o777).toBe(0o700)
        const loaded = yield* keyStore.load
        expect(Option.getOrThrow(loaded)).toEqual(identity)
        expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1)
      }),
    ))

  test("pair: a refused code or a bad code shape is a PairingError and stores nothing", () =>
    run(
      Effect.gen(function* () {
        const dataDir = path.join(t.path, "node-refused")
        const keyStore = makeKeyStore(dataDir)
        const refused = yield* Effect.flip(pairNode({ brainUrl: `http://127.0.0.1:${server.port}/base`, code: "ZZZZ-ZZZZ", keyStore }))
        expect(refused._tag).toBe("PairingError")
        expect(refused.message).toContain("403")
        const malformed = yield* Effect.flip(pairNode({ brainUrl: `http://127.0.0.1:${server.port}/base`, code: "nope", keyStore }))
        expect(malformed.message).toContain("pairing code")
        expect(Option.isNone(yield* keyStore.load)).toBe(true)
      }),
    ))

  test("brain URLs: ws/wss map to http/https; routes map to ws/wss", () => {
    expect(normalizeBrainUrl("wss://brain.example/x/")).toBe("https://brain.example/x")
    expect(normalizeBrainUrl("brain.local:7420")).toBe("http://brain.local:7420")
    expect(brainWsUrl("https://brain.example/x", "/node")).toBe("wss://brain.example/x/node")
    expect(brainWsUrl("http://127.0.0.1:7420", "/node/stream/abc")).toBe("ws://127.0.0.1:7420/node/stream/abc")
  })
})

describe("AuditLog", () => {
  test("JSONL per day, hash-chained; tampering is detected", () =>
    run(
      Effect.gen(function* () {
        const dir = path.join(t.path, "audit")
        const forwarded: Array<unknown> = []
        const log = yield* makeAuditLog({ dir, forward: (e) => Effect.sync(() => void forwarded.push(e)) })
        const inv = { invocationId: "inv_1", botId: "bot_1", runId: "bot_1:conv_1" }
        yield* log.record({ inv, action: "run-command", target: "echo secret-arg", decision: "allowed", by: "node", outcome: "ok", exitCode: 0 })
        yield* log.record({ inv, action: "write-file", target: "x".repeat(400), decision: "refused", error: "PathDenied" })
        const file = log.fileFor(Date.now())
        const lines = readFileSync(file, "utf8").trim().split("\n")
        expect(lines.length).toBe(2)
        expect(verifyAuditChain(lines)).toBe(-1)
        expect(statSync(file).mode & 0o777).toBe(0o600)
        const second = JSON.parse(lines[1]!)
        expect(second.target.length).toBe(256)
        expect(second.targetSha256).toHaveLength(64)
        expect(forwarded.length).toBe(2)
        const tampered = [lines[0]!.replace("echo", "rm -rf"), lines[1]!]
        expect(verifyAuditChain(tampered)).toBe(1)
        // a new log instance continues the chain from the last line on disk
        const log2 = yield* makeAuditLog({ dir })
        yield* log2.record({ inv, action: "read-file", target: "a", decision: "allowed" })
        expect(verifyAuditChain(readFileSync(file, "utf8").trim().split("\n"))).toBe(-1)
      }),
    ))

  test("an audit file that cannot be read never fails the action being recorded", () =>
    run(
      Effect.gen(function* () {
        const forwarded: Array<unknown> = []
        const log = yield* makeAuditLog({ dir: path.join(t.path, "audit-unreadable"), forward: (e) => Effect.sync(() => void forwarded.push(e)) })
        mkdirSync(log.fileFor(Date.now()), { recursive: true })
        yield* log.record({ inv: { invocationId: "inv_1", botId: "bot_1" }, action: "read-file", target: "a", decision: "allowed" })
        expect(forwarded.length).toBe(1)
      }),
    ))
})
