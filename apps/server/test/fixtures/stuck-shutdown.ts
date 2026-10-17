// A process whose "graceful shutdown" never finishes, with a detached child (like a harness CLI or
// the local node's Chromium). Used by shutdown.test.ts: the watchdog must kill both.
import { makeShutdownWatchdog, setShutdownPhase } from "../../src/shutdown.ts"

const grandchild = Bun.spawn(["sleep", "60"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
const watchdog = makeShutdownWatchdog({ timeoutMs: Number(process.argv[2] ?? 300) })
process.on("SIGTERM", () => {
  setShutdownPhase("a finalizer that never returns")
  watchdog.signal("SIGTERM")
})
console.log(`READY ${grandchild.pid}`)
setInterval(() => undefined, 1_000)
