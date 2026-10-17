import type { BotId, MemoryFactId, Millis, SkillName } from "@openbot/contracts"
import { AttachmentStore, MemoryStore, SkillStore } from "@openbot/core"
import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Exit, Option, Schema, Stream } from "effect"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseFrontmatter, pluginManifest, renderFrontmatter } from "../src/index.ts"
import { cleanupTempDirs, run, tempDataDir, testPersistence } from "./helpers.ts"

afterAll(cleanupTempDirs)

const bot = "bot_mem" as BotId

describe("MemoryStore files (Claude auto-memory format)", () => {
  test("writes MEMORY.md and one frontmatter file per fact, and reads them back exactly", async () => {
    const dir = await tempDataDir()
    const fact = {
      id: "dark-mode" as MemoryFactId,
      title: "Prefers dark mode: always",
      description: "UI preference",
      body: "The owner prefers dark mode.\n\n- even at noon\n",
      updatedAt: 1_760_000_000_123 as Millis,
    }
    const read = await run(
      Effect.gen(function*() {
        const store = yield* MemoryStore
        yield* store.writeIndex(bot, "- [Dark mode](dark-mode.md) — UI preference\n")
        yield* store.putFact(bot, fact)
        return { index: yield* store.readIndex(bot), fact: yield* store.getFact(bot, fact.id), all: yield* store.listFacts(bot) }
      }),
      testPersistence(dir),
    )
    expect(read.index).toBe("- [Dark mode](dark-mode.md) — UI preference\n")
    expect(Option.getOrThrow(read.fact)).toEqual(fact)
    expect(read.all).toEqual([fact])

    const memoryDir = join(dir, "bots", bot, "memory")
    expect((await readdir(memoryDir)).sort()).toEqual(["MEMORY.md", "dark-mode.md"])
    const text = await readFile(join(memoryDir, "dark-mode.md"), "utf8")
    expect(text).toBe(
      [
        "---",
        "name: \"Prefers dark mode: always\"",
        "description: UI preference",
        "metadata:",
        "  modified: 2025-10-09T08:53:20.123Z",
        "---",
        "",
        "The owner prefers dark mode.\n\n- even at noon\n",
      ].join("\n"),
    )
  })

  test("tolerates files written by Claude: keeps unknown keys, ignores non-fact files", async () => {
    const dir = await tempDataDir()
    const memoryDir = join(dir, "bots", bot, "memory")
    await mkdir(memoryDir, { recursive: true })
    await writeFile(
      join(memoryDir, "project-goal.md"),
      "---\nname: project-goal\ndescription: \"OpenBot = Grok Bot clone\"\nmetadata:\n  node_type: memory\n  type: project\n  modified: 2026-10-14T21:01:15.498Z\n---\n\nBuild it.\n",
    )
    await writeFile(join(memoryDir, "Notes With Spaces.md"), "ignored")
    await writeFile(join(memoryDir, "no-frontmatter.md"), "just text")
    const facts = await run(
      Effect.gen(function*() {
        const store = yield* MemoryStore
        const before = yield* store.listFacts(bot)
        const goal = before.find((f) => f.id === "project-goal")!
        yield* store.putFact(bot, { ...goal, body: "Build it well.\n", updatedAt: 1 as Millis })
        return before
      }),
      testPersistence(dir),
    )
    expect(facts.map((f) => [f.id, f.title, f.description, f.updatedAt])).toEqual([
      ["no-frontmatter", "no-frontmatter", undefined, expect.any(Number)],
      ["project-goal", "project-goal", "OpenBot = Grok Bot clone", Date.parse("2026-10-14T21:01:15.498Z")],
    ])
    const rewritten = await readFile(join(memoryDir, "project-goal.md"), "utf8")
    expect(rewritten).toContain("  node_type: memory\n  type: project\n  modified: 1970-01-01T00:00:00.001Z\n")
    expect(rewritten.endsWith("---\n\nBuild it well.\n")).toBe(true)
  })

  test("rejects bot ids that would escape the data dir", async () => {
    const dir = await tempDataDir()
    const exit = await run(
      Effect.exit(Effect.flatMap(MemoryStore, (store) => store.writeIndex("../../etc" as BotId, "x"))),
      testPersistence(dir),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("SkillStore files (Claude plugin layout)", () => {
  test("keeps plugin.json and writes skills/<name>/SKILL.md with frontmatter", async () => {
    const dir = await tempDataDir()
    const skill = {
      name: "triage" as SkillName,
      description: "Use when triaging GitHub issues: label, dedupe, assign",
      body: "# Triage\n\n1. Read the issue.\n",
      updatedAt: 42 as Millis,
    }
    const [listed, root] = await run(
      Effect.gen(function*() {
        const store = yield* SkillStore
        yield* store.put(skill)
        return [yield* store.list, store.root] as const
      }),
      testPersistence(dir),
    )
    expect(listed).toEqual([skill])
    expect(root).toBe(join(dir, "skills-lib"))
    expect(JSON.parse(await readFile(join(dir, "skills-lib", ".claude-plugin", "plugin.json"), "utf8"))).toEqual(pluginManifest)
    const text = await readFile(join(dir, "skills-lib", "skills", "triage", "SKILL.md"), "utf8")
    expect(text.startsWith("---\nname: triage\ndescription: \"Use when triaging GitHub issues: label, dedupe, assign\"\n")).toBe(true)
  })
})

describe("AttachmentStore files", () => {
  test("stores bytes at <data>/attachments/<id>", async () => {
    const dir = await tempDataDir()
    const record = await run(
      Effect.flatMap(AttachmentStore, (store) => store.put({ name: "a.png", mime: "image/png", bytes: new Uint8Array([1, 2, 3]) })),
      testPersistence(dir),
    )
    expect(record.path).toBe(join(dir, "attachments", record.id))
    expect([...(await readFile(record.path))]).toEqual([1, 2, 3])
    // Metadata survives a reopen.
    const again = await run(Effect.flatMap(AttachmentStore, (store) => store.get(record.id)), testPersistence(dir))
    expect(Option.getOrThrow(again)).toEqual(record)
    await run(Effect.flatMap(AttachmentStore, (store) => store.delete(record.id)), testPersistence(dir))
    expect(existsSync(record.path)).toBe(false)
  })

  test("putStream writes chunks as they arrive; a failed stream leaves nothing behind", async () => {
    const dir = await tempDataDir()
    const chunks = Array.from({ length: 5 }, (_, i) => new Uint8Array(300_000).fill(i + 1))
    const record = await run(
      Effect.flatMap(AttachmentStore, (store) =>
        store.putStream({ name: "clip.mp4", mime: "video/mp4", chunks: Stream.fromIterable(chunks), width: 1920, height: 1080 })),
      testPersistence(dir),
    )
    expect(record).toMatchObject({ name: "clip.mp4", mime: "video/mp4", byteSize: 1_500_000, width: 1920, height: 1080 })
    const bytes = await readFile(record.path)
    expect(bytes.byteLength).toBe(1_500_000)
    expect(bytes[0]).toBe(1)
    expect(bytes[1_499_999]).toBe(5)
    const again = await run(Effect.flatMap(AttachmentStore, (store) => store.get(record.id)), testPersistence(dir))
    expect(Option.getOrThrow(again)).toEqual(record)

    class Broken extends Schema.TaggedError<Broken>()("Broken", {}) {}
    const failed = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.flatMap(AttachmentStore, (store) =>
          store.putStream({ name: "x.bin", mime: "application/octet-stream", chunks: Stream.concat(Stream.fromIterable(chunks), Stream.fail(new Broken())) })).pipe(
            Effect.provide(testPersistence(dir)),
          ),
      ),
    )
    expect(Exit.isFailure(failed)).toBe(true)
    expect((await readdir(join(dir, "attachments"))).sort()).toEqual([record.id])
  })
})

describe("frontmatter", () => {
  test("round-trips scalars, nested maps and raw blocks", () => {
    const text = "---\nname: x\nallowed-tools:\n  - Read\n  - Grep\nmetadata:\n  a: \"1\"\n---\n\nbody\n---\nnot a fence\n"
    const parsed = parseFrontmatter(text)
    expect(parsed.body).toBe("body\n---\nnot a fence\n")
    expect(parsed.fields.get("allowed-tools")).toEqual({ kind: "raw", lines: ["  - Read", "  - Grep"] })
    expect(renderFrontmatter(parsed)).toBe("---\nname: x\nallowed-tools:\n  - Read\n  - Grep\nmetadata:\n  a: \"1\"\n---\n\nbody\n---\nnot a fence\n")
  })

  test("text without a fence is all body", () => {
    expect(parseFrontmatter("# hi\n").body).toBe("# hi\n")
    expect(parseFrontmatter("---\nunterminated").body).toBe("---\nunterminated")
  })
})
