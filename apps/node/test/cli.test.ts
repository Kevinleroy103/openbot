import { afterAll, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Scope from "effect/Scope"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { makeKeyStore } from "@openbot/node-daemon"
import { BRAIN_ORIGIN, startTestBrain } from "@openbot/node-daemon/testing"
import { generateKeyPair } from "@openbot/node-protocol"
import { buildNodeConfig, keyFingerprint, loadFileConfig, parseRootFlag, readStatusFile, runCli, type CliIo } from "../src/index.ts"

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "openbot-node-cli-")))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
let n = 0
const freshDir = () => {
  const d = path.join(tmp, `d${++n}`)
  mkdirSync(d, { recursive: true })
  return d
}

const captured = () => {
  const out: Array<string> = []
  const err: Array<string> = []
  const io: CliIo = { env: { HOME: tmp }, out: (l) => void out.push(l), err: (l) => void err.push(l) }
  return { io, out, err, text: () => out.join("\n"), errText: () => err.join("\n") }
}

const cli = async (args: ReadonlyArray<string>) => {
  const c = captured()
  const code = await Effect.runPromise(runCli(args, c.io))
  return { code, ...c }
}

const MAIN = path.join(import.meta.dir, "..", "src", "main.ts")

describe("openbot-node CLI (in process)", () => {
  test("help, version, unknown command, bad flags", async () => {
    expect((await cli(["--help"])).text()).toContain("openbot-node pair <brain-url> <code>")
    expect((await cli(["version"])).text()).toMatch(/^openbot-node \d+\.\d+\.\d+ \(protocol 1\)$/)
    const unknown = await cli(["fly"])
    expect(unknown.code).toBe(2)
    expect(unknown.errText()).toContain('unknown command "fly"')
    const bad = await cli(["status", "--nope"])
    expect(bad.code).toBe(2)
    const level = await cli(["run", "--log-level", "loud", "--data-dir", freshDir()])
    expect(level.code).toBe(2)
  })

  test("status and run before pairing explain how to pair", async () => {
    const dir = freshDir()
    const status = await cli(["status", "--data-dir", dir])
    expect(status.code).toBe(1)
    expect(status.text()).toContain("paired:    no")
    const json = await cli(["status", "--json", "--data-dir", dir])
    expect(JSON.parse(json.text())).toMatchObject({ paired: false, daemon: null, dataDir: dir })
    const run = await cli(["run", "--data-dir", dir])
    expect(run.code).toBe(1)
    expect(run.errText()).toContain("openbot-node pair <brain-url> <code>")
  })

  test("pair stores the identity; status shows it; pairing again needs --force", async () => {
    const brainKeys = await Effect.runPromise(generateKeyPair)
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const body = (await req.json()) as { code: string }
        if (new URL(req.url).pathname !== "/node/pair" || body.code !== "K7M2Q9XZ") return new Response("bad code", { status: 403 })
        return Response.json({ nodeId: "nod_cli", brainPublicKey: brainKeys.publicKey, brainOrigin: "https://brain.example" })
      },
    })
    try {
      const dir = freshDir()
      const url = `http://127.0.0.1:${server.port}`
      const refused = await cli(["pair", url, "AAAA-AAAA", "--data-dir", dir])
      expect(refused.code).toBe(1)
      expect(refused.errText()).toContain("Pairing failed")
      const paired = await cli(["pair", url, "k7m2-q9xz", "--data-dir", dir])
      expect(paired.code).toBe(0)
      expect(paired.text()).toContain("as nod_cli")
      expect(paired.text()).toContain(keyFingerprint(brainKeys.publicKey))

      const status = await cli(["status", "--json", "--data-dir", dir])
      expect(status.code).toBe(0)
      expect(JSON.parse(status.text())).toMatchObject({ paired: true, nodeId: "nod_cli", brainUrl: url, brainOrigin: "https://brain.example", daemon: null })

      const again = await cli(["pair", url, "K7M2Q9XZ", "--data-dir", dir])
      expect(again.code).toBe(1)
      expect(again.errText()).toContain("--force")
      expect((await cli(["pair", url, "K7M2Q9XZ", "--data-dir", dir, "--force"])).code).toBe(0)
    } finally {
      server.stop(true)
    }
  })

  test("config.json and flags build the node configuration (flags win)", async () => {
    const dir = freshDir()
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        roots: ["~/ws", { id: "docs", path: "/srv/docs", mode: "ro" }],
        ceiling: "ask",
        actions: { "run-command": "never" },
        denyGlobs: ["**/*.pem"],
        browser: { enabled: true, executable: "/opt/chrome", headless: "auto" },
      }),
    )
    const file = await Effect.runPromise(loadFileConfig(dir))
    const fromFile = await Effect.runPromise(buildNodeConfig({ identity: { nodeId: "nod_x" }, dataDir: dir, file, flags: {} }))
    expect(fromFile.roots.map((r) => [r.id, r.mode])).toEqual([
      ["work", "rw"],
      ["docs", "ro"],
    ])
    expect(fromFile.policy.ceiling).toBe("ask")
    expect(fromFile.policy.actions["run-command"]).toBe("never")
    expect(fromFile.browser.executable).toBe("/opt/chrome")
    expect(fromFile.denyGlobs).toEqual(["**/*.pem"])

    const flagged = await Effect.runPromise(
      buildNodeConfig({
        identity: { nodeId: "nod_x" },
        dataDir: dir,
        file,
        flags: { roots: ["/data/a", "/data/b:ro"], ceiling: "never", noBrowser: true, headless: true },
      }),
    )
    expect(flagged.roots).toEqual([parseRootFlag("/data/a", 0), parseRootFlag("/data/b:ro", 1)])
    expect(flagged.roots[1]?.mode).toBe("ro")
    expect(flagged.policy.ceiling).toBe("never")
    expect(flagged.browser.enabled).toBe(false)
    expect(flagged.browser.headless).toBe(true)

    const bad = await Effect.runPromise(
      Effect.flip(buildNodeConfig({ identity: { nodeId: "x" }, dataDir: dir, file, flags: { ceiling: "sometimes" } })),
    )
    expect(bad.exitCode).toBe(2)
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ actions: { "launch-missiles": "always" } }))
    const unknownAction = await Effect.runPromise(
      Effect.flip(Effect.flatMap(loadFileConfig(dir), (f) => buildNodeConfig({ identity: { nodeId: "x" }, dataDir: dir, file: f, flags: {} }))),
    )
    expect(unknownAction.message).toContain("launch-missiles")
  })
})

