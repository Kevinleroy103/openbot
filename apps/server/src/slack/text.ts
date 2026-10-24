/**
 * Slack message text (D3.4) both ways:
 * - `readableText`: Slack's markup (`<@U1>`, `<#C1|general>`, `<https://x|label>`, `<!here>`, `&amp;`)
 *   as people read it (`@Alice Smith`, `#general`, `label (https://x)`, `@here`, `&`).
 * - `slackText`: what a Bot or the owner wrote, escaped for Slack, with `@Name` of a known person
 *   turned into a real mention and `@here` / `@channel` / `@everyone` into Slack's.
 */

export interface NameLookup {
  /** A person's display name by user id (undefined: unknown). */
  readonly user: (id: string) => string | undefined
  /** A channel's name (without `#`) by id. */
  readonly channel: (id: string) => string | undefined
}

const decodeEntities = (text: string): string => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")

export const readableText = (text: string, names: NameLookup): string =>
  decodeEntities(
    text.replace(/<([^<>]+)>/g, (whole, inner: string) => {
      const [target = "", label] = inner.split("|", 2)
      if (target.startsWith("@U") || target.startsWith("@W"))
        return `@${label ?? names.user(target.slice(1)) ?? "someone"}`
      if (target.startsWith("#C") || target.startsWith("#G"))
        return `#${label ?? names.channel(target.slice(1)) ?? "a-channel"}`
      if (target.startsWith("!subteam^")) return label ?? "@a-group"
      if (target.startsWith("!")) {
        const special = target.slice(1).split("^")[0]
        return special === "here" || special === "channel" || special === "everyone" ? `@${special}` : (label ?? whole)
      }
      if (/^(https?|mailto):/.test(target)) {
        const url = target.startsWith("mailto:") ? target.slice("mailto:".length) : target
        return label === undefined || label === url || label === target ? url : `${label} (${url})`
      }
      return label ?? target
    }),
  )

const escapeSlack = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export interface Person {
  readonly id: string
  /** Names someone might write after `@` (display name, real name, handle). */
  readonly names: ReadonlyArray<string>
}

const NAME_CHAR = /[\p{L}\p{N}._'-]/u

/**
 * Escapes `text` and turns `@Name` into `<@U…>` where Name (up to three words, longest first) is a
 * person's display name, real name or handle (any case). Unknown names stay as written.
 */
export const slackText = (text: string, people: ReadonlyArray<Person>): string => {
  const byName = new Map<string, string>()
  for (const person of people) {
    for (const name of person.names) {
      const key = name.trim().toLowerCase()
      if (key.length > 0 && !byName.has(key)) byName.set(key, person.id)
    }
  }
  let out = ""
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    const prev = i === 0 ? " " : text[i - 1]!
    if (ch !== "@" || NAME_CHAR.test(prev)) {
      out += escapeSlack(ch)
      i++
      continue
    }
    // the words after "@": up to three, longest match first
    const rest = text.slice(i + 1)
    const words = /^([\p{L}\p{N}._'-]+)(?: ([\p{L}\p{N}._'-]+))?(?: ([\p{L}\p{N}._'-]+))?/u.exec(rest)
    if (words === null) {
      out += "@"
      i++
      continue
    }
    const parts = words.slice(1).filter((w): w is string => w !== undefined)
    let matched: { readonly length: number; readonly replacement: string } | undefined
    for (let n = parts.length; n >= 1 && matched === undefined; n--) {
      const candidate = parts.slice(0, n).join(" ")
      const bare = candidate.replace(/[.'-]+$/, "")
      const lower = bare.toLowerCase()
      if (n === 1 && (lower === "here" || lower === "channel" || lower === "everyone")) {
        matched = { length: bare.length, replacement: `<!${lower}>` }
      } else {
        const id = byName.get(lower)
        if (id !== undefined) matched = { length: bare.length, replacement: `<@${id}>` }
      }
    }
    if (matched === undefined) {
      out += "@"
      i++
      continue
    }
    out += matched.replacement
    i += 1 + matched.length
  }
  return out
}
