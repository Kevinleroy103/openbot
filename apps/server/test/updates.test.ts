// Updates (apps/server/src/updates.ts) against a fake GitHub: the newest release and the commits since,
// installing one (download, checksum, unpack, packages, hand-off to deploy.ts), going back, and what the
// next brain says when an install did not take.
import { describe, expect, test } from "bun:test"
import { DEFAULT_SETTINGS, type UpdateStatus } from "@openbot/contracts"
import { Notifier, type NotificationInput, SettingsService } from "@openbot/core"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Updates, UpdatesLive } from "../src/updates.ts"

const CURRENT = "3c1d2e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d"
const LATEST = "fa1465b0aaaabbbbccccddddeeeeffff00001111"
const API = "https://api.test"

interface World {
  readonly dataDir: string
  readonly releasesDir: string
  readonly root: string
  readonly tarball: Uint8Array
  checksum: string
  readonly installed: Array<string>
  readonly launched: Array<ReadonlyArray<string>>
  readonly notified: Array<NotificationInput>
  latestSha: string
}

/** A releases folder with an earlier release and the running one, and a published release tarball. */
const world = (): World => {
  const base = mkdtempSync(join(tmpdir(), "openbot-updates-"))
  const releasesDir = join(base, "releases")
  const release = (name: string, version: string, sha: string) => {
    const dir = join(releasesDir, name)
    mkdirSync(join(dir, "scripts"), { recursive: true })
    writeFileSync(join(dir, "scripts/deploy.ts"), "")
    writeFileSync(join(dir, "release.json"), JSON.stringify({ version, sha }))
    return dir
  }
  release("20261018-090000-8d207db", "2026.10.18-8d207db", "8d207db")
  const root = release("20261020-120000-3c1d2e4", "2026.10.20-3c1d2e4", CURRENT)
  // the published tarball: openbot/scripts/deploy.ts and openbot/release.json
  const src = join(base, "src/openbot")
  mkdirSync(join(src, "scripts"), { recursive: true })
  writeFileSync(join(src, "scripts/deploy.ts"), "// deploy")
  writeFileSync(join(src, "release.json"), JSON.stringify({ version: "2026.10.25-fa1465b", sha: LATEST }))
  const file = join(base, "openbot.tar.gz")
  Bun.spawnSync(["tar", "-czf", file, "-C", join(base, "src"), "openbot"])
  const tarball = new Uint8Array(require("node:fs").readFileSync(file))
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(tarball)
  return {
    dataDir: join(base, "data"),
    releasesDir,
    root,
    tarball,
    checksum: hasher.digest("hex"),
    installed: [],
    launched: [],
    notified: [],
    latestSha: LATEST,
  }
}

const fakeGitHub = (w: World) => async (url: string) => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  if (url === `${API}/repos/o/r/releases/latest`) {
    return json({
      tag_name: "v2026.10.25-fa1465b",
      target_commitish: w.latestSha,
      published_at: "2026-10-25T09:00:00Z",
      html_url: "https://github.com/o/r/releases/tag/v2026.10.25-fa1465b",
      assets: [
        { name: "openbot-2026.10.25-fa1465b.tar.gz", browser_download_url: "https://dl.test/openbot.tar.gz" },
        {
          name: "openbot-2026.10.25-fa1465b.tar.gz.sha256",
          browser_download_url: "https://dl.test/openbot.tar.gz.sha256",
        },
      ],
    })
  }
  if (url === `${API}/repos/o/r/compare/${CURRENT}...${w.latestSha}`) {
    return json({
      status: "ahead",
      ahead_by: 2,
      commits: [
        { sha: "c9dc3340000", commit: { message: "Sign in with another device\n\nbody" } },
        { sha: "fa1465b0000", commit: { message: "Charts: stacked bars" } },
      ],
    })
  }
  if (url === "https://dl.test/openbot.tar.gz") return new Response(w.tarball)
  if (url === "https://dl.test/openbot.tar.gz.sha256") return new Response(`${w.checksum}  openbot.tar.gz\n`)
  return new Response("not found", { status: 404 })
}

