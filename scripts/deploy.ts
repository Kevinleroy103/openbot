#!/usr/bin/env bun
/**
 * `bun run deploy`: ships the working tree to the live OpenBot without losing the bots' work.
 *
 *   bun run deploy [--grace 3m] [--now] [--data-dir <dir>] [--releases <dir>] [-- <server args>]
 *
 * 1. Copies the repo into a new release, `<releases>/<id>` (unchanged files are hard links to the
 *    previous release, so it is quick and small), and checks that it loads (`main.ts --version`).
 * 2. Drains the running brain (SIGUSR2, apps/server/src/drain.ts): no new turn or task starts, messages
 *    wait, running work gets `--grace` (default 3 minutes); what is still running or waiting then is
 *    saved, and the new brain resumes it. `--now` skips the wait (SIGTERM: saved and resumed too).
 *    A brain from before drains existed loses queued work when it stops: it is waited on until no turn
 *    or task has been queued or running for a minute, then stopped.
 * 3. Backs up the database (`<data>/backups/pre-deploy-<release>.sqlite`, the newest 5 are kept).
 * 4. Starts the new release with the running brain's arguments (or the ones after `--`, or the last
 *    deploy's) and waits for "OpenBot started". If it does not start, the previous release is started
 *    again.
 * 5. Points `<releases>/current` at it and keeps the newest releases.
 *
 * Every `CLAUDE*` variable is removed from the brain's environment (a brain started from inside a
 * Claude Code session must not inherit its account).
 */
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const KEEP_RELEASES = 3
const KEEP_BACKUPS = 5
/** A brain that cannot drain loses queued work when it stops: it must have been idle this long. */
const LEGACY_QUIET_MS = 60_000
const STARTUP_TIMEOUT_MS = 120_000
const EXCLUDES = ["/vendor", "/.git", "screenshots", "/apps/mobile", "/.turbo"]

const say = (line: string) => console.log(`deploy: ${line}`)
// a function declaration: a call narrows types like `return` does
function fail(line: string): never {
  console.error(`deploy: ${line}`)
  process.exit(1)
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

// ---------------------------------------------------------------------------- arguments

const parseDuration = (text: string): number => {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim())
  if (!match) return fail(`not a duration: ${text} (e.g. 90s, 3m)`)
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[(match[2] ?? "s") as "ms" | "s" | "m" | "h"]
  return Math.round(Number(match[1]) * unit)
}

const argv = process.argv.slice(2)
const split = argv.indexOf("--")
const own = split < 0 ? argv : argv.slice(0, split)
const passed = split < 0 ? undefined : argv.slice(split + 1)
const option = (name: string) => {
  const at = own.indexOf(name)
  return at < 0 ? undefined : own[at + 1]
}
const repo = resolve(import.meta.dir, "..")
const dataDir = resolve(option("--data-dir") ?? join(homedir(), ".local/share/openbot"))
const releases = resolve(option("--releases") ?? join(homedir(), ".local/share/openbot-releases"))
const graceMs = parseDuration(option("--grace") ?? "3m")
const now = own.includes("--now")

// ---------------------------------------------------------------------------- the running brain

interface Brain {
  readonly pid: number
  readonly cwd: string
  readonly args: ReadonlyArray<string>
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const runningBrain = (): Brain | undefined => {
  const pidFile = join(dataDir, "brain.pid")
  if (!existsSync(pidFile)) return undefined
  const pid = Number(readFileSync(pidFile, "utf8").trim())
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return undefined
  const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((part) => part !== "")
  const main = cmdline.findIndex((part) => part.endsWith("apps/server/src/main.ts"))
  if (main < 0) return fail(`pid ${pid} in ${pidFile} is not an OpenBot brain: ${cmdline.join(" ")}`)
  return { pid, cwd: readlinkSync(`/proc/${pid}/cwd`), args: cmdline.slice(main + 1) }
}

/** Turns and tasks queued, running or waiting (read-only; the brain keeps writing). */
const workInFlight = (): { turns: number; tasks: number } => {
  try {
    const db = new Database(join(dataDir, "openbot.sqlite"), { readonly: true })
    try {
      const count = (sql: string) => (db.query(sql).get() as { n: number }).n
      return {
        turns: count("select count(*) as n from turns where status in ('queued','running','waiting')"),
        tasks: count("select count(*) as n from tasks where status in ('queued','running')"),
      }
    } finally {
      db.close()
    }
  } catch {
    return { turns: 0, tasks: 0 }
  }
}

const brainEnv = (): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("CLAUDE")) env[key] = value
  }
  return env
}

