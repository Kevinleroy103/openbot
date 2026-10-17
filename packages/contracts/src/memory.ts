// Per-bot memory (D5.4): Claude auto-memory layout, a `MEMORY.md` index plus one file per fact
// under `<data>/bots/<id>/memory`. The index is free markdown the owner can edit; core keeps it in
// sync when facts change.
import { Schema } from "effect"
import { Millis, Slug } from "./base.ts"

/** File stem of a fact (`<id>.md`): lower-case slug. */
export const MemoryFactId = Slug.pipe(Schema.brand("MemoryFactId"))
export type MemoryFactId = typeof MemoryFactId.Type

export const MemoryFact = Schema.Struct({
  id: MemoryFactId,
  title: Schema.String,
  /** One-line hook shown in the index. */
  description: Schema.optionalKey(Schema.String),
  body: Schema.String,
  updatedAt: Millis,
})
export type MemoryFact = typeof MemoryFact.Type

export const BotMemory = Schema.Struct({
  /** Contents of MEMORY.md. */
  index: Schema.String,
  facts: Schema.Array(MemoryFact),
})
export type BotMemory = typeof BotMemory.Type

/** `memory.putFact` input: the server derives `id` from the title when absent. */
export const MemoryFactInput = Schema.Struct({
  id: Schema.optionalKey(MemoryFactId),
  title: Schema.String.check(Schema.isMinLength(1)),
  description: Schema.optionalKey(Schema.String),
  body: Schema.String,
})
export type MemoryFactInput = typeof MemoryFactInput.Type

/** The memory index is capped when rendered into instructions (architecture §4.3.7). */
export const MEMORY_INDEX_PROMPT_CAP_BYTES = 4096

/** Derive a fact id from a title: "Prefers dark mode!" -> "prefers-dark-mode". */
export const memoryFactIdFromTitle = (title: string): MemoryFactId => {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "")
  return (slug.length > 0 ? slug : "fact") as MemoryFactId
}
