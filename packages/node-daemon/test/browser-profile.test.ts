// The browser profile lock (launch.ts `clearStaleLock`): an orphaned browser on this node's profile
// (its brain / daemon was SIGKILLed) is killed so the next launch works; other processes are left alone.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import * as path from "node:path"
import { clearStaleLock } from "../src/browser/launch.ts"

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const procs: Array<Bun.Subprocess> = []
const dirs: Array<string> = []
afterEach(() => {
  for (const p of procs.splice(0)) p.kill("SIGKILL")
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const profile = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openbot-profile-test-"))
  dirs.push(dir)
  return dir
}

/** A long-running stand-in for Chromium whose argv carries `extra`, spawned detached like the real one. */
const fakeBrowser = (extra: string) => {
  const p = Bun.spawn(["sh", "-c", "sleep 60", "sh", extra], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  procs.push(p)
  return p
}

describe("clearStaleLock", () => {
  test("kills an orphaned browser that holds this profile, then removes the lock", async () => {
    const dir = profile()
    const orphan = fakeBrowser(`--user-data-dir=${dir}`)
    symlinkSync(`${hostname()}-${orphan.pid}`, path.join(dir, "SingletonLock"))
    clearStaleLock(dir)
    await orphan.exited
    expect(alive(orphan.pid)).toBe(false)
    expect(existsSync(path.join(dir, "SingletonLock"))).toBe(false)
  })

  test("leaves an unrelated live process (and its lock) alone", () => {
    const dir = profile()
    const other = fakeBrowser("--user-data-dir=/somewhere/else")
    symlinkSync(`${hostname()}-${other.pid}`, path.join(dir, "SingletonLock"))
    clearStaleLock(dir)
    expect(alive(other.pid)).toBe(true)
    expect(path.basename(path.join(dir, "SingletonLock"))).toBe("SingletonLock")
    expect(() => require("node:fs").readlinkSync(path.join(dir, "SingletonLock"))).not.toThrow()
  })

  test("removes the lock of a dead browser", async () => {
    const dir = profile()
    const gone = fakeBrowser(`--user-data-dir=${dir}`)
    gone.kill("SIGKILL")
    await gone.exited
    symlinkSync(`${hostname()}-${gone.pid}`, path.join(dir, "SingletonLock"))
    clearStaleLock(dir)
    expect(existsSync(path.join(dir, "SingletonLock"))).toBe(false)
  })
})