// ---------------------------------------------------------------------------- steps

const run = (cmd: ReadonlyArray<string>, cwd = repo) => {
  const proc = Bun.spawnSync([...cmd], { cwd, env: brainEnv(), stdout: "pipe", stderr: "pipe" })
  return { ok: proc.exitCode === 0, out: `${proc.stdout.toString()}${proc.stderr.toString()}`.trim() }
}

const releaseId = () => {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)
  const sha = run(["git", "rev-parse", "--short", "HEAD"]).out
  const dirty = run(["git", "status", "--porcelain"]).out !== ""
  return `${stamp}-${sha || "nogit"}${dirty ? "-dirty" : ""}`
}

const prepareRelease = (previous: string | undefined) => {
  const release = join(releases, releaseId())
  mkdirSync(releases, { recursive: true })
  say(`copying the repo to ${release}`)
  const rsync = [
    "rsync",
    "-a",
    "--delete",
    ...EXCLUDES.flatMap((pattern) => ["--exclude", pattern]),
    ...(previous !== undefined && existsSync(previous) ? [`--link-dest=${previous}`] : []),
    `${repo}/`,
    `${release}/`,
  ]
  const copied = run(rsync)
  if (!copied.ok) fail(`copying failed:\n${copied.out}`)
  const loads = run(["bun", "apps/server/src/main.ts", "--version"], release)
  if (!loads.ok) {
    rmSync(release, { recursive: true, force: true })
    fail(`the new release does not load, nothing was changed:\n${loads.out}`)
  }
  return release
}

const stopBrain = async (brain: Brain) => {
  const canDrain = existsSync(join(brain.cwd, "apps/server/src/drain.ts"))
  if (now) {
    say("stopping the brain now (its work is saved and resumed)")
    process.kill(brain.pid, "SIGTERM")
  } else if (canDrain) {
    await Bun.write(join(dataDir, "drain.json"), JSON.stringify({ graceMs }))
    say(`draining: running work gets up to ${Math.round(graceMs / 1000)} s, then the rest is saved and resumed`)
    process.kill(brain.pid, "SIGUSR2")
  } else {
    say(`this brain cannot drain yet: waiting until no turn or task has run for ${LEGACY_QUIET_MS / 1000} s`)
    let quietSince: number | undefined
    let lastReport = 0
    while (quietSince === undefined || Date.now() - quietSince < LEGACY_QUIET_MS) {
      const { turns, tasks } = workInFlight()
      if (turns + tasks > 0) {
        quietSince = undefined
        if (Date.now() - lastReport > 60_000) {
          say(`waiting: ${turns} turn(s), ${tasks} task(s) queued or running`)
          lastReport = Date.now()
        }
      } else quietSince ??= Date.now()
      await sleep(5_000)
    }
    process.kill(brain.pid, "SIGTERM")
  }
  const deadline = Date.now() + (canDrain && !now ? graceMs : 0) + 60_000
  let lastReport = Date.now()
  while (alive(brain.pid)) {
    if (Date.now() > deadline) {
      say("the brain did not stop in time: stopping it")
      process.kill(brain.pid, "SIGTERM")
      await sleep(10_000)
      if (alive(brain.pid)) process.kill(brain.pid, "SIGKILL")
      break
    }
    if (Date.now() - lastReport > 15_000) {
      const { turns, tasks } = workInFlight()
      say(`still finishing: ${turns} turn(s), ${tasks} task(s)`)
      lastReport = Date.now()
    }
    await sleep(500)
  }
  say("the old brain stopped")
}

