import { afterAll, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { canonicalize, makePathPolicy } from "../src/index.ts"
import { tempDir } from "./helpers.ts"

const t = tempDir("pathpolicy-")
afterAll(t.cleanup)

const root = path.join(t.path, "work")
const ro = path.join(t.path, "ro")
const outside = path.join(t.path, "outside")
const dataDir = path.join(t.path, "state")
mkdirSync(path.join(root, "sub"), { recursive: true })
mkdirSync(ro, { recursive: true })
mkdirSync(outside, { recursive: true })
mkdirSync(dataDir, { recursive: true })
writeFileSync(path.join(outside, "secret.txt"), "s3cret")
writeFileSync(path.join(root, "a.txt"), "a")
writeFileSync(path.join(ro, "r.txt"), "r")
// symlinks that escape the root: a file link, a dir link and a link to the parent
symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link-file"))
symlinkSync(outside, path.join(root, "link-dir"))
symlinkSync("..", path.join(root, "sub", "up"))
// a symlink that stays inside
symlinkSync(path.join(root, "a.txt"), path.join(root, "inner-link"))

const policy = makePathPolicy({
  roots: [
    { id: "work", path: root, mode: "rw" },
    { id: "ro", path: ro, mode: "ro" },
    { id: "bots", path: path.join(t.path, "bots", "{botId}", "workspace"), mode: "rw" },
  ],
  dataDir,
  denyGlobs: ["**/*.pem"],
})

const resolve = (p: string, access: "read" | "write" = "read", botId = "bot_1", cwd?: string) =>
  Effect.runPromise(Effect.result(policy.resolve({ path: p, botId, access, cwd })))

const ok = async (p: string, access: "read" | "write" = "read", botId?: string, cwd?: string) => {
  const r = await resolve(p, access, botId, cwd)
  if (r._tag !== "Success") throw new Error(`expected success for ${p}: ${JSON.stringify(r.failure)}`)
  return r.success
}
const denied = async (p: string, access: "read" | "write" = "read", botId?: string, cwd?: string) => {
  const r = await resolve(p, access, botId, cwd)
  if (r._tag !== "Failure") throw new Error(`expected PathDenied for ${p}, got ${JSON.stringify(r.success)}`)
  expect(r.failure._tag).toBe("PathDenied")
  return r.failure.reason
}

describe("PathPolicy containment", () => {
  test("relative paths resolve against the first root", async () => {
    const r = await ok("a.txt")
    expect(r.real).toBe(path.join(root, "a.txt"))
    expect(r.root.id).toBe("work")
    expect(r.exists).toBe(true)
  })

  test("absolute paths inside a root, and missing files under a root", async () => {
    expect((await ok(path.join(root, "sub"))).exists).toBe(true)
    const missing = await ok(path.join(root, "new", "deep", "file.txt"), "write")
    expect(missing.exists).toBe(false)
    expect(missing.real).toBe(path.join(root, "new", "deep", "file.txt"))
  })

  test("lexical escapes are refused", async () => {
    expect(await denied("../outside/secret.txt")).toContain("outside the node's roots")
    expect(await denied(path.join(outside, "secret.txt"))).toContain("outside")
    expect(await denied("/etc/passwd")).toContain("outside")
    await denied(`${root}/../outside/secret.txt`)
  })

  test("a root is not a string prefix of a sibling", async () => {
    mkdirSync(`${root}-evil`, { recursive: true })
    await denied(`${root}-evil/x`)
  })

  test("symlink escapes are refused (file, dir, parent link, missing tail)", async () => {
    expect(await denied("link-file")).toContain("after resolving symlinks")
    await denied("link-dir/secret.txt")
    await denied("link-dir/new-file.txt", "write")
    // `..` is collapsed lexically BEFORE realpath, and operations act on the canonical path, so this
    // names `<root>/sub/outside/secret.txt` (inside the root), never the outside file
    const lexical = await ok("sub/up/../outside/secret.txt")
    expect(lexical.real).toBe(path.join(root, "sub", "outside", "secret.txt"))
    expect(lexical.exists).toBe(false)
    await denied("sub/up/../../../outside/secret.txt")
    // `sub/up` points at the root itself: still contained
    expect((await ok("sub/up/a.txt")).real).toBe(path.join(root, "a.txt"))
  })

  test("symlinks that stay inside resolve to their target; writing through them is refused", async () => {
    expect((await ok("inner-link")).real).toBe(path.join(root, "a.txt"))
    expect(await denied("inner-link", "write")).toContain("symlink")
  })

  test("read-only roots refuse writes", async () => {
    await ok(path.join(ro, "r.txt"), "read")
    expect(await denied(path.join(ro, "r.txt"), "write")).toContain("read-only")
  })

  test("deny-list: secret dirs and files, extra globs, the node's state dir", async () => {
    mkdirSync(path.join(root, ".ssh"), { recursive: true })
    expect(await denied(".ssh/config")).toContain(".ssh")
    expect(await denied("keys/id_ed25519")).toContain("deny-list")
    expect(await denied("certs/server.pem", "write")).toContain("deny-list")
    // the node's own state dir, even when a root contains it
    const nested = makePathPolicy({ roots: [{ id: "all", path: t.path, mode: "rw" }], dataDir })
    const r = await Effect.runPromise(Effect.result(nested.resolve({ path: path.join(dataDir, "identity.json"), botId: "b", access: "read" })))
    expect(r._tag).toBe("Failure")
  })

  test("NUL bytes are refused", async () => {
    expect(await denied("a.txt\0.png")).toContain("NUL")
  })

  test("{botId} roots are per bot; unsafe bot ids get no such root", async () => {
    const ws = path.join(t.path, "bots", "bot_7", "workspace")
    mkdirSync(ws, { recursive: true })
    expect((await ok(path.join(ws, "f.txt"), "write", "bot_7")).root.id).toBe("bots")
    await denied(path.join(ws, "f.txt"), "write", "bot_8")
    await denied(path.join(t.path, "bots", "..", "x"), "read", "..")
  })

  test("cwd: relative paths resolve against an in-root cwd; an out-of-root cwd is refused", async () => {
    expect((await ok("../a.txt", "read", "bot_1", path.join(root, "sub"))).real).toBe(path.join(root, "a.txt"))
    expect(await denied("x", "read", "bot_1", outside)).toContain("cwd")
  })

  test("allows() filters canonical paths for listings", () => {
    expect(policy.allows(path.join(root, "a.txt"), "bot_1")).toBe(true)
    expect(policy.allows(path.join(outside, "secret.txt"), "bot_1")).toBe(false)
    expect(policy.allows(path.join(root, ".ssh", "id_rsa"), "bot_1")).toBe(false)
  })

  test("canonicalize re-attaches a missing tail to the deepest existing ancestor", () => {
    const c = canonicalize(path.join(root, "link-dir", "nope", "x"))
    expect(c.real).toBe(path.join(outside, "nope", "x"))
    expect(c.exists).toBe(false)
  })

  test("wildcard roots: <base>/*/workspace", async () => {
    const wild = makePathPolicy({ roots: [{ id: "ws", path: path.join(t.path, "bots", "*", "workspace"), mode: "rw" }], dataDir })
    const r = await Effect.runPromise(Effect.result(wild.resolve({ path: path.join(t.path, "bots", "bot_7", "workspace", "x"), botId: "b", access: "write" })))
    expect(r._tag).toBe("Success")
    const bad = await Effect.runPromise(Effect.result(wild.resolve({ path: path.join(t.path, "bots", "bot_7", "other"), botId: "b", access: "read" })))
    expect(bad._tag).toBe("Failure")
  })
})

describe("PathPolicy extra per-bot roots (the local node's project folders)", () => {
  const project = path.join(t.path, "projects", "snip")
  mkdirSync(path.join(project, "src"), { recursive: true })
  writeFileSync(path.join(project, "src", "a.ts"), "a")
  symlinkSync(outside, path.join(project, "escape"))
  const folders = new Map<string, ReadonlyArray<string>>([["bot_p", [project, "relative/ignored", "/"]]])
  const dynamic = makePathPolicy({
    roots: [{ id: "bots", path: path.join(t.path, "bots", "{botId}", "workspace"), mode: "rw" }],
    dataDir,
    extraRoots: (botId) => folders.get(botId) ?? [],
  })
  const run = (p: string, botId: string, access: "read" | "write" = "read", cwd?: string) =>
    Effect.runPromise(Effect.result(dynamic.resolve({ path: p, botId, access, cwd })))

  test("a bot reaches its folders (read, write, as cwd); other bots do not", async () => {
    expect((await run(path.join(project, "src", "a.ts"), "bot_p"))._tag).toBe("Success")
    expect((await run(path.join(project, "src", "new.ts"), "bot_p", "write"))._tag).toBe("Success")
    expect((await run("a.ts", "bot_p", "read", path.join(project, "src")))._tag).toBe("Success")
    expect(dynamic.allows(path.join(project, "src", "a.ts"), "bot_p")).toBe(true)
    expect((await run(path.join(project, "src", "a.ts"), "bot_other"))._tag).toBe("Failure")
    // the static roots reported in node.hello are unchanged
    expect(dynamic.roots.map((r) => r.id)).toEqual(["bots"])
  })

  test("changes apply at once; symlink escapes, `/` and relative entries never count", async () => {
    expect((await run(path.join(project, "escape", "secret.txt"), "bot_p"))._tag).toBe("Failure")
    expect((await run("/etc/hostname", "bot_p"))._tag).toBe("Failure")
    folders.set("bot_p", [])
    expect((await run(path.join(project, "src", "a.ts"), "bot_p"))._tag).toBe("Failure")
    folders.set("bot_p", [project])
    expect((await run(path.join(project, "src", "a.ts"), "bot_p"))._tag).toBe("Success")
  })
})
