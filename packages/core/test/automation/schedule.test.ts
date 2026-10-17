import { describe, expect, test } from "bun:test"
import type { MemoryFactId } from "@openbot/contracts"
import {
  describeTrigger,
  memoryIndexLine,
  nextRunAfter,
  removeIndexLine,
  upsertIndexLine,
  validateTrigger,
} from "../../src/services/automation/index.ts"

const t = (iso: string) => Date.parse(iso)

describe("routine triggers", () => {
  test("cron honors the timezone and is strictly after", () => {
    const trigger = { type: "cron" as const, schedule: "0 9 * * *", timezone: "Europe/Berlin" }
    // 09:00 Berlin (CEST, +02:00) = 07:00Z
    expect(nextRunAfter(trigger, t("2026-10-15T06:00:00Z"))).toBe(t("2026-10-15T07:00:00Z"))
    expect(nextRunAfter(trigger, t("2026-10-15T07:00:00Z"))).toBe(t("2026-10-16T07:00:00Z"))
  })

  test("interval is anchored at the last run / enabling; at least 5 minutes", () => {
    const trigger = { type: "interval" as const, everyMinutes: 30 }
    expect(nextRunAfter(trigger, 0, { anchor: 0 })).toBe(30 * 60_000)
    expect(nextRunAfter(trigger, 95 * 60_000, { anchor: 0 })).toBe(120 * 60_000)
    expect(validateTrigger({ type: "interval", everyMinutes: 4 }, 0)).toContain("at least 5")
  })

  test("once runs at its time, only once; manual never", () => {
    expect(nextRunAfter({ type: "once", at: 1000 }, 0)).toBe(1000)
    expect(nextRunAfter({ type: "once", at: 1000 }, 1000)).toBeUndefined()
    expect(nextRunAfter({ type: "once", at: 1000 }, 0, { ranOnce: true })).toBeUndefined()
    expect(nextRunAfter({ type: "manual" }, 0)).toBeUndefined()
    expect(validateTrigger({ type: "once", at: 5 }, 10)).toContain("future")
  })

  test("validation rejects bad cron expressions and timezones", () => {
    expect(validateTrigger({ type: "cron", schedule: "0 9 * * *", timezone: "UTC" }, 0)).toBeUndefined()
    expect(validateTrigger({ type: "cron", schedule: "nope", timezone: "UTC" }, 0)).toContain("5-field")
    expect(validateTrigger({ type: "cron", schedule: "0 25 * * *", timezone: "UTC" }, 0)).toContain("Invalid schedule")
    expect(validateTrigger({ type: "cron", schedule: "0 9 * * *", timezone: "Mars/Base" }, 0)).toContain("Invalid schedule")
    expect(validateTrigger({ type: "webhook" }, 0)).toContain("not supported")
  })

  test("human summaries", () => {
    expect(describeTrigger({ type: "cron", schedule: "0 9 * * 1-5", timezone: "Europe/Berlin" })).toBe(
      "Weekdays at 9:00 AM (Europe/Berlin)",
    )
    expect(describeTrigger({ type: "cron", schedule: "30 17 * * 5", timezone: "UTC" })).toBe("Every Friday at 5:30 PM UTC")
    expect(describeTrigger({ type: "cron", schedule: "*/15 * * * *", timezone: "UTC" })).toBe('Cron "*/15 * * * *" UTC')
    expect(describeTrigger({ type: "interval", everyMinutes: 120 })).toBe("Every 2 hours")
    expect(describeTrigger({ type: "interval", everyMinutes: 45 })).toBe("Every 45 minutes")
    expect(describeTrigger({ type: "manual" })).toBe("Manual only")
  })
})

describe("MEMORY.md index", () => {
  const fact = { id: "dark-mode" as MemoryFactId, title: "Prefers dark mode", description: "UI preference" }

  test("lines use the Claude auto-memory format", () => {
    expect(memoryIndexLine(fact)).toBe("- [Prefers dark mode](dark-mode.md) — UI preference")
    expect(memoryIndexLine({ id: "x" as MemoryFactId, title: "a [b]" })).toBe("- [a \\[b\\]](x.md)")
  })

  test("upsert replaces the fact's line in place and keeps foreign text; remove drops it", () => {
    const start = "# Notes\nKeep this.\n- [Old](dark-mode.md) — old\n- [Other](other.md)\n"
    const updated = upsertIndexLine(start, fact)
    expect(updated).toBe("# Notes\nKeep this.\n- [Prefers dark mode](dark-mode.md) — UI preference\n- [Other](other.md)\n")
    expect(upsertIndexLine("", fact)).toBe("- [Prefers dark mode](dark-mode.md) — UI preference\n")
    expect(upsertIndexLine("intro\n\n", fact)).toBe("intro\n- [Prefers dark mode](dark-mode.md) — UI preference\n")
    expect(removeIndexLine(updated, fact.id)).toBe("# Notes\nKeep this.\n- [Other](other.md)\n")
    expect(removeIndexLine(upsertIndexLine("", fact), fact.id)).toBe("")
  })
})