const startBrain = async (cwd: string, args: ReadonlyArray<string>): Promise<boolean> => {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const logPath = join(dataDir, "server.log")
  const offset = existsSync(logPath) ? statSync(logPath).size : 0
  const log = openSync(logPath, "a")
  const child = Bun.spawn(["setsid", "bun", "apps/server/src/main.ts", ...args], {
    cwd,
    env: brainEnv(),
    stdin: "ignore",
    stdout: log,
    stderr: log,
  })
  child.unref()
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(500)
    // `offset` counts bytes: cut the bytes, not the decoded text (the log is not ASCII)
    const text = readFileSync(logPath).subarray(offset).toString("utf8")
    if (text.includes("OpenBot started")) return true
    if (text.includes("failed to start") || child.exitCode !== null) {
      console.error(text.split("\n").slice(-20).join("\n"))
      return false
    }
  }
  say("no \"OpenBot started\" in time: stopping it")
  // setsid made it a process-group leader: its harness children go with it
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {}
  for (let i = 0; i < 40 && alive(child.pid); i++) await sleep(500)
  if (alive(child.pid)) process.kill(-child.pid, "SIGKILL")
  return false
}

/** `<data>/backups/pre-deploy-<id>.sqlite`, taken while no brain runs; the newest few are kept. */
const backupDatabase = (release: string) => {
  const database = join(dataDir, "openbot.sqlite")
  if (!existsSync(database)) return
  const dir = join(dataDir, "backups")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = join(dir, `pre-deploy-${release.split("/").at(-1)}.sqlite`)
  const db = new Database(database)
  try {
    db.run(`VACUUM INTO '${target.replaceAll("'", "''")}'`)
  } finally {
    db.close()
  }
  const old = readdirSync(dir).filter((name) => name.startsWith("pre-deploy-") && name.endsWith(".sqlite")).sort().slice(0, -KEEP_BACKUPS)
  for (const name of old) rmSync(join(dir, name), { force: true })
  say(`database backed up to ${target}`)
}

const pointCurrent = (release: string) => {
  const link = join(releases, "current")
  const temp = `${link}.tmp-${process.pid}`
  rmSync(temp, { force: true })
  symlinkSync(release, temp)
  renameSync(temp, link)
}

const prune = (keep: ReadonlyArray<string>) => {
  const all = readdirSync(releases, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(releases, entry.name))
    .sort()
  const newest = all.slice(-KEEP_RELEASES)
  for (const dir of all) {
    if (!newest.includes(dir) && !keep.includes(dir)) rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------- main

const savedArgsPath = join(dataDir, "deploy.json")
const brain = runningBrain()
const args = passed ?? brain?.args ?? (existsSync(savedArgsPath) ? (JSON.parse(readFileSync(savedArgsPath, "utf8")) as { args: Array<string> }).args : undefined)
if (args === undefined) fail("OpenBot is not running and no earlier deploy is known: pass the server arguments after --")

const current = existsSync(join(releases, "current")) ? readlinkSync(join(releases, "current")) : undefined
const release = prepareRelease(current ?? brain?.cwd)
if (brain !== undefined) await stopBrain(brain)
backupDatabase(release)
say(`starting ${release}`)
if (await startBrain(release, args)) {
  pointCurrent(release)
  await Bun.write(savedArgsPath, JSON.stringify({ args, release }, null, 2))
  prune([release, ...(current === undefined ? [] : [current])])
  say("done: OpenBot runs the new release; cut-off work resumes on its own")
} else {
  const previous = brain?.cwd ?? current
  if (previous === undefined || !existsSync(previous)) fail("the new release did not start and there is no previous one to go back to")
  say(`the new release did not start: going back to ${previous}`)
  if (!(await startBrain(previous, brain?.args ?? args))) fail("the previous release did not start either: see server.log")
  fail("rolled back to the previous release; see server.log for why the new one failed")
}
