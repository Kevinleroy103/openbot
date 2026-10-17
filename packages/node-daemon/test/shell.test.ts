import { afterAll, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Stream from "effect/Stream"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import * as path from "node:path"
import type { ExecEvent } from "@openbot/node-protocol"
import { inv, makeTestNode, run, tempDir } from "./helpers.ts"

const t = tempDir("shell-")
afterAll(t.cleanup)
const root = path.join(t.path, "work")
const dataDir = path.join(t.path, "state")
mkdirSync(root, { recursive: true })

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitDead = async (pid: number, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await Bun.sleep(20)
  }
  return !alive(pid)
}

type Exit = Extract<ExecEvent, { _tag: "Exit" }>
const exitOf = (events: ReadonlyArray<ExecEvent>) => events.find((e): e is Exit => e._tag === "Exit")!
const stdout = (events: ReadonlyArray<ExecEvent>) =>
  events.flatMap((e) => (e._tag === "Output" && e.stream === "stdout" ? [e.data] : [])).join("")

describe("shell.exec", () => {
  test("streams Started, Output (stdout+stderr, in order) and Exit", () =>
    run(
      Effect.gen(function* () {
        const { client } = yield* makeTestNode({ dataDir, roots: [root] })
        const stamps: Array<{ e: ExecEvent; at: number }> = []
        yield* client["shell.exec"]({
          inv: inv(),
          command: "for i in 1 2 3; do echo out$i; sleep 0.15; done; echo err >&2; exit 3",
          cwd: root,
          timeoutMs: 10_000,
        }).pipe(Stream.runForEach((e) => Effect.sync(() => void stamps.push({ e, at: Date.now() }))))
        const events = stamps.map((s) => s.e)
        expect(events[0]?._tag).toBe("Started")
        const started = events[0] as Extract<ExecEvent, { _tag: "Started" }>
        expect(started.pgid).toBe(started.pid)
        expect(stdout(events)).toBe("out1\nout2\nout3\n")
        expect(events.some((e) => e._tag === "Output" && e.stream === "stderr" && e.data === "err\n")).toBe(true)
        const seqs = events.flatMap((e) => (e._tag === "Output" ? [e.seq] : []))
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
        const exit = exitOf(events)
        expect(exit).toMatchObject({ code: 3, signal: null, timedOut: false })
        // streaming: the first line arrived well before the exit
        const firstOut = stamps.find((s) => s.e._tag === "Output")!
        const last = stamps[stamps.length - 1]!
        expect(last.at - firstOut.at).toBeGreaterThan(200)
      }),
    ))

  test("runs in the cwd with a filtered environment", () =>
    run(
      Effect.gen(function* () {
        const { client } = yield* makeTestNode({ dataDir, roots: [root] })
        const sub = path.join(root, "sub")
        mkdirSync(sub, { recursive: true })
        const events = yield* Stream.runCollect(
          client["shell.exec"]({
            inv: inv("bot_9"),
            command: 'pwd; echo "$FOO|$LD_PRELOAD|$OPENBOT_BOT_ID|$HOME"',
            cwd: sub,
            timeoutMs: 5000,
            env: { FOO: "bar", LD_PRELOAD: "/evil.so", HOME: "/nope" },
          }),
        )
        const [pwd, vars] = stdout(events).trim().split("\n")
        expect(pwd).toBe(sub)
        const [foo, preload, bot, home] = vars!.split("|")
        expect(foo).toBe("bar")
        expect(preload).toBe("")
        expect(bot).toBe("bot_9")
        expect(home).not.toBe("/nope")
      }),
    ))

  test("timeout: TERM then KILL the whole group; Exit reports timedOut", () =>
    run(
      Effect.gen(function* () {
        const { client } = yield* makeTestNode({ dataDir, roots: [root] })
        const t0 = Date.now()
        const events = yield* Stream.runCollect(
          client["shell.exec"]({ inv: inv(), command: "sleep 30 & echo child=$!; sleep 30", cwd: root, timeoutMs: 400 }),
        )
        const exit = exitOf(events)
        expect(exit.timedOut).toBe(true)
        expect(exit.code).toBeNull()
        expect(exit.signal).toBe("SIGTERM")
        expect(Date.now() - t0).toBeLessThan(5000)
        const child = Number(/child=(\d+)/.exec(stdout(events))?.[1])
        expect(child).toBeGreaterThan(0)
        expect(yield* Effect.promise(() => waitDead(child))).toBe(true)
      }),
    ))

  test("G7: a finished command's background children are killed and release the pipes", () =>
    run(
      Effect.gen(function* () {
        const { client } = yield* makeTestNode({ dataDir, roots: [root] })
        const t0 = Date.now()
        const events = yield* Stream.runCollect(
          client["shell.exec"]({ inv: inv(), command: "sleep 30 & echo bg=$!", cwd: root, timeoutMs: 10_000 }),
        )
        expect(Date.now() - t0).toBeLessThan(3000)
        expect(exitOf(events)).toMatchObject({ code: 0, timedOut: false })
        const bg = Number(/bg=(\d+)/.exec(stdout(events))?.[1])
        expect(yield* Effect.promise(() => waitDead(bg))).toBe(true)
      }),
    ))

  test("interrupt (client stops consuming) kills the process group", () =>
    run(
      Effect.gen(function* () {
        const { client } = yield* makeTestNode({ dataDir, roots: [root] })
        const seen: Array<ExecEvent> = []
        const fiber = yield* client["shell.exec"]({
          inv: inv(),
          command: "sleep 60 & echo bg=$!; sleep 60",
          cwd: root,
          timeoutMs: 120_000,
        }).pipe(
          Stream.runForEach((e) => Effect.sync(() => void seen.push(e))),
          Effect.forkChild({ startImmediately: true }),
        )
        // wait for the background pid to be reported
        for (let i = 0; i < 200 && !/bg=\d+/.test(stdout(seen)); i++) yield* Effect.sleep(10)
        const started = seen.find((e) => e._tag === "Started") as Extract<ExecEvent, { _tag: "Started" }>
        const bg = Number(/bg=(\d+)/.exec(stdout(seen))?.[1])
        expect(alive(started.pid)).toBe(true)
        expect(alive(bg)).toBe(true)
        yield* Fiber.interrupt(fiber)
        expect(yield* Effect.promise(() => waitDead(started.pid))).toBe(true)
        expect(yield* Effect.promise(() => waitDead(bg))).toBe(true)
      }),
    ))

  test("output over the cap is spilled to a file in the root and reported in Exit", () =>
    run(
      Effect.gen(function* () {
        const { client } = yield* makeTestNode({ dataDir, roots: [root] })
        const call = inv()
        const events = yield* Stream.runCollect(
          client["shell.exec"]({
            inv: call,
            command: "for i in $(seq 1 500); do echo line-$i-xxxxxxxxxxxxxxxx; done",
            cwd: root,
            timeoutMs: 10_000,
            outputLimitBytes: 1024,
          }),
        )
        const exit = exitOf(events)
        expect(exit.outputTruncated).toBe(true)
        expect(exit.spillPath).toBe(path.join(root, ".openbot", "spill", `${call.invocationId}.log`))
        const streamed = stdout(events)
        expect(Buffer.byteLength(streamed)).toBeLessThanOrEqual(1024)
        const full = readFileSync(exit.spillPath!, "utf8")
        expect(full.split("\n").filter(Boolean).length).toBe(500)
        expect(full.startsWith(streamed)).toBe(true)
      }),
    ))

  test("cwd outside the roots, or missing, is PathDenied; deny-listed commands are PolicyRefused", () =>
    run(
      Effect.gen(function* () {
        const { client } = yield* makeTestNode({ dataDir, roots: [root] })
        const out = yield* Effect.flip(Stream.runCollect(client["shell.exec"]({ inv: inv(), command: "true", cwd: "/", timeoutMs: 1000 })))
        expect(out._tag).toBe("PathDenied")
        const missing = yield* Effect.flip(
          Stream.runCollect(client["shell.exec"]({ inv: inv(), command: "true", cwd: path.join(root, "nope"), timeoutMs: 1000 })),
        )
        expect(missing._tag).toBe("PathDenied")
        const rm = yield* Effect.flip(Stream.runCollect(client["shell.exec"]({ inv: inv(), command: "rm -rf /", cwd: root, timeoutMs: 1000 })))
        expect(rm._tag).toBe("PolicyRefused")
        expect(existsSync(root)).toBe(true)
      }),
    ))

  test("ask-listed commands need the brain's approval even under an `always` ceiling", () =>
    run(
      Effect.gen(function* () {
        const { client, brain } = yield* makeTestNode({ dataDir, roots: [root] })
        brain.decide = () => "deny"
        const e = yield* Effect.flip(Stream.runCollect(client["shell.exec"]({ inv: inv(), command: "sudo true", cwd: root, timeoutMs: 1000 })))
        expect(e._tag).toBe("PolicyRefused")
        expect(brain.approvals.map((a) => a.action)).toEqual(["run-command"])
        brain.decide = () => "allow-once"
        const ok = yield* Stream.runCollect(client["shell.exec"]({ inv: inv(), command: "echo sudo-ish", cwd: root, timeoutMs: 1000 }))
        expect(stdout(ok)).toBe("sudo-ish\n")
      }),
    ))

  test("the audit log records the command outcome", () =>
    run(
      Effect.gen(function* () {
        const { client } = yield* makeTestNode({ dataDir, roots: [root] })
        const call = inv()
        yield* Stream.runCollect(client["shell.exec"]({ inv: call, command: "exit 7", cwd: root, timeoutMs: 1000 }))
        const day = new Date().toISOString().slice(0, 10)
        const lines = readFileSync(path.join(dataDir, "audit", `${day}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l))
        const mine = lines.filter((l) => l.invocationId === call.invocationId)
        expect(mine.map((l) => l.decision)).toEqual(["allowed", "allowed"])
        expect(mine[1]).toMatchObject({ action: "run-command", outcome: "error", exitCode: 7 })
      }),
    ))
})
