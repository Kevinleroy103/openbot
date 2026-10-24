import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isSecureRequest, loadAuthFile, makeWebAuth, originRefusal } from "../src/auth.ts"

const dir = mkdtempSync(join(tmpdir(), "openbot-auth-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("origin allow-list", () => {
  const allowed = ["http://127.0.0.1:7420", "http://localhost:7420", "https://box.ts.net"]
  test("absent Origin passes (same-origin navigation, non-browser clients)", () => {
    expect(originRefusal({}, allowed)).toBeUndefined()
    expect(originRefusal({ origin: "http://localhost:7420" }, allowed)).toBeUndefined()
    expect(originRefusal({ origin: "HTTPS://BOX.TS.NET" }, allowed)).toBeUndefined()
  })
  test("unlisted, null and cross-site requests are refused", () => {
    expect(originRefusal({ origin: "http://localhost:7421" }, allowed)).toContain("not allowed")
    expect(originRefusal({ origin: "null" }, allowed)).toContain("not allowed")
    expect(originRefusal({ "sec-fetch-site": "cross-site" }, allowed)).toContain("cross-site")
    expect(originRefusal({ "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:7420" }, allowed)).toBeUndefined()
  })
  test("https detection for the Secure cookie flag", () => {
    expect(isSecureRequest({ "x-forwarded-proto": "https" }, [])).toBe(true)
    expect(isSecureRequest({ host: "box.ts.net" }, ["https://box.ts.net"])).toBe(true)
    expect(isSecureRequest({ host: "127.0.0.1:7420" }, ["https://box.ts.net"])).toBe(false)
  })
})

describe("auth.json", () => {
  test("first run creates a 0600 file with an owner token; later runs reuse it", async () => {
    const path = join(dir, "first", "auth.json")
    const first = await Effect.runPromise(loadAuthFile(path))
    expect(first.created).toBe(true)
    expect(first.file.ownerToken.length).toBeGreaterThanOrEqual(40)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const second = await Effect.runPromise(loadAuthFile(path))
    expect(second.created).toBe(false)
    expect(second.file.ownerToken).toBe(first.file.ownerToken)
  })

  test("a corrupt file is set aside and replaced", async () => {
    const path = join(dir, "corrupt.json")
    await Bun.write(path, "{nope")
    const loaded = await Effect.runPromise(loadAuthFile(path))
    expect(loaded.created).toBe(true)
  })

  test("login → session (hashed at rest) survives a reload; logout revokes; tickets are single use", async () => {
    const path = join(dir, "sessions", "auth.json")
    const options = { path, allowedOrigins: ["http://127.0.0.1:1"], publicOrigins: [] }
    await Effect.runPromise(Effect.gen(function*() {
      const { service: auth } = yield* makeWebAuth(options)
      expect(yield* auth.login("wrong")).toBeUndefined()
      const signedIn = (yield* auth.login(auth.ownerToken))!
      expect(signedIn.sessionToken).not.toBe(auth.ownerToken)
      const onDisk = yield* Effect.promise(() => Bun.file(path).text())
      expect(onDisk).not.toContain(signedIn.sessionToken)

      // a second instance (brain restart) still knows the session
      const { service: reloaded } = yield* makeWebAuth(options)
      expect(yield* reloaded.session(signedIn.sessionToken)).toMatchObject({ id: signedIn.session.id })

      const { ticket } = yield* reloaded.mintTicket(signedIn.session)
      expect(yield* reloaded.redeemTicket(ticket)).toBeDefined()
      expect(yield* reloaded.redeemTicket(ticket)).toBeUndefined()

      yield* reloaded.logout(signedIn.sessionToken)
      expect(yield* reloaded.session(signedIn.sessionToken)).toBeUndefined()
    }))
  })

  test("logins and logouts at the same moment keep every session that should be kept, on disk too", async () => {
    const options = { path: join(dir, "concurrent", "auth.json"), allowedOrigins: [], publicOrigins: [] }
    await Effect.runPromise(Effect.gen(function*() {
      const { service: auth } = yield* makeWebAuth(options)
      const leaving = (yield* auth.login(auth.ownerToken))!
      const [first, , ...rest] = yield* Effect.all([
        auth.login(auth.ownerToken),
        auth.logout(leaving.sessionToken),
        auth.login(auth.ownerToken),
        auth.login(auth.ownerToken),
      ], { concurrency: "unbounded" })
      const { service: reloaded } = yield* makeWebAuth(options)
      expect(yield* reloaded.session(leaving.sessionToken)).toBeUndefined()
      for (const signedIn of [first, ...rest]) expect(yield* reloaded.session(signedIn!.sessionToken)).toBeDefined()
    }))
  })
})
