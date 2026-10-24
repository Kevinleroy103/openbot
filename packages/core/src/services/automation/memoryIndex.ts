/**
 * `MEMORY.md` index maintenance (D5.4; harness-context-isolation.md §7): Claude auto-memory format,
 * one line per fact linking its file:
 *
 *   - [Prefers dark mode](prefers-dark-mode.md) — UI preference, set 2026-10
 *
 * The index is free markdown the owner (and Claude, natively) may edit. Core only touches lines that
 * link a fact file (`](<id>.md)`), leaving everything else verbatim.
 */
import type { MemoryFact, MemoryFactId } from "@openbot/contracts"
import { oneLine } from "./text.ts"

const escapeLabel = (text: string): string => oneLine(text).replace(/[[\]]/g, (c) => `\\${c}`)

/** The index line for a fact. */
export const indexLine = (fact: Pick<MemoryFact, "id" | "title" | "description">): string => {
  const description = fact.description === undefined ? "" : oneLine(fact.description)
  return `- [${escapeLabel(fact.title)}](${fact.id}.md)${description.length > 0 ? ` — ${description}` : ""}`
}

const linksFact = (line: string, id: MemoryFactId): boolean => line.includes(`](${id}.md)`)

const splitLines = (index: string): Array<string> =>
  index.length === 0 ? [] : index.replace(/\r\n/g, "\n").split("\n")

const joinLines = (lines: ReadonlyArray<string>): string => {
  const trimmed = [...lines]
  while (trimmed.length > 0 && trimmed[trimmed.length - 1]!.trim() === "") trimmed.pop()
  return trimmed.length === 0 ? "" : `${trimmed.join("\n")}\n`
}

/** Replaces the fact's line (first occurrence; duplicates are dropped) or appends it. */
export const upsertIndexLine = (index: string, fact: Pick<MemoryFact, "id" | "title" | "description">): string => {
  const line = indexLine(fact)
  const lines = splitLines(index)
  let replaced = false
  const out: Array<string> = []
  for (const l of lines) {
    if (linksFact(l, fact.id)) {
      if (!replaced) out.push(line)
      replaced = true
    } else {
      out.push(l)
    }
  }
  if (!replaced) {
    while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop()
    out.push(line)
  }
  return joinLines(out)
}

/** Removes every line linking the fact. */
export const removeIndexLine = (index: string, id: MemoryFactId): string =>
  joinLines(splitLines(index).filter((l) => !linksFact(l, id)))
