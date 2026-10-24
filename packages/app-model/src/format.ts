// Time and text formatting shared by the sidebar, transcript and palettes (grok-bot-ui.md §4.4:
// "Today 7:15 AM", "Yesterday 11:56 AM", "Wednesday 8:13 PM").

const DAY = 24 * 60 * 60 * 1000

const startOfDay = (ms: number): number => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export const formatClock = (ms: number): string =>
  new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })

/** Home list (phone) time column: "9:41 AM", "Yesterday", "Mon", "Oct 3". */
export const formatListTime = (ms: number, now: number = Date.now()): string => {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY)
  if (days <= 0) return formatClock(ms)
  if (days === 1) return "Yesterday"
  if (days < 7) return new Date(ms).toLocaleDateString("en-US", { weekday: "short" })
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear()
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  })
}

/** Transcript timestamp row label. */
export const formatTimestamp = (ms: number, now: number = Date.now()): string => {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY)
  const clock = formatClock(ms)
  if (days <= 0) return `Today ${clock}`
  if (days === 1) return `Yesterday ${clock}`
  if (days < 7) return `${new Date(ms).toLocaleDateString("en-US", { weekday: "long" })} ${clock}`
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear()
  return `${new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })} ${clock}`
}

/** "1.2k", "124k", "1.1M" (context ring, token counts). */
export const formatTokens = (n: number): string => {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
}

/** First letter(s) for the owner monogram. */
export const initials = (name: string | undefined): string => {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "Y"
  return parts[0]!.charAt(0).toUpperCase()
}

/** Plain one-line preview of markdown-ish text. */
export const plainPreview = (text: string, max = 120): string => {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Strip markdown markers only — keep underscores/asterisks inside words (list_bots, a*b).
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[\s(])[*_](?=\S)([^*_\n]*?\S)[*_](?=$|[\s).,:;!?])/g, "$1$2")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
