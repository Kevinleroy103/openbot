// Activity-row phrase (grok-bot-ui-activity.md F.3/F.4): the server's `BotActivity.label` wins;
// otherwise a phrase from the state / tool kind, and "Typing…" while a reply streams. Human and
// plumbing-free (D6.4): helpers and the bot's own bookkeeping read as the generic phrases.
import { CONNECTED_APP_ACTIVITY, type BotActivity, type Turn } from "@openbot/contracts"

const pick = (list: ReadonlyArray<string>, seed: number): string => list[Math.abs(seed) % list.length]!

const THINKING = ["Thinking it through", "Mulling it over", "Putting it together"] as const
const WORKING = ["Getting it done", "Making progress", "Working on it", "Handling it", "Chipping away"] as const

const byTool: Record<string, string> = {
  shell: "Running a few commands",
  "file-read": "Reading the file",
  "file-write": "Jotting it down",
  "file-edit": "Jotting it down",
  search: "Digging around",
  web: "Doing some reading",
  mcp: CONNECTED_APP_ACTIVITY,
  question: "Needs your input",
  browser: "Clicking through pages",
  computer: "Clicking around",
}

export const activityPhrase = (input: {
  readonly activity: BotActivity | undefined
  readonly turn: Turn | undefined
  readonly streaming: boolean
}): string => {
  const { activity, turn, streaming } = input
  if (streaming) return "Typing…"
  if (turn?.status === "waiting") return activity?.label ?? "Waiting for you"
  if (activity?.label) return activity.label.replace(/\.\.\.$/, "…")
  const seed = Math.floor((turn?.startedAt ?? activity?.since ?? 0) / 1000)
  if (activity?.toolKind && byTool[activity.toolKind]) return byTool[activity.toolKind]!
  if (activity?.state === "thinking") return pick(THINKING, seed)
  if (turn?.status === "queued") return "Queued"
  return pick(WORKING, seed)
}
