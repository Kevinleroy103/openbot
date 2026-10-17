/**
 * Minimal YAML frontmatter for the markdown stores (Claude auto-memory fact files and Agent Skills
 * `SKILL.md`). It understands what those formats use: top-level `key: scalar` lines and one level
 * of nested scalar maps (`metadata:`). Anything else (lists, deeper maps, comments) is kept
 * verbatim so files written by Claude or by hand survive a rewrite.
 */

export interface Frontmatter {
  /** Top-level keys in file order. Scalars are decoded strings; nested maps are `Map`s; other blocks raw text. */
  readonly fields: Map<string, FrontmatterValue>
  /** Markdown after the frontmatter (one separating blank line removed). */
  readonly body: string
}

export type FrontmatterValue =
  | { readonly kind: "scalar"; readonly value: string }
  | { readonly kind: "map"; readonly entries: Map<string, string> }
  | { readonly kind: "raw"; readonly lines: ReadonlyArray<string> }

const FENCE = "---"

const unquote = (raw: string): string => {
  const value = raw.trim()
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed === "string") return parsed
    } catch {
      // fall through: keep the inner text
    }
    return value.slice(1, -1)
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'")
  return value
}

/** Quotes a scalar when plain YAML would change its meaning. */
export const quote = (value: string): string => {
  const plain = value.length > 0 &&
    value === value.trim() &&
    !/[\n\r\t]/.test(value) &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
    !value.includes(": ") &&
    !value.includes(" #") &&
    !value.endsWith(":") &&
    !/^(true|false|yes|no|on|off|null|~|[-+]?[0-9][0-9_.eE+-]*)$/i.test(value)
  return plain ? value : JSON.stringify(value)
}

const keyLine = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:\s+(.*))?$/

/** Splits `text` into frontmatter + body. Text without a leading `---` fence has no fields. */
export const parseFrontmatter = (text: string): Frontmatter => {
  const normalized = text.replace(/\r\n/g, "\n")
  const fields = new Map<string, FrontmatterValue>()
  if (!normalized.startsWith(`${FENCE}\n`)) return { fields, body: normalized }
  // the closing fence must be a whole line
  let end = normalized.indexOf(`\n${FENCE}`, FENCE.length)
  while (end !== -1 && normalized.length > end + 1 + FENCE.length && normalized[end + 1 + FENCE.length] !== "\n") {
    end = normalized.indexOf(`\n${FENCE}`, end + 1)
  }
  if (end === -1) return { fields, body: normalized }
  const afterFence = end + 1 + FENCE.length
  const header = normalized.slice(FENCE.length + 1, end).split("\n")
  let body = normalized.slice(afterFence + 1)
  if (body.startsWith("\n")) body = body.slice(1)

  let i = 0
  while (i < header.length) {
    const line = header[i] ?? ""
    const match = keyLine.exec(line)
    if (match === null) {
      i++
      continue
    }
    const key = match[1] ?? ""
    const rest = match[2]
    const blockStyle = rest === undefined ? null : /^([|>])[+-]?\d*\s*$/.exec(rest.trim())
    if (blockStyle !== null) {
      // `key: |` (literal) / `key: >` (folded) block scalar: the indented lines below
      const lines: Array<string> = []
      i++
      while (i < header.length && /^(\s+|$)/.test(header[i] ?? "")) {
        lines.push(header[i] ?? "")
        i++
      }
      while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") lines.pop()
      const indent = Math.min(...lines.filter((l) => l.trim() !== "").map((l) => l.length - l.trimStart().length))
      const text = lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0))
      const value = blockStyle[1] === "|"
        ? text.join("\n")
        : text.reduce((acc, line) => (line === "" ? `${acc}\n` : acc === "" || acc.endsWith("\n") ? `${acc}${line}` : `${acc} ${line}`), "")
      fields.set(key, { kind: "scalar", value })
      continue
    }
    if (rest !== undefined && rest.trim().length > 0) {
      fields.set(key, { kind: "scalar", value: unquote(rest) })
      i++
      continue
    }
    // block value: the following indented (or list) lines
    const block: Array<string> = []
    i++
    while (i < header.length && /^(\s+|-\s|-$)/.test(header[i] ?? "")) {
      block.push(header[i] ?? "")
      i++
    }
    const entries = new Map<string, string>()
    let isMap = block.length > 0
    for (const raw of block) {
      const nested = /^\s+([A-Za-z0-9_][A-Za-z0-9_.-]*):\s+(.*)$/.exec(raw)
      if (nested === null || /^\s{4,}/.test(raw)) {
        isMap = false
        break
      }
      entries.set(nested[1] ?? "", unquote(nested[2] ?? ""))
    }
    fields.set(key, isMap ? { kind: "map", entries } : block.length === 0 ? { kind: "scalar", value: "" } : { kind: "raw", lines: block })
  }
  return { fields, body }
}

export const renderFrontmatter = (frontmatter: Frontmatter): string => {
  const lines: Array<string> = [FENCE]
  for (const [key, value] of frontmatter.fields) {
    switch (value.kind) {
      case "scalar":
        lines.push(`${key}: ${quote(value.value)}`)
        break
      case "map":
        lines.push(`${key}:`)
        for (const [nestedKey, nestedValue] of value.entries) lines.push(`  ${nestedKey}: ${quote(nestedValue)}`)
        break
      case "raw":
        lines.push(`${key}:`, ...value.lines)
        break
    }
  }
  lines.push(FENCE, "", "")
  return lines.join("\n") + frontmatter.body
}

export const scalar = (frontmatter: Frontmatter, key: string): string | undefined => {
  const value = frontmatter.fields.get(key)
  return value?.kind === "scalar" ? value.value : undefined
}

export const metadataValue = (frontmatter: Frontmatter, key: string): string | undefined => {
  const value = frontmatter.fields.get("metadata")
  return value?.kind === "map" ? value.entries.get(key) : undefined
}

/**
 * Rewrites `existing` (or a fresh header) with the given scalar fields and metadata entries,
 * preserving every other key in place. `undefined` removes a scalar field.
 */
export const updateFrontmatter = (
  existing: Frontmatter | undefined,
  update: {
    readonly scalars: ReadonlyArray<readonly [key: string, value: string | undefined]>
    readonly metadata: ReadonlyArray<readonly [key: string, value: string]>
    readonly body: string
  },
): Frontmatter => {
  const fields = new Map<string, FrontmatterValue>(existing?.fields ?? [])
  for (const [key, value] of update.scalars) {
    if (value === undefined) fields.delete(key)
    else fields.set(key, { kind: "scalar", value })
  }
  if (update.metadata.length > 0) {
    const current = fields.get("metadata")
    const entries = new Map<string, string>(current?.kind === "map" ? current.entries : [])
    for (const [key, value] of update.metadata) entries.set(key, value)
    fields.set("metadata", { kind: "map", entries })
  }
  return { fields, body: update.body }
}

/** Milliseconds from an ISO timestamp (or a numeric string); `undefined` when unparseable. */
export const parseTimestamp = (value: string | undefined): number | undefined => {
  if (value === undefined || value.length === 0) return undefined
  if (/^\d+$/.test(value)) return Number(value)
  const ms = Date.parse(value)
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined
}

export const formatTimestamp = (ms: number): string => new Date(ms).toISOString()
