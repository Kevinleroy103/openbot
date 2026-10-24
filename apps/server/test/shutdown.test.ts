// Shutdown watchdog (main.ts / shutdown.ts): a stuck graceful shutdown must not keep the brain or
// its child processes alive.
import { describe, expect, test } from "bun:test"
import { makeShutdownWatchdog, shutdownTimeoutFromEnv } from "../src/shutdown.ts"

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("shutdown watchdog", () => {
  test("forces the exit after the deadline, killing detached children, and says what was stuck", async () => {
    const child = Bun.spawn(
      [process.execPath, new URL("./fixtures/stuck-shutdown.ts", import.meta.url).pathname, "300"],
      { stdout: "pipe", stderr: "pipe" },
    )
    const reader = child.stdout.getReader()
    let out = ""
    while (!/READY (\d+)/.test(out)) out += new TextDecoder().decode((await reader.read()).value)
    const grandchild = Number(/READY (\d+)/.exec(out)![1])
    expect(alive(grandchild)).toBe(true)
    const t0 = Date.now()
    child.kill("SIGTERM")
    await child.exited
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(3_000)
    expect(child.exitCode).toBe(1)
    const stderr = await new Response(child.stderr).text()
    expect(stderr).toContain("stuck at: a finalizer that never returns")
    expect(stderr).toContain("killed 1 child process group")
    await Bun.sleep(100)
    expect(alive(grandchild)).toBe(false)
  }, 10_000)

  test("a second signal forces the exit at once; done() disarms", () => {
    const exits: Array<number> = []
    const lines: Array<string> = []
    const dog = makeShutdownWatchdog({
      timeoutMs: 60_000,
      exit: (c) => exits.push(c),
      log: (l) => lines.push(l),
      kill: () => [],
    })
    dog.signal("SIGTERM")
    expect(exits).toEqual([])
    dog.signal("SIGINT")
    expect(exits).toEqual([1])
    expect(lines[0]).toContain("second SIGINT")

    const calm: Array<number> = []
    const ok = makeShutdownWatchdog({ timeoutMs: 1, exit: (c) => calm.push(c), log: () => undefined, kill: () => [] })
    ok.signal("SIGTERM")
    ok.done()
    ok.signal("SIGTERM")
    return Bun.sleep(20).then(() => expect(calm).toEqual([]))
  })

  test("OPENBOT_SHUTDOWN_TIMEOUT_MS", () => {
    expect(shutdownTimeoutFromEnv({})).toBe(5_000)
    expect(shutdownTimeoutFromEnv({ OPENBOT_SHUTDOWN_TIMEOUT_MS: "1500" })).toBe(1_500)
    expect(shutdownTimeoutFromEnv({ OPENBOT_SHUTDOWN_TIMEOUT_MS: "soon" })).toBe(5_000)
  })
})