// ---------------------------------------------------------------- the real daemon process
const NODE_ID = "nod_cli_e2e"

const spawnRun = (dataDir: string, root: string) =>
  Bun.spawn([process.execPath, MAIN, "run", "--data-dir", dataDir, "--root", root, "--no-browser"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OPENBOT_NODE_DIR: "" },
  })

const pairedNode = (brainUrl: string, brainPublicKey: string) =>
  Effect.gen(function* () {
    const keys = yield* generateKeyPair
    const dataDir = freshDir()
    const root = path.join(dataDir, "..", `${path.basename(dataDir)}-root`)
    mkdirSync(root, { recursive: true })
    yield* Effect.orDie(
      makeKeyStore(dataDir).save({
        version: 1,
        nodeId: NODE_ID,
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
        brainPublicKey,
        brainOrigin: BRAIN_ORIGIN,
        brainUrl,
        pairedAt: Date.now(),
      }),
    )
    return { keys, dataDir, root }
  })

const scoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

describe("openbot-node run (spawned)", () => {
  test(
    "connects with a signed upgrade, serves the brain, reports status, refuses a second daemon, exits 0 on SIGTERM",
    () =>
      scoped(
        Effect.gen(function* () {
          const brainKeys = yield* generateKeyPair
          // the brain must know the node key before the node dials: build the node first, then the brain
          const pre = yield* pairedNode("http://127.0.0.1:1", brainKeys.publicKey)
          const brain = yield* startTestBrain({ brainKeys, nodeId: NODE_ID, nodePublicKey: pre.keys.publicKey })
          const identity = JSON.parse(readFileSync(path.join(pre.dataDir, "identity.json"), "utf8"))
          yield* Effect.orDie(makeKeyStore(pre.dataDir).save({ ...identity, brainUrl: brain.http }))

          const proc = spawnRun(pre.dataDir, pre.root)
          yield* Effect.addFinalizer(() => Effect.sync(() => proc.kill("SIGKILL")))
          const conn = yield* brain.awaitConnection(1, 15_000)
          expect(conn.hello?._tag).toBe("Success")
          yield* conn.peer.client["fs.write"]({
            inv: { invocationId: "inv_e2e", botId: "bot_1", runId: "bot_1:conv_1" },
            path: "from-brain.txt",
            content: "written by the brain through the daemon",
          })
          expect(readFileSync(path.join(pre.root, "from-brain.txt"), "utf8")).toBe("written by the brain through the daemon")

          // status (another process) sees the running daemon
          let status = readStatusFile(pre.dataDir)
          for (let i = 0; i < 100 && status?.state._tag !== "Verified"; i++) {
            yield* Effect.sleep(20)
            status = readStatusFile(pre.dataDir)
          }
          expect(status?.pid).toBe(proc.pid)
          expect(status?.state._tag).toBe("Verified")
          const human = yield* Effect.promise(() => cli(["status", "--data-dir", pre.dataDir]))
          expect(human.text()).toContain(`daemon:    running (pid ${proc.pid}), online since`)

          // a second daemon on the same data dir is refused
          const second = Bun.spawn([process.execPath, MAIN, "run", "--data-dir", pre.dataDir, "--no-browser"], { stdout: "pipe", stderr: "pipe" })
          expect(yield* Effect.promise(() => second.exited)).toBe(1)
          expect(yield* Effect.promise(() => new Response(second.stderr).text())).toContain("already running")

          proc.kill("SIGTERM")
          expect(yield* Effect.promise(() => proc.exited)).toBe(0)
          expect(existsSync(path.join(pre.dataDir, "run", "status.json"))).toBe(false)
          const out = yield* Effect.promise(() => new Response(proc.stdout).text())
          expect(out).toContain(`node ${NODE_ID}`)
          expect(out).toContain("capabilities: fs@1, shell@1, pty@1, tunnel@1")
        }),
      ),
    30_000,
  )

  test(
    "a revoked node (close 4401) stops and exits 3",
    () =>
      scoped(
        Effect.gen(function* () {
          const brainKeys = yield* generateKeyPair
          const pre = yield* pairedNode("http://127.0.0.1:1", brainKeys.publicKey)
          const brain = yield* startTestBrain({ brainKeys, nodeId: NODE_ID, nodePublicKey: pre.keys.publicKey })
          brain.closeOnConnect = 4401
          const identity = JSON.parse(readFileSync(path.join(pre.dataDir, "identity.json"), "utf8"))
          yield* Effect.orDie(makeKeyStore(pre.dataDir).save({ ...identity, brainUrl: brain.http }))
          const proc = spawnRun(pre.dataDir, pre.root)
          yield* Effect.addFinalizer(() => Effect.sync(() => proc.kill("SIGKILL")))
          const code = yield* Effect.promise(() => proc.exited).pipe(Effect.timeout("15 seconds"))
          expect(code).toBe(3)
          expect(yield* Effect.promise(() => new Response(proc.stderr).text())).toContain("revoked")
          expect(brain.connections.length).toBe(1)
        }),
      ),
    30_000,
  )
})
