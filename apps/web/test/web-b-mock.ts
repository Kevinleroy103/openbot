// Starts W2.2's in-memory OpenBot mock (dev/mock-server.ts) as a child process for the W2.3 screenshot
// test and returns its `/rpc` WebSocket URL. A child process keeps the mock's HTML import (Tailwind via
// apps/web/bunfig.toml) out of the test runner.
import { join } from "node:path"

export interface WebBMock {
  readonly url: string
  readonly rpcUrl: string
  readonly stop: () => Promise<void>
}

const appRoot = new URL("..", import.meta.url).pathname

export const startWebBMock = async (options: { readonly empty?: boolean } = {}): Promise<WebBMock> => {
  const proc = Bun.spawn(["bun", join(appRoot, "dev/mock-server.ts"), "--port", "0", "--fast", ...(options.empty ? ["--empty"] : [])], {
    cwd: appRoot,
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, NODE_ENV: "production" },
  })
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  const deadline = Date.now() + 30_000
  let url: string | undefined
  while (url === undefined) {
    if (Date.now() > deadline) {
      proc.kill()
      throw new Error(`mock server did not start: ${buffered}`)
    }
    const { value, done } = await reader.read()
    if (done) throw new Error(`mock server exited: ${buffered}`)
    buffered += decoder.decode(value, { stream: true })
    const m = /OPENBOT_MOCK_URL=(\S+)/.exec(buffered)
    if (m) url = m[1]!
  }
  // keep draining stdout so the child never blocks on a full pipe
  void (async () => {
    for (;;) {
      const { done } = await reader.read().catch(() => ({ done: true }))
      if (done) break
    }
  })()
  return {
    url,
    rpcUrl: `${url.replace(/^http/, "ws")}/rpc`,
    stop: async () => {
      proc.kill("SIGTERM")
      await Promise.race([proc.exited, Bun.sleep(2000)])
      if (proc.exitCode === null) proc.kill("SIGKILL")
    },
  }
}