const run = <A, E>(w: World, use: (updates: Updates["Service"]) => Effect.Effect<A, E>, root = w.root) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* Updates
        return yield* use(updates)
      }).pipe(
        Effect.provide(
          UpdatesLive({
            dataDir: w.dataDir,
            releasesDir: w.releasesDir,
            repo: "o/r",
            apiUrl: API,
            root,
            fetch: fakeGitHub(w),
            installPackages: async (dir) => void w.installed.push(dir),
            launch: (argv) => void w.launched.push(argv),
            schedule: false,
          }).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(SettingsService, {
                  get: Effect.succeed(DEFAULT_SETTINGS),
                } as unknown as SettingsService["Service"]),
                Layer.succeed(
                  Notifier,
                  Notifier.of({
                    notify: (input) => Effect.sync(() => void w.notified.push(input)).pipe(Effect.as(undefined)),
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  )

const settle = async (read: () => Promise<UpdateStatus>, done: (s: UpdateStatus) => boolean) => {
  for (let i = 0; i < 100; i++) {
    const s = await read()
    if (done(s)) return s
    await Bun.sleep(20)
  }
  throw new Error("never settled")
}

describe("updates", () => {
  test("a newer release: available, with the commits since, newest first; notified once", async () => {
    const w = world()
    const [first, second] = await run(w, (u) => Effect.all([u.check, u.check]))
    expect(first.current).toEqual({ version: "2026.10.20-3c1d2e4", sha: CURRENT })
    expect(first.state).toBe("available")
    expect(first.latest?.version).toBe("2026.10.25-fa1465b")
    expect(first.behind).toBe(2)
    expect(first.commits).toEqual([
      { sha: "fa1465b", message: "Charts: stacked bars" },
      { sha: "c9dc334", message: "Sign in with another device" },
    ])
    expect(first.canInstall).toBe(true)
    expect(first.previous).toBe("2026.10.18-8d207db")
    expect(second.state).toBe("available")
    expect(w.notified.map((n) => n.kind)).toEqual(["update"])
  })

  test("the running commit is the newest release: up to date", async () => {
    const w = world()
    w.latestSha = CURRENT
    const status = await run(w, (u) => u.check)
    expect(status.state).toBe("up-to-date")
    expect(status.commits).toEqual([])
    expect(w.notified).toEqual([])
  })

  test("a clone run straight from git sees releases but cannot install them", async () => {
    const w = world()
    const clone = mkdtempSync(join(tmpdir(), "openbot-clone-"))
    const out = await run(w, (u) => Effect.all([u.check, Effect.flip(u.install)]), clone)
    expect(out[0].canInstall).toBe(false)
    expect(out[1]._tag).toBe("Unavailable")
    expect(w.launched).toEqual([])
  })

  test("install: downloads and checks it, unpacks it, installs its packages and hands off to its deploy.ts", async () => {
    const w = world()
    const done = await run(w, (u) =>
      Effect.gen(function* () {
        yield* u.check
        const started = yield* u.install
        expect(started.state).toBe("installing")
        const again = yield* Effect.flip(u.install)
        expect(again._tag).toBe("Conflict")
        return yield* Effect.promise(() =>
          settle(
            () => Effect.runPromise(u.status),
            (s) => s.step === "Restarting…" || s.state === "failed",
          ),
        )
      }),
    )
    expect(done.problem).toBeUndefined()
    const unpacked = join(w.dataDir, "updates/src/openbot")
    expect(w.installed).toEqual([unpacked])
    expect(w.launched).toHaveLength(1)
    const argv = w.launched[0]!
    expect(argv[1]).toBe(join(unpacked, "scripts/deploy.ts"))
    expect(argv).toContain("--local")
    expect(argv.slice(argv.indexOf("--releases"), argv.indexOf("--releases") + 2)).toEqual([
      "--releases",
      w.releasesDir,
    ])
    expect(argv[argv.indexOf("--release-id") + 1]).toMatch(/^\d{8}-\d{6}-fa1465b$/)
    const attempt = JSON.parse(await Bun.file(join(w.dataDir, "updates/attempt.json")).text())
    expect(attempt).toEqual({ version: "2026.10.25-fa1465b", sha: LATEST, from: "2026.10.20-3c1d2e4" })
  })

  test("a download that does not match its checksum is not installed", async () => {
    const w = world()
    w.checksum = "0".repeat(64)
    const done = await run(w, (u) =>
      Effect.gen(function* () {
        yield* u.install
        return yield* Effect.promise(() =>
          settle(
            () => Effect.runPromise(u.status),
            (s) => s.state !== "installing",
          ),
        )
      }),
    )
    expect(done.state).toBe("failed")
    expect(done.problem).toContain("does not match its checksum")
    expect(w.installed).toEqual([])
    expect(w.launched).toEqual([])
  })

  test("going back runs deploy.ts --use with the release before this one", async () => {
    const w = world()
    const status = await run(w, (u) => u.rollback)
    expect(status.state).toBe("installing")
    expect(w.launched).toHaveLength(1)
    const argv = w.launched[0]!
    expect(argv[1]).toBe(join(w.root, "scripts/deploy.ts"))
    expect(argv.slice(argv.indexOf("--use"), argv.indexOf("--use") + 2)).toEqual(["--use", "20261018-090000-8d207db"])
  })

  test("the next brain says when an update did not start and OpenBot went back", async () => {
    const w = world()
    mkdirSync(join(w.dataDir, "updates"), { recursive: true })
    writeFileSync(
      join(w.dataDir, "updates/attempt.json"),
      JSON.stringify({ version: "2026.10.25-fa1465b", sha: LATEST, from: "2026.10.20-3c1d2e4" }),
    )
    const status = await run(w, (u) => u.status)
    expect(status.problem).toContain("2026.10.25-fa1465b did not start, so OpenBot went back to 2026.10.20-3c1d2e4")
    // read once: the brain after that one says nothing
    expect((await run(w, (u) => u.status)).problem).toBeUndefined()
  })
})
