// DEV MOCK ONLY: the `ui` cards a Bot posts when a message names a scenario (`ui-choice`, `ui-chart-fill`, …).
// They cover every block, the three action styles, update_ui and content the renderer must defuse.
import type { AttachmentId, UiAnswer, UiCard, UiChecklistStatus } from "@openbot/contracts"

export const UI_GALLERY_IMAGE = "att_gallery" as AttachmentId

export interface UiScenario {
  readonly reply: string
  readonly card: UiCard
  /** update_ui: each replaces the card on the same entry, ~1.2 s apart. */
  readonly updates?: ReadonlyArray<UiCard>
  readonly closing?: string
}

const CI_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const WEEKS = ["W36", "W37", "W38", "W39", "W40", "W41", "W42", "W43"]
const HALF_HOURS = Array.from(
  { length: 48 },
  (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`,
)
/** 0 at midnight, 1 at midday. */
const daytime = (halfHour: number) => (1 - Math.cos((halfHour / 48) * 2 * Math.PI)) / 2

const ROLLOUT = ["Build web bundle", "Run migrations", "Roll out to 10%", "Roll out to everyone"]

const rolloutStatus = (i: number, done: number): UiChecklistStatus => {
  if (i < done) return "done"
  return i === done ? "active" : "upcoming"
}

const rollout = (done: number): UiCard => {
  const finished = done === ROLLOUT.length
  return {
    type: "ui",
    version: 1,
    title: "Search rollout",
    subtitle: finished ? "Finished" : `${done} of ${ROLLOUT.length} done`,
    blocks: [{ type: "checklist", items: ROLLOUT.map((label, i) => ({ label, status: rolloutStatus(i, done) })) }],
    fallback: finished ? "Search rollout: finished." : `Search rollout: ${done} of ${ROLLOUT.length} done.`,
  }
}

export const UI_SCENARIOS: Record<string, UiScenario> = {
  "ui-comparison": {
    reply: "I'd take the morning flight. It's direct, includes a cabin bag, and gives you most of the day in London.",
    card: {
      type: "ui",
      version: 1,
      title: "Tirana → London",
      subtitle: "Thu, 29 Oct · One way · 1 adult",
      blocks: [
        {
          type: "options",
          items: [
            {
              id: "ba",
              title: "British Airways",
              subtitle: "TIA → LHR",
              lines: ["09:20 – 11:40", "3h 20m · Direct"],
              value: "€148",
              note: "Cabin bag included",
            },
            {
              id: "wizz",
              title: "Wizz Air",
              subtitle: "TIA → LTN",
              lines: ["12:10 – 14:35", "3h 25m · Direct"],
              value: "€92",
              note: "Small bag only",
            },
            {
              id: "os",
              title: "Austrian",
              subtitle: "TIA → LHR",
              lines: ["06:00 – 10:10", "5h 10m · 1 stop"],
              value: "€176",
              note: "Cabin bag included",
              badge: "1 stop",
            },
          ],
          pick: "ba",
        },
        { type: "text", markdown: "Heathrow is the easier arrival for central London. Prices are illustrative." },
        { type: "link", label: "View morning flight", url: "https://www.britishairways.com/" },
      ],
      fallback:
        "Tirana → London, Thu 29 Oct: British Airways 09:20–11:40 direct €148 (my pick); Wizz Air 12:10–14:35 direct €92; Austrian 06:00–10:10 1 stop €176.",
    },
  },
  "ui-chart": {
    reply: "Yes. The median run fell from 8m 24s to 5m 12s after Thursday's cache change. All 42 runs passed.",
    card: {
      type: "ui",
      version: 1,
      title: "CI is getting faster",
      subtitle: "Main branch · 19–25 Oct",
      blocks: [
        {
          type: "stats",
          items: [
            { label: "Median duration", value: "5m 12s", delta: "38% faster", tone: "good" },
            { label: "Runs this week", value: "42" },
            { label: "Pass rate", value: "100%", delta: "0 failed runs", tone: "neutral" },
          ],
        },
        {
          type: "chart",
          kind: "bar",
          unit: "min",
          series: [
            {
              name: "CI duration",
              points: [
                { x: "Mon", y: 8.7 },
                { x: "Tue", y: 8.4 },
                { x: "Wed", y: 8.2 },
                { x: "Thu", y: 5.8 },
                { x: "Fri", y: 5.3 },
                { x: "Sat", y: 5.2 },
                { x: "Sun", y: 5.1 },
              ],
            },
          ],
          highlight: "Thu",
        },
        { type: "text", markdown: "The improvement held across the last 18 runs." },
      ],
      fallback:
        "CI median fell from 8m 24s to 5m 12s (38% faster) after the cache change on Thu 22 Oct; 42 runs, 100% passed.",
    },
  },
  "ui-chart-stacked": {
    reply: "Browser tests are still the biggest share, but every step got faster after Thursday's cache change.",
    card: {
      type: "ui",
      version: 1,
      title: "Where CI time goes",
      subtitle: "Main branch · 19–25 Oct",
      blocks: [
        {
          type: "chart",
          kind: "bar",
          stacked: true,
          unit: "min",
          series: [
            { name: "Typecheck", points: CI_DAYS.map((x, i) => ({ x, y: [2.1, 2.0, 2.0, 1.2, 1.1, 1.1, 1.0][i]! })) },
            { name: "Unit tests", points: CI_DAYS.map((x, i) => ({ x, y: [3.4, 3.3, 3.2, 2.4, 2.2, 2.1, 2.1][i]! })) },
            {
              name: "Browser tests",
              points: CI_DAYS.map((x, i) => ({ x, y: [3.2, 3.1, 3.0, 2.2, 2.0, 2.0, 2.0][i]! })),
            },
          ],
          highlight: "Thu",
        },
      ],
      fallback:
        "CI minutes per day, 19–25 Oct: 8.7 on Monday down to 5.1 on Sunday; browser tests take the largest share every day.",
    },
  },
  "ui-chart-fill": {
    reply: "iPhone is now 40% of weekly users. Response times peak around midday but p95 stays under 400 ms.",
    card: {
      type: "ui",
      version: 1,
      title: "Usage and latency",
      subtitle: "Weeks 36–43 · today in half hours",
      blocks: [
        {
          type: "chart",
          kind: "line",
          fill: true,
          stacked: true,
          series: [
            {
              name: "Web",
              points: WEEKS.map((x, i) => ({ x, y: [1200, 1260, 1310, 1290, 1380, 1420, 1460, 1510][i]! })),
            },
            { name: "iPhone", points: WEEKS.map((x, i) => ({ x, y: [310, 340, 420, 510, 640, 760, 880, 1010][i]! })) },
          ],
          highlight: "W43",
        },
        {
          type: "chart",
          kind: "line",
          fill: true,
          unit: "ms",
          series: [
            { name: "p50", points: HALF_HOURS.map((x, i) => ({ x, y: Math.round(110 + 60 * daytime(i)) })) },
            { name: "p95", points: HALF_HOURS.map((x, i) => ({ x, y: Math.round(220 + 160 * daytime(i)) })) },
          ],
        },
      ],
      fallback:
        "Weekly active users grew from 1,510 to 2,520 over weeks 36–43 (iPhone 310 → 1,010). Today p50 stayed at 110–170 ms and p95 at 220–380 ms, peaking around midday.",
    },
  },
  "ui-plan": {
    reply:
      "The implementation and tests are done. I'm checking the last UI details; the release is waiting on your review.",
    card: {
      type: "ui",
      version: 1,
      title: "Search release",
      subtitle: "2 of 4 complete · Updated just now",
      blocks: [
        {
          type: "checklist",
          items: [
            { label: "Build search and keyboard navigation", detail: "Web and mobile", status: "done" },
            { label: "Run regression checks", detail: "Search, reactions and message windows", status: "done" },
            { label: "Check the final UI details", detail: "Phone layout and empty states", status: "active" },
            { label: "Review and release", detail: "Your review is the next handoff", status: "upcoming" },
          ],
        },
      ],
      actions: [{ id: "review", label: "Review changes", style: "secondary" }],
      fallback:
        "Search release: 2 of 4 complete. Build and regression checks are done, final UI details in progress, then your review.",
    },
  },
  "ui-choice": {
    reply: "You're both free at these times. Pick a slot and I'll prepare the invite for your review.",
    card: {
      type: "ui",
      version: 1,
      title: "Choose a meeting time",
      subtitle: "Sun, 25 Oct · 30 min · Europe/Tirane",
      blocks: [
        {
          type: "fields",
          items: [
            { label: "With", value: "Mira" },
            { label: "Availability", value: "Both available" },
          ],
        },
        {
          type: "choice",
          id: "slot",
          label: "Meeting time",
          mode: "one",
          options: [
            { id: "1000", label: "10:00 – 10:30", badge: "Recommended" },
            { id: "1330", label: "13:30 – 14:00" },
            { id: "1500", label: "15:00 – 15:30" },
          ],
          default: ["1000"],
        },
        { type: "input", id: "title", label: "Meeting title", default: "Design review" },
      ],
      actions: [{ id: "send", label: "Send choice", style: "primary" }],
      fallback: "Choose a meeting time with Mira on Sun 25 Oct: 10:00–10:30, 13:30–14:00 or 15:00–15:30.",
    },
  },
  "ui-agenda": {
    reply:
      "You have two meetings tomorrow. I've left the morning clear for focused work and added a buffer before the review.",
    card: {
      type: "ui",
      version: 1,
      title: "Your Sunday",
      subtitle: "25 Oct · Europe/Tirane",
      blocks: [
        {
          type: "fields",
          items: [
            { label: "Meetings", value: "2" },
            { label: "Focus time", value: "1h 30m" },
          ],
        },
        {
          type: "timeline",
          items: [
            { time: "09:00", title: "Focus time", detail: "Search release review", tag: "Protected" },
            { time: "10:30", title: "Design review", detail: "With Mira · Google Meet", tag: "30 min" },
            { time: "11:00", title: "A little breathing room", detail: "Notes and a break", tag: "Buffer" },
            { time: "14:00", title: "Weekly planning", detail: "With the team · Google Meet", tag: "45 min" },
          ],
        },
        { type: "link", label: "Open calendar", url: "https://calendar.google.com/" },
      ],
      fallback: "Sun 25 Oct: 09:00 focus time, 10:30 design review with Mira, 11:00 buffer, 14:00 weekly planning.",
    },
  },
  "ui-compact": {
    reply: "Ready for your review. All checks passed; the details are tucked below.",
    card: {
      type: "ui",
      version: 1,
      title: "Search release checks",
      subtitle: "6 checks passed · No blockers",
      collapsed: true,
      blocks: [
        {
          type: "checklist",
          items: [
            { label: "Web typecheck", status: "done" },
            { label: "Mobile typecheck", status: "done" },
            { label: "Search regressions", status: "done" },
            { label: "Message window tests", status: "done" },
            { label: "Keyboard navigation", status: "done" },
            { label: "Phone layout", status: "done" },
          ],
        },
        { type: "text", markdown: "The branch is ready for your review." },
      ],
      fallback: "All 6 checks passed on the search release branch.",
    },
  },
  "ui-progress": {
    reply: "Rolling it out now. I'll keep this card current.",
    card: rollout(0),
    updates: [1, 2, 3, 4].map(rollout),
    closing: "Rolled out to everyone. No errors so far.",
  },
  // An unknown block can't cross the RPC (it is decode-only), so the renderer's fixture adds one.
  "ui-everything": {
    reply: "Here's every kind of block in one card.",
    card: {
      type: "ui",
      version: 1,
      title: "Block gallery",
      subtitle: "Every block type",
      blocks: [
        {
          type: "text",
          markdown:
            "**Bold** text, `inline code` and a [docs link](https://example.com/docs).\n\n- First item\n- Second item",
        },
        {
          type: "fields",
          items: [
            { label: "Owner", value: "Lekë" },
            { label: "Status", value: "In review" },
            { label: "Due", value: "Fri, 30 Oct" },
          ],
        },
        {
          type: "stats",
          items: [
            { label: "Signups", value: "1,204", delta: "+12%", tone: "good" },
            { label: "Errors", value: "37", delta: "+9", tone: "bad" },
            { label: "Latency", value: "212 ms", delta: "±0", tone: "neutral" },
            { label: "Regions", value: "4" },
          ],
        },
        {
          type: "table",
          columns: ["Region", "Requests", "p95"],
          rows: [
            ["eu-central", "48,210", "180 ms"],
            ["us-east", "61,904", "205 ms"],
            ["ap-south", "12,377", "290 ms"],
            ["sa-east", "4,018", "340 ms"],
          ],
        },
        {
          type: "options",
          items: [
            { id: "small", title: "Small", subtitle: "2 vCPU · 4 GB", lines: ["Good for staging"], value: "€18/mo" },
            {
              id: "large",
              title: "Large",
              subtitle: "8 vCPU · 16 GB",
              lines: ["Handles peak traffic"],
              value: "€64/mo",
              note: "Recommended for prod",
              badge: "Popular",
            },
          ],
        },
        {
          type: "checklist",
          items: [
            { label: "Lint", status: "done" },
            { label: "Unit tests", detail: "388 of 388", status: "done" },
            { label: "E2E tests", detail: "Running shard 2 of 3", status: "active" },
            { label: "Visual diff", detail: "2 screenshots changed", status: "failed" },
            { label: "Deploy", status: "upcoming" },
          ],
        },
        {
          type: "timeline",
          items: [
            { time: "09:12", title: "Alert fired", detail: "p95 above 300 ms in ap-south", tag: "Paged" },
            { time: "09:20", title: "Rolled back", detail: "Back to build 4182" },
            { time: "09:41", title: "Resolved", tag: "18 min" },
          ],
        },
        {
          type: "chart",
          kind: "line",
          unit: "ms",
          series: [
            {
              name: "Web p95",
              points: [
                { x: "Mon", y: 210 },
                { x: "Tue", y: 205 },
                { x: "Wed", y: 230 },
                { x: "Thu", y: 310 },
                { x: "Fri", y: 220 },
                { x: "Sat", y: 198 },
                { x: "Sun", y: 192 },
              ],
            },
            {
              name: "Mobile p95",
              points: [
                { x: "Mon", y: 260 },
                { x: "Tue", y: 255 },
                { x: "Wed", y: 270 },
                { x: "Thu", y: 390 },
                { x: "Fri", y: 280 },
                { x: "Sat", y: 250 },
                { x: "Sun", y: 244 },
              ],
            },
          ],
          highlight: "Thu",
        },
        { type: "image", attachmentId: UI_GALLERY_IMAGE, alt: "The OpenBot app icon" },
        { type: "link", label: "Open the dashboard", url: "https://example.com/dashboard" },
        {
          type: "choice",
          id: "toppings",
          label: "Toppings",
          mode: "many",
          options: [
            { id: "olives", label: "Olives" },
            { id: "basil", label: "Basil", detail: "Fresh from the garden" },
            { id: "chili", label: "Chili", badge: "Hot" },
            { id: "anchovies", label: "Anchovies" },
          ],
          default: ["olives", "basil"],
        },
        { type: "input", id: "notes", label: "Notes", placeholder: "Anything we should change?", multiline: true },
      ],
      actions: [
        { id: "ok", label: "Looks good", style: "primary" },
        { id: "change", label: "Ask for changes", style: "secondary" },
        { id: "discard", label: "Discard", style: "danger" },
      ],
      fallback: "Block gallery: one card with every block type, a toppings choice and a notes field.",
    },
  },
  // Skips the brain's show_ui validation on purpose: the renderer must defuse all of it on its own.
  "ui-hostile": {
    reply: "This card is hostile on purpose. Nothing in it should load, run or break the layout.",
    card: {
      type: "ui",
      version: 1,
      title: "<b>Hostile</b> card",
      subtitle: "Everything here must render inert",
      blocks: [
        {
          type: "text",
          markdown:
            "Tracking pixel: ![pixel](https://tracker.example/p.gif)\n\nScript link: [click](javascript:alert(1))\n\nData link: [data](data:text/html,<script>alert(1)</script>)\n\nRaw HTML: <img src=x onerror=alert(1)>",
        },
        { type: "fields", items: [{ label: "<i>Label</i>", value: "<script>alert(1)</script>" }] },
        { type: "link", label: "javascript link", url: "javascript:alert(1)" },
        { type: "link", label: "plain http link", url: "http://example.com" },
        { type: "link", label: "data link", url: "data:text/html,<script>alert(1)</script>" },
        { type: "image", attachmentId: "att_missing" as AttachmentId, alt: "Missing attachment" },
        {
          type: "table",
          columns: Array.from({ length: 10 }, (_, c) => `Column ${c + 1}`),
          rows: Array.from({ length: 60 }, (_, r) => Array.from({ length: 10 }, (_cell, c) => `r${r + 1}c${c + 1}`)),
        },
        {
          type: "options",
          items: [
            { id: "long", title: "A".repeat(400), lines: ["B".repeat(400)] },
            { id: "short", title: "Short" },
          ],
          pick: "long",
        },
      ],
      fallback: "Hostile content test card.",
    },
  },
}

/** The mock Bot's reply to a pressed action: the action and each value, choices by label. */
export const uiAnswerReply = (card: UiCard, answer: UiAnswer): string => {
  const action = card.actions?.find((a) => a.id === answer.actionId)?.label ?? answer.actionId
  const values = Object.entries(answer.values).map(([id, value]) => {
    if (typeof value === "string") return `${id} = ${value}`
    const block = card.blocks.find((b) => b.type === "choice" && b.id === id)
    const options = block?.type === "choice" ? block.options : []
    return `${id} = ${value.map((v) => options.find((o) => o.id === v)?.label ?? v).join(", ")}`
  })
  return values.length === 0 ? `Got "${action}".` : `Got "${action}": ${values.join("; ")}.`
}
