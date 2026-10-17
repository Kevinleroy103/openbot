/**
 * `MemoryStore` on disk (D5.4), in Claude auto-memory format so Claude bots can read and write the
 * directory natively (`autoMemoryDirectory`):
 *
 * ```
 * <data>/bots/<botId>/memory/MEMORY.md     the index (free markdown)
 * <data>/bots/<botId>/memory/<factId>.md   one fact per file:
 *   ---
 *   name: <title>
 *   description: <one-line hook>
 *   metadata:
 *     modified: <ISO timestamp = updatedAt>
 *   ---
 *
 *   <body>
 * ```
 *
 * Files written by Claude or by hand are tolerated: unknown frontmatter keys are preserved on
 * rewrite, a missing `name` falls back to the file stem, a missing `modified` to the file mtime, and
 * files whose stem is not a valid `MemoryFactId` are ignored.
 */
import type { BotId, MemoryFact, MemoryFactId, Millis } from "@openbot/contracts"
import { type DataDirShape, joinPath, MemoryStore, RepoError } from "@openbot/core"
import { Effect, Option } from "effect"
import { listDirectory, modifiedAt, readTextFile, removePath, safeSegment, writeFileAtomic } from "./files.ts"
import { formatTimestamp, metadataValue, parseFrontmatter, parseTimestamp, renderFrontmatter, scalar, updateFrontmatter } from "./frontmatter.ts"

export const MEMORY_INDEX_FILE = "MEMORY.md"
const FACT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

export const makeFileMemoryStore = (dataDir: DataDirShape) =>
  Effect.sync(() => {
    const dirOf = (op: string, botId: BotId) => Effect.map(safeSegment(op, botId), (id) => dataDir.memoryDir(id))
    const factPath = (op: string, botId: BotId, factId: MemoryFactId) =>
      Effect.gen(function*() {
        if (!FACT_ID.test(factId)) return yield* new RepoError({ op, message: `Invalid fact id: ${JSON.stringify(factId)}` })
        return joinPath(yield* dirOf(op, botId), `${factId}.md`)
      })

    const readFact = (op: string, path: string, factId: MemoryFactId): Effect.Effect<Option.Option<MemoryFact>, RepoError> =>
      Effect.gen(function*() {
        const text = yield* readTextFile(op, path)
        if (text === undefined) return Option.none()
        const frontmatter = parseFrontmatter(text)
        const description = scalar(frontmatter, "description")
        const updatedAt = parseTimestamp(metadataValue(frontmatter, "modified")) ?? (yield* modifiedAt(op, path)) ?? 0
        const fact: MemoryFact = {
          id: factId,
          title: scalar(frontmatter, "name") || factId,
          ...(description === undefined || description.length === 0 ? {} : { description }),
          body: frontmatter.body,
          updatedAt: updatedAt as Millis,
        }
        return Option.some(fact)
      })

    return MemoryStore.of({
      readIndex: (botId) =>
        Effect.gen(function*() {
          const dir = yield* dirOf("MemoryStore.readIndex", botId)
          return (yield* readTextFile("MemoryStore.readIndex", joinPath(dir, MEMORY_INDEX_FILE))) ?? ""
        }),

      writeIndex: (botId, index) =>
        Effect.gen(function*() {
          const dir = yield* dirOf("MemoryStore.writeIndex", botId)
          yield* writeFileAtomic("MemoryStore.writeIndex", joinPath(dir, MEMORY_INDEX_FILE), index)
        }),

      listFacts: (botId) =>
        Effect.gen(function*() {
          const dir = yield* dirOf("MemoryStore.listFacts", botId)
          const names = (yield* listDirectory("MemoryStore.listFacts", dir))
            .filter((e) => e.isFile && e.name.endsWith(".md") && e.name !== MEMORY_INDEX_FILE)
            .map((e) => e.name.slice(0, -3))
            .filter((stem) => FACT_ID.test(stem))
            .sort()
          const facts: Array<MemoryFact> = []
          for (const stem of names) {
            const fact = yield* readFact("MemoryStore.listFacts", joinPath(dir, `${stem}.md`), stem as MemoryFactId)
            if (Option.isSome(fact)) facts.push(fact.value)
          }
          return facts
        }),

      getFact: (botId, factId) =>
        Effect.gen(function*() {
          if (!FACT_ID.test(factId)) return Option.none()
          return yield* readFact("MemoryStore.getFact", yield* factPath("MemoryStore.getFact", botId, factId), factId)
        }),

      putFact: (botId, fact) =>
        Effect.gen(function*() {
          const path = yield* factPath("MemoryStore.putFact", botId, fact.id)
          const existingText = yield* readTextFile("MemoryStore.putFact", path)
          const frontmatter = updateFrontmatter(existingText === undefined ? undefined : parseFrontmatter(existingText), {
            scalars: [["name", fact.title], ["description", fact.description]],
            metadata: [["modified", formatTimestamp(fact.updatedAt)]],
            body: fact.body,
          })
          yield* writeFileAtomic("MemoryStore.putFact", path, renderFrontmatter(frontmatter))
        }),

      deleteFact: (botId, factId) =>
        Effect.gen(function*() {
          if (!FACT_ID.test(factId)) return false
          return yield* removePath("MemoryStore.deleteFact", yield* factPath("MemoryStore.deleteFact", botId, factId))
        }),

      deleteAll: (botId) =>
        Effect.gen(function*() {
          yield* removePath("MemoryStore.deleteAll", yield* dirOf("MemoryStore.deleteAll", botId))
        }),
    })
  })
