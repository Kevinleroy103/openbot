// A browser launch that is cancelled before the node has connected to it kills the browser.
import { afterAll, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { makeBrowserManager } from "../src/index.ts"
import { run, tempDir } from "./helpers.ts"

const t = tempDir("browser-launch-")
afterAll(t.cleanup)
const pidFile = path.join(t.path, "pid")
const dialedFile = path.join(t.path, "dialed")

// answers /json/version, then refuses the DevTools WebSocket after a moment
const fakeChrome = path.join(t.path, "chrome")
writeFileSync(
  fakeChrome,
  `#!${process.execPath}
const port = Number(process.argv.find((a) => a.startsWith("--remote-debugging-port="))?.split("=")[1])
await Bun.write(${JSON.stringify(pidFile)}, String(process.pid))
Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    if (new URL(req.url).pathname === "/json/version") return Response.json({ webSocketDebuggerUrl: \`ws://127.0.0.1:\${port}/devtools/browser/x\` })
    Bun.write(${JSON.stringify(dialedFile)}, "1")
    return Bun.sleep(300).then(() => new Response("no", { status: 500 }))
  },
})
`,
)
chmodSync(fakeChrome, 0o755)

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const waitFor = (pred: () => boolean, ms = 5000) =>
  Effect.gen(function* () {
    const end = Date.now() + ms
    while (!pred() && Date.now() < end) yield* Effect.sleep(20)
    return pred()
  })

test(
  "interrupting a launch while it connects to the browser kills the browser",
  () =>
    run(
      Effect.gen(function* () {
        const manager = yield* makeBrowserManager({
          enabled: true,
          executable: fakeChrome,
          headless: true,
          profileDir: path.join(t.path, "profile"),
          width: 800,
          height: 600,
          extraArgs: [],
          navigationTimeoutMs: 15_000,
        })
        const ensuring = yield* Effect.forkScoped(manager.ensure("bot_a"))
        expect(yield* waitFor(() => existsSync(dialedFile))).toBe(true)
        const pid = Number(readFileSync(pidFile, "utf8"))
        expect(alive(pid)).toBe(true)
        yield* Fiber.interrupt(ensuring)
        expect(yield* waitFor(() => !alive(pid))).toBe(true)
      }),
    ),
  15_000,
)
