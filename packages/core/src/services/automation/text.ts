/** Small text helpers shared by the automation services (no platform APIs). */

const encoder = new TextEncoder()

export const utf8Length = (text: string): number => encoder.encode(text).length

/** Truncates `text` to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export const capUtf8 = (text: string, maxBytes: number): string => {
  if (utf8Length(text) <= maxBytes) return text
  let out = ""
  let used = 0
  for (const char of text) {
    const size = utf8Length(char)
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return out
}

/** Truncates to `max` characters (code points), appending "…" when cut. */
export const truncate = (text: string, max: number): string => {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`
}

/** Collapses whitespace to single spaces (one-line previews). */
export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim()
