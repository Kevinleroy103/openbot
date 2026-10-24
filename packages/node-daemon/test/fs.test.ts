import { afterAll, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { sha256Hex } from "../src/index.ts"
import { inv, makeTestNode, run, tempDir } from "./helpers.ts"

const t = tempDir("fs-")
afterAll(t.cleanup)
const root = path.join(t.path, "work")
const outside = path.join(t.path, "outside")
const dataDir = path.join(t.path, "state")
mkdirSync(root, { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(path.join(outside, "secret.txt"), "top secret")
symlinkSync(outside, path.join(root, "escape"))

const node = (extra?: Parameters<typeof makeTestNode>[0]) => makeTestNode({ dataDir, roots: [root], ...extra })

const failureTag = <A, E extends { _tag: string }, R>(e: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(e), (err) => err)

describe("fs ops", () => {
  test("write → read → stat round trip (atomic, sha256, createParents)", () =>
    run(
      Effect.gen(function* () {
        const { client } = yield* node()
        const w = yield* client["fs.write"]({ inv: inv(), path: "dir/a/hello.txt", content: "hello\nworld\n" })
        expect(w.size).toBe(12)
        expect(w.sha256).toBe(sha256Hex("hello\nworld\n"))
        expect(readFileSync(path.join(root, "dir/a/hello.txt"), "utf8")).toBe("hello\nworld\n")
        // no temp files left behind
        expect(readdirSync(path.join(root, "dir/a"))).toEqual(["hello.txt"])

        const r = yield* client["fs.read"]({ inv: inv(), path: path.join(root, "dir/a/hello.txt") })
        expect(r).toEqual({ content: "hello\nworld\n", encoding: "utf8", sha256: w.sha256, size: 12, truncated: false })

        const part = yield* client["fs.read"]({ inv: inv(), path: "dir/a/hello.txt", offset: 6, limit: 3 })
        expect(part.content).toBe("wor")
        expect(part.truncated).toBe(true)
        expect(part.sha256).toBe(w.sha256)

        const st = yield* client["fs.stat"]({ inv: inv(), path: "dir/a/hello.txt" })
        expect(st?.type).toBe("file")
        expect(st?.size).toBe(12)
        expect(yield* client["fs.stat"]({ inv: inv(), path: "nope.txt" })).toBeNull()
      }),
    ))

  test("base64 encoding round trip", () =>
    run(
      Effect.gen(function* () {
        const { client } = yield* node()
        const bytes = Buffer.from([0, 1, 2, 250, 255])
        yield* client["fs.write"]({
          inv: inv(),
          path: "bin.dat",
          content: bytes.toString("base64"),
          encoding: "base64",
        })
        const r = yield* client["fs.read"]({ inv: inv(), path: "bin.dat", encoding: "base64" })
        expect(Buffer.from(r.content, "base64")).toEqual(bytes)
        expect(r.size).toBe(5)
      }),
    ))

  test("expectedSha256: stale writes fail, '' means must not exist", () =>
    run(
      Effect.gen(function* () {
        const { client } = yield* node()
        const first = yield* client["fs.write"]({ inv: inv(), path: "cas.txt", content: "v1", expectedSha256: "" })
        const again = yield* Effect.flip(
          client["fs.write"]({ inv: inv(), path: "cas.txt", content: "x", expectedSha256: "" }),
        )
        expect(again._tag).toBe("EditFailed")
        const stale = yield* Effect.flip(
          client["fs.write"]({ inv: inv(), path: "cas.txt", content: "x", expectedSha256: "0".repeat(64) }),
        )
        expect(stale._tag).toBe("EditFailed")
        yield* client["fs.write"]({ inv: inv(), path: "cas.txt", content: "v2", expectedSha256: first.sha256 })
        expect(readFileSync(path.join(root, "cas.txt"), "utf8")).toBe("v2")
      }),
    ))

  test("edit: unique match, replaceAll, not found, ambiguous, stale", () =>
    run(
      Effect.gen(function* () {
        const { client } = yield* node()
        yield* client["fs.write"]({ inv: inv(), path: "e.txt", content: "a b a c\n" })
        const amb = yield* Effect.flip(client["fs.edit"]({ inv: inv(), path: "e.txt", oldString: "a", newString: "z" }))
        expect(amb._tag).toBe("EditFailed")
        expect((amb as { reason: string }).reason).toContain("2 times")
        const one = yield* client["fs.edit"]({ inv: inv(), path: "e.txt", oldString: "b", newString: "B" })
        expect(one.replacements).toBe(1)
        const all = yield* client["fs.edit"]({
          inv: inv(),
          path: "e.txt",
          oldString: "a",
          newString: "$&x",
          replaceAll: true,
        })
        expect(all.replacements).toBe(2)
        // `$&` is literal, not a replacement pattern
        expect(readFileSync(path.join(root, "e.txt"), "utf8")).toBe("$&x B $&x c\n")
        expect(all.sha256).toBe(sha256Hex("$&x B $&x c\n"))
        const missing = yield* Effect.flip(
          client["fs.edit"]({ inv: inv(), path: "e.txt", oldString: "nope", newString: "x" }),
        )
        expect(missing._tag).toBe("EditFailed")
        const stale = yield* Effect.flip(
          client["fs.edit"]({ inv: inv(), path: "e.txt", oldString: "c", newString: "d", expectedSha256: "00" }),
        )
        expect(stale._tag).toBe("EditFailed")
        const nofile = yield* Effect.flip(
          client["fs.edit"]({ inv: inv(), path: "none.txt", oldString: "c", newString: "d" }),
        )
        expect(nofile._tag).toBe("FsError")
      }),
    ))

  test("list (depth, hidden, limit) and glob", () =>
    run(
      Effect.gen(function* () {
        const { client } = yield* node()
        for (const f of ["l/one.ts", "l/two.md", "l/sub/three.ts", "l/.hidden"]) {
          yield* client["fs.write"]({ inv: inv(), path: f, content: f })
        }
        const shallow = yield* client["fs.list"]({ inv: inv(), path: "l" })
        expect(shallow.entries.map((e) => e.path)).toEqual(["one.ts", "sub", "two.md"])
        expect(shallow.entries.find((e) => e.path === "sub")?.type).toBe("dir")
        const deep = yield* client["fs.list"]({ inv: inv(), path: "l", depth: 3, includeHidden: true })
        expect(deep.entries.map((e) => e.path).sort()).toEqual([".hidden", "one.ts", "sub", "sub/three.ts", "two.md"])
        const limited = yield* client["fs.list"]({ inv: inv(), path: "l", limit: 2 })
        expect(limited.entries.length).toBe(2)
        expect(limited.truncated).toBe(true)

        const g = yield* client["fs.glob"]({ inv: inv(), pattern: "**/*.ts", cwd: path.join(root, "l") })
        expect(g.paths.map((p) => path.relative(root, p)).sort()).toEqual(["l/one.ts", "l/sub/three.ts"])
        expect(g.truncated).toBe(false)
      }),
    ))

  test("listing does not follow symlinks out of the root", () =>
    run(
      Effect.gen(function* () {
        const { client } = yield* node()
        const all = yield* client["fs.list"]({ inv: inv(), path: ".", depth: 3 })
        expect(all.entries.some((e) => e.path.startsWith("escape/"))).toBe(false)
        const g = yield* client["fs.glob"]({ inv: inv(), pattern: "**/*.txt", cwd: root })
        expect(g.paths.some((p) => p.includes("secret"))).toBe(false)
      }),
    ))

  for (const backend of ["rg", "js"] as const) {
    test(`grep (${backend}): content with context, files_with_matches, count, ignoreCase, literal, glob`, () =>
      run(
        Effect.gen(function* () {
          const rg = Bun.which("rg")
          if (backend === "rg" && !rg) return
          const { client } = yield* node({ dataDir, roots: [root], binaries: backend === "rg" ? { rg: rg! } : {} })
          yield* client["fs.write"]({ inv: inv(), path: "g/a.txt", content: "alpha\nbeta\nGamma\nbeta again\n" })
          yield* client["fs.write"]({ inv: inv(), path: "g/b.md", content: "nothing\nbeta.max\n" })
          const content = yield* client["fs.grep"]({ inv: inv(), pattern: "beta", path: "g", glob: "*.txt" })
          expect(content.matches.map((m) => [path.basename(m.path), m.line, m.text])).toEqual([
            ["a.txt", 2, "beta"],
            ["a.txt", 4, "beta again"],
          ])
          const ctx = yield* client["fs.grep"]({ inv: inv(), pattern: "^Gamma$", path: "g/a.txt", contextLines: 1 })
          expect(ctx.matches.map((m) => m.line)).toEqual([2, 3, 4])
          const files = yield* client["fs.grep"]({
            inv: inv(),
            pattern: "beta",
            path: "g",
            outputMode: "files_with_matches",
          })
          expect(files.files.map((f) => path.basename(f))).toEqual(["a.txt", "b.md"])
          const counts = yield* client["fs.grep"]({ inv: inv(), pattern: "beta", path: "g", outputMode: "count" })
          expect(counts.counts.map((c) => [path.basename(c.path), c.count])).toEqual([
            ["a.txt", 2],
            ["b.md", 1],
          ])
          const ci = yield* client["fs.grep"]({ inv: inv(), pattern: "gamma", path: "g", ignoreCase: true })
          expect(ci.matches.length).toBe(1)
          const lit = yield* client["fs.grep"]({ inv: inv(), pattern: "beta.max", path: "g", literal: true })
          expect(lit.matches.map((m) => m.text)).toEqual(["beta.max"])
          const lim = yield* client["fs.grep"]({ inv: inv(), pattern: "a", path: "g", limit: 1 })
          expect(lim.matches.length).toBe(1)
          expect(lim.truncated).toBe(true)
        }),
      ))
  }

  test("mkdir, move (no overwrite unless asked), remove (recursive; never through a symlink)", () =>
    run(
      Effect.gen(function* () {
        const { client } = yield* node()
        yield* client["fs.mkdir"]({ inv: inv(), path: "m/x/y" })
        expect(existsSync(path.join(root, "m/x/y"))).toBe(true)
        yield* client["fs.write"]({ inv: inv(), path: "m/f1", content: "1" })
        yield* client["fs.write"]({ inv: inv(), path: "m/f2", content: "2" })
        const exists = yield* Effect.flip(client["fs.move"]({ inv: inv(), from: "m/f1", to: "m/f2" }))
        expect(exists._tag).toBe("FsError")
        yield* client["fs.move"]({ inv: inv(), from: "m/f1", to: "m/f2", overwrite: true })
        expect(readFileSync(path.join(root, "m/f2"), "utf8")).toBe("1")
        yield* client["fs.move"]({ inv: inv(), from: "m/f2", to: "m/x/moved" })
        expect(readFileSync(path.join(root, "m/x/moved"), "utf8")).toBe("1")

        const notEmpty = yield* Effect.flip(client["fs.remove"]({ inv: inv(), path: "m/x" }))
        expect(notEmpty._tag).toBe("FsError")
        yield* client["fs.remove"]({ inv: inv(), path: "m/x", recursive: true })
        expect(existsSync(path.join(root, "m/x"))).toBe(false)

        symlinkSync(path.join(root, "m"), path.join(root, "m-link"))
        // writes (and removals) through a final-component symlink are refused; the target survives
        const viaLink = yield* Effect.flip(client["fs.remove"]({ inv: inv(), path: "m-link", recursive: true }))
        expect(viaLink._tag).toBe("PathDenied")
        expect(existsSync(path.join(root, "m"))).toBe(true)
        const rootRemove = yield* Effect.flip(client["fs.remove"]({ inv: inv(), path: root, recursive: true }))
        expect(rootRemove._tag).toBe("PathDenied")
        expect(existsSync(root)).toBe(true)
      }),
    ))

  test("escapes and deny-list are refused with PathDenied; nothing outside is touched", () =>
    run(
      Effect.gen(function* () {
        const { client } = yield* node()
        const read = yield* failureTag(client["fs.read"]({ inv: inv(), path: "escape/secret.txt" }))
        expect(read._tag).toBe("PathDenied")
        const write = yield* failureTag(client["fs.write"]({ inv: inv(), path: "escape/new.txt", content: "x" }))
        expect(write._tag).toBe("PathDenied")
        expect(existsSync(path.join(outside, "new.txt"))).toBe(false)
        const abs = yield* failureTag(client["fs.read"]({ inv: inv(), path: "/etc/hostname" }))
        expect(abs._tag).toBe("PathDenied")
        const ssh = yield* failureTag(client["fs.write"]({ inv: inv(), path: ".ssh/authorized_keys", content: "k" }))
        expect(ssh._tag).toBe("PathDenied")
        const mv = yield* failureTag(
          client["fs.move"]({ inv: inv(), from: "cas.txt", to: path.join(outside, "stolen") }),
        )
        expect(mv._tag).toBe("PathDenied")
        const dirRead = yield* failureTag(client["fs.read"]({ inv: inv(), path: "." }))
        expect(dirRead._tag).toBe("FsError")
      }),
    ))

  test("policy: a `never` ceiling refuses writes (PolicyRefused, do not retry) and audits it", () =>
    run(
      Effect.gen(function* () {
        const { client } = yield* node({
          dataDir,
          roots: [root],
          policy: { ceiling: "always", actions: { "write-file": "never" } },
        })
        const e = yield* failureTag(client["fs.write"]({ inv: inv(), path: "never.txt", content: "x" }))
        expect(e._tag).toBe("PolicyRefused")
        expect((e as { retry: boolean }).retry).toBe(false)
        expect(existsSync(path.join(root, "never.txt"))).toBe(false)
        // reads are still fine
        yield* client["fs.list"]({ inv: inv(), path: "." })
        const day = new Date().toISOString().slice(0, 10)
        const log = readFileSync(path.join(dataDir, "audit", `${day}.jsonl`), "utf8")
        expect(log).toContain('"decision":"refused"')
      }),
    ))

  test("policy: `ask` goes to the brain; deny refuses, allow-always is remembered", () =>
    run(
      Effect.gen(function* () {
        const { client, brain } = yield* node({ dataDir, roots: [root], policy: { ceiling: "ask" } })
        brain.decide = () => "deny"
        const call = inv("bot_1", "toolu_1")
        const denied = yield* failureTag(client["fs.write"]({ inv: call, path: "ask.txt", content: "x" }))
        expect(denied._tag).toBe("PolicyRefused")
        expect(brain.approvals[0]).toMatchObject({
          invocationId: call.invocationId,
          botId: "bot_1",
          runId: call.runId,
          toolCallId: "toolu_1",
          action: "write-file",
          target: "ask.txt",
        })
        brain.decide = () => "allow-always"
        yield* client["fs.write"]({ inv: inv(), path: "ask.txt", content: "x" })
        yield* client["fs.write"]({ inv: inv(), path: "ask.txt", content: "y" })
        // the second identical write used the cached grant
        expect(brain.approvals.length).toBe(2)
        expect(readFileSync(path.join(root, "ask.txt"), "utf8")).toBe("y")
      }),
    ))
})
