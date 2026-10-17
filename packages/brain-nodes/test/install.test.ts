// Installing the node from the brain (NodeInstall): the pairing code comes with the installer
// one-liner, /node/install.sh is a valid sh script for the brain's origin, and /node/download/:target
// compiles the node entry (here a tiny stand-in) for that platform. Without `nodeInstall` none of it.
import { afterAll, describe, expect, test } from "bun:test"
import { NodeAdmin } from "@openbot/core"
import { Effect, Layer } from "effect"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { installScript } from "../src/index.ts"
import { BRAIN_ORIGIN, brainStack, run, startServer, tempDir } from "./helpers.ts"

const dir = tempDir()
afterAll(() => dir.cleanup())

const entry = join(dir.path, "tiny-node.ts")
writeFileSync(entry, `console.log("tiny-node " + process.argv.slice(2).join(" "))\n`)

const hostTarget = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`

const shCheck = (script: string) => {
  const file = join(dir.path, "install.sh")
  writeFileSync(file, script)
  return Bun.spawnSync(["sh", "-n", file], { stderr: "pipe" })
}

describe("node install", () => {
  test("the pairing code comes with the installer one-liner; install.sh and the binary are served", () =>
    run(
      Effect.gen(function*() {
        const server = yield* startServer
        const admin = yield* NodeAdmin
        const code = yield* admin.createPairingCode
        expect(code.command).toBe(`curl -fsSL ${BRAIN_ORIGIN}/node/install.sh | sh -s -- ${code.code}`)

        const script = yield* Effect.promise(() => fetch(`${server.http}/node/install.sh`).then(async (r) => ({ status: r.status, text: await r.text() })))
        expect(script.status).toBe(200)
        expect(script.text).toContain(`ORIGIN='${BRAIN_ORIGIN}'`)
        expect(shCheck(script.text).exitCode).toBe(0)

        const unknown = yield* Effect.promise(() => fetch(`${server.http}/node/download/windows-x64`))
        expect(unknown.status).toBe(404)

        // two at once share one build
        const [a, b] = yield* Effect.promise(() =>
          Promise.all([fetch(`${server.http}/node/download/${hostTarget}`), fetch(`${server.http}/node/download/${hostTarget}`)]))
        expect([a.status, b.status]).toEqual([200, 200])
        const bin = join(dir.path, "openbot-node")
        writeFileSync(bin, new Uint8Array(yield* Effect.promise(() => a.arrayBuffer())))
        yield* Effect.promise(() => b.arrayBuffer())
        chmodSync(bin, 0o755)
        expect(Bun.spawnSync([bin, "version"]).stdout.toString().trim()).toBe("tiny-node version")
      }).pipe(Effect.provide(Layer.fresh(brainStack({ dataRoot: dir.path, nodeInstall: { entry } })))),
    ), 120_000)

  test("without a node entry: the plain pair command and no installer", () =>
    run(
      Effect.gen(function*() {
        const server = yield* startServer
        const code = yield* (yield* NodeAdmin).createPairingCode
        expect(code.command).toBe(`openbot-node pair ${BRAIN_ORIGIN} ${code.code}`)
        expect((yield* Effect.promise(() => fetch(`${server.http}/node/install.sh`))).status).toBe(404)
      }).pipe(Effect.provide(Layer.fresh(brainStack({ dataRoot: dir.path })))),
    ), 20_000)

  test("install.sh quotes an origin with a quote in it", () => {
    const script = installScript("https://o'brien.example")
    expect(script).toContain(`ORIGIN='https://o'"'"'brien.example'`)
    expect(shCheck(script).exitCode).toBe(0)
  })
})
